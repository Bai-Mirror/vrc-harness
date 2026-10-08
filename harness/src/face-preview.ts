import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { inflateSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { buildAggregateInput } from './state/aggregate-input.ts';
import { projectRoot } from './archive/takeover.ts';
import { pendingNativeImport } from './workflow/native-import.ts';
import { fileHash } from './workflow/artifacts.ts';
import { checkedPreviewFile, previewFail, previewFile } from './preview-files.ts';

export const FACE_PREVIEW_MANIFEST = '_harness/face/preview/manifest.json';
export const FACE_CANDIDATE_PREVIEW_MANIFEST = '_harness/face/candidate-preview/manifest.json';
const INPUT = 'Assets/_Harness/Face/design.json', OUTPUT = '_harness/face/output.json', OBSERVATION = '_harness/face/observation.json';
// A measured commercial source with 821 blend keys and multiple renderers produces 41 MB of source facts.
// This bounded local read never returns source geometry through the GUI API.
const MAX_OBSERVATION_BYTES = 128 * 1024 * 1024;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
/** Every refusal from this reader names the face preview, so a person can tell which picture is missing. */
const LABEL = '脸型预览不可用';
function fail(message: string): never { previewFail(LABEL, message); }
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('报告格式无效');
  return value as Record<string, any>;
}
function checkedFile(root: string, path: unknown, maxBytes: number): string {
  return checkedPreviewFile(root, path, maxBytes, LABEL);
}
function file(root: string, path: unknown, maxBytes = 32 * 1024 * 1024): Buffer {
  return previewFile(root, path, maxBytes, LABEL);
}

