import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openDatabase } from '../src/state/db.ts';
import { canonicalExploration, explorationAllowance,explorationContext, parseExploration, parseExplorationRequest, performExploration } from '../src/asset-exploration.ts';
import { coordinatorResult } from '../src/interactions.ts';
import type { LocalConfig } from '../src/config.ts';
import { removeTemp } from './fixtures/platform.ts';
import { hostPlatform } from '../src/host-platform.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(),'avh-exploration-')), sources = join(root,'sources'); mkdirSync(sources);
  const db = openDatabase(join(root,'state.db'));
  db.prepare('INSERT INTO workspace(id,path) VALUES(?,?)').run('w',root);
  for (const project of ['p','other']) db.prepare("INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version) VALUES(?,'w','sample',?,'{}','active','test','test')").run(project,join(root,project));
  const config = { assetSearchRoots: [sources] } as LocalConfig;
  t.after(() => { db.close(); removeTemp(root); });
  const target = explorationContext(db,config,'p','unused').roots[0]!.id;
  return { root,sources,db,config,target };
}
test('exploration returns scoped paginated observations and never invents approval', t => {
  const f = fixture(t);
  for (let i=0;i<101;i++) writeFileSync(join(f.sources,`asset-${String(i).padStart(3,'0')}.prefab`),'AvatarDescriptor candidate');
  mkdirSync(join(f.sources,'Library')); writeFileSync(join(f.sources,'.secret'),'hidden');
  const page = performExploration(f.db,f.config,'p',{op:'list',target:f.target,offset:0}) as
    { entries: Array<{id:string;name:string}>;nextOffset:number;total:number };
  assert.equal(page.total,101); assert.equal(page.entries.length,100); assert.equal(page.nextOffset,100);
  const next = performExploration(f.db,f.config,'p',{op:'list',target:f.target,offset:100}) as typeof page;
  assert.equal(next.entries.length,1);
  const target = page.entries[0]!.id;
  const inspected = performExploration(f.db,f.config,'p',{op:'inspect',target}) as { content:string };
  assert.equal(inspected.content,'AvatarDescriptor candidate');
  const chosen = performExploration(f.db,f.config,'p',{op:'select',target,kind:'avatar'}) as {assetId:string;status:string};
  assert.equal(chosen.status,'candidate');
  assert.equal(f.db.prepare('SELECT role FROM project_asset WHERE asset_id=?').get(chosen.assetId)!.role,'candidate');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM production_proposal').get()!.n,0);
  f.db.prepare("UPDATE project_asset SET role='rejected' WHERE asset_id=?").run(chosen.assetId);
  assert.throws(()=>performExploration(f.db,f.config,'p',{op:'select',target,kind:'avatar'}),/已拒绝/);
});
test('exploration refuses foreign tokens, revoked roots and arbitrary operations', t => {
  const f=fixture(t);
  assert.throws(()=>performExploration(f.db,f.config,'other',{op:'list',target:f.target,offset:0}),/授权/);
  assert.throws(()=>performExploration(f.db,{...f.config,assetSearchRoots:[]},'p',{op:'list',target:f.target,offset:0}),/授权/);
  assert.throws(()=>parseExploration({op:'list',target:'../../private'}),/目标无效/);
  assert.throws(()=>parseExploration({op:'list',target:f.target,command:'shell'}),/操作或目标无效/);
  assert.throws(()=>parseExploration({op:'list',target:f.target,offset:-1}),/页码无效/);
  assert.deepEqual(parseExplorationRequest({operations:[{op:'list',target:f.target}]}),{operations:[{op:'list',target:f.target,offset:0}]});
  assert.throws(()=>parseExplorationRequest({operations:Array(9).fill({op:'list',target:f.target})}),/1 至 8/);
  // recall must be a batch of its own. A real coordinator mixed it with other operations, and because the
  // old message only said the result would be re-omitted it repeated the mistake until the repair budget
  // was gone and the request hard-failed. The error must name the rule and the fix.
  assert.throws(()=>parseExplorationRequest({operations:[{op:'recall',target:'o_0123456789abcdef',offset:0},
    {op:'recall',target:'o_fedcba9876543210',offset:0}]}), /recall 必须单独成批/);
  assert.deepEqual(parseExplorationRequest({operations:[{op:'recall',target:'o_0123456789abcdef',offset:0}]}),
    {operations:[{op:'recall',target:'o_0123456789abcdef',offset:0}]});
  assert.deepEqual(coordinatorResult({schema:'interaction-result/0.1',requestId:'r',revision:1,kind:'explore',text:'查找可用素材',
    exploration:{op:'list',target:f.target}},'r',1),{kind:'explore',text:'查找可用素材',exploration:{op:'list',target:f.target,offset:0}});
});

