import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, ftruncateSync, mkdtempSync, mkdirSync, openSync, readFileSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { deflateSync } from 'node:zlib';
import { FACE_CANDIDATE_PREVIEW_MANIFEST, FACE_PREVIEW_MANIFEST, projectFaceCandidatePreview, projectFaceCandidatePreviewImage, projectFacePreview, projectFacePreviewImage, readFaceCandidatePreview, readFacePreview, verifiedPreviewPng } from '../src/face-preview.ts';
import { openDatabase } from '../src/state/db.ts';
import { faceSelectionForDispatch, validateFaceAcceptance, validateFaceChoice } from '../src/face-selection.ts';
import { removeTemp } from './fixtures/platform.ts';
import { RuntimeService } from '../src/api/server.ts';
import { ApiClient } from '../src/api/client.ts';
import { MAX_MESSAGE_BYTES } from '../src/api/protocol.ts';
import { stringify } from 'yaml';
import { execFileSync } from 'node:child_process';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function crc(bytes: Buffer) { let n = 0xffffffff; for (const b of bytes) { n ^= b; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; }
function chunk(type: string, bytes: Buffer) { const out = Buffer.alloc(bytes.length + 12); out.writeUInt32BE(bytes.length); out.write(type, 4); bytes.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, -4)), out.length - 4); return out; }
// Synthetic pixel fixtures exercise the PNG decoder only; these are never advertised as Unity renders.
function png(flat = false) {
  const header = Buffer.alloc(13); header.writeUInt32BE(128); header.writeUInt32BE(128, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((128 * 3 + 1) * 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) pixels[(y * (128 * 3 + 1)) + 1 + x * 3] = flat ? 80 : x ^ y;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-face-preview-')); t.after(() => removeTemp(root));
  const put = (path: string, bytes: Buffer | string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); return { path, sha256: hash(readFileSync(join(root, path))) }; };
  const source = put('Assets/Original.prefab', 'actual source fixture'), candidate = put('Assets/_Harness/Face/Generated/Avatar.prefab', 'actual candidate fixture');
  const mesh = put('Assets/_Harness/Face/Generated/FaceMesh.asset', 'mesh fixture');
  const observation = put('_harness/face/observation.json', JSON.stringify({ schema: 'face-unity-observation/0.1', dependencies: [source] }));
  const refs = Object.fromEntries(['blenderCatalog', 'blenderDesign', 'candidateReceipt'].map(key => {
    const record = put(`Assets/_Harness/Face/${key}.json`, '{}'); return [key, { file: record.path, sha256: record.sha256 }];
  }));
  const input = put('Assets/_Harness/Face/design.json', JSON.stringify({ schema: 'face-unity-design/0.1', mode: 'design', observationSha256: observation.sha256, ...refs }));
  const output = put('_harness/face/output.json', JSON.stringify({ schema: 'face-unity-output/0.1', mode: 'design', sourcePrefab: source.path, avatar: candidate.path,
    inputSha256: input.sha256, observationSha256: observation.sha256, productionAccepted: false }));
  const images = ['before-front', 'after-front', 'before-side', 'after-side'].map(id => {
    const [version, view] = id.split('-'), image = put(`_harness/face/preview/render/${id}.png`, png()); return { ...image, id, version, view, width: 128, height: 128 };
  });
  const manifest = { schema: 'face-preview/0.1', productionAccepted: false, bindings: { input, output, observation, source, candidate }, dependencies: [source, candidate, mesh],
    protocol: { camera: 'orthographic', pose: 'prefab-defaults', views: ['front', 'side'], center: [0,1,0], orthographicSize: 1 }, images };
  const save = () => put(FACE_PREVIEW_MANIFEST, JSON.stringify(manifest)); save();
  return { root, put, manifest, save };
}
test('PNG readback refuses truncation, bad CRC and pure background instead of accepting a render receipt', () => {
  assert.deepEqual(verifiedPreviewPng(png()), { width: 128, height: 128 });
  for (const bytes of [png(true), png().subarray(0, -5), Buffer.from('producer says rendered')]) assert.throws(() => verifiedPreviewPng(bytes));
  const corrupt = png(); corrupt[33] ^= 1; assert.throws(() => verifiedPreviewPng(corrupt), /损坏/);
});
for(const large of ['none','verification','candidateReceipt','transport']) test(`Runtime consumes version-bound quality groups and close-ups without exposing ${large==='none'?'raw flags':large==='transport'?'an oversized API frame':`a 257 MiB ${large} receipt`}`,async t=>{
  const f=fixture(t),raw=f.put('Assets/_Harness/Face/verification.json','raw flags retained');
  const input=JSON.parse(readFileSync(join(f.root,f.manifest.bindings.input.path),'utf8'));
  const oversized=large==='candidateReceipt'?{path:input.candidateReceipt.file,sha256:input.candidateReceipt.sha256}:raw;
  if(large!=='none'&&large!=='transport'){
    const size=257*1024*1024,fd=openSync(join(f.root,oversized.path),'w');try{ftruncateSync(fd,size);}finally{closeSync(fd);}
    const sha=createHash('sha256'),chunk=Buffer.alloc(1024*1024);for(let offset=0;offset<size;offset+=chunk.length)sha.update(chunk);oversized.sha256=sha.digest('hex');
    if(large==='candidateReceipt')input.candidateReceipt.sha256=oversized.sha256;
  }
  input.blenderVerification={file:raw.path,sha256:raw.sha256};
  f.manifest.bindings.input=f.put(f.manifest.bindings.input.path,JSON.stringify(input));
  const output=JSON.parse(readFileSync(join(f.root,f.manifest.bindings.output.path),'utf8'));output.inputSha256=f.manifest.bindings.input.sha256;
  f.manifest.bindings.output=f.put(f.manifest.bindings.output.path,JSON.stringify(output));
  const images=['front','side'].flatMap(view=>['before','after'].map(version=>{const id='quality-'+version+'-'+view,image=f.put('_harness/face/preview/review/'+id+'.png',png());return{...image,id,version,view,width:128,height:128};}));
  const row={region:'left-eye',kind:'edge distortion',baseline:'new',rawCount:2,uniqueCount:1};
  const review={schema:'face-quality-review/0.1',productionAccepted:false,verification:raw,rawFindingCount:2,uniqueFindingCount:1,stateCount:1,
    groups:[{...row,id:'group',imageIds:images.map(i=>i.id),maximumChangeMm:.1,maximumFootprintMm:.5,estimatedChangePixels:1}],states:[{...row,state:'basis',weight:null}],images,limitations:['几何估计不代表可见缺陷。']};
  if(large==='transport')review.limitations.push('完整证据'.repeat(800_000));
  const save=()=>{(f.manifest as any).qualityReview=f.put('_harness/face/preview/review/quality-review.json',JSON.stringify(review));f.save();};save();
  const result=readFacePreview(f.root);assert.equal(result.qualityReview?.rawFindingCount,2);assert.equal(result.qualityReview?.uniqueFindingCount,1);assert.equal(result.images.length,4);
  assert.equal('verification' in result.qualityReview!,false);
  if(large==='transport'){
    const home=mkdtempSync(join(tmpdir(),'avh-preview-api-home-')),tools=join(home,'tools'),knowledge=join(home,'knowledge');
    t.after(()=>removeTemp(home));
    for(const path of [join(home,'config'),join(home,'state'),join(tools,'审查/perception'),knowledge])mkdirSync(path,{recursive:true});
    for(const name of ['project_fingerprint.py','vpm_baseline_check.py','审查/perception/strip_audit.py'])writeFileSync(join(tools,name),'');
    writeFileSync(join(home,'config/harness.yaml'),stringify({workspaceRoot:f.root,toolRoot:tools,knowledgeRoot:knowledge,
      exportRoots:[],knownBodies:[],projectAliases:{},sampleNames:[],providers:[],processDefinitions:{fixture:'fixture.yaml'},defaultProfile:'fixture',thresholdsFile:'thresholds.yaml'}));
    writeFileSync(join(knowledge,'thresholds.yaml'),'schema: thresholds/0.1\nversion: "1"\nt: {}\n');
    writeFileSync(join(knowledge,'fixture.yaml'),stringify({schema:'process/0.1',id:'fixture',version:'1',applies_to:{},artifacts:['face'],
      stages:[{id:'face',needs:[],produces:['face'],requires:[],gates:[],invalidated_by:[]}],checks:[],gates:[],milestones:[]}));
    execFileSync('git',['init','-q',f.root]);
    const db=openDatabase(join(home,'state/harness.db'));
    db.prepare('INSERT INTO workspace(id,path) VALUES(?,?)').run('workspace',dirname(f.root));
    db.prepare("INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version) VALUES('project','workspace','sample',?,'{}','active','test','test')").run(f.root);
    db.prepare("INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json) VALUES('workflow','project','face','hash','test','active','{}')").run();
    db.prepare("INSERT INTO artifact_version(workflow_id,kind,hash) VALUES('workflow','face','actual-face-artifact')").run();
    db.prepare("INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES('face-task','workflow','face','preview','test','WAITING_HUMAN')").run();
    db.prepare("INSERT INTO run(id,task_id,attempt,status,result_json) VALUES('face-run','face-task',1,'exited',?)").run(JSON.stringify({exitStatus:0,outputs:{[FACE_PREVIEW_MANIFEST]:result.previewSha256},unitySteps:[{method:'AVH.Harness.FacePreviewStage.Render',exitCode:0}]}));
    db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason) VALUES('workflow','runtime','run','face-run','unity_unit_intended','synthetic consumer fixture')").run();
    db.prepare("INSERT INTO stage_completion(workflow_id,stage_id,artifact_hashes_json,run_id) VALUES('workflow','face','{}','face-run')").run();
    const expected=projectFacePreview(db,'project','workflow');db.close();
    assert.ok(expected.status==='ready'&&expected.generatedAt,'the face preview names when its stage was recorded');
    assert.ok(Buffer.byteLength(JSON.stringify({id:2,result:expected}))>MAX_MESSAGE_BYTES);
    const service=new RuntimeService({home,scheduler:false,pollMs:50});await service.start();
    const client=await ApiClient.connect(home);t.after(async()=>{client.close();await service.stop();});
    const params={projectId:'project',workflowId:'workflow'};
    const [actual,status]=await Promise.all([client.call('project.face.preview',params),client.call('service.status')]);
    assert.deepEqual(actual,expected,'the real server and LineBuffer client must retain every evidence byte');assert.ok(status);
    const image=await client.call<any>('project.face.preview.image',{...params,previewSha256:result.previewSha256,id:'after-front'});
    assert.equal(image.sha256,result.images.find(i=>i.id==='after-front')!.sha256);
    const batch=await client.call<any[]>('project.face.preview.images',{...params,previewSha256:result.previewSha256,ids:result.images.map(i=>i.id)});
    assert.deepEqual(batch.map(i=>({id:i.id,sha256:i.sha256,dataUrl:i.dataUrl})),result.images.map(i=>({id:i.id,sha256:i.sha256,dataUrl:'data:image/png;base64,'+png().toString('base64')})));
    for(const ids of [[],Array(9).fill('after-front'),['after-front','after-front'],['../private.png']])
      await assert.rejects(client.call('project.face.preview.images',{...params,previewSha256:result.previewSha256,ids}),/批次无效|版本已变化/);
    await assert.rejects(client.call('project.face.preview.images',{...params,previewSha256:'0'.repeat(64),ids:['after-front']}),/版本已变化/);
    await assert.rejects(client.call('project.face.preview',{...params,projectId:'other'}),/所属制作流程/);
    await assert.rejects(client.call('project.face.preview.image',{...params,previewSha256:'0'.repeat(64),id:'after-front'}),/版本已变化/);
    const old=readFileSync(join(f.root,images[0]!.path));f.put(images[0]!.path,'changed');
    await assert.rejects(client.call('project.face.preview',params),/特写已变化/);f.put(images[0]!.path,old);
    assert.equal(client.closed,false);
  }
  if(large!=='none'&&large!=='transport'){
    const fd=openSync(join(f.root,oversized.path),'r+');
    try{
      writeSync(fd,Buffer.from([1]),0,1,257*1024*1024-1);assert.throws(()=>readFacePreview(f.root),/实际源依赖已变化/);
      writeSync(fd,Buffer.from([0]),0,1,257*1024*1024-1);ftruncateSync(fd,512*1024*1024+1);assert.throws(()=>readFacePreview(f.root),/类型或大小无效/);
      ftruncateSync(fd,257*1024*1024);
    }finally{closeSync(fd);}
  }
  review.rawFindingCount=3;save();assert.throws(()=>readFacePreview(f.root),/丢失原始记录/);
  review.rawFindingCount=2;review.groups[0]!.imageIds.pop();save();assert.throws(()=>readFacePreview(f.root),/缺少特写/);
  review.groups[0]!.imageIds.push(images[3]!.id);review.verification.sha256='f'.repeat(64);save();assert.throws(()=>readFacePreview(f.root),/复核版本不一致/);
});

