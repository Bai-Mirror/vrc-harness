import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, type Stats } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { hashedModes, ordinal, packTreeHash } from './pack-hash.ts';
import { sharingState } from './sharing/state.ts';
import { candidateReportDecision, projectCandidateReport, verifyCandidateReportTree } from './sharing/candidate-report.ts';
import { cancelPendingContributions } from './sharing/contribution-cleanup.ts';
import { MAX_QUEUE_DAYS, MAX_QUEUED_CONTRIBUTIONS } from './shared/sharing.ts';

export interface ContributionRow {id:string;candidateId:string;evaluationId:string;payloadHash:string;bundlePath:string;
  status:'authorized'|'exported'|'submitted'|'failed'|'cancelled';authorizedBy:string;consentText:string;receipt:Record<string,unknown>|null;
  error:string|null;submittedAt:string|null;createdAt:string;updatedAt:string}
function row(value:Record<string,unknown>):ContributionRow{return{id:String(value.id),candidateId:String(value.candidate_id),evaluationId:String(value.evaluation_id),
  payloadHash:String(value.payload_hash),bundlePath:String(value.bundle_path),status:value.status as ContributionRow['status'],authorizedBy:String(value.authorized_by),
  consentText:String(value.consent_text),receipt:value.receipt_json?JSON.parse(String(value.receipt_json)) as Record<string,unknown>:null,
  error:value.error as string|null,submittedAt:value.submitted_at as string|null,createdAt:String(value.created_at),updatedAt:String(value.updated_at)};}
export function contributionRows(db:DatabaseSync):ContributionRow[]{return(db.prepare('SELECT * FROM managed_pack_contribution ORDER BY created_at DESC').all() as Record<string,unknown>[]).map(row);}

/** Retains audit rows and local candidates, revoking only old/excess unsent report authorizations before cleanup. */
export function pruneContributionQueue(db:DatabaseSync,home?:string,at=new Date()):void{
  const cutoff=new Date(at.getTime()-MAX_QUEUE_DAYS*86400_000).toISOString();
  const pending=(db.prepare("SELECT * FROM managed_pack_contribution WHERE status IN ('authorized','exported','failed') ORDER BY created_at DESC,rowid DESC").all() as Record<string,unknown>[]).map(row);
  const fresh=pending.filter(item=>item.createdAt>=cutoff);
  const expired=pending.filter(item=>item.createdAt<cutoff).map(item=>item.id),excess=fresh.slice(MAX_QUEUED_CONTRIBUTIONS).map(item=>item.id);
  // Cancel both groups before any filesystem operation. Cleanup failure cannot leave the other group sendable.
  for(const [ids,reason]of [[expired,'unsent-report-expired'],[excess,'unsent-report-capacity']] as const)for(const id of ids){
    db.prepare("UPDATE managed_pack_contribution SET status='cancelled',error='授权已撤销，待清理本地载荷',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status IN ('authorized','exported','failed')").run(id);
    db.prepare("INSERT INTO event(actor,entity_type,entity_id,action,reason) VALUES('runtime','contribution',?,'contribution_queue_pruned',?)").run(id,reason);
  }
  const cleanup=contributionRows(db).filter(item=>item.status==='cancelled'&&item.error).map(item=>item.id);
  cancelPendingContributions(db,home,{ids:cleanup,reason:'retry-pruned-cleanup'});
}

