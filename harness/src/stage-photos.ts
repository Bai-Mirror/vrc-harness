import { createHash } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { projectRoot } from './archive/takeover.ts';
import { verifiedPreviewPng } from './face-preview.ts';
import { previewFail, previewFile } from './preview-files.ts';
import { buildAggregateInput } from './state/aggregate-input.ts';

/**
 * The pictures the Unity stages already rendered, read back for the person who has to decide on them:
 * the recolour candidates (`<run>/candidates/`, one per tier × outfit, same camera) that the `recolor_approval` Gate
 * binds, and the outfit photos (`<run>/photos/`) the regression stage takes of the finished avatar.
 *
 * The strict face-preview rules apply unchanged: read-only, no absolute host path leaves this module, every picture is
 * bound to its own bytes and to one picture set (a short digest the caller must pass back), paths stay inside one Run
 * directory, and a picture set that is not the version bound to the decision is reported as missing rather than shown.
 * Nothing here renders; a picture that no supervised Unity step produced is not a candidate.
 */
const RECOLOR = '配色候选图不可用';
const DELIVERY = '成品照片不可用';
const RECOLOR_METHOD = 'AVH.Harness.RecolorStage.Run';
const REGRESSION_METHOD = 'AVH.Harness.RegressionStage.Run';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_BATCH = 24;

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function fail(label: string, message: string): never { return previewFail(label, message); }

export interface RecolorTier { id: string; label: string; chosen: boolean }
export interface RecolorImage { id: string; tier: string; outfit: string | null; outfitLabel: string | null; chosen: boolean; sha256: string; width: number; height: number }
export interface RecolorPreview { status: 'ready'; source: 'unity'; artifactHash: string; previewSha256: string; chosenTier: string;
  /** When the stage that produced these pictures was recorded as complete; the picture set's own time. */
  generatedAt: string; tiers: RecolorTier[]; images: RecolorImage[]; renderDigest: string; runId: string }
export type RecolorPreviewResult = RecolorPreview | { status: 'missing'; reason: string };

export interface DeliveryPhoto { id: string; label: string; sha256: string; width: number; height: number }
export interface DeliveryPhotos { status: 'ready'; source: 'unity'; buildHash: string; previewSha256: string; generatedAt: string; photos: DeliveryPhoto[]; renderDigest: string }
export type DeliveryPhotosResult = DeliveryPhotos | { status: 'missing'; reason: string };