test('native FBX preview requires both eye states and refuses stale skinning even with freshly bound image bytes',t=>{
  const f=fixture(t),m=f.manifest;
  const model=f.put('Assets/_Harness/Face/Candidates/current/candidate.fbx','complete FBX fixture');
  m.dependencies=m.dependencies.filter(d=>!d.path.endsWith('FaceMesh.asset'));m.dependencies.push(model);
  const design=f.put('Assets/_Harness/Face/blenderDesign.json',JSON.stringify({recipe:{compensation:{method:'regional-additive',regions:[{side:'left'},{side:'right'}]}}}));
  const input=JSON.parse(readFileSync(join(f.root,m.bindings.input.path),'utf8'));input.route='native-fbx/1';input.blenderDesign={file:design.path,sha256:design.sha256};
  m.bindings.input=f.put(m.bindings.input.path,JSON.stringify(input));
  const output=JSON.parse(readFileSync(join(f.root,m.bindings.output.path),'utf8'));output.deliveryMode='native-fbx-reference';output.candidateModel=model;output.inputSha256=m.bindings.input.sha256;
  m.bindings.output=f.put(m.bindings.output.path,JSON.stringify(output));
  for(const version of ['before','after'])for(const view of ['eyes-half','eyes-full']){
    const id=version+'-'+view;const image=f.put(`_harness/face/preview/render/${id}.png`,png());
    m.images.push({...image,id,version,view,width:128,height:128,poseSha256:(view==='eyes-half'?'a':'b').repeat(64)} as any);
  }
  f.save();assert.equal(readFacePreview(f.root).images.length,8);assert.equal(readFacePreview(f.root).visuallyAccepted,false);
  const full=m.images.find(i=>i.id==='after-eyes-full') as any;full.poseSha256='a'.repeat(64);f.save();assert.throws(()=>readFacePreview(f.root),/真实不同的蒙皮/);
  full.poseSha256='b'.repeat(64);m.images.pop();f.save();assert.throws(()=>readFacePreview(f.root),/特写未齐全/);
});

