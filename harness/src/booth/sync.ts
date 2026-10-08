import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { parse } from 'node-html-parser';
import { markFileUnavailable, recordRemoteFile, upsertBoothItem, withoutUrls } from './catalog.ts';
import { BoothSyncStopped, parseClue, politeFetch, probeFile, resolveDownloadable, type BoothRequest, type RequestOptions } from './remote.ts';

export { BOOTH_REQUEST_INTERVAL_MS, BoothSyncStopped } from './remote.ts';
const MAX_PAGES=200;
const ITEM_RE=/\/items\/(\d+)/;
const DOWNLOAD_RE=/\/downloadables\/(\d+)/;
export interface LibraryEntry { itemId:string; name:string; downloadableIds:string[]; gift:boolean }
/**
 * quick (the default): read the library listing, then read an item's JSON only when its listing entry changed (or was
 * never read), and resolve and probe only new files and files whose size, clue or availability is not known.
 * deep: read every item's JSON and resolve and probe every file again.
 */
export type SyncMode = 'quick'|'deep';
/**
 * truncated: the library has more than MAX_PAGES pages, so ownership was left unchanged. probes counts the files probed
 * this sync by what the probe saw (remote.ts Probe.outcome; `resolve:http-404` and the like for files BOOTH no longer
 * offers). unknownSizes counts the files probed this sync whose size is still unknown.
 */
export interface SyncResult { mode:SyncMode;items:number;files:number;pages:number;itemsRead:number;itemsUnchanged:number;unavailableItems:number;
  filesProbed:number;filesUnchanged:number;newFiles:number;unavailableFiles:number;unknownSizes:number;probes:Record<string,number>;
  requests:number;truncated:boolean }
export interface SyncProgress { phase:'library'|'items';mode:SyncMode;pages:number;items:number;itemsTotal:number;requests:number }
export interface SyncOptions extends RequestOptions { mode?:SyncMode;probeTimeoutMs?:number;onProgress?:(progress:SyncProgress)=>void }

function target(node:{getAttribute(name:string):string|undefined}):string{return node.getAttribute('href')??node.getAttribute('data-href')??'';}
export function parseLibraryPage(html:string,gift=false):{entries:LibraryEntry[];lastPage:number}{
  const root=parse(html),downloads=root.querySelectorAll('a[href*="/downloadables/"], [data-href*="/downloadables/"]');
  const entries=new Map<string,LibraryEntry>();
  for(const download of downloads){
    let block=download.parentNode;let links:ReturnType<typeof root.querySelectorAll>=[];
    for(let i=0;i<12&&block;i++,block=block.parentNode){links=block.querySelectorAll('a[href*="/items/"]');if(links.length)break;}
    const itemLink=links.find(link=>ITEM_RE.test(target(link)));if(!itemLink||!block)continue;
    const itemId=ITEM_RE.exec(target(itemLink))?.[1];if(!itemId)continue;
    const downloadableIds=block.querySelectorAll('a[href*="/downloadables/"], [data-href*="/downloadables/"]')
      .map(link=>DOWNLOAD_RE.exec(target(link))?.[1]).filter((value):value is string=>Boolean(value));
    const names=links.map(link=>link.innerText.trim()).filter(Boolean).sort((a,b)=>b.length-a.length);
    const current=entries.get(itemId)??{itemId,name:names[0]??`item-${itemId}`,downloadableIds:[],gift};
    for(const id of downloadableIds)if(!current.downloadableIds.includes(id))current.downloadableIds.push(id);entries.set(itemId,current);
  }
  if(!entries.size&&html.includes('/downloadables/'))throw new Error('BOOTH 页面包含下载项但无法解析，页面结构可能已变化');
  // The real last page, even beyond what a sync reads: the caller must know when a listing is incomplete.
  let lastPage=1;for(const link of root.querySelectorAll('a[href*="page="]')){const raw=/[?&]page=(\d+)/.exec(target(link))?.[1];if(raw&&Number.isSafeInteger(Number(raw)))lastPage=Math.max(lastPage,Number(raw));}
  return{entries:[...entries.values()],lastPage};
}