function readJson(root: string, path: string, maxBytes: number, label: string): Record<string, any> {
  const bytes = previewFile(root, path, maxBytes, label);
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { fail(label, '记录不是有效 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label, '记录格式无效');
  return value as Record<string, any>;
}

interface StageContext { project: string; home: string }
function stageContext(db: DatabaseSync, projectId: string, workflowId: string, label: string): StageContext {
  const row = db.prepare('SELECT p.path AS path FROM project p JOIN workflow w ON w.project_id = p.id WHERE p.id = ? AND w.id = ?')
    .get(projectId, workflowId);
  if (!row) fail(label, '找不到所属制作流程');
  const location = String((db.prepare('PRAGMA database_list').all() as { name: string; file?: string }[])
    .find(item => item.name === 'main')?.file ?? '');
  if (!location) fail(label, '找不到本地状态库，无法定位运行目录');
  return { project: projectRoot(db, projectId), home: dirname(dirname(location)) };
}

interface Completion { seq: number; runId: string; hashes: Record<string, string>; recordedAt: string }
/**
 * The newest completion of one stage whose Run belongs to this Workflow. An inherited completion has no Run here, so it
 * cannot be used to show pictures: the pictures live in the Run directory of the process that produced them.
 */
function completions(db: DatabaseSync, workflowId: string, stageId: string): Completion[] {
  const completed = (db.prepare(`SELECT c.seq AS seq, c.run_id AS runId, c.artifact_hashes_json AS hashes, c.recorded_at AS recordedAt
    FROM stage_completion c JOIN run r ON r.id = c.run_id JOIN task t ON t.id = r.task_id
    WHERE c.workflow_id = ? AND c.stage_id = ? AND t.workflow_id = ?
    ORDER BY c.seq DESC`).all(workflowId, stageId, workflowId) as
    { seq: number; runId: string; hashes: string; recordedAt: string }[])
    .map(row => {
      const hashes = JSON.parse(row.hashes) as Record<string, string>;
      if (row.runId) {
        const run = db.prepare('SELECT result_json FROM run WHERE id=?').get(row.runId) as { result_json: string | null } | undefined;
        const result = run?.result_json ? JSON.parse(run.result_json) : undefined;
        if (result?.previewDigests?.[stageId]) hashes.previewDigest = result.previewDigests[stageId];
      }
      return { seq: row.seq, runId: row.runId, hashes, recordedAt: row.recordedAt };
    });
  const verified = db.prepare(`SELECT r.id, r.result_json, e.seq, e.occurred_at FROM run r JOIN task t ON t.id=r.task_id
    JOIN event e ON e.entity_id=r.id AND e.entity_type='run' AND e.actor='runtime' AND e.action='verified'
    WHERE t.workflow_id=? AND t.stage_id=? AND r.status='exited' ORDER BY e.seq DESC`).all(workflowId, stageId);
  return [...verified.map(row => {
    const result = JSON.parse(String(row.result_json));
    return { seq: Number(row.seq), runId: String(row.id), recordedAt: String(row.occurred_at),
      hashes: { ...(result.verifiedArtifactHashes ?? {}), previewDigest: result.previewDigests?.[stageId] } };
  }), ...completed];
}

/** The Run directory of a completion, after proving Unity actually ran the step that writes the pictures there. */
function completedRunDir(db: DatabaseSync, workflowId: string, runId: string, method: string, label: string, home: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) fail(label, '运行标识无效');
  const run = db.prepare(`SELECT r.status AS status, r.result_json AS result FROM run r JOIN task t ON t.id = r.task_id
    WHERE r.id = ? AND t.workflow_id = ?`).get(runId, workflowId) as { status: string; result: string | null } | undefined;
  if (!run || run.status !== 'exited' || !run.result) fail(label, '这批图片所属的运行还没有完成记录');
  const result = JSON.parse(String(run.result)) as { exitStatus?: number; errorClass?: string; outOfBoundsPaths?: unknown[];
    unitySteps?: Array<{ method?: string; exitCode?: number; timedOut?: boolean; status?: string }> };
  if (result.exitStatus !== 0 || result.errorClass || (result.outOfBoundsPaths?.length ?? 0) ||
      !Array.isArray(result.unitySteps) || !result.unitySteps.some(step => step.method === method && step.exitCode === 0 &&
        !step.timedOut && step.status !== 'not_started')) fail(label, '这批图片所属的运行没有成功的 Unity 渲染记录');
  if (!db.prepare(`SELECT 1 FROM event WHERE workflow_id = ? AND actor = 'runtime' AND entity_type = 'run'
    AND entity_id = ? AND action = 'unity_unit_intended' LIMIT 1`).get(workflowId, runId))
    fail(label, '这批图片没有对应的受管 Unity 启动记录');
  const runDir = join(home, 'runs', runId);
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(runDir); } catch { fail(label, '这批图片所在的运行目录已不存在'); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(label, '运行目录不是普通目录');
  return runDir;
}

/** Every `.png` under one directory of the Run, at most two levels deep, as a Run-relative path. */
function pictureFiles(root: string, directory: string, label: string): string[] {
  const found: string[] = [];
  const walk = (relative: string, depth: number) => {
    let entries;
    try { entries = readdirSync(join(root, relative), { withFileTypes: true }); }
    catch { fail(label, '图片目录读取失败'); }
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = `${relative}/${entry.name}`;
      if (entry.isFile() && entry.name.endsWith('.png')) found.push(path);
      else if (entry.isDirectory() && depth < 2) walk(path, depth + 1);
    }
  };
  walk(directory, 0);
  return found;
}

/** The camera every candidate of one set must share: pictures from different cameras are not comparable (SOP 40). */
function cameraSignature(spec: Record<string, any>): string {
  if (spec.schema !== 'camera-spec/0.1') return '';
  return JSON.stringify([spec.projection, spec.ortho_size, spec.position, spec.rotation, spec.background, spec.lights]);
}

interface Png { bytes: Buffer; width: number; height: number; sha256: string }
function readPicture(root: string, relative: string, label: string): Png {
  const bytes = previewFile(root, relative, MAX_IMAGE_BYTES, label);
  const size = verifiedPreviewPng(bytes, label);
  return { bytes, ...size, sha256: hash(bytes) };
}

