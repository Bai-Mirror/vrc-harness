import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { dropStalePartials, receive, storeReceived, verifyBlob } from './pool.ts';
import { BoothSyncStopped, clueText, parseClue, politeFetch, probeFile, resolveDownloadable, sameVersion, versionHeaders, type BoothRequest,
  type RemoteClue, type RequestOptions, type Resolved } from './remote.ts';

export interface BoothItemInput {
  itemId: string; name: string; shopName?: string; itemUrl?: string; category?: string; owned?: boolean;
  status?: 'indexed'|'available'|'login_required'|'unavailable'; tags?: string[]; images?: string[];
  metadata?: Record<string,unknown>; remoteUpdatedAt?: string;
  /** Digest of the item's library listing entry the metadata was read for; left as it was when absent. */
  listingDigest?: string;
}
export interface BoothFileInput { downloadableId:string; itemId:string; filename:string; byteSize?:number; remoteVersion?:string;
  status?:'indexed'|'available'|'login_required'|'unavailable'; probedAt?:string;
  /** What the resolve and size probe saw (remote.ts Probe.outcome), never the signed URL. */
  probeOutcome?:string }

function json(value: unknown): string { return JSON.stringify(value ?? null); }
const now = (): string => new Date().toISOString();
function cleanFilename(value: string): string {
  const name=basename(value).replace(/[\u0000-\u001f]/g,'').trim();
  if(!name || name==='.' || name==='..') throw new Error('BOOTH 文件名无效');
  return name;
}
/**
 * Signed file URLs carry a signature and the session is a credential: no message that may be stored or shown keeps
 * either. A quoted JSON credential field goes first, on the untouched text: cutting a URL inside its value would eat
 * the backslash of an escaped quote and end the field early. The URL is cut next, so a signed query string never
 * survives as a bare `X-Amz-Signature=...` followed by the rest of its parameters.
 */
export function withoutUrls(message: string): string {
  // JSON-style quoted fields consume escaped quotes as part of the value.
  return message.replace(/["'](?:authorization|proxy-authorization|cookie|set-cookie|x-amz-signature|signature|token|_?plaza_session[\w-]*)["']\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi,
      '<凭据已隐去>')
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, '<链接已隐去>')
    // A plain header's value may contain commas, semicolons and more key/value pairs; mask through the line end.
    .replace(/\b(?:cookie|set-cookie|authorization|proxy-authorization)\s*[:=][^\r\n]*/gi, '<凭据已隐去>')
    .replace(/\b(?:x-amz-signature|signature|token|_?plaza_session[\w-]*)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi,
      '<凭据已隐去>');
}

/**
 * A file download that lost its connection is asked again a few times, with a growing pause; a settled answer (HTTP
 * 404, a short body, bytes that are not the pinned version) never is. `database is locked` is not a network failure.
 */
export const DOWNLOAD_ATTEMPTS = 3;
export const DOWNLOAD_RETRY_BASE_MS = 500;
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ENETDOWN', 'ENETRESET',
  'ENETUNREACH', 'EHOSTDOWN', 'EHOSTUNREACH', 'EAI_AGAIN', 'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_ABORTED']);
const TRANSIENT_NAMES = new Set(['AbortError', 'TimeoutError']);
/**
 * Whether a failure is a lost connection, worth one more try, rather than a settled answer. Node's fetch hides the
 * reason under `cause` (`fetch failed`, `terminated`), so the whole chain is walked for a network code or name.
 */
export function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof BoothSyncStopped) return false;
  const seen = new Set<unknown>();
  for (let node: unknown = error, depth = 0; node instanceof Error && depth < 8 && !seen.has(node); node = node.cause, depth++) {
    seen.add(node);
    const code = (node as NodeJS.ErrnoException).code;
    if (code && TRANSIENT_CODES.has(code)) return true;
    if (TRANSIENT_NAMES.has(node.name)) return true;
  }
  return false;
}
/** The errors under a failure, as text: a failed plan says whether the socket or the archive was at fault. */
export function errorCauseText(error: unknown): string {
  const parts: string[] = [], seen = new Set<unknown>();
  for (let node: unknown = error instanceof Error ? error.cause : undefined, depth = 0;
    node instanceof Error && depth < 5 && !seen.has(node); node = node.cause, depth++) {
    seen.add(node);
    const code = (node as NodeJS.ErrnoException).code;
    parts.push(`${node.name}: ${node.message}${code ? ` (${code})` : ''}`);
  }
  return parts.join(' ← ');
}

