import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, ftruncateSync, mkdtempSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeImportSource } from '../../src/import/materialize.ts';
import { removeTemp, windows } from '../fixtures/platform.ts';

// Git Bash puts GNU tar first on PATH, and it takes `C:` for a remote host; Windows ships bsdtar in System32.
const tar=windows?join(process.env.SystemRoot??'C:\\Windows','System32','tar.exe'):'tar';
function fixture(t:test.TestContext){const root=mkdtempSync(join(tmpdir(),'avh-materialize-'));const workspace=join(root,'workspace');mkdirSync(workspace);t.after(()=>removeTemp(root));return{root,workspace};}
function unity(root:string){mkdirSync(join(root,'Assets'),{recursive:true});mkdirSync(join(root,'ProjectSettings'),{recursive:true});writeFileSync(join(root,'ProjectSettings','ProjectVersion.txt'),'m_EditorVersion: 2022.3.22f1\n');}
function sparse(path:string):void{writeFileSync(path,'');if(windows)execFileSync('fsutil.exe',['sparse','setflag',path]);const fd=openSync(path,'r+');try{ftruncateSync(fd,9*1024*1024*1024);}finally{closeSync(fd);}assert.equal(statSync(path).size,9*1024*1024*1024);if(!windows)assert.ok(statSync(path).blocks<16,'fixture must not allocate nine GiB');}

test('folder import copies one ordinary Unity project into workspace',t=>{const f=fixture(t),source=join(f.root,'Source');unity(source);
  const result=materializeImportSource(source,f.workspace);assert.equal(result.sourceKind,'folder');assert.equal(result.created,true);assert.deepEqual(result.candidateRoots,[result.projectPath]);assert.ok(existsSync(join(result.projectPath,'Assets')));assert.ok(existsSync(join(result.projectPath,'.git')));
});

test('ambiguous folder is staged for AI recovery instead of rejected',t=>{const f=fixture(t),source=join(f.root,'Mystery');mkdirSync(source);writeFileSync(join(source,'avatar.prefab'),'not really yaml');
  const result=materializeImportSource(source,f.workspace);assert.equal(result.candidateRoots.length,0);assert.match(result.warnings[0]!,/AI/);assert.ok(existsSync(join(result.projectPath,'_Harness','Incoming','avatar.prefab')));assert.ok(existsSync(join(result.projectPath,'ProjectSettings','ProjectVersion.txt')));
});

test('unitypackage restores Assets and creates a recovery project shell',t=>{const f=fixture(t),pack=join(f.root,'avatar.unitypackage'),body=join(f.root,'body'),guid=join(body,'abc123');mkdirSync(guid,{recursive:true});
  writeFileSync(join(guid,'pathname'),'Assets/Avatar/item.txt\n');writeFileSync(join(guid,'asset'),'payload');writeFileSync(join(guid,'asset.meta'),'guid: abc123\n');execFileSync(tar,['-czf',pack,'-C',body,'.']);
  const result=materializeImportSource(pack,f.workspace);assert.equal(result.sourceKind,'unitypackage');assert.equal(result.candidateRoots.length,1);assert.equal(readFileSync(join(result.projectPath,'Assets','Avatar','item.txt'),'utf8'),'payload');
});

test('large regenerable root caches are excluded identically from folder budget, copy and source fingerprint',t=>{
  const f=fixture(t),source=join(f.root,'Source');unity(source);
  for(const cache of ['Library','Temp','Logs','obj']){mkdirSync(join(source,cache));writeFileSync(join(source,cache,'cache.bin'),'regenerable');}
  sparse(join(source,'Library','large.bin'));
  mkdirSync(join(source,'Assets','Library'));writeFileSync(join(source,'Assets','Library','user.txt'),'real source');
  const first=materializeImportSource(source,f.workspace);
  assert.equal(first.created,true);assert.match(first.warnings.join(' '),/原目录未修改/);
  for(const cache of ['Library','Temp','Logs','obj']){assert.ok(existsSync(join(source,cache)));assert.ok(!existsSync(join(first.projectPath,cache)));}
  assert.equal(readFileSync(join(first.projectPath,'Assets','Library','user.txt'),'utf8'),'real source');
  for(const cache of ['Library','Temp','Logs','obj'])writeFileSync(join(source,cache,'cache.bin'),'updated regenerable cache');
  assert.equal(materializeImportSource(source,f.workspace).sourceHash,first.sourceHash);
  for(const cache of ['Library','Temp','Logs','obj'])rmSync(join(source,cache),{recursive:true});
  const second=materializeImportSource(source,f.workspace);assert.equal(second.sourceHash,first.sourceHash);
  writeFileSync(join(source,'Assets','Library','user.txt'),'changed real source');
  const third=materializeImportSource(source,f.workspace);assert.notEqual(third.sourceHash,first.sourceHash);
});