function itemMetadata(itemId:string,payload:unknown,fallback:string):Parameters<typeof upsertBoothItem>[1]{
  const value=payload&&typeof payload==='object'?payload as Record<string,unknown>:{};
  const shop=value.shop&&typeof value.shop==='object'?value.shop as Record<string,unknown>:{};
  const category=value.category&&typeof value.category==='object'?value.category as Record<string,unknown>:{};
  const strings=(input:unknown):string[]=>Array.isArray(input)?input.map(entry=>typeof entry==='string'?entry:
    entry&&typeof entry==='object'&&typeof (entry as Record<string,unknown>).name==='string'?String((entry as Record<string,unknown>).name):'').filter(Boolean):[];
  const images=Array.isArray(value.images)?value.images.map(entry=>typeof entry==='string'?entry:
    entry&&typeof entry==='object'&&typeof (entry as Record<string,unknown>).original==='string'?String((entry as Record<string,unknown>).original):'').filter(Boolean):[];
  return{itemId,name:typeof value.name==='string'?value.name:fallback,shopName:typeof shop.name==='string'?shop.name:'',
    itemUrl:typeof value.url==='string'?value.url:`https://booth.pm/ja/items/${itemId}`,category:typeof category.name==='string'?category.name:'',
    owned:true,status:'available',tags:strings(value.tags),images,metadata:value};
}
/** What a listing entry says, as a digest: a quick sync reads the item's JSON again only when it changes. */
function listingDigest(entry:LibraryEntry):string{
  return createHash('sha256').update(JSON.stringify({name:entry.name,gift:entry.gift,files:[...entry.downloadableIds].sort()})).digest('hex');
}
async function libraryPath(path:string,request:BoothRequest,progress:SyncProgress,report:()=>void):Promise<{entries:LibraryEntry[];pages:number;truncated:boolean}>{
  const merged=new Map<string,LibraryEntry>();let page=1,lastPage=1,pages=0;
  do{
    const response=await request(`https://accounts.booth.pm/${path}?page=${page}`,{redirect:'manual'});
    pages++;progress.pages++;report();
    if(response.status>=300&&response.status<400)throw new BoothSyncStopped('BOOTH 会话已失效，请重新连接');
    if(!response.ok)throw new BoothSyncStopped(`BOOTH 素材库读取失败: HTTP ${response.status}`);
    const parsed=parseLibraryPage(await response.text(),path.endsWith('/gifts'));lastPage=Math.max(lastPage,parsed.lastPage);
    for(const entry of parsed.entries){const current=merged.get(entry.itemId)??entry;for(const id of entry.downloadableIds)if(!current.downloadableIds.includes(id))current.downloadableIds.push(id);merged.set(entry.itemId,current);}
    if(page===1&&lastPage===1&&parsed.entries.length>0)lastPage=2;else if(page>1&&parsed.entries.length===0)break;
    page++;
  }while(page<=lastPage&&page<=MAX_PAGES);
  return{entries:[...merged.values()],pages,truncated:lastPage>MAX_PAGES};
}

/**
 * Metadata only, never file bodies. Ownership changes only after the whole library listing was read; an empty listing
 * while the index still has owned items is treated as a lost session rather than as "nothing is owned any more".
 */