export function upsertBoothItem(db:DatabaseSync,item:BoothItemInput):void {
  if(!/^\d+$/.test(item.itemId))throw new Error('BOOTH 商品 ID 无效');
  db.prepare(`INSERT INTO booth_item(item_id,name,shop_name,item_url,category,owned,status,tags_json,images_json,metadata_json,remote_updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET name=excluded.name,shop_name=excluded.shop_name,
    item_url=excluded.item_url,category=excluded.category,owned=excluded.owned,status=excluded.status,tags_json=excluded.tags_json,
    images_json=excluded.images_json,metadata_json=excluded.metadata_json,remote_updated_at=excluded.remote_updated_at,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(item.itemId,item.name,item.shopName??'',item.itemUrl??`https://booth.pm/ja/items/${item.itemId}`,
      item.category??'',item.owned?1:0,item.status??'indexed',json(item.tags??[]),json(item.images??[]),json(item.metadata??{}),item.remoteUpdatedAt??null);
  if(item.listingDigest!==undefined)db.prepare('UPDATE booth_item SET listing_digest=? WHERE item_id=?').run(item.listingDigest,item.itemId);
}
export function upsertBoothFile(db:DatabaseSync,file:BoothFileInput):void {
  if(!/^\d+$/.test(file.downloadableId))throw new Error('BOOTH 下载项 ID 无效');
  // Two downloads of one item may share a file name; the second is told apart by its downloadable id.
  let filename=cleanFilename(file.filename);
  if(db.prepare('SELECT 1 FROM booth_file WHERE item_id=? AND filename=? AND downloadable_id<>?').get(file.itemId,filename,file.downloadableId)){
    const ext=extname(filename);filename=`${filename.slice(0,filename.length-ext.length)} (${file.downloadableId})${ext}`;}
  db.prepare(`INSERT INTO booth_file(downloadable_id,item_id,filename,byte_size,remote_version,status,probed_at,probe_outcome) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(downloadable_id) DO UPDATE SET item_id=excluded.item_id,filename=excluded.filename,byte_size=excluded.byte_size,
    remote_version=excluded.remote_version,status=excluded.status,probed_at=excluded.probed_at,probe_outcome=excluded.probe_outcome`).run(file.downloadableId,
      file.itemId,filename,file.byteSize??null,file.remoteVersion??'',file.status??'indexed',file.probedAt??null,file.probeOutcome??'');
}
/**
 * What BOOTH showed of a file just now. A probe that could not size it keeps the last known size and clue while the
 * file name is unchanged, and records the failure in probe_outcome.
 */
export function recordRemoteFile(db:DatabaseSync,file:{downloadableId:string;itemId:string},seen:RemoteClue,outcome:string):RemoteClue {
  const row=db.prepare('SELECT remote_version AS clue FROM booth_file WHERE downloadable_id=?').get(file.downloadableId) as {clue:string}|undefined;
  const known=parseClue(row?.clue);
  const clue=seen.size===undefined&&known?.size!==undefined&&known.name===seen.name?known:seen;
  upsertBoothFile(db,{downloadableId:file.downloadableId,itemId:file.itemId,filename:seen.name,byteSize:clue.size,remoteVersion:clueText(clue),
    status:'available',probedAt:now(),probeOutcome:outcome});
  return clue;
}
/** BOOTH no longer offers a downloadable (404, 410, no redirect, or gone from the library): its name, size and versions stay. */
export function markFileUnavailable(db:DatabaseSync,file:{downloadableId:string;itemId:string},outcome:string):void {
  if(db.prepare(`UPDATE booth_file SET status='unavailable',probed_at=?,probe_outcome=? WHERE downloadable_id=?`).run(now(),outcome,file.downloadableId).changes)return;
  upsertBoothFile(db,{downloadableId:file.downloadableId,itemId:file.itemId,filename:`${file.downloadableId}.bin`,status:'unavailable',probedAt:now(),probeOutcome:outcome});
}

/**
 * A plan names the files a project needs. A file may pin a version already in the pool by its sha256: then only those
 * bytes will do, even when BOOTH no longer offers the file. Without a pin, the version is chosen when the plan is
 * materialized, and pinned then.
 */