function candidateFixture(t:TestContext){
  // Declared decoder/consumer fixtures; the optional Unity integration tests supply actual rendered evidence.
  const f=fixture(t),source=f.manifest.bindings.source,targetId='1'.repeat(64);
  const observation=f.put('_harness/face/observation.json',JSON.stringify({schema:'face-unity-observation/0.1',sourcePrefab:source,dependencies:[source],targets:[{targetId,meshSnapshot:{keys:[{name:'Width'}]},protectedKeys:[]}]}));
  const request=f.put('_harness/face/request.json',JSON.stringify({schema:'face-request/0.2',observationSha256:observation.sha256,targetId,candidates:[{id:'soft',values:{Width:.1}},{id:'wide',values:{Width:.25}}]}));
  const installed=f.put('Assets/_HarnessTools/Editor/FacePreviewStage.cs','declared unit tool fixture'),tool=f.put('tools/FacePreviewStage.cs','declared unit tool fixture'),binary=f.put('fixture-binary','declared unit binary fixture');
  const catalog=f.put('Assets/_Harness/Face/Catalogs/'+'a'.repeat(64)+'/catalog.json','{}'),references=[catalog];
  const candidates=['soft','wide'].map((id,index)=>{
    const design=f.put(`Assets/_Harness/Face/CandidateSets/set/${id}/design.json`,JSON.stringify({schema:'face-design/0.1',revisionId:id})),validation=f.put(`Assets/_Harness/Face/CandidateSets/set/${id}/validation.json`,JSON.stringify({schema:'face-candidate-validation/0.1',revisionId:id,designFileSha256:design.sha256,status:'mathematical_candidate_validated',productionAccepted:false}));references.push(design,validation);
    return{id,weightsUnityPercent:{Width:index?25:10},design:{file:design.path,sha256:design.sha256},validation:{file:validation.path,sha256:validation.sha256}};
  });
  const collection={schema:'face-candidate-set/0.1',id:'set',productionAccepted:false,sourcePrefab:source.path,targetId,requestSha256:request.sha256,observationSha256:observation.sha256,
    binary:{path:join(f.root,binary.path),sha256:binary.sha256},tools:{'FacePreviewStage.cs':tool.sha256},blenderCatalog:{file:catalog.path,sha256:catalog.sha256},candidates};
  const collectionBinding=f.put('_harness/face/candidates.json',JSON.stringify(collection));f.put('Assets/_Harness/Face/CandidateSets/set/candidate-set.json',JSON.stringify(collection));
  const input=f.put('Assets/_Harness/Face/preview-input.json',JSON.stringify({schema:'face-preview-input/0.1',observationSha256:observation.sha256,collectionSha256:collectionBinding.sha256,sourcePrefab:source.path,targetId,candidates:candidates.map(({id,weightsUnityPercent})=>({id,weightsUnityPercent}))}));
  const images=['front','side'].flatMap(view=>[...['before',...candidates.map((_,index)=>'candidate-'+index)]].map((name,index)=>{
    const image=f.put(`_harness/face/candidate-preview/render/${name}-${view}.png`,png());return{...image,id:`${name}-${view}`,version:index?'after':'before',view,...(index?{candidateId:candidates[index-1]!.id}:{}),width:128,height:128};
  }));
  const manifest={schema:'face-candidate-preview/0.1',productionAccepted:false,bindings:{collection:collectionBinding,input,observation,request,source},dependencies:[source],references,
    protocol:f.manifest.protocol,images,candidates:candidates.map((candidate,index)=>({id:candidate.id,revisionSha256:collectionBinding.sha256,imageIds:['candidate-'+index+'-front','candidate-'+index+'-side']}))};
  const save=()=>f.put(FACE_CANDIDATE_PREVIEW_MANIFEST,JSON.stringify(manifest));save();
  return{...f,manifest,collection,save,installed,tool};
}
test('multiple real candidate identities require shared source/front-side images and immutable version bindings',t=>{
  const f=candidateFixture(t),preview=readFaceCandidatePreview(f.root);assert.equal(preview.mode,'candidates');assert.equal(preview.candidates.length,2);assert.equal(preview.images.length,6);assert.equal(preview.visuallyAccepted,false);
  assert.equal(preview.candidateSetSha256,f.manifest.bindings.collection.sha256);assert.deepEqual(preview.candidates.map(c=>c.id),['soft','wide']);
  assert.deepEqual(preview.candidates.map(c=>c.candidateNumber),[1,2]);
});