/** Digest the files that existed when a supervised Unity Run completed. Runtime stores this beside the Run binding. */
export function renderedImageDigest(root: string, directory: string): string | undefined {
  let directoryStat: ReturnType<typeof lstatSync>;
  try { directoryStat = lstatSync(join(root, directory)); } catch { return undefined; }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail(RECOLOR, '图片目录包含链接或不是普通目录');
  try {
    const files = pictureFiles(root, directory, RECOLOR);
    const entries = files.flatMap(path => [path, path.replace(/\.png$/, '.json')]).map(path => {
      const bytes = previewFile(root, path, MAX_IMAGE_BYTES, RECOLOR);
      return { path, sha256: hash(bytes), bytes: bytes.length };
    });
    return hash(Buffer.from(JSON.stringify({ schema: 'rendered-image-list/0.1', directory, entries })));
  } catch { return undefined; }
}

/** The plan's outfit names, so a photo can say which outfit instead of which internal id. */
function outfitLabels(plan: Record<string, any> | undefined): Map<string, string> {
  const labels = new Map<string, string>();
  if (!plan || typeof plan !== 'object') return labels;
  const groups = Array.isArray(plan.avatar_config?.groups) ? plan.avatar_config.groups : [];
  const outfits: Array<Record<string, any>> = Array.isArray(plan.outfits) ? plan.outfits : groups.flatMap((group: any) => group?.members ?? []);
  for (const outfit of outfits) {
    if (!outfit || typeof outfit !== 'object' || typeof outfit.id !== 'string') continue;
    const name = [outfit.label, outfit.item].find(value => typeof value === 'string' && value.trim()) as string | undefined;
    labels.set(outfit.id, name ? String(name).split(/[\\/]/).filter(Boolean).at(-1)! : outfit.id);
  }
  return labels;
}

/** Which member one exclusive group selects at a state value. The same rule AvatarConfig.Selected applies in Unity. */
function selectedMember(group: Record<string, any>, value: unknown): Record<string, any> | undefined {
  const members: Array<Record<string, any>> = Array.isArray(group.members) ? group.members : [];
  if (group.activation !== 'exclusive') return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (group.parameter?.type === 'Int') {
    const ordered = [...members].sort((a, b) => (a.id === group.default ? 0 : 1) - (b.id === group.default ? 0 : 1));
    return ordered.find((member, index) => Math.abs(value - index) < 0.001);
  }
  const index = Array.from({ length: Math.max(members.length - 1, 0) }, (_, i) => i + 1)
    .filter(i => Math.fround(value) >= Math.fround(i / members.length)).length;
  return members[index];
}

function stateLabel(plan: Record<string, any> | undefined, state: unknown): string {
  if (!plan || typeof plan !== 'object' || !state || typeof state !== 'object') return '';
  const groups = Array.isArray(plan.avatar_config?.groups) ? plan.avatar_config.groups : [];
  const labels = outfitLabels(plan);
  const parts: string[] = [];
  for (const group of groups) {
    if (group?.activation !== 'exclusive') continue;
    const member = selectedMember(group, (state as Record<string, unknown>)[group?.parameter?.name]);
    if (!member) continue;
    const name = labels.get(String(member.id)) ?? String(member.id ?? '');
    parts.push(group.label ? `${group.label}：${name}` : name);
  }
  return parts.join('；');
}