test('archive exploration observes member paths without extracting or changing the original', t => {
  const f=fixture(t),archive=join(f.sources,'candidate.zip');
  execFileSync(hostPlatform.toolCommand('python'),['-c',"import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('../../escape.prefab','not executable'); z.writestr('Assets/Body.prefab','original'); z.close()",archive]);
  const before=readFileSync(archive);
  const page=performExploration(f.db,f.config,'p',{op:'list',target:f.target,offset:0}) as {entries:Array<{id:string}>};
  const result=performExploration(f.db,f.config,'p',{op:'inspect',target:page.entries[0]!.id}) as {inventory:{paths:string[]}};
  assert.deepEqual(result.inventory.paths,['../../escape.prefab','Assets/Body.prefab']);
  assert.deepEqual(readFileSync(archive),before);
  assert.equal(existsSync(join(f.root,'escape.prefab')),false);
  assert.equal(existsSync(join(f.sources,'Assets')),false);
});

test('scoped search discovers nested candidates without traversing caches or outside links', t => {
  const f=fixture(t),nested=join(f.sources,'character','Assets');mkdirSync(nested,{recursive:true});
  writeFileSync(join(nested,'Silver.prefab'),'source');
  mkdirSync(join(f.sources,'Library'));writeFileSync(join(f.sources,'Library','Silver.prefab'),'cache');
  const outside=join(f.root,'outside');mkdirSync(outside);writeFileSync(join(outside,'Silver.prefab'),'private');
  symlinkSync(outside,join(f.sources,'external'),process.platform==='win32'?'junction':'dir');
  const op=parseExploration({op:'search',target:f.target,query:'character Silver'});
  const result=performExploration(f.db,f.config,'p',op) as {entries:{id:string;relativePath:string}[];truncated:boolean};
  assert.deepEqual(result.entries.map(x=>x.relativePath),['character/Assets/Silver.prefab']);assert.equal(result.truncated,false);
  const observed=performExploration(f.db,f.config,'p',{op:'inspect',target:result.entries[0]!.id}) as {content:string};
  assert.equal(observed.content,'source');
  assert.throws(()=>performExploration(f.db,f.config,'other',op),/授权/);
  assert.throws(()=>parseExploration({op:'search',target:f.target,query:''}),/关键词/);
  for(let i=0;i<101;i++)writeFileSync(join(nested,`Silver-${i}.prefab`),'source');
  assert.equal((performExploration(f.db,f.config,'p',op) as {truncated:boolean}).truncated,true,'bounded results disclose truncation');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM asset').get()!.n,0,'search does not select or approve');
});

