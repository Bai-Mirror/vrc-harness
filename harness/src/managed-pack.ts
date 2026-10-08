import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostPlatform } from './host-platform.ts';
import { copyTreeExact, packTreeHash } from './managed-pack-candidate.ts';

export interface ManagedPackInfo {
  schema: 'harness-managed-pack/0.1';
  id: string;
  version: string;
  channel: string;
  description: string;
  /** Set on a bundled pack installed beside an older copy of the same id: the id it shipped as and its content hash. */
  bundledFrom?: string;
  contentHash?: string;
}

export interface Profile { id: string; definition: string; capabilities?: string }
/** Process definitions in a knowledge root, and which of them can run as formal Workflows. */
export function findProfiles(knowledgeRoot: string): { profiles: Profile[]; thresholds?: string } {
  const dir = join(knowledgeRoot, 'process');
  if (!existsSync(dir)) return { profiles: [] };
  const files = readdirSync(dir);
  const profiles = files.filter(name => name.endsWith('.process.yaml')).sort().map(name => {
    const id = name.slice(0, -'.process.yaml'.length);
    const capabilities = files.includes(`${id}.capabilities.yaml`) ? `process/${id}.capabilities.yaml` : undefined;
    return { id, definition: `process/${name}`, ...(capabilities ? { capabilities } : {}) };
  });
  return { profiles, ...(files.includes('thresholds.yaml') ? { thresholds: 'process/thresholds.yaml' } : {}) };
}

export function bundledPackRoot(): string | undefined {
  const moduleDir=dirname(fileURLToPath(import.meta.url));
  return [process.env.AVH_BUNDLED_ROOT,join(moduleDir,'../builtin'),join(moduleDir,'../../builtin')]
    .filter((value):value is string=>Boolean(value)).find(value=>existsSync(join(value,'pack.json')));
}

export function bundledPackInfo(): ManagedPackInfo | undefined {
  const root=bundledPackRoot();
  return root ? JSON.parse(readFileSync(join(root,'pack.json'),'utf8')) as ManagedPackInfo : undefined;
}

/**
 * Install the bundled pack under AVH_HOME as an immutable copy. Packs are never rewritten in place: Workflows in flight
 * keep the tool hashes they froze. A bundle whose content differs from every installed copy (a newer build that kept
 * the same id and version) is installed beside them as `<id>+<hash>` and waits for an explicit activation.
 */
export function installBundledPack(home:string): {root:string;knowledgeRoot:string;toolRoot:string;info:ManagedPackInfo} {
  const source=bundledPackRoot(),info=bundledPackInfo();
  if(!source||!info)throw new Error('安装包缺少 Harness 托管的制作规则和执行工具，请重新安装');
  const parent=join(home,'managed','packs');hostPlatform.mkdirPrivate(parent);
  const staging=join(parent,`.staging-${process.pid}-${Date.now()}`);
  // Python bytecode left by a source checkout's test runs is not part of the pack.
  // Modes are copied exactly, so the bundle hashes the same whatever the umask of the process that installs it.
  copyTreeExact(source,staging,path=>!/(^|[\\/])__pycache__([\\/]|$)|\.pyc$/.test(path));
  try {
    const hash=packTreeHash(staging).hash;
    const same=managedPacks(home).find(pack=>pack.contentHash===hash||(pack.id===info.id&&!pack.contentHash&&packTreeHash(pack.root).hash===hash));
    if(same){rmSync(staging,{recursive:true,force:true});return{root:same.root,knowledgeRoot:join(same.root,'knowledge'),toolRoot:join(same.root,'tools'),info:same};}
    let installed:ManagedPackInfo=info;
    if(existsSync(join(parent,info.id))){
      installed={...info,id:`${info.id}+${hash.slice(0,12)}`,bundledFrom:info.id,contentHash:hash};
      hostPlatform.writePrivate(join(staging,'pack.json'),`${JSON.stringify(installed,null,2)}\n`);
    }
    const root=join(parent,installed.id);renameSync(staging,root);
    return {root,knowledgeRoot:join(root,'knowledge'),toolRoot:join(root,'tools'),info:installed};
  } catch(error){rmSync(staging,{recursive:true,force:true});throw error;}
}

export function managedPacks(home:string,activeKnowledgeRoot?:string): Array<ManagedPackInfo&{root:string;active:boolean}> {
  const parent=join(home,'managed','packs');
  if(!existsSync(parent))return[];
  return readdirSync(parent).flatMap(id=>{
    const root=join(parent,id),manifest=join(root,'pack.json');
    try {
      if(!statSync(root).isDirectory()||!statSync(manifest).isFile())return[];
      const info=JSON.parse(readFileSync(manifest,'utf8')) as ManagedPackInfo;
      if(info.schema!=='harness-managed-pack/0.1'||info.id!==id)return[];
      return [{...info,root,active:activeKnowledgeRoot===join(root,'knowledge')}];
    } catch{return[];}
  }).sort((a,b)=>b.version.localeCompare(a.version));
}