/** The recolour candidates bound to the version the `recolor_approval` Gate is about to decide on. */
export function projectRecolorPreview(db: DatabaseSync, projectId: string, workflowId: string, expectedHash: string): RecolorPreviewResult {
  if (!digest(expectedHash)) fail(RECOLOR, '候选图版本无效');
  const { project, home } = stageContext(db, projectId, workflowId, RECOLOR);
  const aggregate = buildAggregateInput(db, workflowId), current = aggregate.artifactHashes;
  const bound = completions(db, workflowId, 'recolor').find(completion => completion.hashes.materials === expectedHash);
  if (!bound) return { status: 'missing', reason: '当前配色版本还没有 Unity 渲染的候选图；重新运行配色阶段后，这里会按档位与服装显示候选图。' };
  if (current.materials !== expectedHash) return { status: 'missing', reason: '配色产物已经变化，候选图对应的版本不再是当前版本，需要重新运行配色阶段。' };
  const runDir = completedRunDir(db, workflowId, bound.runId, RECOLOR_METHOD, RECOLOR, home);
  if (!bound.hashes.previewDigest || renderedImageDigest(runDir, 'candidates') !== bound.hashes.previewDigest)
    return { status: 'missing', reason: '候选图在 Unity 渲染完成后发生了变化，当前证据已撤下；重新运行配色阶段后再查看。' };
  const recipe = readJson(project, 'Assets/_Harness/Recolor/recipe.json', 2 * 1024 * 1024, RECOLOR);
  const tiers: Array<{ id: string; label: string }> = Array.isArray(recipe.tiers)
    ? recipe.tiers.filter((tier: any) => tier && typeof tier.id === 'string' && tier.id.trim())
      .map((tier: any) => ({ id: String(tier.id), label: typeof tier.label === 'string' ? tier.label : '' })) : [];
  if (!tiers.length || typeof recipe.chosen !== 'string' || !tiers.some(tier => tier.id === recipe.chosen))
    fail(RECOLOR, '配色配方没有可用的档位或选定档');
  const files = pictureFiles(runDir, 'candidates', RECOLOR);
  if (!files.length) fail(RECOLOR, '运行目录里没有候选图');
  const labels = outfitLabels(aggregate.plan as Record<string, any> | undefined);
  const result = JSON.parse(String(db.prepare('SELECT result_json FROM run WHERE id=?').get(bound.runId)!.result_json));
  const requiredStates: string[] = result.previewStates;
  if (!Array.isArray(requiredStates) || !requiredStates.length) fail(RECOLOR, '这次运行没有冻结应渲染的服装状态集合，请重新运行配色阶段');
  let camera: string | undefined, size: { width: number; height: number } | undefined;
  const images: RecolorImage[] = [];
  const missingTiers = new Set(tiers.map(tier => tier.id));
  for (const file of files) {
    const name = file.slice('candidates/'.length, -'.png'.length);
    // Filenames are `<tier>_<outfit>`; the longest tier id that prefixes the name is the tier (ids may share prefixes).
    const tier = tiers.map(tier => tier.id).filter(id => name === `${id}_original` || name.startsWith(`${id}_`))
      .sort((a, b) => b.length - a.length)[0];
    if (!tier) fail(RECOLOR, `候选图 ${name} 不属于配方里的任何档位`);
    const outfit = name === `${tier}_original` ? null : name.slice(tier.length + 1);
    const picture = readPicture(runDir, file, RECOLOR);
    const spec = readJson(runDir, file.replace(/\.png$/, '.json'), 256 * 1024, RECOLOR);
    const signature = cameraSignature(spec);
    if (!signature) fail(RECOLOR, '候选图的机位规格无效');
    camera ??= signature;
    if (signature !== camera) fail(RECOLOR, '候选图不是同一机位，不能并排比较');
    size ??= { width: picture.width, height: picture.height };
    if (spec.width !== picture.width || spec.height !== picture.height || picture.width !== size.width || picture.height !== size.height)
      fail(RECOLOR, '候选图的尺寸与机位规格不一致');
    if (spec.candidate !== undefined && spec.candidate !== tier) fail(RECOLOR, '候选图的档位与机位规格不一致');
    missingTiers.delete(tier);
    images.push({ id: name, tier, outfit, outfitLabel: outfit === null ? null : labels.get(outfit) ?? outfit,
      chosen: tier === recipe.chosen, sha256: picture.sha256, width: picture.width, height: picture.height });
  }
  if (missingTiers.size) fail(RECOLOR, `档位 ${[...missingTiers].join('、')} 没有候选图`);
  if (requiredStates.length) {
    const expected = new Set(tiers.flatMap(tier => requiredStates.map(state => `${tier.id}_${state}`)));
    const present = new Set(images.map(image => image.id));
    const missing = [...expected].filter(id => !present.has(id));
    if (missing.length) fail(RECOLOR, `候选图缺少必要的档位与服装组合：${missing.join('、')}`);
  }
  const order = new Map(tiers.map((tier, index) => [tier.id, index]));
  images.sort((a, b) => (order.get(a.tier)! - order.get(b.tier)!) || a.id.localeCompare(b.id));
  const manifest = { schema: 'recolor-candidates/0.1', source: 'unity' as const, artifactHash: expectedHash, chosenTier: recipe.chosen,
    runId: bound.runId, renderDigest: bound.hashes.previewDigest,
    tiers: tiers.map(tier => ({ id: tier.id, label: tier.label, chosen: tier.id === recipe.chosen })),
    images: images.map(({ id, tier, outfit, sha256, width, height }) => ({ id, tier, outfit, sha256, width, height })) };
  return { status: 'ready', source: 'unity', artifactHash: expectedHash, previewSha256: hash(Buffer.from(JSON.stringify(manifest))),
    generatedAt: bound.recordedAt, chosenTier: recipe.chosen, tiers: manifest.tiers, images, renderDigest: bound.hashes.previewDigest, runId: bound.runId };
}