test('compensated preview retains candidate 2 from its hash-bound frozen set rather than its single display column',t=>{
  const f=fixture(t),path=f.manifest.bindings.input.path;
  const set=f.put('Assets/_Harness/Face/CandidateSets/set/candidate-set.json',JSON.stringify({schema:'face-candidate-set/0.1',candidates:[{id:'soft'},{id:'wide'}]}));
  const design=f.put('Assets/_Harness/Face/CandidateSets/set/wide/design.json','{}');
  const input=JSON.parse(readFileSync(join(f.root,path),'utf8'));
  input.blenderDesign={file:design.path,sha256:design.sha256};input.candidateId='wide';input.candidateSetSha256=set.sha256;
  const save=()=>{
    f.manifest.bindings.input=f.put(path,JSON.stringify(input));
    const output=JSON.parse(readFileSync(join(f.root,f.manifest.bindings.output.path),'utf8'));output.inputSha256=f.manifest.bindings.input.sha256;
    f.manifest.bindings.output=f.put(f.manifest.bindings.output.path,JSON.stringify(output));f.save();
  };
  save();let preview=readFacePreview(f.root);
  assert.equal(preview.candidates.length,1);assert.equal(preview.candidates[0]!.candidateNumber,2);assert.equal(preview.candidates[0]!.candidateId,'wide');
  f.put('_harness/face/candidates.json','a later candidate pointer is not this output identity');
  assert.equal(readFacePreview(f.root).candidates[0]!.candidateNumber,2);
  input.candidateId='missing';save();assert.throws(()=>readFacePreview(f.root),/冻结集合/);
  input.candidateId='wide';save();f.put(set.path,'changed set');assert.throws(()=>readFacePreview(f.root),/变化/);
});
test('native candidate preview rejects reconstructed authority even after all public bindings are rehashed',t=>{
 const f=candidateFixture(t),collection={...f.collection,route:'native-fbx/1',sourceAuthority:{file:'Assets/_Harness/Face/Catalogs/old/source-authority.json',sha256:'a'.repeat(64)}};
 const raw=JSON.stringify(collection);f.manifest.bindings.collection=f.put('_harness/face/candidates.json',raw);f.put('Assets/_Harness/Face/CandidateSets/set/candidate-set.json',raw);
 const input=JSON.parse(readFileSync(join(f.root,f.manifest.bindings.input.path),'utf8'));input.collectionSha256=f.manifest.bindings.collection.sha256;f.manifest.bindings.input=f.put(f.manifest.bindings.input.path,JSON.stringify(input));
 for(const candidate of f.manifest.candidates)candidate.revisionSha256=f.manifest.bindings.collection.sha256;f.save();
 assert.throws(()=>readFaceCandidatePreview(f.root),/原生 FBX 候选不能使用旧重建源/);
});
test('candidate preview also freezes the actual optional UV/source mapping file',t=>{
  const f=candidateFixture(t),mapping=f.put('Assets/_Harness/Face/Catalogs/'+'a'.repeat(64)+'/source-mapping.json','{"schema":"declared-unit-mapping"}');
  const collection={...f.collection,sourceMapping:{file:mapping.path,sha256:mapping.sha256}},raw=JSON.stringify(collection);
  f.manifest.bindings.collection=f.put('_harness/face/candidates.json',raw);f.put('Assets/_Harness/Face/CandidateSets/set/candidate-set.json',raw);
  const input=JSON.parse(readFileSync(join(f.root,f.manifest.bindings.input.path),'utf8'));input.collectionSha256=f.manifest.bindings.collection.sha256;
  f.manifest.bindings.input=f.put(f.manifest.bindings.input.path,JSON.stringify(input));
  for(const candidate of f.manifest.candidates)candidate.revisionSha256=f.manifest.bindings.collection.sha256;
  f.manifest.references.push(mapping);f.save();assert.equal(readFaceCandidatePreview(f.root).status,'ready');
  f.put(mapping.path,'changed mapping');assert.throws(()=>readFaceCandidatePreview(f.root),/变化/);
});
test('large measured source observations remain bounded local reads instead of a 32 MB product ceiling',t=>{
  const f=fixture(t),bytes=readFileSync(join(f.root,f.manifest.bindings.observation.path));
  f.manifest.bindings.observation=f.put(f.manifest.bindings.observation.path,Buffer.concat([bytes,Buffer.alloc(33*1024*1024,32)]));
  const input=JSON.parse(readFileSync(join(f.root,f.manifest.bindings.input.path),'utf8'));input.observationSha256=f.manifest.bindings.observation.sha256;
  f.manifest.bindings.input=f.put(f.manifest.bindings.input.path,JSON.stringify(input));
  const output=JSON.parse(readFileSync(join(f.root,f.manifest.bindings.output.path),'utf8'));output.inputSha256=f.manifest.bindings.input.sha256;output.observationSha256=input.observationSha256;
  f.manifest.bindings.output=f.put(f.manifest.bindings.output.path,JSON.stringify(output));f.save();
  assert.equal(readFacePreview(f.root).images.length,4);
});
test('multi-candidate preview rejects changed source/inputs/collection/validation/catalog/binary and wrong image identities',async t=>{
  for(const fault of ['collection','immutable','request','input','source','validation','catalog','binary','missing-view','candidate-id','candidate-image','path-escape'])await t.test(fault,sub=>{
    const f=candidateFixture(sub);
    if(['collection','request','input','source'].includes(fault))f.put(f.manifest.bindings[fault as 'collection'].path,'changed');
    if(fault==='immutable')f.put('Assets/_Harness/Face/CandidateSets/set/candidate-set.json','changed');
    if(fault==='validation')f.put(f.collection.candidates[0]!.validation.file,'changed');
    if(fault==='catalog')f.put(f.collection.blenderCatalog.file,'changed');
    if(fault==='binary')f.put('fixture-binary','changed');
    if(fault==='missing-view'){f.manifest.images.pop();f.save();}
    if(fault==='candidate-id'){f.manifest.candidates[0]!.id='another';f.save();}
    if(fault==='candidate-image'){f.manifest.images[1]!.candidateId='another';f.save();}
    if(fault==='path-escape'){f.manifest.images[0]!.path='../private.png';f.save();}
    assert.throws(()=>readFaceCandidatePreview(f.root));
  });
});
test('candidate project consumer requires latest supervised RenderCandidates and frozen current tool identities',t=>{
  const f=candidateFixture(t),db=openDatabase(join(f.root,'state.db'));t.after(()=>db.close());
  db.prepare('INSERT INTO workspace(id,path) VALUES(?,?)').run('workspace',dirname(f.root));
  db.prepare("INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version) VALUES('project','workspace','sample',?,'{}','active','test','test')").run(f.root);
  db.prepare("INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json) VALUES('workflow','project','face','hash','test','active','{}')").run();
  const definition={gates:[{id:'choice',binds:'face_candidates'}],checks:[],stages:[]};
  db.prepare("INSERT INTO workflow_definition(workflow_id,profile,definition_json,capabilities_json,thresholds_json,tools_json,tool_root) VALUES('workflow','fixture',?,'{}','{}',?,?)").run(JSON.stringify(definition),JSON.stringify({'FacePreviewStage.cs':f.tool.sha256}),join(f.root,'tools'));
  db.prepare("INSERT INTO artifact_version(workflow_id,kind,hash) VALUES('workflow','face_candidates','actual-set-artifact')").run();
  assert.throws(()=>projectFaceCandidatePreview(db,'project','workflow'),/受管渲染/);
  db.prepare("INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES('face-task','workflow','face_design','preview','test','WAITING_HUMAN')").run();
  const result={exitStatus:0,prepare:{status:'finished',exitStatus:0,outOfBoundsPaths:[]},outputs:{[FACE_CANDIDATE_PREVIEW_MANIFEST]:hash(readFileSync(join(f.root,FACE_CANDIDATE_PREVIEW_MANIFEST)))},unitySteps:[{method:'AVH.Harness.FacePreviewStage.RenderCandidates',exitCode:0}]};
  db.prepare("INSERT INTO run(id,task_id,attempt,status,result_json) VALUES('face-run','face-task',1,'exited',?)").run(JSON.stringify(result));
  db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason) VALUES('workflow','runtime','run','face-run','unity_unit_intended','declared consumer fixture')").run();
  assert.throws(()=>projectFaceCandidatePreview(db,'project','workflow'),/数学验证尚无受管/);
  db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason) VALUES('workflow','provider','run','face-run','prepare_unit_intended','producer claim is not authority')").run();
  assert.throws(()=>projectFaceCandidatePreview(db,'project','workflow'),/数学验证尚无受管/);
  db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason) VALUES('workflow','runtime','run','face-run','prepare_unit_intended','declared consumer fixture')").run();
  for(const prepare of [undefined,{status:'started',exitStatus:0,outOfBoundsPaths:[]},{status:'finished',exitStatus:1,outOfBoundsPaths:[]},
    {status:'finished',exitStatus:0,errorClass:'tool_failure',outOfBoundsPaths:[]},{status:'finished',exitStatus:0,outOfBoundsPaths:['Assets/Original.prefab']}]){
    db.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify({...result,prepare}),'face-run');
    assert.throws(()=>projectFaceCandidatePreview(db,'project','workflow'),/数学验证尚无受管/);
  }
  db.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify(result),'face-run');
  const preview=projectFaceCandidatePreview(db,'project','workflow');assert.equal(preview.status,'ready');if(preview.status!=='ready')throw new Error('not ready');
  assert.equal(preview.expectedHash,'actual-set-artifact');assert.equal(projectFaceCandidatePreviewImage(db,'project','workflow',preview.previewSha256,'candidate-0-front').dataUrl,'data:image/png;base64,'+png().toString('base64'));
  const choice=validateFaceChoice(db,'workflow','choice','actual-set-artifact',{candidateId:'soft',candidateSetSha256:preview.candidateSetSha256,previewSha256:preview.previewSha256});
  db.prepare("INSERT INTO gate_decision(workflow_id,gate_id,artifact_hash,result,selection_json) VALUES('workflow','choice','actual-set-artifact','chosen',?)").run(JSON.stringify(choice));
  const dispatched=faceSelectionForDispatch(db,'workflow','choice','face_candidates'),selectionPath=join(f.root,'_harness/face/selection.json');
  const metadata=()=>{const s=statSync(selectionPath,{bigint:true});return [s.size,s.mtimeNs,s.ino];};
  const before=metadata();
  assert.deepEqual(faceSelectionForDispatch(db,'workflow','choice','face_candidates'),dispatched);
  assert.deepEqual(metadata(),before,'reconstructing a router must leave the authorized selection scan metadata unchanged');
  writeFileSync(selectionPath,'model-written choice');
  assert.deepEqual(faceSelectionForDispatch(db,'workflow','choice','face_candidates'),dispatched,'only the actual human decision may rebuild a changed projection');
  assert.throws(()=>projectFaceCandidatePreviewImage(db,'project','workflow','0'.repeat(64),'candidate-0-front'),/版本已变化/);
  f.put(f.tool.path,'changed external frozen source');assert.throws(()=>projectFaceCandidatePreview(db,'project','workflow'),/变化/);
  f.put(f.tool.path,'declared unit tool fixture');f.put(f.installed.path,'changed installed source');assert.throws(()=>projectFaceCandidatePreview(db,'project','workflow'),/变化/);
});
test('preview binds exact current source, candidate, frozen design and all actual images without aesthetic acceptance', t => {
  const f = fixture(t), before = readFileSync(join(f.root, f.manifest.bindings.candidate.path));
  const preview = readFacePreview(f.root); assert.equal(preview.images.length, 4); assert.equal(preview.visuallyAccepted, false);
  assert.equal(preview.candidates.length, 1); assert.equal(preview.candidates[0]!.id, f.manifest.bindings.output.sha256);
  assert.deepEqual(readFileSync(join(f.root, f.manifest.bindings.candidate.path)), before, 'readback is read-only');
});
test('Unity historical design inputs without mode use the same explicit design default as the actual consumer', t => {
  const f = fixture(t), input = JSON.parse(readFileSync(join(f.root,f.manifest.bindings.input.path),'utf8')); delete input.mode;
  f.manifest.bindings.input = f.put(f.manifest.bindings.input.path,JSON.stringify(input));
  const output = JSON.parse(readFileSync(join(f.root,f.manifest.bindings.output.path),'utf8')); output.inputSha256=f.manifest.bindings.input.sha256;
  f.manifest.bindings.output=f.put(f.manifest.bindings.output.path,JSON.stringify(output));f.save();
  assert.equal(readFacePreview(f.root).mode,'design');
});
test('changed design/output/source/dependencies/images and unsafe paths are rejected with no substitute pictures', async t => {
  for (const fault of ['design', 'output', 'source', 'mesh', 'image', 'missing-view', 'omitted-mesh', 'escape', 'link']) await t.test(fault, sub => {
    const f = fixture(sub);
    if (fault === 'design') f.put(f.manifest.bindings.input.path, '{}');
    if (fault === 'output') f.put(f.manifest.bindings.output.path, '{}');
    if (fault === 'source') f.put(f.manifest.bindings.source.path, 'changed');
    if (fault === 'mesh') f.put(f.manifest.dependencies[2]!.path, 'changed');
    if (fault === 'image') f.put(f.manifest.images[0]!.path, png(true));
    if (fault === 'missing-view') { f.manifest.images.pop(); f.save(); }
    if (fault === 'omitted-mesh') { f.manifest.dependencies.pop(); f.save(); }
    if (fault === 'escape') { f.manifest.images[0]!.path = '../private.png'; f.save(); }
    if (fault === 'link') {
      const outside = mkdtempSync(join(tmpdir(), 'avh-preview-outside-')); sub.after(() => removeTemp(outside)); writeFileSync(join(outside, 'private.png'), png());
      symlinkSync(outside, join(f.root, '_harness/face/preview/linked'), process.platform === 'win32' ? 'junction' : 'dir');
      f.manifest.images[0]!.path = '_harness/face/preview/linked/private.png'; f.save();
    }
    assert.throws(() => readFacePreview(f.root));
  });
});
test('project consumer returns only current image identities, rejects cross-project/workflow access and stale version requests', t => {
  const f = fixture(t), db = openDatabase(join(f.root, 'state.db')); t.after(() => db.close());
  db.prepare('INSERT INTO workspace(id,path) VALUES(?,?)').run('workspace', dirname(f.root));
  db.prepare("INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version) VALUES('project','workspace','sample',?,'{}','active','test','test')").run(f.root);
  db.prepare("INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json) VALUES('workflow','project','face','hash','test','active','{}')").run();
  db.prepare("INSERT INTO artifact_version(workflow_id,kind,hash) VALUES('workflow','face','actual-face-artifact')").run();
  assert.throws(() => projectFacePreview(db, 'project', 'workflow'), /受管渲染/);
  db.prepare("INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES('face-task','workflow','face','preview','test','FAILED')").run();
  const result = {exitStatus:0,outputs:{[FACE_PREVIEW_MANIFEST]:hash(readFileSync(join(f.root,FACE_PREVIEW_MANIFEST)))},
    unitySteps:[{method:'AVH.Harness.FacePreviewStage.Render',exitCode:0}]};
  db.prepare("INSERT INTO run(id,task_id,attempt,status,result_json) VALUES('face-run','face-task',1,'exited',?)").run(JSON.stringify(result));
  assert.throws(() => projectFacePreview(db, 'project', 'workflow'), /绑定当前/);
  db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason) VALUES('workflow','runtime','run','face-run','unity_unit_intended','test fixture')").run();
  const preview = projectFacePreview(db, 'project', 'workflow'); assert.equal(preview.status, 'ready'); if (preview.status !== 'ready') throw new Error('not ready');
  assert.equal(preview.faceArtifactHash, 'actual-face-artifact');
  const image = projectFacePreviewImage(db, 'project', 'workflow', preview.previewSha256, 'after-front');
  assert.equal(image.dataUrl, 'data:image/png;base64,' + png().toString('base64'));
  assert.throws(() => projectFacePreview(db, 'another', 'workflow'), /所属制作流程/);
  assert.throws(() => projectFacePreviewImage(db, 'project', 'workflow', '0'.repeat(64), 'after-front'), /版本已变化/);
  assert.throws(() => projectFacePreviewImage(db, 'project', 'workflow', preview.previewSha256, '../private.png'), /版本已变化/);
  const acceptance=validateFaceAcceptance(db,'workflow','actual-face-artifact',{previewSha256:preview.previewSha256});
  assert.equal(acceptance.schema,'face-output-acceptance/0.1');
  assert.throws(()=>validateFaceAcceptance(db,'workflow','old-artifact',{previewSha256:preview.previewSha256}),/已变化/);
  assert.throws(()=>validateFaceAcceptance(db,'workflow','actual-face-artifact',{previewSha256:'0'.repeat(64)}),/已变化/);
  db.prepare("INSERT INTO workflow_definition(workflow_id,profile,definition_json,capabilities_json,thresholds_json,tools_json,tool_root) VALUES('workflow','fixture',?,'{}','{}','{}',?)")
    .run(JSON.stringify({gates:[{id:'appearance',review:'face-output',kind:'approve',binds:'face'}]}),f.root);
  const saveDecision=(saved:unknown,result='approved')=>db.prepare("INSERT INTO gate_decision(workflow_id,gate_id,artifact_hash,result,selection_json) VALUES('workflow','appearance','actual-face-artifact',?,?)").run(result,JSON.stringify(saved));
  for(const saved of [{schema:'face-output-acceptance/0.1',artifactHash:'old-artifact',previewSha256:preview.previewSha256},
    {...acceptance,previewSha256:'0'.repeat(64)},{}]){
    saveDecision(saved);assert.equal((projectFacePreview(db,'project','workflow') as {visuallyAccepted:boolean}).visuallyAccepted,false);
  }
  saveDecision(acceptance);assert.equal((projectFacePreview(db,'project','workflow') as {visuallyAccepted:boolean}).visuallyAccepted,true);
  assert.equal(readFacePreview(f.root).visuallyAccepted,false,'filesystem receipts cannot accept their own appearance');
  saveDecision(acceptance,'done');assert.equal((projectFacePreview(db,'project','workflow') as {visuallyAccepted:boolean}).visuallyAccepted,false);
  for(const path of [f.manifest.images[0]!.path,f.manifest.bindings.output.path]){
    const bytes=readFileSync(join(f.root,path));f.put(path,Buffer.concat([bytes,Buffer.from('changed')]));
    assert.throws(()=>validateFaceAcceptance(db,'workflow','actual-face-artifact',{previewSha256:preview.previewSha256}));f.put(path,bytes);
  }
  const oldInput=f.manifest.bindings.input,oldOutput=f.manifest.bindings.output;
  const input=JSON.parse(readFileSync(join(f.root,oldInput.path),'utf8'));input.mode='preserve';
  f.manifest.bindings.input=f.put(oldInput.path,JSON.stringify(input));
  const output=JSON.parse(readFileSync(join(f.root,oldOutput.path),'utf8'));output.mode='preserve';output.inputSha256=f.manifest.bindings.input.sha256;
  f.manifest.bindings.output=f.put(oldOutput.path,JSON.stringify(output));f.save();
  db.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify({...result,outputs:{[FACE_PREVIEW_MANIFEST]:hash(readFileSync(join(f.root,FACE_PREVIEW_MANIFEST)))}}),'face-run');
  const preserved=projectFacePreview(db,'project','workflow');assert.equal(preserved.status,'ready');if(preserved.status!=='ready')throw new Error('missing preserved preview');
  assert.throws(()=>validateFaceAcceptance(db,'workflow','actual-face-artifact',{previewSha256:preserved.previewSha256}),/已变化/);
  // Restore the frozen design fixture before exercising managed-render failures below.
  input.mode='design';f.put(oldInput.path,JSON.stringify(input));output.mode='design';output.inputSha256=oldInput.sha256;f.put(oldOutput.path,JSON.stringify(output));
  f.manifest.bindings.input=oldInput;f.manifest.bindings.output=oldOutput;f.save();
  for (const changed of [{...result,exitStatus:1},{...result,outputs:{}},{...result,unitySteps:[{method:'AVH.Harness.FaceStage.Apply',exitCode:0}]},
    {...result,outOfBoundsPaths:['unknown']},{...result,unitySteps:[{method:'AVH.Harness.FacePreviewStage.Render',exitCode:0,timedOut:true}]}]) {
    db.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify(changed),'face-run');
    assert.throws(() => projectFacePreview(db,'project','workflow'),/绑定当前/);
  }
});