/** Explicit authorization creates a whitelist-projected observation report; it never copies a candidate pack. */
export function authorizeContribution(db:DatabaseSync,home:string,candidateId:string,authorizedBy:string,consentText:string):ContributionRow{
  if(!authorizedBy.trim()||!consentText.trim())throw new Error('contribution requires explicit actor and consent text');
  if(!sharingState(db).active)throw new Error('请先查看当前数据说明并开启回传；本地制作不受影响');
  pruneContributionQueue(db,home);
  const decision=candidateReportDecision(db,candidateId);if(!decision.eligible||!decision.evaluationId)
    throw new Error(`candidate is not eligible for contribution: ${decision.reasons.join('; ')}`);
  const existing=db.prepare('SELECT * FROM managed_pack_contribution WHERE candidate_id=? AND evaluation_id=?').get(candidateId,decision.evaluationId) as Record<string,unknown>|undefined;
  if(existing&&existing.status!=='cancelled')return row(existing);
  if(existing?.error)throw new Error('旧载荷清理未完成，请先重试停止并撤回');
  const id=existing?String(existing.id):randomUUID(),revision=randomUUID(),parent=join(home,'contributions'),target=join(parent,id),temporary=`${target}.next`;
  mkdirSync(parent,{recursive:true,mode:0o700});if(existsSync(target)||existsSync(temporary))throw new Error('contribution bundle path already exists');
  mkdirSync(join(temporary,'pack'),{recursive:true,mode:0o700});
  writeFileSync(join(temporary,'pack/candidate-report.json'),JSON.stringify(projectCandidateReport(db,candidateId,decision.evaluationId)),{mode:0o600});
  verifyCandidateReportTree(join(temporary,'pack'));const contentHash=packTreeHash(join(temporary,'pack')).hash;
  const manifest={schema:'harness-contribution/0.1',purpose:'product-improvement',category:'candidate-evaluation',projection:'structured-observation/0.1',
    candidate:{id,contentHash},authorization:{explicit:true,revision}};
  const bytes=`${JSON.stringify(manifest,null,2)}\n`,payloadHash=createHash('sha256').update(bytes).update(contentHash).digest('hex');
  writeFileSync(join(temporary,'contribution.json'),bytes,{mode:0o600});renameSync(temporary,target);
  if(existing)db.prepare(`UPDATE managed_pack_contribution SET status='authorized',payload_hash=?,bundle_path=?,authorized_by=?,consent_text=?,receipt_json=NULL,
    submitted_at=NULL,error=NULL,created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='cancelled'`)
    .run(payloadHash,target,authorizedBy.trim(),consentText.trim(),id);
  else db.prepare(`INSERT INTO managed_pack_contribution(id,candidate_id,evaluation_id,payload_hash,bundle_path,authorized_by,consent_text)
    VALUES(?,?,?,?,?,?,?)`).run(id,candidateId,decision.evaluationId,payloadHash,target,authorizedBy.trim(),consentText.trim());
  db.prepare("INSERT INTO event(actor,entity_type,entity_id,action,reason) VALUES('human','contribution',?,'contribution_authorized',?)")
    .run(id,JSON.stringify({revision,payloadHash,previousPayloadHash:existing?.payload_hash??null,scope:'structured-candidate-observation'}));
  pruneContributionQueue(db,home);
  return contributionRows(db).find(item=>item.id===id)!;
}

/** The same projection and immutable-byte check precedes every outward handoff, including legacy rows. */
function verifyReportBundle(current:ContributionRow):void{
  if(!existsSync(current.bundlePath)||lstatSync(current.bundlePath).isSymbolicLink()||!lstatSync(current.bundlePath).isDirectory())throw new Error('contribution bundle is incomplete');
  const manifestPath=join(current.bundlePath,'contribution.json');
  if(!existsSync(manifestPath)||lstatSync(manifestPath).isSymbolicLink()||!lstatSync(manifestPath).isFile()||lstatSync(manifestPath).size>64*1024)throw new Error('contribution manifest is invalid');
    const manifestBytes=readFileSync(join(current.bundlePath,'contribution.json'));
    const manifest=JSON.parse(manifestBytes.toString('utf8')) as {schema?:unknown;purpose?:unknown;category?:unknown;projection?:unknown;candidate?:{id?:unknown;contentHash?:unknown};authorization?:{explicit?:unknown;revision?:unknown}};
    const contentHash=String(manifest.candidate?.contentHash??'');
    if(manifest.schema!=='harness-contribution/0.1'||manifest.purpose!=='product-improvement'||manifest.category!=='candidate-evaluation'||manifest.projection!=='structured-observation/0.1'||
      manifest.authorization?.explicit!==true||typeof manifest.authorization.revision!=='string'||! /^[a-f0-9-]{36}$/.test(manifest.authorization.revision)||Object.keys(manifest).sort().join(',')!=='authorization,candidate,category,projection,purpose,schema'||
      Object.keys(manifest.candidate??{}).sort().join(',')!=='contentHash,id'||Object.keys(manifest.authorization??{}).sort().join(',')!=='explicit,revision')throw new Error('旧载荷未通过当前内容与用途投影，请撤回后重新授权技术报告');
    verifyCandidateReportTree(join(current.bundlePath,'pack'));
    if(readdirSync(current.bundlePath).sort().join(',')!=='contribution.json,pack')throw new Error('贡献载荷含报告之外的文件');
    if(manifest.candidate?.id!==current.id||packTreeHash(join(current.bundlePath,'pack')).hash!==contentHash||
      createHash('sha256').update(manifestBytes).update(contentHash).digest('hex')!==current.payloadHash)
      throw new Error('contribution bundle changed after authorization');
}
export function verifyContributionReady(db:DatabaseSync,id:string,home?:string):ContributionRow{
  pruneContributionQueue(db,home);
  const current=contributionRows(db).find(item=>item.id===id);if(!current)throw new Error('contribution not found');
  if(current.status==='submitted')return current;
  if(!['authorized','exported','failed'].includes(current.status))throw new Error('contribution is not submit-ready');
  if(!sharingState(db).active)throw new Error('回传已关闭或正在撤回，旧授权不能发送');
  verifyReportBundle(current);return current;
}