function boundFile(root: string, value: unknown): { path: string; sha256: string } {
  const record = object(value); if (!digest(record.sha256)) fail('文件摘要无效');
  if (hash(file(root, record.path, 256 * 1024 * 1024)) !== record.sha256) fail('工程产物已变化，请重新生成预览');
  return { path: record.path, sha256: record.sha256 };
}
/** Source-only binary dependencies are hashed in bounded chunks, never returned to the browser. */
function boundSourceFile(root:string,value:unknown,maxBytes=2*1024*1024*1024):{path:string;sha256:string}{
 const reference=object(value);if(!digest(reference.sha256))fail('源文件摘要无效');
 const path=checkedFile(root,reference.path,maxBytes),before=lstatSync(path),handle=openSync(path,'r'),buffer=Buffer.alloc(65536),sha=createHash('sha256');let count=0;
 try{let length;while((length=readSync(handle,buffer,0,buffer.length,null))>0){count+=length;if(count>maxBytes)fail('源文件过大');sha.update(buffer.subarray(0,length));}}finally{closeSync(handle);}
 const after=lstatSync(path);if(count!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||sha.digest('hex')!==reference.sha256)fail('预览的实际源依赖已变化');
 return{path:reference.path,sha256:reference.sha256};
}
function sourceAuthorityReferences(project:string,holder:Record<string,any>,observed:Record<string,any>,targetId:string):Map<string,string>{
 const references=new Map<string,string>();if(holder.route==='native-fbx/1'&&(holder.sourceAuthority||holder.sourceMapping))fail('原生 FBX 候选不能使用旧重建源');if(holder.sourceAuthority&&holder.sourceMapping)fail('有效源与原始源映射不能同时使用');if(!holder.sourceAuthority)return references;
 const put=(fileRef:unknown,prefix:string)=>{const ref=object(fileRef);if(typeof ref.file!=='string'||!ref.file.startsWith(prefix))fail('有效源依赖路径无效');const bound=boundSourceFile(project,{path:ref.file,sha256:ref.sha256});if(references.has(bound.path)&&references.get(bound.path)!==bound.sha256)fail('有效源依赖版本冲突');references.set(bound.path,bound.sha256);return bound;};
 const authorityRef=put(holder.sourceAuthority,'Assets/_Harness/Face/Catalogs/'),authority=object(JSON.parse(file(project,authorityRef.path,2*1024*1024).toString('utf8')));
 const target=observed.targets?.find((value:any)=>value.targetId===targetId);if(!target||authority.schema!=='face-unity-imported-source/0.1'||authority.productionAccepted!==false||authority.targetId!==targetId||authority.meshSha256!==target.meshSha256||!isDeepStrictEqual(authority.sourceModel,target.mesh))fail('有效源身份与实际观测不一致');
 if(object(authority.observation).file!==OBSERVATION||object(authority.observation).sha256!==hash(file(project,OBSERVATION,MAX_OBSERVATION_BYTES))||!isDeepStrictEqual(authority.unityFrameEvidence,target.frameEvidence))fail('有效源绑定了其他观测版本');
 put(authority.observation,'_harness/face/');put(authority.unityFrameEvidence,'_harness/face/source-evidence/');
 for(const key of ['effectiveSource','effectiveEvidence','originalBlenderCatalog','originalBlenderEvidence'])put(authority[key],'Assets/_Harness/Face/Catalogs/');
 const source=object(authority.sourceModel);if(!String(source.path).startsWith('Assets/')||!digest(source.metaSha256))fail('实际源模型身份无效');
 for(const ref of [{path:source.path,sha256:source.sha256},{path:source.path+'.meta',sha256:source.metaSha256}]){const bound=boundSourceFile(project,ref);references.set(bound.path,bound.sha256);}
 const binary=(value:unknown,prefix:string)=>{if(Array.isArray(value))return;const ref=object(value);if(Object.keys(ref).sort().join(',')!=='count,encoding,file,sha256'||ref.encoding!=='float32-le'||!Number.isSafeInteger(ref.count)||ref.count<0||!String(ref.file).endsWith('.bin'))fail('源帧二进制引用无效');const bound=put(ref,prefix);if(lstatSync(join(project,bound.path)).size!==ref.count*12)fail('源帧二进制长度变化');};
 for(const key of ['effectiveEvidence','originalBlenderEvidence']){const data=object(JSON.parse(file(project,object(authority[key]).file,MAX_OBSERVATION_BYTES).toString('utf8')));if(data.schema!=='face-blender-source-evidence/0.1'||!Array.isArray(data.meshes))fail('有效源几何证据无效');for(const mesh of data.meshes){if(!Array.isArray(mesh.keys))fail('有效源形态键证据缺失');for(const shape of mesh.keys)for(const field of ['coordinates','cornerNormals','vertexNormals'])if(shape[field]!==undefined)binary(shape[field],'Assets/_Harness/Face/Catalogs/');}}
 const frame=object(JSON.parse(file(project,object(authority.unityFrameEvidence).file,MAX_OBSERVATION_BYTES).toString('utf8')));if(frame.schema!=='face-unity-frame-evidence/0.1'||!Array.isArray(frame.frames))fail('实际源帧证据无效');for(const shape of frame.frames){if(!Array.isArray(shape.frames))fail('实际源帧证据缺失');for(const item of shape.frames)for(const key of ['vertices','normals','tangents'])binary(item[key],'_harness/face/source-evidence/');}
 return references;
}
function verifySourceReferences(project:string,manifest:Record<string,any>,expected:Map<string,string>):void{
 if(!Array.isArray(manifest.references)||manifest.references.length!==expected.size)fail('有效源预览依赖未齐全');const pending=new Map(expected);for(const value of manifest.references){const ref=object(value);if(pending.get(ref.path)!==ref.sha256)fail('有效源预览依赖版本不一致');pending.delete(ref.path);boundSourceFile(project,ref);}
}
function crc(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
/**
 * Parse and decode the actual PNG. A signature, missing render, truncated file or flat background is not a preview.
 * `label` names the picture being read, so a refusal from another reader (recolour candidates, outfit photos) does not
 * claim the face preview failed.
 */
export function verifiedPreviewPng(bytes: Buffer, label = LABEL): { width: number; height: number } {
  function bad(message: string): never { return previewFail(label, message); }
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) bad('文件不是 PNG');
  let at = 8, width = 0, height = 0, channels = 0, ended = false; const data: Buffer[] = [];
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8), end = at + 12 + length;
    if (end > bytes.length || crc(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) bad('PNG 数据损坏');
    const chunk = bytes.subarray(at + 8, end - 4);
    if (type === 'IHDR') {
      if (at !== 8 || length !== 13) bad('PNG 图头无效');
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4); channels = chunk[9] === 6 ? 4 : chunk[9] === 2 ? 3 : 0;
      if (width < 128 || height < 128 || width > 2048 || height > 2048 || chunk[8] !== 8 || !channels || chunk[10] || chunk[11] || chunk[12]) bad('PNG 渲染规格无效');
    } else if (type === 'IDAT') data.push(chunk);
    else if (type === 'IEND') { if (length || end !== bytes.length) bad('PNG 结束数据无效'); ended = true; break; }
    at = end;
  }
  if (!ended || !width || !data.length) bad('PNG 不完整');
  const stride = width * channels; let decoded: Buffer;
  try { decoded = inflateSync(Buffer.concat(data), { maxOutputLength: (stride + 1) * height }); } catch { bad('PNG 像素无法读取'); }
  if (decoded.length !== (stride + 1) * height) bad('PNG 像素长度无效');
  let prior = Buffer.alloc(stride), different = 0; let first: string | undefined;
  for (let y = 0; y < height; y++) {
    const method = decoded[y * (stride + 1)]!, row = Buffer.from(decoded.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    if (method > 4) bad('PNG 像素过滤无效');
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels]! : 0, b = prior[x]!, c = x >= channels ? prior[x - channels]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      row[x] = (row[x]! + (method === 1 ? a : method === 2 ? b : method === 3 ? Math.floor((a + b) / 2) : method === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0)) & 255;
    }
    for (let x = 0; x < stride; x += channels) { const color = row.subarray(x, x + 3).toString('hex'); first ??= color; if (color !== first) different++; }
    prior = row;
  }
  if (different < 32) bad('没有可辨认的实际渲染内容');
  return { width, height };
}
export interface FacePreviewImage { id: string; version: 'before' | 'after'; view: 'front' | 'side' | 'eyes-half' | 'eyes-full'; sha256: string; width: number; height: number; candidateId?: string }
export interface FacePreview { status: 'ready'; previewSha256: string; mode: string; visuallyAccepted: boolean; images: FacePreviewImage[];
  candidates: Array<{ id: string; candidateId?: string; candidateNumber?: number; revisionSha256: string; outputSha256?: string; imageIds: string[] }>;
  workflowId?: string; faceArtifactHash?: string; candidateSetSha256?: string; expectedHash?: string; protocol: Record<string, unknown>; qualityReview?: FaceQualityReview;
  /** When the stage that rendered these pictures was recorded as complete; added by the project reader, not the file reader. */
  generatedAt?: string }