/** One batch of candidate pictures, each bound to the picture set the caller was shown. */
export function projectRecolorPreviewImages(db: DatabaseSync, projectId: string, workflowId: string, expectedHash: string,
  previewSha256: string, ids: string[]) {
  const preview = projectRecolorPreview(db, projectId, workflowId, expectedHash);
  if (preview.status !== 'ready') fail(RECOLOR, preview.reason);
  return readBatch(db, projectId, workflowId, RECOLOR, preview.previewSha256, previewSha256, ids,
    () => preview.images.map(image => ({ id: image.id, path: `candidates/${image.id}.png`, sha256: image.sha256, width: image.width, height: image.height })));
}

/** The outfit photos the regression stage took of the finished avatar, bound to the current build. */
export function projectDeliveryPhotos(db: DatabaseSync, projectId: string, workflowId: string): DeliveryPhotosResult {
  const { project, home } = stageContext(db, projectId, workflowId, DELIVERY);
  const workflow = db.prepare('SELECT status FROM workflow WHERE id = ?').get(workflowId) as { status: string } | undefined;
  if (!workflow || !['upload_ready', 'client_verified'].includes(workflow.status))
    return { status: 'missing', reason: '制作还没到可上传；回归阶段拍完成品照后会显示在这里。' };
  const current = buildAggregateInput(db, workflowId).artifactHashes;
  const bound = current.build ? completions(db, workflowId, 'regression').find(completion => completion.hashes.build === current.build) : undefined;
  if (!bound) return { status: 'missing', reason: '当前构建还没有回归阶段拍的成品照；重新运行回归阶段后会显示在这里。' };
  const runDir = completedRunDir(db, workflowId, bound.runId, REGRESSION_METHOD, DELIVERY, home);
  if (!bound.hashes.previewDigest || renderedImageDigest(runDir, 'photos') !== bound.hashes.previewDigest)
    return { status: 'missing', reason: '成品照片在回归完成后发生了变化，当前证据已撤下；重新运行回归阶段后再查看。' };
  const coverage = readJson(runDir, 'coverage.json', 8 * 1024 * 1024, DELIVERY);
  if (coverage.schema !== 'coverage/0.1' && coverage.schema !== 'coverage/0.2') fail(DELIVERY, '回归记录格式无效');
  const entries: Array<Record<string, any>> = Array.isArray(coverage.photos) ? coverage.photos : [];
  if (!entries.length) return { status: 'missing', reason: '这次回归没有拍成品照；下次运行回归阶段会为每套服装拍照。' };
  const plan = buildAggregateInput(db, workflowId).plan as Record<string, any> | undefined;
  const labels = outfitLabels(plan);
  // coverage/0.1 names its file and the outfit it intended to show; coverage/0.2 is one state per photo, in order.
  const work = coverage.schema === 'coverage/0.1'
    ? entries.map((entry, index) => {
      if (typeof entry.photo !== 'string' || !entry.photo) fail(DELIVERY, '回归记录里的照片文件名无效');
      const named = Array.isArray(entry.named) ? entry.named.map((id: unknown) => labels.get(String(id)) ?? String(id)) : [];
      return { path: `photos/${entry.photo}`, label: named.join('、') || `成品照 ${index + 1}` };
    })
    : pictureFiles(runDir, 'photos', DELIVERY).filter(path => /(^|\/)group_\d+\.png$/.test(path))
      .sort((a, b) => Number(/(\d+)\.png$/.exec(a)![1]) - Number(/(\d+)\.png$/.exec(b)![1]))
      .map((path, index) => ({ path, label: stateLabel(plan, entries[index]?.avatar_state) || `成品照 ${index + 1}` }));
  if (coverage.schema === 'coverage/0.2' && work.length !== entries.length)
    fail(DELIVERY, '回归记录里的照片数量与文件不一致');
  let camera: string | undefined, size: { width: number; height: number } | undefined;
  const photos: DeliveryPhoto[] = [];
  for (const item of work) {
    const picture = readPicture(runDir, item.path, DELIVERY);
    const spec = readJson(runDir, item.path.replace(/\.png$/, '.json'), 256 * 1024, DELIVERY);
    const signature = cameraSignature(spec);
    if (!signature) fail(DELIVERY, '成品照片的机位规格无效');
    camera ??= signature;
    if (signature !== camera) fail(DELIVERY, '成品照片不是同一机位');
    size ??= { width: picture.width, height: picture.height };
    if (spec.width !== picture.width || spec.height !== picture.height || picture.width !== size.width || picture.height !== size.height)
      fail(DELIVERY, '成品照片的尺寸与机位规格不一致');
    photos.push({ id: item.path.slice('photos/'.length, -'.png'.length).replaceAll('/', '~'), label: item.label,
      sha256: picture.sha256, width: picture.width, height: picture.height });
  }
  if (new Set(photos.map(photo => photo.id)).size !== photos.length) fail(DELIVERY, '成品照片的文件名重复');
  const manifest = { schema: 'delivery-photos/0.1', source: 'unity' as const, buildHash: current.build,
    photos: photos.map(({ id, label, sha256, width, height }) => ({ id, label, sha256, width, height })) };
  return { status: 'ready', source: 'unity', buildHash: current.build!, previewSha256: hash(Buffer.from(JSON.stringify(manifest))),
    generatedAt: bound.recordedAt, photos, renderDigest: bound.hashes.previewDigest };
}