test('Unity lookalike directories and genuine Assets remain under the eight GiB source budget',t=>{
  const f=fixture(t);
  for(const mode of ['ordinary','missing-version','assets-library','root-cache-file']){
    const source=join(f.root,mode);mkdirSync(source);let large:string;
    if(mode!=='ordinary')unity(source);
    if(mode==='missing-version')rmSync(join(source,'ProjectSettings','ProjectVersion.txt'));
    if(mode==='assets-library'){mkdirSync(join(source,'Assets','Library'));large=join(source,'Assets','Library','asset.bin');}
    else if(mode==='root-cache-file')large=join(source,'Library');
    else{mkdirSync(join(source,'Library'));large=join(source,'Library','large.bin');}
    sparse(large);assert.throws(()=>materializeImportSource(source,f.workspace),/byte limit/,mode);
  }
});

test('only exact known Unity root cache links are left unread and uncopied',t=>{
  const f=fixture(t),source=join(f.root,'Source'),external=join(f.root,'External');unity(source);mkdirSync(external);sparse(join(external,'external.bin'));
  symlinkSync(external,join(source,'Library'),windows?'junction':'dir');
  const first=materializeImportSource(source,f.workspace);assert.ok(!existsSync(join(first.projectPath,'Library')));
  assert.ok(existsSync(join(external,'external.bin')));rmSync(join(source,'Library'));
  assert.equal(materializeImportSource(source,f.workspace).sourceHash,first.sourceHash);
  symlinkSync(external,join(source,'Assets','Library'),windows?'junction':'dir');
  assert.throws(()=>materializeImportSource(source,f.workspace),/unsupported extracted entry/);
  const ordinary=join(f.root,'Ordinary');mkdirSync(ordinary);symlinkSync(external,join(ordinary,'Library'),windows?'junction':'dir');
  assert.throws(()=>materializeImportSource(ordinary,f.workspace),/unsupported extracted entry/);
});

test('Unity-like trees inside Assets retain their Library as user source',t=>{
  const f=fixture(t),source=join(f.root,'Source');unity(source);const nested=join(source,'Assets','Nested');unity(nested);
  mkdirSync(join(nested,'Library'));writeFileSync(join(nested,'Library','user.txt'),'nested asset');
  const first=materializeImportSource(source,f.workspace);
  assert.equal(readFileSync(join(first.projectPath,'_Harness','Incoming','Assets','Nested','Library','user.txt'),'utf8'),'nested asset');
  writeFileSync(join(nested,'Library','user.txt'),'changed');assert.notEqual(materializeImportSource(source,f.workspace).sourceHash,first.sourceHash);
});

test('Windows mixed-case persistent source trees retain nested Unity-like Library contents',{skip:!windows},t=>{
  const f=fixture(t);
  for(const [canonical,actual] of [['Assets','aSsEtS'],['Packages','PACKAGES'],['ProjectSettings','pRoJeCtSeTtInGs']] as const){
    const source=join(f.root,actual);unity(source);
    if(existsSync(join(source,canonical!)))renameSync(join(source,canonical!),join(source,actual!));else mkdirSync(join(source,actual!));
    const nested=join(source,actual!,'Nested');unity(nested);mkdirSync(join(nested,'Library'));writeFileSync(join(nested,'Library','user.txt'),'must remain source');
    const first=materializeImportSource(source,f.workspace);
    assert.equal(readFileSync(join(first.projectPath,'_Harness','Incoming',actual!,'Nested','Library','user.txt'),'utf8'),'must remain source');
    writeFileSync(join(nested,'Library','user.txt'),'changed real source');assert.notEqual(materializeImportSource(source,f.workspace).sourceHash,first.sourceHash);
  }
});
