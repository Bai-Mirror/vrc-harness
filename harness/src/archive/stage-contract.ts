import type {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {existsSync,lstatSync} from 'node:fs';
import {relativeInside} from './scan.ts';
import {projectRoot} from './takeover.ts';
import {packAt,packOfToolRoot,samePack,frozenContent,type PackIdentity} from './packs.ts';
import {managedPacks} from '../managed-pack.ts';
import {inputSha256} from '../workflow/inputs.ts';
import {sha256File} from '../file-hash.ts';
import {workflowSnapshot,type WorkflowSnapshot} from '../workflow/runtime.ts';

type Asset=NonNullable<WorkflowSnapshot['manifest']>['assets'][number]&{location?:'project'|'external'};
export interface ArchivedStageContract {seq:number;workflowId:string;stageId:string;at:string;payload:string;sha256:string;pack:Omit<PackIdentity,'root'>|null}
/** A selected contract is required Run input, even when optional process history is excluded. */
export function archiveStageContracts(db:DatabaseSync,projectId:string,portable:(value:string)=>string):ArchivedStageContract[] {
  const rows=db.prepare(`SELECT e.seq,e.workflow_id,e.entity_id,e.occurred_at,e.payload_json FROM event e JOIN workflow w ON w.id=e.workflow_id
    WHERE w.project_id=? AND e.actor='human' AND e.entity_type='stage_contract' AND e.action='selected' ORDER BY e.seq`).all(projectId);
  if(!rows.length)return [];
  const root=projectRoot(db,projectId);
  return rows.map(row=>{
    const original=JSON.parse(String(row.payload_json)),snapshot=original.selection.snapshot as WorkflowSnapshot;
    const pack=packOfToolRoot(snapshot.toolRoot),identity=pack?{id:pack.id,version:pack.version,channel:pack.channel,contentHash:pack.contentHash}:null;
    const manifest=snapshot.manifest?structuredClone(snapshot.manifest):undefined;
    if(manifest) {
      const relocated=new Map<string,string>();
      manifest.assets=manifest.assets.map(asset=>{const path=relativeInside(root,asset.item);relocated.set(asset.item,path??asset.item);
        return {...asset,item:path??asset.item,location:path!==undefined?'project':'external'};});
      for(const variant of manifest.variants??[])for(const asset of variant.assets)asset.item=relocated.get(asset.item)??asset.item;
    }
    // Customer wording follows the existing C-layer Manifest, not the required executable selection record.
    const portableManifest=manifest?{...manifest,request:undefined,faceConcept:undefined}:undefined;
    const payload=portable(JSON.stringify({...original,selection:{...original.selection,snapshot:{...snapshot,manifest:portableManifest,toolRoot:'',
      variables:Object.fromEntries(Object.keys(snapshot.variables).map(name=>[name,''])),
      contexts:Object.fromEntries(Object.entries(snapshot.contexts).map(([path,value])=>[path,{sha256:value.sha256,content:''}]))}}}));
    return {seq:Number(row.seq),workflowId:String(row.workflow_id),stageId:String(row.entity_id),at:String(row.occurred_at),payload,sha256:inputSha256(payload),pack:identity};
  });
}
/** Resolve only the exact selected pack and verified project members; absence is an explicit input problem. */
export function restoreStageContracts(db:DatabaseSync,projectId:string,root:string,home:string,contracts:ArchivedStageContract[],
  id:(old:string)=>string,variable:(name:string)=>string|undefined):{sequences:Map<number,number>;missing:string[]} {
  const sequences=new Map<number,number>(),missing:string[]=[];
  for(const contract of contracts) {
    try {
      if(inputSha256(contract.payload)!==contract.sha256)throw new Error('digest');
      const payload=JSON.parse(contract.payload),snapshot=payload.selection.snapshot as WorkflowSnapshot,workflowId=id(contract.workflowId);
      if(snapshot.workflowId!==contract.workflowId || !Array.isArray(payload.selection.deployment) ||
        !db.prepare('SELECT 1 FROM workflow_definition d JOIN workflow w ON w.id=d.workflow_id WHERE w.id=? AND w.project_id=?').get(workflowId,projectId))throw new Error('workflow');
      const pack=contract.pack?managedPacks(home).map(value=>packAt(value.root)).find(value=>value&&value.channel===contract.pack!.channel&&samePack(value,contract.pack!)):undefined;
      if(!pack)throw new Error('pack');
      const content=frozenContent(pack.root,snapshot.tools,Object.fromEntries(Object.entries(snapshot.contexts).map(([path,value])=>[path,value.sha256])));
      if(!content.ok)throw new Error('content');
      const relocated=new Map<string,string>();
      if(snapshot.manifest) {
        snapshot.manifest.request=workflowSnapshot(db,workflowId).manifest?.request??'（原始需求没有随分享提供：以已批准的方案和已确认的决定为准）';
        snapshot.manifest.assets=snapshot.manifest.assets.map((entry:Asset)=>{
          const {location,...asset}=entry;
          if(location!=='project')return asset;
          const target=join(root,asset.item);
          if(relativeInside(root,target)!==asset.item || !asset.sha256 || !existsSync(target) || lstatSync(target).isSymbolicLink() ||
            !lstatSync(target).isFile() || sha256File(target)!==asset.sha256)throw new Error('asset');
          relocated.set(asset.item,target);return {...asset,item:target};
        });
        for(const variant of snapshot.manifest.variants??[])for(const asset of variant.assets)asset.item=relocated.get(asset.item)??asset.item;
      }
      snapshot.workflowId=workflowId;snapshot.toolRoot=join(pack.root,'tools');snapshot.contexts=content.contexts;
      snapshot.variables=Object.fromEntries(Object.keys(snapshot.variables).flatMap(name=>{const value=variable(name);return value?[[name,value]]:[];}));
      // Reimporting the same archive must not duplicate a human decision or alter its existing local binding.
      const existing=db.prepare(`SELECT seq FROM event WHERE workflow_id=? AND actor='human' AND entity_type='stage_contract' AND action='selected' AND json_extract(payload_json,'$.archiveSelection.seq')=? AND json_extract(payload_json,'$.archiveSelection.sha256')=? ORDER BY seq DESC LIMIT 1`).get(workflowId,contract.seq,contract.sha256);
      payload.archiveSelection={seq:contract.seq,sha256:contract.sha256};
      const seq=existing?.seq??db.prepare(`INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason,payload_json,occurred_at)
        VALUES(?,'human','stage_contract',?,'selected','恢复已采用阶段工具及其冻结输入',?,?) RETURNING seq`).get(workflowId,contract.stageId,JSON.stringify(payload),contract.at)!.seq;
      sequences.set(contract.seq,Number(seq));
    }catch {missing.push(`stage-contract-input:${contract.workflowId}:${contract.seq}`);}
  }
  preserveArchivedSelectionOrder(db,contracts,sequences);
  return {sequences,missing};
}

/** Missing selection authority is never permission to continue with the base Workflow contract. */
export function missingStageContractReason(db:DatabaseSync,projectId:string):string|undefined {
  const row=db.prepare('SELECT document_json FROM production_archive_reference WHERE project_id=?').get(projectId);
  if(!row)return;
  const document=JSON.parse(String(row.document_json));
  const missing:string[]=document.missingInputs??[];
  const key=missing.find(value=>value.startsWith('stage-contract-input:')||value.startsWith('stage-contract:'));
  if(!key)return;
  const contract=(document.stageContracts??[]).find((item:ArchivedStageContract)=>key===`stage-contract-input:${item.workflowId}:${item.seq}`)??document.stageContracts?.[0];
  return `缺少已采用的修复包 ${contract?.pack?.id??'（身份待核验）'} ${contract?.pack?.version??''} 的可核验合同，安装精确版本后完成恢复。`;
}

/** Late installation must not make an older source selection the contract of future Runs. */
function preserveArchivedSelectionOrder(db:DatabaseSync,contracts:ArchivedStageContract[],sequences:Map<number,number>):void {
  for(const workflow of new Set(contracts.map(contract=>contract.workflowId))) {
    const group=contracts.filter(contract=>contract.workflowId===workflow).sort((a,b)=>a.seq-b.seq);
    if(!group.every(contract=>sequences.has(contract.seq)))continue;
    const last=group.at(-1)!,source=db.prepare('SELECT workflow_id,payload_json FROM event WHERE seq=?').get(sequences.get(last.seq)!);
    const current=db.prepare("SELECT payload_json FROM event WHERE workflow_id=? AND actor='human' AND entity_type='stage_contract' AND action='selected' ORDER BY seq DESC LIMIT 1").get(source!.workflow_id!);
    const origin=current?JSON.parse(String(current.payload_json)).archiveSelection:undefined;
    if(!origin || origin.seq===last.seq || !group.some(contract=>contract.seq===origin.seq))continue;
    const restored=db.prepare(`INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason,payload_json,occurred_at)
      VALUES(?,'human','stage_contract',?,'selected','已完成恢复，保持原采用顺序',?,?) RETURNING seq`).get(source!.workflow_id!,last.stageId,source!.payload_json!,last.at)!;
    sequences.set(last.seq,Number(restored.seq));
  }
}