export interface FaceQualityReview {
  rawFindingCount:number;uniqueFindingCount:number;stateCount:number;groups:Array<Record<string,any>>;states:Array<Record<string,any>>;
  images:Array<Record<string,any>>;limitations:string[];
}
function readQualityReview(project:string,manifest:Record<string,any>,input:Record<string,any>):FaceQualityReview|undefined {
  if(!manifest.qualityReview)return;
  const reference=boundFile(project,manifest.qualityReview);
  if(!reference.path.startsWith('_harness/face/preview/')||!reference.path.endsWith('/quality-review.json'))fail('发现汇总路径无效');
  const review=object(JSON.parse(file(project,reference.path).toString('utf8'))),raw=object(review.verification),source=object(input.blenderVerification);
  if(review.schema!=='face-quality-review/0.1'||review.productionAccepted!==false||raw.path!==source.file||raw.sha256!==source.sha256)fail('发现汇总与独立复核版本不一致');
  // Match the independent native verification receipt domain. Hash in chunks;
  // raw flags remain local and are never returned through the preview API.
  boundSourceFile(project,raw,512*1024*1024);
  const count=(n:any)=>Number.isSafeInteger(n)&&n>=0;
  if(!count(review.rawFindingCount)||!count(review.uniqueFindingCount)||review.uniqueFindingCount>review.rawFindingCount||!count(review.stateCount)||
    !Array.isArray(review.groups)||!Array.isArray(review.states)||!Array.isArray(review.images)||!Array.isArray(review.limitations)||!review.limitations.every((s:any)=>typeof s==='string'))fail('发现汇总格式无效');
  if(review.states.reduce((n:number,r:any)=>n+r.rawCount,0)!==review.rawFindingCount||review.states.reduce((n:number,r:any)=>n+r.uniqueCount,0)!==review.uniqueFindingCount)fail('发现汇总丢失原始记录');
  const ids=new Set<string>();
  for(const value of review.images){const image=object(value);if(typeof image.id!=='string'||ids.has(image.id)||!['before','after'].includes(image.version)||!String(image.path).startsWith('_harness/face/preview/')||!String(image.path).endsWith('.png')||!digest(image.sha256)||!count(image.width)||!count(image.height)||image.width<128||image.width>2048||image.height<128||image.height>2048)fail('发现特写清单无效');
    if(fileHash(checkedFile(project,image.path,4*1024*1024))!==image.sha256)fail('发现特写已变化');ids.add(image.id);}
  for(const row of [...review.groups,...review.states])if(!count(row.rawCount)||!count(row.uniqueCount)||row.uniqueCount>row.rawCount||typeof row.region!=='string'||typeof row.kind!=='string'||typeof row.baseline!=='string')fail('发现分组格式无效');
  for(const row of review.groups)if(!Array.isArray(row.imageIds)||row.imageIds.length!==4||!row.imageIds.every((id:any)=>ids.has(id))||!['maximumChangeMm','maximumFootprintMm','estimatedChangePixels'].every(k=>Number.isFinite(row[k])&&row[k]>=0))fail('发现分组缺少特写或可见性估计');
  if(review.groups.reduce((n:number,r:any)=>n+r.rawCount,0)!==review.rawFindingCount||review.groups.reduce((n:number,r:any)=>n+r.uniqueCount,0)!==review.uniqueFindingCount)fail('区域类型汇总丢失原始记录');
  return {rawFindingCount:review.rawFindingCount,uniqueFindingCount:review.uniqueFindingCount,stateCount:review.stateCount,groups:review.groups,states:review.states,images:review.images,limitations:review.limitations};
}
/** Read-only evidence consumer: producer claims alone never supply an image or establish acceptance. */
export function readFacePreview(project: string): FacePreview {
  const manifestBytes = file(project, FACE_PREVIEW_MANIFEST, 2 * 1024 * 1024), manifest = object(JSON.parse(manifestBytes.toString('utf8')));
  if (manifest.schema !== 'face-preview/0.1' || manifest.productionAccepted !== false) fail('预览报告格式无效');
  const bindings = object(manifest.bindings);
  for (const [key, path] of [['input', INPUT], ['output', OUTPUT], ['observation', OBSERVATION]]) {
    if (object(bindings[key!]).path !== path) fail('预览绑定了其他产物'); boundFile(project, bindings[key!]);
  }
  const output = object(JSON.parse(file(project, OUTPUT).toString('utf8')));
  if (output.schema !== 'face-unity-output/0.1' || !['design', 'preserve'].includes(output.mode) || output.productionAccepted !== false ||
      output.inputSha256 !== bindings.input.sha256 || output.observationSha256 !== bindings.observation.sha256) fail('脸型输出版本未核清');
  const input = object(JSON.parse(file(project, INPUT).toString('utf8')));
  if (input.schema !== 'face-unity-design/0.1' || (input.mode === 'preserve' ? 'preserve' : 'design') !== output.mode || input.observationSha256 !== bindings.observation.sha256) fail('脸型设计版本无效');
  if (output.mode === 'design') for (const key of ['blenderCatalog', 'blenderDesign', 'candidateReceipt']) {
    const reference = object(input[key]); if (!String(reference.file).startsWith('Assets/_Harness/Face/')) fail('冻结设计来源无效');
    const binding={path:reference.file,sha256:reference.sha256};
    // Historical native receipts retain full production evidence. Verify their
    // frozen identity using the same bounded read domain as native preparation.
    if(key==='candidateReceipt')boundSourceFile(project,binding,512*1024*1024);
    else boundFile(project,binding);
  }
  if (object(bindings.source).path !== output.sourcePrefab || object(bindings.candidate).path !== output.avatar) fail('图片不是当前原型与候选');
  for (const key of ['source', 'candidate']) {
    if (!String(object(bindings[key]).path).startsWith('Assets/') || !String(object(bindings[key]).path).endsWith('.prefab')) fail('头像路径无效');
    boundFile(project, bindings[key]);
  }
  if (!Array.isArray(manifest.dependencies) || !manifest.dependencies.length || manifest.dependencies.length > 20000) fail('缺少源与候选依赖绑定');
  for (const dependency of manifest.dependencies) {
    if (!String(object(dependency).path).startsWith('Assets/')) fail('依赖路径无效'); boundFile(project, dependency);
  }
  const dependencyPaths = new Set(manifest.dependencies.map((value: unknown) => object(value).path));
  const observed = object(JSON.parse(file(project, OBSERVATION, MAX_OBSERVATION_BYTES).toString('utf8')));
  if (observed.schema !== 'face-unity-observation/0.1' || !Array.isArray(observed.dependencies)) fail('源模型观测无效');
  const authorityReferences=sourceAuthorityReferences(project,input,observed,output.targetId);if(authorityReferences.size)verifySourceReferences(project,manifest,authorityReferences);
  for (const value of observed.dependencies) {
    const dependency = object(value); boundFile(project, dependency);
    if (dependency.metaSha256) boundFile(project, { path: dependency.path + '.meta', sha256: dependency.metaSha256 });
  }
  const required = [output.sourcePrefab, output.avatar, ...observed.dependencies.map((value: unknown) => object(value).path),
    ...(output.mode === 'design' ? [output.deliveryMode === 'native-fbx-reference' ? object(output.candidateModel).path : dirname(output.avatar).replaceAll('\\', '/') + '/FaceMesh.asset'] : [])];
  for (const path of required) {
    if (!dependencyPaths.has(path) || (existsSync(join(project, path + '.meta')) && !dependencyPaths.has(path + '.meta'))) fail('源与候选依赖绑定不完整');
  }
  const protocol = object(manifest.protocol);
  if (protocol.camera !== 'orthographic' || protocol.pose !== 'prefab-defaults' || !Array.isArray(protocol.views) || protocol.views.join(',') !== 'front,side' ||
      !Array.isArray(protocol.center) || protocol.center.length !== 3 || !protocol.center.every(Number.isFinite) || !Number.isFinite(protocol.orthographicSize) || protocol.orthographicSize <= 0) fail('缺少共同构图协议');
  const nativeEyes = output.deliveryMode === 'native-fbx-reference' && input.route === 'native-fbx/1' &&
    object(JSON.parse(file(project, object(input.blenderDesign).file).toString('utf8'))).recipe?.compensation?.regions?.length === 2;
  if (!Array.isArray(manifest.images) || manifest.images.length !== (nativeEyes ? 8 : 4)) fail('原型与候选的正侧图片或眼部特写未齐全');
  const expected = new Set(['before-front', 'after-front', 'before-side', 'after-side', ...(nativeEyes ? ['before-eyes-half','after-eyes-half','before-eyes-full','after-eyes-full'] : [])]);
  if (nativeEyes) for (const version of ['before','after']) {
    const half = manifest.images.find((i:any)=>i.id===version+'-eyes-half'), full=manifest.images.find((i:any)=>i.id===version+'-eyes-full');
    if (!half || !full || !digest(half.poseSha256) || !digest(full.poseSha256) || half.poseSha256===full.poseSha256) fail('眼部半状态和完整状态缺少真实不同的蒙皮证据');
  }
  const images = manifest.images.map((value: unknown) => {
    const image = object(value), id = `${image.version}-${image.view}`;
    if (!expected.delete(id) || image.id !== id || !String(image.path).startsWith('_harness/face/preview/') || !String(image.path).endsWith('.png') || !digest(image.sha256)) fail('图片清单无效');
    const bytes = file(project, image.path, 4 * 1024 * 1024), size = verifiedPreviewPng(bytes);
    if (hash(bytes) !== image.sha256 || size.width !== image.width || size.height !== image.height) fail('预览图片已变化');
    return { id, version: image.version, view: image.view, sha256: image.sha256, ...size } as FacePreviewImage;
  });
  if (images.some(image => image.width !== images[0]!.width || image.height !== images[0]!.height)) fail('前后图片规格不一致');
  const qualityReview=readQualityReview(project,manifest,input);
  let identity: {candidateId?:string;candidateNumber?:number} = {};
  if (output.mode === 'design' && input.candidateId !== undefined) {
    const setPath = /^Assets\/_Harness\/Face\/CandidateSets\/([^/]+)\//.exec(String(input.blenderDesign.file));
    if (!setPath || typeof input.candidateId !== 'string' || !digest(input.candidateSetSha256)) fail('选定候选身份不完整');
    const frozen = boundFile(project, {path:`Assets/_Harness/Face/CandidateSets/${setPath[1]}/candidate-set.json`,sha256:input.candidateSetSha256});
    const set = object(JSON.parse(file(project, frozen.path).toString('utf8')));
    if (set.schema !== 'face-candidate-set/0.1' || !Array.isArray(set.candidates) ||
        set.candidates.filter((candidate:any)=>candidate.id===input.candidateId).length!==1) fail('选定候选不在冻结集合中');
    identity = {candidateId:input.candidateId,candidateNumber:set.candidates.findIndex((candidate:any)=>candidate.id===input.candidateId)+1};
  }
  return { status: 'ready', previewSha256: hash(manifestBytes), mode: output.mode, visuallyAccepted: false, images, protocol,...(qualityReview?{qualityReview}:{}),
    candidates: [{ id: bindings.output.sha256, ...identity, revisionSha256: bindings.input.sha256, outputSha256: bindings.output.sha256,
      imageIds: images.filter(image => image.version === 'after').map(image => image.id) }] };
}
function projectContext(db: DatabaseSync, projectId: string, workflowId: string) {
  const row = db.prepare('SELECT p.path FROM project p JOIN workflow w ON w.project_id=p.id WHERE p.id=? AND w.id=?').get(projectId, workflowId);
  if (!row) fail('找不到所属制作流程'); return projectRoot(db, projectId);
}
function temporaryImportPreview(db:DatabaseSync,workflowId:string,project:string):{status:'missing';reason:string}|undefined {
  const location=String(db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file??'');if(!location)return;
  const run=db.prepare(`SELECT r.id FROM run r JOIN task t ON t.id=r.task_id WHERE t.workflow_id=?
    AND t.status IN ('RUNNING','RECOVERY_REQUIRED') AND r.status='running' AND EXISTS(SELECT 1 FROM event e WHERE e.entity_type='run' AND e.entity_id=r.id
    AND e.actor='runtime' AND e.action='unity_unit_intended') ORDER BY r.rowid DESC LIMIT 1`).get(workflowId);
  if(!run)return;
  try{if(pendingNativeImport(project,join(dirname(dirname(location)),'runs',String(run.id))))return{status:'missing',reason:'Unity 正在比较选定候选的临时导入，源文件恢复后原预览会重新可用。你仍可随时停止制作。'};}catch{/* An unbound source edit remains a stale preview. */}
}
/** When the stage that produced one picture set was recorded as complete, for the preview's source line. */
function stageRecordedAt(db: DatabaseSync, workflowId: string, stageId: string): string | undefined {
  const row = db.prepare('SELECT recorded_at AS recordedAt FROM stage_completion WHERE workflow_id = ? AND stage_id = ? ORDER BY seq DESC LIMIT 1')
    .get(workflowId, stageId) as { recordedAt: string } | undefined;
  return row?.recordedAt;
}
export function projectFacePreview(db: DatabaseSync, projectId: string, workflowId: string): FacePreview | { status: 'missing'; reason: string } {
  const root = projectContext(db, projectId, workflowId);
  const temporary=temporaryImportPreview(db,workflowId,root);if(temporary)return temporary;
  if (!existsSync(join(root, FACE_PREVIEW_MANIFEST))) return { status: 'missing', reason: '实际脸型前后图尚未生成，不能确认效果。' };
  const preview = readFacePreview(root); trustedRender(db, workflowId, preview.previewSha256);
  const faceArtifactHash = buildAggregateInput(db, workflowId).artifactHashes.face;
  let visuallyAccepted = false;
  const definition = db.prepare('SELECT definition_json FROM workflow_definition WHERE workflow_id=?').get(workflowId);
  if (definition && faceArtifactHash && preview.mode === 'design') {
    const gates = JSON.parse(String(definition.definition_json)).gates;
    for (const gate of Array.isArray(gates) ? gates : []) {
      if (gate.review !== 'face-output' || gate.kind !== 'approve' || gate.binds !== 'face') continue;
      const decision = db.prepare('SELECT artifact_hash,result,selection_json FROM gate_decision WHERE workflow_id=? AND gate_id=? ORDER BY seq DESC LIMIT 1').get(workflowId, gate.id);
      if (!decision || decision.result !== 'approved' || decision.artifact_hash !== faceArtifactHash || !decision.selection_json) continue;
      try {
        const saved = JSON.parse(String(decision.selection_json));
        visuallyAccepted ||= saved.schema === 'face-output-acceptance/0.1' && saved.artifactHash === faceArtifactHash && saved.previewSha256 === preview.previewSha256;
      } catch { /* Incomplete historical decisions never establish appearance acceptance. */ }
    }
  }
  const generatedAt = stageRecordedAt(db, workflowId, 'face');
  return { ...preview, visuallyAccepted, workflowId, ...(faceArtifactHash ? { faceArtifactHash } : {}), ...(generatedAt ? { generatedAt } : {}) };
}
/** Current face execution, not an unrelated prior render or a Provider-supplied PNG. */
function trustedRender(db: DatabaseSync, workflowId: string, previewSha256: string, stage='face', method='AVH.Harness.FacePreviewStage.Render', manifestPath=FACE_PREVIEW_MANIFEST): void {
  const task = db.prepare('SELECT id FROM task WHERE workflow_id=? AND stage_id=? ORDER BY rowid DESC LIMIT 1').get(workflowId,stage);
  const run = task && db.prepare('SELECT id,status,result_json FROM run WHERE task_id=? ORDER BY attempt DESC LIMIT 1').get(task.id!);
  if (!run || run.status !== 'exited' || !run.result_json) fail('当前制作尚无受管渲染完成记录');
  const result = object(JSON.parse(String(run.result_json)));
  if(stage==='face_design'){
    const prepare=result.prepare&&object(result.prepare);
    if(!prepare||prepare.status!=='finished'||prepare.exitStatus!==0||prepare.errorClass||!Array.isArray(prepare.outOfBoundsPaths)||prepare.outOfBoundsPaths.length||
      !db.prepare("SELECT 1 FROM event WHERE workflow_id=? AND actor='runtime' AND entity_type='run' AND entity_id=? AND action='prepare_unit_intended' LIMIT 1").get(workflowId,run.id!))fail('候选数学验证尚无受管完成记录');
  }
  if (result.exitStatus !== 0 || result.errorClass || (result.outOfBoundsPaths?.length ?? 0) ||
      !Array.isArray(result.unitySteps) || !result.unitySteps.some((step: any) => step.method === method && step.exitCode === 0 && !step.timedOut && step.status !== 'not_started') ||
      !db.prepare("SELECT 1 FROM event WHERE workflow_id=? AND actor='runtime' AND entity_type='run' AND entity_id=? AND action='unity_unit_intended' LIMIT 1").get(workflowId, run.id!) ||
      result.outputs?.[manifestPath] !== previewSha256) fail('实际图片尚未绑定当前受管渲染结果');
}
export function projectFacePreviewImage(db: DatabaseSync, projectId: string, workflowId: string, previewSha256: string, id: string) {
  return projectFacePreviewImages(db,projectId,workflowId,previewSha256,[id])[0]!;
}
/** Validate all dependencies once per bounded batch; every image still binds the frozen preview and its own bytes. */
export function projectFacePreviewImages(db:DatabaseSync,projectId:string,workflowId:string,previewSha256:string,ids:string[]) {
  const root=projectContext(db,projectId,workflowId),preview=projectFacePreview(db,projectId,workflowId);
  if(preview.status!=='ready')fail(preview.reason);
  if(!Array.isArray(ids)||!ids.length||ids.length>8||new Set(ids).size!==ids.length)fail('图片读取批次无效');
  return ids.map(id=>readPreviewImage(root,preview,previewSha256,id));
}
function readPreviewImage(root:string,preview:FacePreview,previewSha256:string,id:string) {
  const detail=preview.qualityReview?.images.find(image=>image.id===id);
  if (!digest(previewSha256) || preview.previewSha256 !== previewSha256 || (!preview.images.some(image => image.id === id)&&!detail)) fail('预览版本已变化，请刷新');
  const manifestBytes = file(root, FACE_PREVIEW_MANIFEST);
  if (hash(manifestBytes) !== previewSha256) fail('预览在读取期间发生变化');
  const manifest = object(JSON.parse(manifestBytes.toString('utf8'))), image = detail??manifest.images.find((value: any) => value.id === id);
  const bytes = file(root, image.path, 4 * 1024 * 1024);
  if (hash(bytes) !== image.sha256) fail('图片在读取期间发生变化');
  const size=verifiedPreviewPng(bytes);if(size.width!==image.width||size.height!==image.height)fail('发现特写规格变化');
  return { id, previewSha256, sha256: image.sha256, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
}

/** Before selection: actual source key combinations, never a guessed baked candidate. */
export type FaceCandidatePreview = FacePreview & { mode:'candidates'; candidateSetSha256:string; expectedHash:string };
export function readFaceCandidatePreview(project:string): Omit<FaceCandidatePreview,'expectedHash'> {
  const bytes=file(project,FACE_CANDIDATE_PREVIEW_MANIFEST,2*1024*1024), manifest=object(JSON.parse(bytes.toString('utf8')));
  if(manifest.schema!=='face-candidate-preview/0.1'||manifest.productionAccepted!==false)fail('候选预览格式无效');
  const bindings=object(manifest.bindings), paths={collection:'_harness/face/candidates.json',input:'Assets/_Harness/Face/preview-input.json',observation:OBSERVATION,request:'_harness/face/request.json'};
  for(const [key,path]of Object.entries(paths)){if(object(bindings[key]).path!==path)fail('候选预览绑定了其他文件');boundFile(project,bindings[key]);}
  const collection=object(JSON.parse(file(project,paths.collection).toString('utf8'))),input=object(JSON.parse(file(project,paths.input).toString('utf8'))),observed=object(JSON.parse(file(project,OBSERVATION,MAX_OBSERVATION_BYTES).toString('utf8')));
  if(collection.schema!=='face-candidate-set/0.1'||collection.productionAccepted!==false||input.schema!=='face-preview-input/0.1'||input.collectionSha256!==bindings.collection.sha256||collection.observationSha256!==bindings.observation.sha256||input.observationSha256!==bindings.observation.sha256||collection.requestSha256!==bindings.request.sha256)fail('候选集合版本已变化');
  if(typeof collection.id!=='string'||!collection.id||/[\\/:\x00-\x1f]/.test(collection.id)||['.','..'].includes(collection.id))fail('候选集合标识无效');
  const immutable=`Assets/_Harness/Face/CandidateSets/${collection.id}/candidate-set.json`;
  if(hash(file(project,immutable))!==bindings.collection.sha256)fail('候选集合不可变副本不一致');
  if(collection.sourcePrefab!==input.sourcePrefab||collection.sourcePrefab!==object(bindings.source).path||collection.targetId!==input.targetId||!String(collection.sourcePrefab).startsWith('Assets/')||!String(collection.sourcePrefab).endsWith('.prefab'))fail('候选原型绑定无效');
  boundFile(project,bindings.source);
  if(observed.schema!=='face-unity-observation/0.1'||object(observed.sourcePrefab).path!==collection.sourcePrefab||!Array.isArray(observed.targets)||!observed.targets.some((target:any)=>target.targetId===collection.targetId)||!Array.isArray(observed.dependencies))fail('候选实际原型观测无效');
  if(!Array.isArray(collection.candidates)||collection.candidates.length<2||collection.candidates.length>5||!Array.isArray(input.candidates)||input.candidates.length!==collection.candidates.length)fail('需要两至五个实际候选');
  const ids=new Set<string>(), references=new Set<string>();
  const catalog=object(collection.blenderCatalog);if(catalog.file!=='Assets/_Harness/Face/catalog.json'&&!/^Assets\/_Harness\/Face\/Catalogs\/[a-f0-9]{64}\/catalog\.json$/.test(catalog.file))fail('候选冻结目录无效');boundFile(project,{path:catalog.file,sha256:catalog.sha256});references.add(catalog.file);
  const authorityReferences=sourceAuthorityReferences(project,collection,observed,collection.targetId);for(const path of authorityReferences.keys())references.add(path);
  if(collection.sourceMapping){const mapping=object(collection.sourceMapping);if(!String(mapping.file).startsWith('Assets/_Harness/Face/Catalogs/'))fail('候选源映射路径无效');boundFile(project,{path:mapping.file,sha256:mapping.sha256});references.add(mapping.file);}
  const same=(a:Record<string,any>,b:Record<string,any>)=>Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>a[key]===b[key]);
  const target=observed.targets.find((value:any)=>value.targetId===collection.targetId),knownKeys=new Set(object(target.meshSnapshot).keys.map((key:any)=>key.name));
  for(let index=0;index<collection.candidates.length;index++){
    const candidate=object(collection.candidates[index]),previewInput=object(input.candidates[index]);
    if(typeof candidate.id!=='string'||!candidate.id.trim()||candidate.id.length>128||ids.has(candidate.id)||previewInput.id!==candidate.id)fail('实际候选身份不一致');ids.add(candidate.id);
    const weights=object(candidate.weightsUnityPercent);if(!Object.keys(weights).length||!same(weights,object(previewInput.weightsUnityPercent))||Object.entries(weights).some(([key,value])=>!knownKeys.has(key)||!Number.isFinite(value)||target.protectedKeys.includes(key)))fail('实际候选形态键组合不一致');
    for(const key of ['design','validation']){const reference=object(candidate[key]);if(!String(reference.file).startsWith(`Assets/_Harness/Face/CandidateSets/${collection.id}/`))fail('候选记录越出冻结集合');boundFile(project,{path:reference.file,sha256:reference.sha256});references.add(reference.file);}
  }
  if(!Array.isArray(manifest.references)||manifest.references.length!==references.size)fail('候选冻结记录未齐全');
  for(const reference of manifest.references){const ref=object(reference);if(!references.delete(ref.path))fail('候选冻结记录重复或不属于当前集合');if(authorityReferences.has(ref.path)){if(authorityReferences.get(ref.path)!==ref.sha256)fail('有效源预览绑定了其他版本');boundSourceFile(project,ref);}else boundFile(project,ref);}
  const binary=object(collection.binary);if(!isAbsolute(binary.path)||!digest(binary.sha256)||hash(file(dirname(binary.path),basename(binary.path),512*1024*1024))!==binary.sha256)fail('候选执行工具已变化');
  if(!Array.isArray(manifest.dependencies)||!manifest.dependencies.length||manifest.dependencies.length>20000)fail('候选源依赖缺失');
  const dependencyPaths=new Set<string>();for(const value of manifest.dependencies){const ref=object(value);if(!String(ref.path).startsWith('Assets/'))fail('源依赖路径无效');boundFile(project,ref);dependencyPaths.add(ref.path);}
  for(const value of observed.dependencies){const ref=object(value);boundFile(project,ref);if(ref.metaSha256)boundFile(project,{path:ref.path+'.meta',sha256:ref.metaSha256});if(!dependencyPaths.has(ref.path)||(existsSync(join(project,ref.path+'.meta'))&&!dependencyPaths.has(ref.path+'.meta')))fail('候选源依赖绑定不完整');}
  if(!dependencyPaths.has(collection.sourcePrefab))fail('候选原型依赖未绑定');
  const protocol=object(manifest.protocol);if(protocol.camera!=='orthographic'||protocol.pose!=='prefab-defaults'||protocol.views?.join(',')!=='front,side'||!Array.isArray(protocol.center)||protocol.center.length!==3||!protocol.center.every(Number.isFinite)||!Number.isFinite(protocol.orthographicSize)||protocol.orthographicSize<=0)fail('缺少候选共同构图协议');
  if(!Array.isArray(manifest.candidates)||manifest.candidates.length!==ids.size||!Array.isArray(manifest.images)||manifest.images.length!==2+2*ids.size)fail('实际候选正侧图未齐全');
  const expectedImages=new Map<string,{version:'before'|'after';view:'front'|'side';candidateId?:string}>();
  for(const view of ['front','side'] as const)expectedImages.set('before-'+view,{version:'before',view});
  const candidates=manifest.candidates.map((value:unknown,index:number)=>{const candidate=object(value),id=collection.candidates[index].id,imageIds=['candidate-'+index+'-front','candidate-'+index+'-side'];if(candidate.id!==id||candidate.revisionSha256!==bindings.collection.sha256||candidate.imageIds?.join(',')!==imageIds.join(','))fail('候选图片身份不一致');for(const view of ['front','side'] as const)expectedImages.set('candidate-'+index+'-'+view,{version:'after',view,candidateId:id});return{id,candidateId:id,candidateNumber:index+1,revisionSha256:bindings.collection.sha256,imageIds};});
  const images=manifest.images.map((value:unknown)=>{const image=object(value),expected=expectedImages.get(image.id);if(!expected||image.version!==expected.version||image.view!==expected.view||image.candidateId!==expected.candidateId||!String(image.path).startsWith('_harness/face/candidate-preview/')||!String(image.path).endsWith('.png')||!digest(image.sha256))fail('候选图片清单无效');expectedImages.delete(image.id);const data=file(project,image.path,4*1024*1024),size=verifiedPreviewPng(data);if(hash(data)!==image.sha256||size.width!==image.width||size.height!==image.height)fail('候选图片已变化');return{id:image.id,...expected,sha256:image.sha256,...size};});
  if(images.some(image=>image.width!==images[0]!.width||image.height!==images[0]!.height))fail('候选图片规格不一致');
  return{status:'ready',mode:'candidates',visuallyAccepted:false,previewSha256:hash(bytes),candidateSetSha256:bindings.collection.sha256,images,candidates,protocol};
}

