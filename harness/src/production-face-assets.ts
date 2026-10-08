import {join} from 'node:path';
import {existsSync,lstatSync} from 'node:fs';
import {relativeInside} from './archive/scan.ts';
import {sha256File} from './file-hash.ts';
import type {WorkflowSnapshot} from './workflow/runtime.ts';
import type {ProductionFile} from './production-face-continuation.ts';

/** Relocate only verified project members. The continuation retains the source workflow provenance. */
export function relocateProductionAssets(snapshot:WorkflowSnapshot,source:string,destination:string,files:ProductionFile[]):WorkflowSnapshot {
  if(!snapshot.manifest)return snapshot;
  const copied=new Map(files.map(file=>[file.path,file.sha256]));
  const assets=snapshot.manifest.assets.map(asset=>{
    const path=relativeInside(source,asset.item);
    if(path===undefined)return asset;
    const target=join(destination,path);
    if(!asset.sha256 || copied.get(path)!==asset.sha256 || !existsSync(target) || lstatSync(target).isSymbolicLink()
      || !lstatSync(target).isFile() || sha256File(target)!==asset.sha256)
      throw new Error('后继工程的冻结素材与核验复制清单不同，未发布制作版本。');
    return {...asset,item:target};
  });
  const relocated=new Map(snapshot.manifest.assets.map((asset,index)=>[asset.item,assets[index]!.item]));
  const variants=snapshot.manifest.variants?.map(variant=>({...variant,assets:variant.assets.map(asset=>({...asset,item:relocated.get(asset.item)??asset.item}))}));
  return {...snapshot,manifest:{...snapshot.manifest,assets,...(variants?{variants}:{})}};
}