test('package member observations read real ZIP and Unity YAML with bounded pages and no extraction', t => {
  const f=fixture(t);
  const script=`import io,sys,tarfile,zipfile
from pathlib import Path
root=Path(sys.argv[1])
content=('%YAML 1.1\\nAvatar: {bone: Head, material: Silver}\\n'+'x'*40000).encode()
with zipfile.ZipFile(root/'body.zip','w') as z: z.writestr('Assets/Body.prefab',content)
with tarfile.open(root/'body.unitypackage','w:gz') as t:
 for name,data in [('abc/pathname',b'Assets/Body.prefab'),('abc/asset',content)]:
  m=tarfile.TarInfo(name);m.size=len(data);t.addfile(m,io.BytesIO(data))
`;
  execFileSync(hostPlatform.toolCommand('python'),['-c',script,f.sources]);
  const entries=(performExploration(f.db,f.config,'p',{op:'list',target:f.target,offset:0}) as {entries:{id:string;name:string}[]}).entries;
  const hashes:string[]=[];
  for(const entry of entries){
    const before=readFileSync(join(f.sources,entry.name));
    const op=parseExploration({op:'inspect',target:entry.id,member:'Assets/Body.prefab'});
    type Observation={observation:{content:string;sha256:string;nextOffset:number|null;truncated:boolean}};
    const first=performExploration(f.db,f.config,'p',op) as Observation;
    assert.match(first.observation.content,/bone: Head/);assert.equal(first.observation.content.length,32768);
    assert.equal(first.observation.truncated,true);assert.equal(first.observation.nextOffset,32768);
    const next=performExploration(f.db,f.config,'p',{...op,op:'inspect',member:'Assets/Body.prefab',offset:32768}) as Observation;
    assert.equal(next.observation.nextOffset,null);assert.equal(next.observation.sha256,first.observation.sha256);
    hashes.push(first.observation.sha256);
    assert.deepEqual(readFileSync(join(f.sources,entry.name)),before);
    assert.throws(()=>performExploration(f.db,f.config,'other',op),/授权/);
    assert.throws(()=>performExploration(f.db,{...f.config,assetSearchRoots:[]},'p',op),/授权/);
    assert.throws(()=>performExploration(f.db,f.config,'p',{op:'inspect',target:entry.id,member:'Assets/Missing.prefab'}),/观察失败/);
  }
  assert.equal(hashes[0],hashes[1]);assert.equal(existsSync(join(f.sources,'Assets')),false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM asset').get()!.n,0);
  assert.throws(()=>parseExploration({op:'inspect',target:f.target,member:'../escape.prefab'}),/相对文本/);
  assert.throws(()=>parseExploration({op:'inspect',target:f.target,member:'Assets/Body.fbx'}),/相对文本/);
  assert.throws(()=>parseExploration({op:'inspect',target:f.target,offset:0}),/需要指定/);
});

test('package text inspection refuses duplicate, linked, binary and oversized members', t => {
  const f=fixture(t);
  execFileSync(hostPlatform.toolCommand('python'),['-c',`import stat,sys,warnings,zipfile
warnings.simplefilter('ignore')
with zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:
 z.writestr('duplicate.prefab','first');z.writestr('duplicate.prefab','second')
 z.writestr('binary.prefab',b'\\x00binary');z.writestr('large.prefab',b'x'*(8*1024*1024+1))
 m=zipfile.ZipInfo('link.prefab');m.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(m,'private')
`,join(f.sources,'unsafe.zip')]);
  const target=(performExploration(f.db,f.config,'p',{op:'list',target:f.target,offset:0}) as {entries:{id:string}[]}).entries[0]!.id;
  for(const member of ['duplicate.prefab','binary.prefab','large.prefab','link.prefab'])
    assert.throws(()=>performExploration(f.db,f.config,'p',{op:'inspect',target,member}),/观察失败/);
});

test('ZIP wrapped UnityPackage inspection streams its inventory and selected text without extraction',t=>{
  const f=fixture(t);
  execFileSync(hostPlatform.toolCommand('python'),['-c',`import io,stat,sys,tarfile,zipfile
raw=io.BytesIO()
with tarfile.open(fileobj=raw,mode='w:gz') as t:
 for name,data in [('abc/pathname',b'Assets/Body.prefab'),('abc/asset',b'%YAML 1.1\\nbone: Head')]:
  m=tarfile.TarInfo(name);m.size=len(data);t.addfile(m,io.BytesIO(data))
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('Product/Avatar.unitypackage',raw.getvalue())
 m=zipfile.ZipInfo('linked.unitypackage');m.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(m,'private')
`,join(f.sources,'product.zip')]);
  const target=(performExploration(f.db,f.config,'p',{op:'list',target:f.target,offset:0}) as {entries:{id:string}[]}).entries[0]!.id;
  const op=parseExploration({op:'inspect',target,container:'Product/Avatar.unitypackage'});
  const inventory=performExploration(f.db,f.config,'p',op) as {inventory:{paths:string[];truncated:boolean}};
  assert.deepEqual(inventory.inventory.paths,['Assets/Body.prefab']);assert.equal(inventory.inventory.truncated,false);
  const result=performExploration(f.db,f.config,'p',{...op,op:'inspect',container:'Product/Avatar.unitypackage',member:inventory.inventory.paths[0]!}) as {observation:{content:string;container:string}};
  assert.match(result.observation.content,/bone: Head/);assert.equal(result.observation.container,'Product/Avatar.unitypackage');
  assert.equal(existsSync(join(f.sources,'Product')),false);assert.equal(existsSync(join(f.sources,'Assets')),false);
  assert.throws(()=>performExploration(f.db,f.config,'p',{op:'inspect',target,container:'linked.unitypackage'}),/观察失败/);
  assert.throws(()=>parseExploration({op:'inspect',target,container:'../private.unitypackage'}),/相对路径/);
  assert.throws(()=>parseExploration({op:'inspect',target,container:'more.zip'}),/UnityPackage/);
});

test('short resource tokens retain exact project binding and refuse ambiguous prefixes', t => {
  const f=fixture(t);assert.match(f.target,/^r_[a-f0-9]{16}$/);
  const full=String(f.db.prepare('SELECT id FROM exploration_resource WHERE project_id=?').get('p')!.id);
  const request={op:'list' as const,target:f.target,offset:0};
  assert.deepEqual(canonicalExploration(f.db,'p',request),{...request,target:full});
  assert.deepEqual(performExploration(f.db,f.config,'p',request),performExploration(f.db,f.config,'p',{...request,target:full}));
  assert.throws(()=>performExploration(f.db,f.config,'other',request),/授权/);
  const other=join(f.sources,'other');mkdirSync(other);
  const collision=full.slice(0,16)+(full.slice(16)==='0'.repeat(48)?'1':'0').repeat(48);
  f.db.prepare('INSERT INTO exploration_resource(id,project_id,root,path) VALUES(?,?,?,?)').run(collision,'p',f.sources,other);
  assert.throws(()=>performExploration(f.db,f.config,'p',request),/冲突/);
  assert.equal(explorationContext(f.db,f.config,'p','unused').roots[0]!.id,full,'colliding resources retain full identifiers');
});


test('exploration windows grow from actual useful receipts and honor expandable current configuration',t=>{
 const f=fixture(t),rows=(count:number,useful=true)=>Array.from({length:count},(_,index)=>({request_json:JSON.stringify({op:'inspect',target:'a'.repeat(64)}),result_json:JSON.stringify(useful?{bytes:4,content:'evidence'}:{error:'unreadable'})}));
 assert.equal(explorationAllowance(rows(15),f.config).maxOperations,24);
 assert.equal(explorationAllowance(rows(16),f.config).maxOperations,48);
 assert.equal(explorationAllowance(rows(40),f.config).maxOperations,72);
 assert.equal(explorationAllowance(rows(72,false),f.config).maxOperations,24,'failure does not renew work');
 assert.equal(explorationAllowance(rows(16).map(row=>({...row,result_json:JSON.stringify({entries:[]})})),f.config).maxOperations,24,'empty discoveries do not renew work');
 const configPath=join(f.root,'guard.yaml');writeFileSync(configPath,'coordination:\n  maxExplorationOperations: 96\n');
 const live={...f.config,assetSearchRootsConfigPath:configPath};assert.equal(explorationAllowance(rows(64),live).maxOperations,96);
 writeFileSync(configPath,'coordination:\n  maxExplorationOperations: 24\n');assert.equal(explorationAllowance(rows(64),live).maxOperations,24,'a running consumer respects a lowered guard without discarding receipts');
 writeFileSync(configPath,'coordination: invalid');assert.equal(explorationAllowance(rows(64),live).maxOperations,24);
});


test('direct texture selection validates PNG/JPEG and preserves role, source and authorization boundaries', t => {
  const f=fixture(t),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  writeFileSync(join(f.sources,'texture.png'),png);writeFileSync(join(f.sources,'fake.jpg'),png);
  writeFileSync(join(f.sources,'unsupported.webp'),Buffer.from('RIFF0000WEBP'));
  const entries=(performExploration(f.db,f.config,'p',{op:'list',target:f.target,offset:0}) as {entries:{id:string;name:string}[]}).entries;
  const id=(name:string)=>entries.find(e=>e.name===name)!.id;
  assert.throws(()=>performExploration(f.db,f.config,'p',{op:'select',target:id('texture.png'),kind:'avatar'}),/此类型/);
  assert.throws(()=>performExploration(f.db,f.config,'p',{op:'select',target:id('fake.jpg'),kind:'texture'}),/格式不一致/);
  assert.throws(()=>performExploration(f.db,f.config,'p',{op:'select',target:id('unsupported.webp'),kind:'texture'}),/此类型/);
  const selected=performExploration(f.db,f.config,'p',{op:'select',target:id('texture.png'),kind:'texture'}) as {assetId:string};
  assert.equal(f.db.prepare('SELECT kind,status FROM asset WHERE id=?').get(selected.assetId)!.kind,'texture');
  assert.deepEqual(readFileSync(join(f.sources,'texture.png')),png);
  assert.throws(()=>performExploration(f.db,{...f.config,assetSearchRoots:[]},'p',{op:'select',target:id('texture.png'),kind:'texture'}),/授权/);
  assert.throws(()=>performExploration(f.db,f.config,'p',{op:'select',target:f.target,kind:'texture'}),/列出目录/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM production_proposal').get()!.n,0);
});