export function projectDeliveryPhotoImages(db: DatabaseSync, projectId: string, workflowId: string, previewSha256: string, ids: string[]) {
  const preview = projectDeliveryPhotos(db, projectId, workflowId);
  if (preview.status !== 'ready') fail(DELIVERY, preview.reason);
  return readBatch(db, projectId, workflowId, DELIVERY, preview.previewSha256, previewSha256, ids,
    () => preview.photos.map(photo => ({ id: photo.id, path: `photos/${photo.id.replaceAll('~', '/')}.png`, sha256: photo.sha256, width: photo.width, height: photo.height })));
}

/** Validate one bounded batch once, then return each picture only if it still is the one the caller was shown. */
function readBatch(db: DatabaseSync, projectId: string, workflowId: string, label: string, currentSha256: string,
  previewSha256: string, ids: string[], entries: () => Array<{ id: string; path: string; sha256: string; width: number; height: number }>) {
  if (!digest(previewSha256) || previewSha256 !== currentSha256) fail(label, '这些图片在你查看之后发生了变化，请刷新制作进度');
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_BATCH || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== 'string' || !id)) fail(label, '图片读取批次无效');
  const { home } = stageContext(db, projectId, workflowId, label);
  const all = entries(), wanted = ids.map(id => all.find(entry => entry.id === id));
  if (wanted.some(entry => !entry)) fail(label, '这些图片不在当前候选里，请刷新');
  const root = runRootFor(db, workflowId, label, home);
  return wanted.map(entry => {
    const picture = readPicture(root, entry!.path, label);
    if (picture.sha256 !== entry!.sha256 || picture.width !== entry!.width || picture.height !== entry!.height)
      fail(label, '图片在读取期间发生变化');
    return { id: entry!.id, previewSha256, sha256: entry!.sha256, dataUrl: `data:image/png;base64,${picture.bytes.toString('base64')}` };
  });
}

/**
 * Which Run directory a batch reads from. The picture set was already validated; re-deriving the directory from the
 * same completion keeps the batch and the listing on one Run even though the batch validates the manifest again.
 */
function runRootFor(db: DatabaseSync, workflowId: string, label: string, home: string): string {
  const recolor = label === RECOLOR;
  const current = buildAggregateInput(db, workflowId).artifactHashes;
  const bound = recolor ? completions(db, workflowId, 'recolor').find(c => c.hashes.materials === current.materials)
    : current.build ? completions(db, workflowId, 'regression').find(c => c.hashes.build === current.build) : undefined;
  if (!bound) fail(label, '这批图片所属的运行已不可用');
  return completedRunDir(db, workflowId, bound.runId, recolor ? RECOLOR_METHOD : REGRESSION_METHOD, label, home);
}
