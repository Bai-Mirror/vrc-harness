import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { projectRoot } from './archive/takeover.ts';
import { projectFaceCandidatePreview, projectFacePreview } from './face-preview.ts';
import { hostPlatform } from './host-platform.ts';
import { buildAggregateInput } from './state/aggregate-input.ts';
import { evidenceFresh, evidenceInputHashes } from './process/evidence.ts';
import type { ProcessDefinition } from './process/types.ts';

export interface FaceChoiceInput { candidateId: string; candidateSetSha256: string; previewSha256: string }
export interface FaceAcceptanceInput { previewSha256: string }
export interface FaceOutputAcceptance { schema: 'face-output-acceptance/0.1'; artifactHash: string; previewSha256: string }
interface Selection {
  schema: 'face-selection/0.1'; requestSha256: string; candidateSetSha256: string;
  observationSha256: string; targetId: string; candidateId: string; gateId: string;
}
interface FaceGateChoice { schema: 'face-gate-choice/0.1'; artifactHash: string; previewSha256: string; selection: Selection }
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function fail(message: string): never { throw new Error(`脸型选择未生效：${message}`); }
function plainPath(root: string, path: string, mustExist = true): string {
  if (/[\\:\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) fail('内部路径无效');
  let current = root;
  for (const part of ['', ...path.split('/')]) {
    if (part) current = join(current, part);
    if (!existsSync(current)) { if (!mustExist && current === join(root, path)) return current; fail('候选文件不见了'); }
    if (lstatSync(current).isSymbolicLink()) fail('候选文件路径包含链接');
  }
  return current;
}
function bytes(root: string, path: string, maxBytes = 8 * 1024 * 1024): Buffer {
  const file = plainPath(root, path), stat = lstatSync(file);
  if (!stat.isFile() || stat.size > maxBytes) fail('候选记录文件无效');
  const result = readFileSync(file); if (result.length > maxBytes) fail('候选记录过大'); return result;
}
function projectId(db: DatabaseSync, workflowId: string): string {
  const row = db.prepare('SELECT project_id FROM workflow WHERE id=?').get(workflowId);
  if (!row) fail('找不到制作流程'); return String(row.project_id);
}
/** A human may accept the actual rendered output, never a producer's self-declared qualification. */
export function validateFaceAcceptance(db: DatabaseSync, workflowId: string, artifactHash: string, review: FaceAcceptanceInput): FaceOutputAcceptance {
  if (!review || Object.keys(review).join(',') !== 'previewSha256' || !digest(review.previewSha256)) fail('请查看当前工程的实际效果后确认');
  const preview = projectFacePreview(db, projectId(db, workflowId), workflowId);
  if (preview.status !== 'ready' || preview.mode !== 'design' || preview.faceArtifactHash !== artifactHash || preview.previewSha256 !== review.previewSha256)
    fail('工程或效果图片已变化，请重新查看后确认');
  return { schema: 'face-output-acceptance/0.1', artifactHash, previewSha256: review.previewSha256 };
}
/** Only a current, supervised render may supply the choices shown to a person. */
export function validateFaceChoice(db: DatabaseSync, workflowId: string, gateId: string, artifactHash: string, choice: FaceChoiceInput): FaceGateChoice {
  if (!choice || Object.keys(choice).sort().join(',') !== 'candidateId,candidateSetSha256,previewSha256' ||
      typeof choice.candidateId !== 'string' || !choice.candidateId || !digest(choice.candidateSetSha256) || !digest(choice.previewSha256)) fail('请选择当前实际预览中的候选');
  const id = projectId(db, workflowId), preview = projectFaceCandidatePreview(db, id, workflowId);
  if (preview.status !== 'ready' || preview.candidateSetSha256 !== choice.candidateSetSha256 || preview.previewSha256 !== choice.previewSha256 ||
      !preview.candidates.some(candidate => candidate.id === choice.candidateId)) fail('候选或图片已经变化，请重新查看后选择');
  const root = projectRoot(db, id), raw = bytes(root, '_harness/face/candidates.json');
  if (sha(raw) !== choice.candidateSetSha256) fail('候选在选择期间发生变化');
  const set = JSON.parse(raw.toString('utf8'));
  if (set.schema !== 'face-candidate-set/0.1' || !digest(set.requestSha256) || !digest(set.observationSha256) || !digest(set.targetId) ||
      sha(bytes(root, '_harness/face/request.json')) !== set.requestSha256 || sha(bytes(root, '_harness/face/observation.json', 128 * 1024 * 1024)) !== set.observationSha256 ||
      !Array.isArray(set.candidates) || !set.candidates.some((candidate: { id: string }) => candidate.id === choice.candidateId)) fail('候选来源版本不一致');
  return { schema: 'face-gate-choice/0.1', artifactHash, previewSha256: choice.previewSha256,
    selection: { schema: 'face-selection/0.1', requestSha256: set.requestSha256, candidateSetSha256: choice.candidateSetSha256,
      observationSha256: set.observationSha256, targetId: set.targetId, candidateId: choice.candidateId, gateId } };
}
/** Rebuild the small projection from the actual human decision; a model-written JSON never grants approval. */
export function faceSelectionForDispatch(db: DatabaseSync, workflowId: string, gateId: string, artifactKind: string,
  project = true): { sha256: string; content: string } {
  const row = db.prepare('SELECT artifact_hash,result,selection_json,input_hashes_json FROM gate_decision WHERE workflow_id=? AND gate_id=? ORDER BY seq DESC LIMIT 1').get(workflowId, gateId);
  const hashes = buildAggregateInput(db, workflowId).artifactHashes, hash = hashes[artifactKind];
  if (!row || row.result !== 'chosen' || !row.selection_json || row.artifact_hash !== hash) fail('尚未选定当前候选版本');
  const definition = db.prepare('SELECT definition_json FROM workflow_definition WHERE workflow_id=?').get(workflowId);
  if (definition && !evidenceFresh(String(row.artifact_hash), hash, row.input_hashes_json ? JSON.parse(String(row.input_hashes_json)) : undefined,
    evidenceInputHashes(JSON.parse(String(definition.definition_json)) as ProcessDefinition, { gateId }, hashes))) fail('候选决定所绑定的制作输入已变化');
  const saved = JSON.parse(String(row.selection_json)) as FaceGateChoice;
  if (saved.schema !== 'face-gate-choice/0.1' || saved.artifactHash !== hash || saved.selection?.gateId !== gateId) fail('决定记录不完整');
  const current = validateFaceChoice(db, workflowId, gateId, hash, { candidateId: saved.selection.candidateId,
    candidateSetSha256: saved.selection.candidateSetSha256, previewSha256: saved.previewSha256 });
  if (JSON.stringify(saved) !== JSON.stringify(current)) fail('决定的来源已经变化');
  const content = JSON.stringify(current.selection);
  if (!project) return { sha256: sha(content), content };
  const root = projectRoot(db, projectId(db, workflowId)), path = plainPath(root, '_harness/face/selection.json', false);
  if (existsSync(path) && !lstatSync(path).isFile()) fail('选择记录路径不是文件');
  const temporary = `${path}.${randomUUID()}.tmp`;
  // Router reconstruction must not change scan metadata for an already-authorized projection.
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return { sha256: sha(content), content };
  hostPlatform.writePrivate(temporary, content, { flag: 'wx' }); renameSync(temporary, path);
  return { sha256: sha(content), content };
}