function authorityCandidateFixture(t:TestContext){
 const f=candidateFixture(t),base='Assets/_Harness/Face/Catalogs/'+'a'.repeat(64),bin=f.put(base+'/effective/frames/frame.bin',Buffer.alloc(12)),nativeBin=f.put(base+'/frames/native.bin',Buffer.alloc(12)),unityBin=f.put('_harness/face/source-evidence/frame.bin',Buffer.alloc(12));
 const asRef=(value:{path:string;sha256:string})=>({file:value.path,sha256:value.sha256});const vector=(value:{path:string;sha256:string})=>({...asRef(value),encoding:'float32-le',count:1});
 const effective=f.put(base+'/effective/source-evidence.json',JSON.stringify({schema:'face-blender-source-evidence/0.1',meshes:[{keys:[{coordinates:vector(bin),cornerNormals:[],vertexNormals:[]}]}]}));
 const native=f.put(base+'/source-evidence.json',JSON.stringify({schema:'face-blender-source-evidence/0.1',meshes:[{keys:[{coordinates:vector(nativeBin),cornerNormals:[],vertexNormals:[]}]}]}));
 const frame=f.put('_harness/face/source-evidence/frame.json',JSON.stringify({schema:'face-unity-frame-evidence/0.1',frames:[{frames:[{vertices:vector(unityBin),normals:vector(unityBin),tangents:vector(unityBin)}]}]}));
 const model=f.put('Assets/Source/model.fbx','declared decoder model fixture'),meta=f.put('Assets/Source/model.fbx.meta','fixture meta'),sourceModel={...model,metaSha256:meta.sha256};
 const observed=JSON.parse(readFileSync(join(f.root,f.manifest.bindings.observation.path),'utf8'));Object.assign(observed.targets[0],{mesh:sourceModel,meshSha256:'b'.repeat(64),frameEvidence:asRef(frame)});
 const observation=f.put(f.manifest.bindings.observation.path,JSON.stringify(observed));f.manifest.bindings.observation=observation;
 const source=f.put(base+'/effective/effective-source.blend','declared effective source'),authority=f.put(base+'/effective/source-authority.json',JSON.stringify({schema:'face-unity-imported-source/0.1',productionAccepted:false,targetId:f.collection.targetId,meshSha256:'b'.repeat(64),sourceModel,observation:asRef(observation),unityFrameEvidence:asRef(frame),effectiveSource:asRef(source),effectiveEvidence:asRef(effective),originalBlenderCatalog:{...f.collection.blenderCatalog},originalBlenderEvidence:asRef(native)}));
 const collection={...f.collection,observationSha256:observation.sha256,sourceAuthority:asRef(authority)};
 const update=()=>{const raw=JSON.stringify(collection);f.manifest.bindings.collection=f.put('_harness/face/candidates.json',raw);f.put('Assets/_Harness/Face/CandidateSets/set/candidate-set.json',raw);const input=JSON.parse(readFileSync(join(f.root,f.manifest.bindings.input.path),'utf8'));input.collectionSha256=f.manifest.bindings.collection.sha256;input.observationSha256=observation.sha256;f.manifest.bindings.input=f.put(f.manifest.bindings.input.path,JSON.stringify(input));for(const candidate of f.manifest.candidates)candidate.revisionSha256=f.manifest.bindings.collection.sha256;f.save();};
 f.manifest.references.push(...[authority,observation,frame,source,effective,native,model,meta,bin,nativeBin,unityBin]);update();
 return{...f,collection,authority,bin,nativeBin,unityBin,effective,native,frame,model,meta,source,update};
}