export function projectFaceCandidatePreview(db:DatabaseSync,projectId:string,workflowId:string):FaceCandidatePreview|{status:'missing';reason:string}{
  const root=projectContext(db,projectId,workflowId);
  const temporary=temporaryImportPreview(db,workflowId,root);if(temporary)return temporary;
  if(!existsSync(join(root,FACE_CANDIDATE_PREVIEW_MANIFEST)))return{status:'missing',reason:'实际多方案正侧图尚未生成，不能选择效果。'};
  const preview=readFaceCandidatePreview(root);trustedRender(db,workflowId,preview.previewSha256,'face_design','AVH.Harness.FacePreviewStage.RenderCandidates',FACE_CANDIDATE_PREVIEW_MANIFEST);
  const collection=object(JSON.parse(file(root,'_harness/face/candidates.json').toString('utf8'))),tools=object(collection.tools);
  for(const candidate of collection.candidates){
    const design=object(JSON.parse(file(root,object(candidate.design).file).toString('utf8'))),validation=object(JSON.parse(file(root,object(candidate.validation).file).toString('utf8')));
    if(collection.route==='native-fbx/1'&&(design.route!==collection.route||validation.route!==collection.route||!String(design.source?.path).toLowerCase().endsWith('.fbx')))fail('原生 FBX 候选的源或验证路线不一致');
    if(design.schema!=='face-design/0.1'||typeof design.revisionId!=='string'||!design.revisionId||validation.schema!=='face-candidate-validation/0.1'||
      validation.status!==(collection.route==='native-fbx/1'?'shape_combination_validated':'mathematical_candidate_validated')||validation.productionAccepted!==false||validation.revisionId!==design.revisionId||validation.designFileSha256!==candidate.design.sha256)fail('候选数学验证尚未核清，实际图片不能代替工程资格');
  }
  const frozen=db.prepare('SELECT tools_json,tool_root FROM workflow_definition WHERE workflow_id=?').get(workflowId);if(!frozen)fail('候选执行工具未冻结');
  const frozenTools=object(JSON.parse(String(frozen.tools_json)));
  for(const [name,sha256]of Object.entries(tools)){
    const matches=Object.entries(frozenTools).filter(([path])=>basename(path)===name);if(matches.length!==1||matches[0]![1]!==sha256)fail('候选执行工具与流程冻结版本不一致');
    boundFile(String(frozen.tool_root),{path:matches[0]![0],sha256});
    if(name.endsWith('.cs'))boundFile(root,{path:'Assets/_HarnessTools/Editor/'+name,sha256});
  }
  if(!Object.keys(tools).length||!tools['FacePreviewStage.cs'])fail('缺少可信候选渲染工具');
  const expectedHash=buildAggregateInput(db,workflowId).artifactHashes.face_candidates;if(!expectedHash)fail('候选集合尚未记录当前版本');
  const generatedAt=stageRecordedAt(db,workflowId,'face_design');
  return{...preview,workflowId,expectedHash,...(generatedAt?{generatedAt}:{})};
}

export function projectFaceCandidatePreviewImage(db:DatabaseSync,projectId:string,workflowId:string,previewSha256:string,id:string){
  const preview=projectFaceCandidatePreview(db,projectId,workflowId);if(preview.status!=='ready'||!digest(previewSha256)||preview.previewSha256!==previewSha256||!preview.images.some(image=>image.id===id))fail('候选预览版本已变化，请刷新');
  const root=projectContext(db,projectId,workflowId),manifestBytes=file(root,FACE_CANDIDATE_PREVIEW_MANIFEST);if(hash(manifestBytes)!==previewSha256)fail('候选预览在读取期间发生变化');
  const manifest=object(JSON.parse(manifestBytes.toString('utf8'))),image=manifest.images.find((value:any)=>value.id===id),bytes=file(root,image.path,4*1024*1024);if(hash(bytes)!==image.sha256)fail('候选图片在读取期间发生变化');
  return{id,previewSha256,sha256:image.sha256,dataUrl:'data:image/png;base64,'+bytes.toString('base64')};
}