export function createSelectionPlan(db:DatabaseSync,input:{projectId:string;variantId?:string;workflowId?:string;rationale?:string;
  createdBy?:'provider'|'human';files:Array<{downloadableId:string;purpose:string;sha256?:string}>}):string {
  if(!input.files.length)throw new Error('文件选择计划不能为空');
  const id=randomUUID();db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare(`INSERT INTO asset_selection_plan(id,project_id,variant_id,workflow_id,status,rationale,created_by)
      VALUES(?,?,?,?,?,?,?)`).run(id,input.projectId,input.variantId??null,input.workflowId??null,'validated',input.rationale??'',input.createdBy??'provider');
    const insert=db.prepare(`INSERT INTO asset_selection_file(plan_id,downloadable_id,purpose) SELECT ?,?,?
      WHERE EXISTS(SELECT 1 FROM booth_file f JOIN booth_item i ON i.item_id=f.item_id
        WHERE f.downloadable_id=? AND f.status='available' AND i.owned=1 AND i.status='available')`);
    const insertPinned=db.prepare(`INSERT INTO asset_selection_file(plan_id,downloadable_id,purpose) SELECT ?,?,?
      WHERE EXISTS(SELECT 1 FROM booth_file_version v JOIN pool_blob b ON b.sha256=v.sha256 JOIN booth_file f ON f.downloadable_id=v.downloadable_id
        JOIN booth_item i ON i.item_id=f.item_id WHERE v.downloadable_id=? AND v.sha256=? AND b.status='ready' AND i.owned=1)`);
    for(const file of input.files){
      if(file.sha256===undefined){
        if(!insert.run(id,file.downloadableId,file.purpose,file.downloadableId).changes)throw new Error(`下载项不可用或未拥有: ${file.downloadableId}`);
        continue;
      }
      if(!/^[0-9a-f]{64}$/.test(file.sha256))throw new Error(`版本摘要应为 64 位小写十六进制: ${file.downloadableId}`);
      if(!insertPinned.run(id,file.downloadableId,file.purpose,file.downloadableId,file.sha256).changes)
        throw new Error(`素材池里没有下载项 ${file.downloadableId} 的这个版本（${file.sha256.slice(0,12)}），或商品未拥有`);
      db.prepare('INSERT INTO asset_selection_pin(plan_id,downloadable_id,sha256) VALUES(?,?,?)').run(id,file.downloadableId,file.sha256);
    }
    db.exec('COMMIT');return id;
  }catch(error){db.exec('ROLLBACK');throw error;}
}
/** A released plan no longer holds its versions: the pool may then remove them on request. Its pins stay as history. */
export function releaseSelectionPlan(db:DatabaseSync,planId:string):void {
  const plan=db.prepare('SELECT status FROM asset_selection_plan WHERE id=?').get(planId) as {status:string}|undefined;
  if(!plan)throw Object.assign(new Error(`选择计划不存在: ${planId}`),{code:'NOT_FOUND'});
  if(plan.status==='materializing')throw new Error('这个计划正在获取文件，结束后再释放');
  db.prepare(`UPDATE asset_selection_plan SET status='released',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(planId);
}

export interface MaterializeOptions extends RequestOptions { probeTimeoutMs?: number }
export interface MaterializedFile { downloadableId:string; path:string; sha256:string; fetched:boolean }
type PlanFile = { downloadableId:string; itemId:string; filename:string; pinned:string|null };

/** The plan uses these bytes: pin them (or confirm the pin), in one transaction with a last look that they are still here. */
function pinVersion(db:DatabaseSync,planId:string,downloadableId:string,sha256:string):void {
  const pin=db.prepare('SELECT sha256 FROM asset_selection_pin WHERE plan_id=? AND downloadable_id=?').get(planId,downloadableId) as {sha256:string}|undefined;
  if(pin&&pin.sha256!==sha256)throw new Error(`计划锁定的是另一个版本: ${downloadableId}`);
  if(pin)db.prepare('UPDATE asset_selection_pin SET materialized_at=? WHERE plan_id=? AND downloadable_id=?').run(now(),planId,downloadableId);
  else db.prepare('INSERT INTO asset_selection_pin(plan_id,downloadable_id,sha256,materialized_at) VALUES(?,?,?,?)').run(planId,downloadableId,sha256,now());
}
/** A version found intact is used by the plan, unless an explicit removal took its bytes in the meantime. */
function useCachedVersion(db:DatabaseSync,planId:string,downloadableId:string,sha256:string,confirmed:boolean):boolean {
  db.exec('BEGIN IMMEDIATE');
  try{
    const blob=db.prepare('SELECT status FROM pool_blob WHERE sha256=?').get(sha256) as {status:string}|undefined;
    if(blob?.status!=='ready'){db.exec('ROLLBACK');return false;}
    pinVersion(db,planId,downloadableId,sha256);
    if(confirmed)db.prepare(`UPDATE booth_file_version SET seen_at=? WHERE downloadable_id=? AND sha256=?`).run(now(),downloadableId,sha256);
    db.exec('COMMIT');return true;
  }catch(error){db.exec('ROLLBACK');throw error;}
}
/** BOOTH no longer offers a file: say so, and name a version the pool still holds, which a new plan can pin. */
function unavailable(db:DatabaseSync,file:PlanFile,outcome:string):Error {
  markFileUnavailable(db,file,outcome);
  const kept=db.prepare(`SELECT v.sha256 FROM booth_file_version v JOIN pool_blob b ON b.sha256=v.sha256 WHERE v.downloadable_id=? AND b.status='ready'
    ORDER BY v.fetched_at DESC LIMIT 1`).get(file.downloadableId) as {sha256:string}|undefined;
  return new Error(`BOOTH 已不提供这个文件（${file.filename}，下载项 ${file.downloadableId}，${outcome==='resolve:no-location'?'没有给出文件地址'
    :`返回 ${outcome.replace(/^resolve:http-/,'HTTP ')}`}）${kept?`；素材池里还有它的版本 ${kept.sha256.slice(0,12)}，新建计划时可以锁定这个版本`:''}`);
}
/**
 * Download a file into the pool and record it as a version of its downloadable (a new one, or the same bytes seen again
 * under a new clue). `accept` says whether the plan takes these bytes; the index learns the measured size either way.
 */
async function fetchVersion(db:DatabaseSync,root:string,request:BoothRequest,file:PlanFile,planId:string,
  accept:(sha256:string)=>boolean,known?:Extract<Resolved,{kind:'file'}>):Promise<{sha256:string;path:string;accepted:boolean}> {
  const resolve=async()=>{
    const resolved=await resolveDownloadable(request,file.downloadableId,status=>new Error(
      `BOOTH 下载项 ${file.downloadableId} 没有跳转到文件（HTTP ${status}），可能是会话失效，请重新连接`));
    if(resolved.kind==='unavailable')throw unavailable(db,file,resolved.outcome);
    return resolved;
  };
  let resolved=known??await resolve();
  let response=await request(resolved.location,{redirect:'follow'},true);
  // A signed address can expire while its size was probed; ask BOOTH for a fresh one once.
  if(known&&(response.status===401||response.status===403)){response.body?.cancel().catch(()=>{});resolved=await resolve();response=await request(resolved.location,{redirect:'follow'},true);}
  if(!response.ok||!response.body){response.body?.cancel().catch(()=>{});throw new Error(`BOOTH 下载失败: HTTP ${response.status}（${file.filename}）`);}
  // A lost session ends on a login page with 200; that page must never pass as the file.
  if(/^text\/html\b/i.test(response.headers.get('content-type')??'')){response.body.cancel().catch(()=>{});
    throw new Error(`BOOTH 返回了网页而不是文件，可能是会话失效，请重新连接: ${file.downloadableId}`);}
  const declared=response.headers.get('content-length');
  const received=await receive(root,response.body);
  if(declared&&/^\d+$/.test(declared)&&Number(declared)!==received.bytes){
    rmSync(received.partial,{force:true});
    throw new Error(`BOOTH 文件大小不符: ${file.downloadableId}（应为 ${declared} 字节，收到 ${received.bytes} 字节）`);
  }
  const clue:RemoteClue={name:resolved.name,size:received.bytes,...versionHeaders(response)};
  let accepted=false;
  const path=await storeReceived(db,root,received,resolved.name,'booth',()=>{
    db.prepare(`INSERT INTO booth_file_version(downloadable_id,sha256,filename,byte_size,remote_version) VALUES(?,?,?,?,?)
      ON CONFLICT(downloadable_id,sha256) DO UPDATE SET remote_version=excluded.remote_version,seen_at=excluded.seen_at`)
      .run(file.downloadableId,received.sha256,resolved.name,received.bytes,clueText(clue));
    // What was just measured is the best size the index can show.
    upsertBoothFile(db,{downloadableId:file.downloadableId,itemId:file.itemId,filename:resolved.name,byteSize:received.bytes,
      remoteVersion:clueText(clue),status:'available',probedAt:now(),probeOutcome:'fetched'});
    if(accept(received.sha256)){pinVersion(db,planId,file.downloadableId,received.sha256);accepted=true;}
  });
  return{sha256:received.sha256,path,accepted};
}
/**
 * One plan file. A pinned version is used when its bytes are here and intact, with no request to BOOTH; if they are
 * gone, only the same bytes from BOOTH can replace them. Without a pin, BOOTH is asked what it serves now, and a pool
 * version is reused only when its bytes still hash to its sha256 and its clue matches the current one (name, size,
 * ETag and Last-Modified where known). Otherwise the file is downloaded: a changed file becomes a new version, and
 * plans that pinned the old one keep it.
 */
async function materializeFile(db:DatabaseSync,root:string,request:BoothRequest,planId:string,file:PlanFile,
  options:MaterializeOptions):Promise<MaterializedFile> {
  if(file.pinned){
    const path=await verifyBlob(db,file.pinned);
    if(path&&useCachedVersion(db,planId,file.downloadableId,file.pinned,false))return{downloadableId:file.downloadableId,path,sha256:file.pinned,fetched:false};
    const pinned=file.pinned,fetched=await fetchVersion(db,root,request,file,planId,sha256=>sha256===pinned);
    if(!fetched.accepted)throw new Error(`计划锁定的版本 ${pinned.slice(0,12)}（${file.filename}）已不在本机，BOOTH 现在提供的也不是这个版本：`
      +'新文件已存为新版本，这个计划仍锁定原版本；要改用新版本，请新建计划');
    return{downloadableId:file.downloadableId,path:fetched.path,sha256:pinned,fetched:true};
  }
  const resolved=await resolveDownloadable(request,file.downloadableId,status=>new Error(
    `BOOTH 下载项 ${file.downloadableId} 没有跳转到文件（HTTP ${status}），可能是会话失效，请重新连接`));
  if(resolved.kind==='unavailable')throw unavailable(db,file,resolved.outcome);
  // Versions of this file in the pool whose recorded name is the one BOOTH serves now, newest first.
  const candidates=(db.prepare(`SELECT v.sha256,v.remote_version AS clue FROM booth_file_version v JOIN pool_blob b ON b.sha256=v.sha256
    WHERE v.downloadable_id=? AND b.status='ready' ORDER BY v.fetched_at DESC,v.sha256 DESC`).all(file.downloadableId) as Array<{sha256:string;clue:string}>)
    .map(row=>({sha256:row.sha256,clue:parseClue(row.clue)})).filter(row=>row.clue?.name===resolved.name);
  if(candidates.length){
    const probe=await probeFile(request,resolved.location,options.probeTimeoutMs);
    const current:RemoteClue={name:resolved.name,...(probe.size===undefined?{}:{size:probe.size}),
      ...(probe.etag?{etag:probe.etag}:{}),...(probe.lastModified?{lastModified:probe.lastModified}:{})};
    recordRemoteFile(db,file,current,probe.outcome);
    for(const candidate of candidates){
      if(!sameVersion(candidate.clue!,current))continue;
      const path=await verifyBlob(db,candidate.sha256);
      if(path&&useCachedVersion(db,planId,file.downloadableId,candidate.sha256,true))
        return{downloadableId:file.downloadableId,path,sha256:candidate.sha256,fetched:false};
    }
  }
  const fetched=await fetchVersion(db,root,request,file,planId,()=>true,resolved);
  return{downloadableId:file.downloadableId,path:fetched.path,sha256:fetched.sha256,fetched:true};
}

/**
 * One file's attempt. A lost connection drops the partial bytes that attempt left behind and tries the file again after
 * a growing pause, which also asks BOOTH for a fresh signed address; a settled failure is thrown at once.
 */
async function withTransientRetry<T>(run:()=>Promise<T>,sleep:(ms:number)=>Promise<unknown>):Promise<T> {
  for(let attempt=0;;attempt++){
    try{return await run();}
    catch(error){
      if(attempt+1>=DOWNLOAD_ATTEMPTS||!isTransientNetworkError(error))throw error;
      await sleep(DOWNLOAD_RETRY_BASE_MS*2**attempt);
    }
  }
}

/**
 * Bring the plan's files into the pool under `root`/pool and pin the version each uses. Requests to BOOTH are paced
 * like the index sync; the session goes to BOOTH hosts only, never to the file host. A transient network failure is
 * retried per file; the plan's error keeps the underlying cause, with links and credentials removed.
 */
export async function materializeSelection(db:DatabaseSync,planId:string,root:string,sessionCookie:string,
  options:MaterializeOptions={}):Promise<MaterializedFile[]> {
  const plan=db.prepare('SELECT status FROM asset_selection_plan WHERE id=?').get(planId) as {status:string}|undefined;
  if(plan?.status==='released')throw new Error('这个计划已释放，不能再获取；需要这些文件请新建计划');
  const files=db.prepare(`SELECT s.downloadable_id AS downloadableId,f.item_id AS itemId,f.filename,n.sha256 AS pinned
    FROM asset_selection_file s JOIN booth_file f ON f.downloadable_id=s.downloadable_id
    LEFT JOIN asset_selection_pin n ON n.plan_id=s.plan_id AND n.downloadable_id=s.downloadable_id
    WHERE s.plan_id=? AND s.selected=1 ORDER BY s.downloadable_id`).all(planId) as PlanFile[];
  if(!files.length)throw new Error('选择计划不存在或没有文件');
  dropStalePartials(root);
  db.prepare(`UPDATE asset_selection_plan SET status='materializing',error=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(planId);
  const request=politeFetch(sessionCookie,options,{requests:0},'fetch'),sleep=options.sleep??delay;
  const result:MaterializedFile[]=[];
  try{
    for(const file of files)result.push(await withTransientRetry(()=>materializeFile(db,root,request,planId,file,options),sleep));
    db.prepare(`UPDATE asset_selection_plan SET status='ready',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(planId);return result;
  }catch(error){
    const originalMessage=error instanceof Error?error.message:String(error),message=withoutUrls(originalMessage),causes=errorCauseText(error);
    const detail=causes?`${message}；底层原因: ${withoutUrls(causes)}`:message;
    db.prepare(`UPDATE asset_selection_plan SET status='failed',error=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(detail,planId);
    if(detail===originalMessage)throw error;
    throw error instanceof BoothSyncStopped?new BoothSyncStopped(detail):new Error(detail,{cause:error});
  }
}

/** How a file's current remote version relates to the pool: current (a matching version is here), cached (a version is here
 *  and nothing tells whether it is current), outdated (only other versions are here), none. */
export type CacheState = 'current'|'cached'|'outdated'|'none';
type VersionRow = { downloadableId:string; sha256:string; clue:string; path:string };
function readyVersions(db:DatabaseSync):Map<string,VersionRow[]> {
  const versions=new Map<string,VersionRow[]>();
  for(const row of db.prepare(`SELECT v.downloadable_id AS downloadableId,v.sha256,v.remote_version AS clue,b.path FROM booth_file_version v
    JOIN pool_blob b ON b.sha256=v.sha256 WHERE b.status='ready' ORDER BY v.fetched_at DESC,v.sha256 DESC`).all() as VersionRow[])
    versions.set(row.downloadableId,[...(versions.get(row.downloadableId)??[]),row]);
  return versions;
}
function cacheState(remote:string,versions:VersionRow[]):{state:CacheState;version?:VersionRow} {
  if(!versions.length)return{state:'none'};
  const current=parseClue(remote);
  const match=current&&versions.find(version=>{const clue=parseClue(version.clue);return clue&&sameVersion(clue,current);});
  if(match)return{state:'current',version:match};
  // Without a clue on either side nothing says the version is stale; materializing checks it against BOOTH anyway.
  const unknown=!current||current.size===undefined?versions[0]:versions.find(version=>!parseClue(version.clue));
  return unknown?{state:'cached',version:unknown}:{state:'outdated',version:versions[0]};
}
/** The index as the API shows it: items, their files, and each file's size, probe outcome and pool state. */
export function boothCatalog(db:DatabaseSync) {
  const versions=readyVersions(db);
  const files=new Map<string,Array<Record<string,unknown>>>();
  for(const row of db.prepare(`SELECT downloadable_id AS downloadableId,item_id AS itemId,filename,byte_size AS byteSize,remote_version AS remoteVersion,
    status,probed_at AS probedAt,probe_outcome AS probe FROM booth_file ORDER BY filename`).all() as Array<{downloadableId:string;itemId:string;remoteVersion:string}>){
    const own=versions.get(row.downloadableId)??[],{state,version}=cacheState(row.remoteVersion,own);
    const {itemId,...file}=row;
    files.set(itemId,[...(files.get(itemId)??[]),{...file,path:version?.path??null,sha256:version?.sha256??null,
      materialized:state==='current'||state==='cached',cache:state,versions:own.length}]);
  }
  return (db.prepare(`SELECT item_id AS itemId,name,shop_name AS shopName,item_url AS itemUrl,category,owned,status,tags_json AS tagsJson,
    images_json AS imagesJson,updated_at AS updatedAt FROM booth_item ORDER BY updated_at DESC,item_id DESC`).all() as Array<Record<string,unknown>>)
    .map(({tagsJson,imagesJson,...item})=>{const own=files.get(String(item.itemId))??[];
      return{...item,owned:Boolean(item.owned),tags:JSON.parse(String(tagsJson)),images:JSON.parse(String(imagesJson)),
        fileCount:own.length,materializedCount:own.filter(file=>file.materialized).length,files:own};});
}
/** booth.status counts; `materialized` counts files whose current version (or a version not known to be stale) is in the pool. */
export function boothCounts(db:DatabaseSync):{items:number;owned:number;files:number;materialized:number} {
  const counts=db.prepare(`SELECT count(*) AS items,coalesce(sum(owned),0) AS owned,(SELECT count(*) FROM booth_file) AS files FROM booth_item`).get() as
    {items:number;owned:number;files:number};
  const versions=readyVersions(db);let materialized=0;
  for(const file of db.prepare('SELECT downloadable_id AS id,remote_version AS remote FROM booth_file').all() as Array<{id:string;remote:string}>){
    const state=cacheState(file.remote,versions.get(file.id)??[]).state;if(state==='current'||state==='cached')materialized++;}
  return{...counts,materialized};
}
/** Plans of one project (or all), with how many of their files have their pinned version here. */
export function selectionPlans(db:DatabaseSync,projectId=''):unknown[] {
  return db.prepare(`SELECT p.id,p.project_id AS projectId,p.variant_id AS variantId,p.workflow_id AS workflowId,
    p.status,p.rationale,p.error,p.created_by AS createdBy,p.created_at AS createdAt,p.updated_at AS updatedAt,
    count(s.downloadable_id) AS fileCount,count(n.sha256) AS pinnedCount,
    count(CASE WHEN n.materialized_at IS NOT NULL AND b.status='ready' THEN 1 END) AS readyCount
    FROM asset_selection_plan p LEFT JOIN asset_selection_file s ON s.plan_id=p.id AND s.selected=1
    LEFT JOIN asset_selection_pin n ON n.plan_id=s.plan_id AND n.downloadable_id=s.downloadable_id
    LEFT JOIN pool_blob b ON b.sha256=n.sha256
    WHERE (?='' OR p.project_id=?) GROUP BY p.id ORDER BY p.created_at DESC`).all(projectId,projectId);
}
/**
 * The pinned versions a project's ready plans give a Workflow: the path of each version's bytes, and the files whose
 * pinned bytes are no longer here (they must be fetched again before a Workflow can read them).
 */
export function pinnedPlanFiles(db:DatabaseSync,projectId:string):{files:Array<{path:string;name:string|null;category:string|null}>;missing:string[]} {
  const rows=db.prepare(`SELECT b.sha256,b.path,b.status,f.filename,i.name,i.category FROM asset_selection_plan p
    JOIN asset_selection_file s ON s.plan_id=p.id AND s.selected=1
    JOIN asset_selection_pin n ON n.plan_id=s.plan_id AND n.downloadable_id=s.downloadable_id AND n.materialized_at IS NOT NULL
    JOIN pool_blob b ON b.sha256=n.sha256 JOIN booth_file f ON f.downloadable_id=s.downloadable_id LEFT JOIN booth_item i ON i.item_id=f.item_id
    WHERE p.project_id=? AND p.status='ready' ORDER BY p.created_at,s.downloadable_id`).all(projectId) as
    Array<{sha256:string;path:string;status:string;filename:string;name:string|null;category:string|null}>;
  const files:Array<{path:string;name:string|null;category:string|null}>=[],missing:string[]=[];
  for(const row of rows){
    if(row.status==='ready'&&existsSync(row.path)){if(!files.some(file=>file.path===row.path))files.push({path:row.path,name:row.name,category:row.category});}
    else missing.push(row.filename);
  }
  return{files,missing:[...new Set(missing)]};
}