export async function syncBoothLibrary(db:DatabaseSync,session:string,options:SyncOptions={}):Promise<SyncResult>{
  try{return await sync(db,session,options);}
  catch(error){const message=withoutUrls((error as Error).message);
    if(message===(error as Error).message)throw error;
    throw error instanceof BoothSyncStopped?new BoothSyncStopped(message):new Error(message);}
}
async function sync(db:DatabaseSync,session:string,options:SyncOptions):Promise<SyncResult>{
  const mode=options.mode??'quick';
  const progress:SyncProgress={phase:'library',mode,pages:0,items:0,itemsTotal:0,requests:0};
  const report=()=>options.onProgress?.({...progress}),request=politeFetch(session,options,progress);
  // Purchases, then gifts: never two BOOTH crawls at once.
  const purchases=await libraryPath('library',request,progress,report),gifts=await libraryPath('library/gifts',request,progress,report);
  const entries=new Map<string,LibraryEntry>();for(const entry of [...purchases.entries,...gifts.entries]){const current=entries.get(entry.itemId)??entry;
    for(const id of entry.downloadableIds)if(!current.downloadableIds.includes(id))current.downloadableIds.push(id);entries.set(entry.itemId,current);}
  const truncated=purchases.truncated||gifts.truncated;
  const owned=(db.prepare('SELECT count(*) AS n FROM booth_item WHERE owned=1').get() as {n:number}).n;
  if(!entries.size&&owned>0)throw new BoothSyncStopped(`BOOTH 素材库返回为空，而本地索引里有 ${owned} 个已拥有的商品：可能是会话失效或页面结构变化。本地索引未改动，请重新连接后再同步。`);
  // An incomplete listing proves nothing about the items it did not reach.
  if(!truncated){
    db.exec('BEGIN IMMEDIATE');
    try{db.prepare(`UPDATE booth_item SET owned=0,status='indexed',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE owned=1 AND item_id NOT IN (SELECT value FROM json_each(?))`).run(JSON.stringify([...entries.keys()]));db.exec('COMMIT');}
    catch(error){db.exec('ROLLBACK');throw error;}
  }
  progress.phase='items';progress.itemsTotal=entries.size;report();
  const result:SyncResult={mode,items:entries.size,files:0,pages:purchases.pages+gifts.pages,itemsRead:0,itemsUnchanged:0,unavailableItems:0,
    filesProbed:0,filesUnchanged:0,newFiles:0,unavailableFiles:0,unknownSizes:0,probes:{},requests:0,truncated};
  const count=(outcome:string)=>{result.probes[outcome]=(result.probes[outcome]??0)+1;};
  for(const entry of entries.values()){
    const digest=listingDigest(entry);
    const known=db.prepare(`SELECT owned,status,metadata_json AS metadata,listing_digest AS digest FROM booth_item WHERE item_id=?`).get(entry.itemId) as
      {owned:number;status:string;metadata:string;digest:string}|undefined;
    if(mode==='deep'||!known||!known.owned||known.status!=='available'||known.metadata==='{}'||known.digest!==digest){
      result.itemsRead++;
      const itemResponse=await request(`https://booth.pm/ja/items/${entry.itemId}.json`,{redirect:'follow'});
      if(itemResponse.ok){let payload:unknown;try{payload=await itemResponse.json();}catch{payload={};}
        upsertBoothItem(db,{...itemMetadata(entry.itemId,payload,entry.name),listingDigest:digest});}
      else{
        // Unreadable now: keep what the index knew, and leave the digest so that the next sync tries again.
        result.unavailableItems++;itemResponse.body?.cancel().catch(()=>{});
        if(known)db.prepare(`UPDATE booth_item SET owned=1,status='available',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id=?`).run(entry.itemId);
        else upsertBoothItem(db,{itemId:entry.itemId,name:entry.name,owned:true,status:'available'});
      }
    }else result.itemsUnchanged++;
    for(const downloadableId of entry.downloadableIds){
      result.files++;
      const file=db.prepare(`SELECT item_id AS itemId,byte_size AS size,remote_version AS clue,status FROM booth_file WHERE downloadable_id=?`)
        .get(downloadableId) as {itemId:string;size:number|null;clue:string;status:string}|undefined;
      if(mode==='quick'&&file&&file.itemId===entry.itemId&&file.status==='available'&&file.size!==null&&parseClue(file.clue)){result.filesUnchanged++;continue;}
      if(!file)result.newFiles++;
      result.filesProbed++;
      const ref={downloadableId,itemId:entry.itemId};
      const resolved=await resolveDownloadable(request,downloadableId,status=>new BoothSyncStopped(
        `BOOTH 下载项 ${downloadableId} 没有跳转到文件（HTTP ${status}），可能是会话失效或页面结构变化；已停止同步。`));
      if(resolved.kind==='unavailable'){markFileUnavailable(db,ref,resolved.outcome);result.unavailableFiles++;count(resolved.outcome);continue;}
      const probe=await probeFile(request,resolved.location,options.probeTimeoutMs);
      count(probe.outcome);
      const clue=recordRemoteFile(db,ref,{name:resolved.name,...(probe.size===undefined?{}:{size:probe.size}),
        ...(probe.etag?{etag:probe.etag}:{}),...(probe.lastModified?{lastModified:probe.lastModified}:{})},probe.outcome);
      if(clue.size===undefined)result.unknownSizes++;
    }
    // A file of a listed item that the listing no longer shows is no longer offered; its name and versions stay.
    if(!truncated)result.unavailableFiles+=db.prepare(`UPDATE booth_file SET status='unavailable',probe_outcome='unlisted',probed_at=?
      WHERE item_id=? AND status<>'unavailable' AND downloadable_id NOT IN (SELECT value FROM json_each(?))`)
      .run(new Date().toISOString(),entry.itemId,JSON.stringify(entry.downloadableIds)).changes as number;
    progress.items++;report();
  }
  result.requests=progress.requests;
  return result;
}

/** What a sync did, for people: the counts, and why sizes stayed unknown. */
export function syncMessage(result:SyncResult):string{
  const failed=Object.entries(result.probes).filter(([outcome])=>!/(^| )(head|range):ok$/.test(outcome)&&!outcome.startsWith('resolve:'))
    .sort((a,b)=>b[1]-a[1]).map(([outcome,n])=>`${outcome} ×${n}`);
  return [`${result.mode==='deep'?'深度':'快速'}同步完成：${result.items} 个商品、${result.files} 个文件`,
    `读取了 ${result.itemsRead} 个商品的详情（${result.itemsUnchanged} 个未变化），探测了 ${result.filesProbed} 个文件（新文件 ${result.newFiles} 个，跳过 ${result.filesUnchanged} 个已知文件）`,
    ...(result.unavailableFiles?[`${result.unavailableFiles} 个文件 BOOTH 已不再提供（名称与已取回的版本保留）`]:[]),
    ...(result.unknownSizes?[`${result.unknownSizes} 个大小未知${failed.length?`（${failed.join('，')}）`:''}`]:[]),
    `共 ${result.requests} 次请求`,
    ...(result.truncated?['素材库超过 200 页，只读了前 200 页，其余商品的拥有状态没有改动']:[])].join('；');
}