test('effective Unity source authority freezes each source revision and actual binary frame dependency',async t=>{
 for(const fault of ['none','authority','effective','native','frame','model','meta','source','bin','nativeBin','unityBin','omitted-binary','coexistent-mapping','false-target'])await t.test(fault,sub=>{
  const f=authorityCandidateFixture(sub);if(fault==='none'){assert.equal(readFaceCandidatePreview(f.root).status,'ready');return;}
  if(['authority','effective','native','frame','model','meta','source','bin','nativeBin','unityBin'].includes(fault))f.put((f as any)[fault].path,'changed');
  if(fault==='omitted-binary'){f.manifest.references=f.manifest.references.filter(ref=>ref.path!==f.nativeBin.path);f.save();}
  if(fault==='coexistent-mapping'){Object.assign(f.collection,{sourceMapping:{file:f.authority.path,sha256:f.authority.sha256}});f.update();}
  if(fault==='false-target'){const authority=JSON.parse(readFileSync(join(f.root,f.authority.path),'utf8'));authority.targetId='other';const changed=f.put(f.authority.path,JSON.stringify(authority));f.collection.sourceAuthority.sha256=changed.sha256;const old=f.manifest.references.find(ref=>ref.path===f.authority.path)!;old.sha256=changed.sha256;f.update();}
  assert.throws(()=>readFaceCandidatePreview(f.root));
 });
});