/** Marks a bundle handed to an external uploader. This is not a claim that a server accepted or released it. */
export function markContributionExported(db:DatabaseSync,id:string,home?:string):ContributionRow{
  pruneContributionQueue(db,home);
  const current=db.prepare('SELECT * FROM managed_pack_contribution WHERE id=?').get(id) as Record<string,unknown>|undefined;
  if(!current)throw new Error('contribution not found');const item=row(current);
  if(!sharingState(db).active)throw new Error('回传已关闭或正在撤回，旧授权不能导出');
  verifyReportBundle(item);
  if(item.status==='exported')return item;if(item.status!=='authorized')throw new Error('only an authorized contribution can be exported');
  if(!existsSync(join(item.bundlePath,'contribution.json'))||!existsSync(join(item.bundlePath,'pack')))throw new Error('contribution bundle is incomplete');
  db.prepare(`UPDATE managed_pack_contribution SET status='exported',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id);
  return contributionRows(db).find(value=>value.id===id)!;
}

const MAX_UPLOAD_BYTES=64*1024*1024;
/** Every file, and every directory with its mode: the pack hash covers directory modes, and empty directories too. */
function uploadEntries(root:string):{files:Array<{path:string;mode:number;bytes:string}>;directories:Array<{path:string;mode:number}>}{
  const files:Array<{path:string;mode:number;bytes:string}>=[],directories:Array<{path:string;mode:number}>=[];let total=0;
  // The pack's modes as its content hash has them (Windows stores none of its own); the bundle's other files as they are.
  const packMode=hashedModes(join(root,'pack')),modeOf=(name:string,info:Stats):number=>name.startsWith('pack/')?packMode(name.slice(5),info):info.mode&0o777;
  const walk=(directory:string):void=>{for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>ordinal(a.name,b.name))){
    const path=join(directory,entry.name),info=lstatSync(path),name=relative(root,path).split('\\').join('/');
    if(info.isSymbolicLink()||(!entry.isDirectory()&&!entry.isFile()))throw new Error('contribution contains unsupported filesystem entry');
    if(entry.isDirectory()){if(name.startsWith('pack/'))directories.push({path:name,mode:modeOf(name,info)});walk(path);continue;}
    total+=info.size;if(total>MAX_UPLOAD_BYTES)throw new Error('contribution exceeds 64 MiB upstream limit');
    files.push({path:name,mode:modeOf(name,info),bytes:readFileSync(path).toString('base64')});
  }};walk(root);return{files,directories};
}
export interface ContributionReceipt {schema:'harness-contribution-receipt/0.1';candidateId:string;payloadHash:string;status:'accepted';receiptId:string}
export interface ContributionUpstream {endpoint:string;token?:string;username?:string;home?:string}
/**
 * Uploads an explicitly authorized structured report. A receipt records observation reception and never promotes
 * a local candidate. Optional installation credentials bind ownership; the report purpose does not include names.
 */
export async function submitContribution(db:DatabaseSync,id:string,upstream:ContributionUpstream,fetcher:typeof fetch=fetch):Promise<ContributionRow>{
  pruneContributionQueue(db,upstream.home);
  const current=contributionRows(db).find(item=>item.id===id);if(!current)throw new Error('contribution not found');
  if(current.status==='submitted')return current;if(!['authorized','exported','failed'].includes(current.status))throw new Error('contribution is not submit-ready');
  if(!sharingState(db).active)throw new Error('回传已关闭或正在撤回，旧授权不能发送');
  try{
    verifyReportBundle(current);
    const token=upstream.token?.trim();
    const response=await fetcher(upstream.endpoint,{method:'POST',headers:{...(token?{authorization:`Bearer ${token}`}:{}),'content-type':'application/json'},
      body:JSON.stringify({schema:'harness-contribution-upload/0.1',payloadHash:current.payloadHash,username:'',
        ...uploadEntries(current.bundlePath)})});
    if(!response.ok)throw new Error(`upstream returned HTTP ${response.status}`);
    const receipt=await response.json() as ContributionReceipt;
    if(receipt.schema!=='harness-contribution-receipt/0.1'||receipt.status!=='accepted'||receipt.candidateId!==current.id||receipt.payloadHash!==current.payloadHash||!receipt.receiptId)
      throw new Error('upstream receipt does not match contribution');
    const settled=db.prepare(`UPDATE managed_pack_contribution SET status='submitted',receipt_json=?,submitted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),error=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND payload_hash=? AND status IN ('authorized','exported','failed')`).run(JSON.stringify(receipt),id,current.payloadHash);
    if(!Number(settled.changes))throw new Error('发送期间该授权已撤销；本机保持取消，可通过设置请求远端撤回');
  }catch(error){db.prepare(`UPDATE managed_pack_contribution SET status='failed',error=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND payload_hash=? AND status IN ('authorized','exported','failed')`)
    .run(String((error as Error).message).slice(0,2000),id,current.payloadHash);throw error;}
  return contributionRows(db).find(item=>item.id===id)!;
}
