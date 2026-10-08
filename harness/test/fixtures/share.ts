import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { crc32 } from 'node:zlib';
import { stringify } from 'yaml';
import { projectionDigest } from '../../src/archive/projection.ts';
import { registerEntries, type NewEntry } from '../../src/archive/registry.ts';
import { pack7z, sevenZip } from '../../src/archive/sevenzip.ts';
import { loadConfig, type LocalConfig } from '../../src/config.ts';
import type { Executor, RunHandle, RunResult, RunSpec } from '../../src/runtime/interfaces.ts';
import { openDatabase } from '../../src/state/db.ts';
import { serveOnce } from '../../src/task-cli.ts';
import { createWorkflow, decideFormalGate } from '../../src/workflow/runtime.ts';
import { describeWorkflow } from '../../src/workflow/view.ts';
import { FAKE_PROVIDER, fakeCommand, removeTemp } from './platform.ts';

/**
 * Two Harness installations on one disk for share and restore tests: a sender with a formal Workflow in progress on a
 * small Unity project, and a receiver with its own AVH_HOME, workspace (at another path) and state database. Both run
 * the same capability pack, installed as a managed pack under their own AVH_HOME. Nothing touches the real AVH_HOME.
 */
export const has7z = !('problem' in sevenZip());

export const PROCESS = {
  schema: 'process/0.1', id: 'synthetic-formal', version: 'v1', applies_to: {}, artifacts: ['plan', 'scene', 'report'],
  stages: [
    { id: 'plan', needs: [], produces: ['plan'], requires: ['plan_has_title'], gates: ['plan_approval'], invalidated_by: [] },
    { id: 'make', needs: ['plan'], produces: ['scene'], requires: ['scene_items'], gates: [], invalidated_by: ['plan'] },
    { id: 'extra', needs: ['make'], when: 'plan.extra', produces: ['report'], requires: ['report_ok'], gates: [], invalidated_by: ['scene'] },
  ],
  checks: [
    { id: 'plan_has_title', observe: 'plan.inspect', on: 'plan', scope: 'edit', rule: 'title_length > 0', severity: 'blocking', maturity: 'accepted' },
    { id: 'scene_items', observe: 'scene.count', on: 'scene', scope: 'edit', rule: 'items >= 2', severity: 'blocking', maturity: 'accepted' },
    { id: 'report_ok', observe: 'report.check', on: 'report', scope: 'build', rule: 'ok == true', severity: 'blocking', maturity: 'accepted' },
  ],
  gates: [{ id: 'plan_approval', kind: 'approve', binds: 'plan' }, { id: 'client_test', kind: 'do', binds: 'scene' }],
  milestones: [{ id: 'UPLOAD_READY', requires_stages: 'all', evidence_on: 'scene' }, { id: 'CLIENT_VERIFIED', after: 'UPLOAD_READY', gates: ['client_test'] }],
};
export const CAPABILITIES = {
  schema: 'capabilities/0.1', process: 'synthetic-formal', version: '1',
  artifacts: { plan: { paths: ['_harness/plan.yaml'], format: 'yaml' }, scene: { paths: ['scene'] }, report: { paths: ['report.json'] } },
  stages: {
    plan: { mode: 'provider', goal: '按需求写方案：{{manifest.request}}',
      context: [{ id: 'plan-core', path: 'SOP/plan.md', heading: '核心', required: true, covers: ['plan.constraints'] }],
      contextBudgetChars: 2000, contextCoverage: ['plan.constraints'], allowedWrites: ['_harness'] },
    make: { mode: 'provider', goal: '按方案制作', allowedWrites: ['scene'] },
    extra: { mode: 'provider', goal: '写报告', allowedWrites: ['report.json'] },
  },
  observers: {
    'plan.inspect': { command: ['node', '{toolRoot}/inspect-plan.mjs', '{project}', '{out}'] },
    'scene.count': { command: ['node', '{toolRoot}/count.mjs', '{project}', '{out}'] },
    'report.check': { command: ['node', '{toolRoot}/report.mjs', '{project}', '{out}'] },
  },
};
const OBSERVERS: Record<string, string> = {
  'inspect-plan.mjs': `import { readFileSync, writeFileSync } from 'node:fs';
const plan = JSON.parse(readFileSync(process.argv[2] + '/_harness/plan.yaml', 'utf8'));
writeFileSync(process.argv[3], JSON.stringify({ schema: 'observation/0.1', metrics: { title_length: (plan.title ?? '').length } }));`,
  'count.mjs': `import { readdirSync, writeFileSync } from 'node:fs';
writeFileSync(process.argv[3], JSON.stringify({ schema: 'observation/0.1', metrics: { items: readdirSync(process.argv[2] + '/scene').length } }));`,
  'report.mjs': `import { readFileSync, writeFileSync } from 'node:fs';
const report = JSON.parse(readFileSync(process.argv[2] + '/report.json', 'utf8'));
writeFileSync(process.argv[3], JSON.stringify({ schema: 'observation/0.1', metrics: { ok: report.ok === true } }));`,
};
export const GUID = { scene: '33333333333333333333333333333333', prefab: '11111111111111111111111111111111', material: '22222222222222222222222222222222',
  vpm: '44444444444444444444444444444444', paid: '55555555555555555555555555555555' };

/** A capability pack laid out as Harness installs one: pack.json, knowledge/, tools/. */
export function writePack(root: string, version = '1.0.0'): void {
  for (const dir of ['knowledge/SOP', 'tools']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'pack.json'), `${JSON.stringify({ schema: 'harness-managed-pack/0.1', id: 'test-pack', version, channel: 'dev', description: 'test' })}\n`);
  writeFileSync(join(root, 'knowledge', 'synthetic.process.yaml'), stringify(PROCESS));
  writeFileSync(join(root, 'knowledge', 'synthetic.capabilities.yaml'), stringify(CAPABILITIES));
  writeFileSync(join(root, 'knowledge', 'thresholds.yaml'), stringify({ schema: 'thresholds/0.1', version: 't1', t: {} }));
  writeFileSync(join(root, 'knowledge', 'SOP', 'plan.md'), '# 方案规范\n## 核心\n只能使用已选素材。\n');
  for (const [name, source] of Object.entries(OBSERVERS)) writeFileSync(join(root, 'tools', name), source);
  // The import's read-only reviews, which a configuration requires to exist.
  mkdirSync(join(root, 'tools', '审查', 'perception'), { recursive: true });
  for (const name of ['project_fingerprint.py', 'vpm_baseline_check.py', '审查/perception/strip_audit.py']) writeFileSync(join(root, 'tools', ...name.split('/')), '');
  normalizeModes(root);
}
/** Pack trees hash with their modes: 0755 folders and 0644 files, whatever the umask of the test run. */
export function normalizeModes(root: string): void {
  if (process.platform === 'win32') return;
  chmodSync(root, 0o755);
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true }))
    chmodSync(join(entry.parentPath, entry.name), entry.isDirectory() ? 0o755 : 0o644);
}

/** A project candidate pack that passes registration: knowledge with verified checks, tools rooted in the pack. */
export function writeCandidate(root: string, id = 'luna-candidate'): void {
  for (const dir of ['knowledge/process', 'knowledge/SOP', 'tools']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'pack.json'), JSON.stringify({ schema: 'harness-managed-pack/0.1', id, version: '1-candidate', channel: 'candidate', description: 'test' }));
  const process = structuredClone(PROCESS);
  for (const [index, check] of process.checks.entries()) {
    const ref = `${index + 1}`.repeat(12);
    Object.assign(check, { source_id: ref, verification: [{ kind: 'sop-editorial', ref }], kind: 'spec' });
  }
  writeFileSync(join(root, 'knowledge', 'process', 'synthetic-formal.process.yaml'), stringify(process));
  writeFileSync(join(root, 'knowledge', 'process', 'synthetic-formal.capabilities.yaml'), stringify(CAPABILITIES));
  writeFileSync(join(root, 'knowledge', 'process', 'thresholds.yaml'), stringify({ schema: 'thresholds/0.1', version: 't1', t: {} }));
  writeFileSync(join(root, 'knowledge', 'SOP', 'plan.md'), '# 候选上下文\n## 核心\n候选核心\n');
  for (const [name, source] of Object.entries(OBSERVERS)) writeFileSync(join(root, 'tools', name), source);
  normalizeModes(root);
}

export interface Side { root: string; home: string; workspace: string; exportRoot: string; config: LocalConfig; db: DatabaseSync; packRoot: string }
/** One Harness: AVH_HOME with configuration and the test pack, a workspace, a state database. */
export function harnessSide(t: TestContext, root: string, name: string, options: { pack?: boolean } = {}): Side {
  const base = join(root, name), home = join(base, 'home'), workspace = join(base, name === 'sender' ? 'workspace' : 'another workspace'),
    exportRoot = join(base, 'export'), packRoot = join(home, 'managed', 'packs', 'test-pack');
  for (const dir of [join(home, 'config'), join(home, 'state'), workspace, exportRoot]) mkdirSync(dir, { recursive: true });
  if (options.pack !== false) writePack(packRoot);
  else writePack(join(base, 'dev-pack'));
  const knowledge = options.pack !== false ? join(packRoot, 'knowledge') : join(base, 'dev-pack', 'knowledge');
  const tools = options.pack !== false ? join(packRoot, 'tools') : join(base, 'dev-pack', 'tools');
  const fake = fakeCommand(join(base, 'fake-codex'), FAKE_PROVIDER);
  writeFileSync(join(home, 'config', 'harness.yaml'), stringify({ workspaceRoot: workspace, toolRoot: tools, knowledgeRoot: knowledge,
    exportRoots: [exportRoot], knownBodies: [], projectAliases: {}, sampleNames: [],
    processDefinitions: { 'synthetic-formal': { definition: 'synthetic.process.yaml', capabilities: 'synthetic.capabilities.yaml' } },
    defaultProfile: 'synthetic-formal', thresholdsFile: 'thresholds.yaml',
    providers: [{ id: 'fake', type: 'codex-cli', executable: fake, roles: ['executor'], writable: [], maxConcurrentRuns: 1 }] }));
  const config = loadConfig(home);
  const db = openDatabase(join(home, 'state', 'harness.db'));
  t.after(() => { if (db.isOpen) db.close(); });
  return { root: base, home, workspace, exportRoot, config, db, packRoot };
}

/** Stands in for Providers: each stage writes what it produces; `refuse` stages meet a rate limit and wait. */
export class StageFake implements Executor {
  starts: RunSpec[] = []; plan: Record<string, unknown> = { title: 'Luna', extra: true }; refuse = new Set<string>();
  readonly project: () => string;
  constructor(project: () => string) { this.project = project; }
  start(spec: RunSpec): RunHandle {
    if (this.refuse.has(spec.stageId)) throw Object.assign(new Error('rate limited'), { errorClass: 'rate_limit', noSideEffects: true });
    this.starts.push(spec); return { ref: `fake-${spec.runId}` };
  }
  observe(): { state: 'exited' } { return { state: 'exited' }; }
  cancel(): 'confirmed' { return 'confirmed'; }
  confirmNeverStarted(): boolean { return true; }
  collect(handle: RunHandle): RunResult {
    const spec = this.starts.find(item => `fake-${item.runId}` === handle.ref)!;
    const project = this.project();
    if (spec.stageId === 'plan') writeFileSync(join(project, '_harness', 'plan.yaml'), JSON.stringify(this.plan));
    if (spec.stageId === 'make') { mkdirSync(join(project, 'scene'), { recursive: true }); for (const item of ['a', 'b']) writeFileSync(join(project, 'scene', item), item); }
    if (spec.stageId === 'extra') writeFileSync(join(project, 'report.json'), JSON.stringify({ ok: true }));
    return { exitStatus: 0, outputs: {} };
  }
}

export interface SenderOptions { paid?: boolean;frozenProjectAsset?:boolean }
/**
 * The sender's project: a Unity project whose scene references a prefab, a material and a VPM package, a formal
 * Workflow with the plan approved and the make stage passed, the extra stage waiting (rate limited), an Avatar root,
 * a brief with the customer's words and a conversation. Every file is registered, so the project can be shared.
 */
export async function senderProject(t: TestContext, options: SenderOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'avh-share-'));
  t.after(() => removeTemp(root));
  const sender = harnessSide(t, root, 'sender');
  const project = join(sender.workspace, 'Luna');
  const file = (path: string, body: string | Buffer): void => { mkdirSync(join(project, ...path.split('/').slice(0, -1)), { recursive: true }); writeFileSync(join(project, ...path.split('/')), body); };
  mkdirSync(project, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  file('.gitignore', 'Library/\n');
  execFileSync('git', ['-C', project, 'add', '.gitignore']);
  execFileSync('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'init']);
  const meta = (guid: string) => `fileFormatVersion: 2\nguid: ${guid}\n`;
  file('ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3.22f1\n');
  file('ProjectSettings/ProjectSettings.asset', '%YAML 1.1\nPlayerSettings:\n  productName: Luna\n');
  file('Packages/vpm-manifest.json', JSON.stringify({ dependencies: { 'com.vrchat.avatars': { version: '3.7.0' } }, locked: { 'com.vrchat.avatars': { version: '3.7.0' } } }));
  file('Packages/com.vrchat.avatars/package.json', '{"name":"com.vrchat.avatars"}');
  file('Packages/com.vrchat.avatars/Runtime/VRC.cs', 'class VRC {}');
  file('Packages/com.vrchat.avatars/Runtime/VRC.cs.meta', meta(GUID.vpm));
  file('Assets/Scenes.meta', meta('a0000000000000000000000000000001'));
  file('Assets/Scenes/Main.unity', `%YAML 1.1\n--- !u!1001 &100\nPrefabInstance:\n  m_SourcePrefab: {fileID: 100100000, guid: ${GUID.prefab}, type: 3}\n` +
    `--- !u!114 &2\nMonoBehaviour:\n  m_Script: {fileID: 11500000, guid: ${GUID.vpm}, type: 3}\n  m_Font: {fileID: 10102, guid: 0000000000000000e000000000000000, type: 0}\n` +
    (options.paid ? `--- !u!1001 &101\nPrefabInstance:\n  m_SourcePrefab: {fileID: 100100000, guid: ${GUID.paid}, type: 3}\n` : ''));
  file('Assets/Scenes/Main.unity.meta', meta(GUID.scene));
  file('Assets/Avatar.meta', meta('a0000000000000000000000000000002'));
  file('Assets/Avatar/Luna.prefab', `%YAML 1.1\n--- !u!23 &1\nMeshRenderer:\n  m_Materials:\n  - {fileID: 2100000, guid: ${GUID.material}, type: 2}\n`);
  file('Assets/Avatar/Luna.prefab.meta', meta(GUID.prefab));
  file('Assets/Avatar/Body.mat', '%YAML 1.1\n--- !u!21 &2100000\nMaterial:\n  m_Name: Body\n');
  file('Assets/Avatar/Body.mat.meta', meta(GUID.material));
  file('Assets/Avatar/Empty.meta', meta('a0000000000000000000000000000003'));
  mkdirSync(join(project, 'Assets', 'Avatar', 'Empty'), { recursive: true });
  if (options.paid) {
    file('Assets/Paid.meta', meta('a0000000000000000000000000000004'));
    file('Assets/Paid/Kimono.prefab', '%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: Kimono\n');
    file('Assets/Paid/Kimono.prefab.meta', meta(GUID.paid));
  }
  mkdirSync(join(project, '_harness'), { recursive: true });

  const manifestPath = join(sender.root, 'manifest.yaml');
  const input=join(project,'Assets/Avatar/Luna.prefab');
  writeFileSync(manifestPath, stringify({ schema: 'manifest/0.1', profile: 'synthetic-formal', assets: [{ store: 'library', item: options.frozenProjectAsset?input:'1', role: 'body',...(options.frozenProjectAsset?{sha256:createHash('sha256').update(readFileSync(input)).digest('hex')}:{}) }],
    request: '客户原话：想要樱花色的和服（仅在敏感层）' }));
  const workflowId = createWorkflow(sender.db, sender.config, 'Luna', 'synthetic-formal', manifestPath);
  const projectId = (sender.db.prepare('SELECT project_id FROM workflow WHERE id = ?').get(workflowId) as { project_id: string }).project_id;
  const executor = new StageFake(() => project);
  executor.refuse.add('extra');
  const tick = () => serveOnce(sender.db, sender.config, () => executor);
  await tick();
  await decideFormalGate(sender.db, sender.config, workflowId, 'plan_approval', true, '看过方案');
  for (let i = 0; i < 8; i++) {
    await tick();
    const extra = describeWorkflow(sender.db, workflowId).stages.find(stage => stage.id === 'extra');
    if (extra?.task?.status === 'READY') break;
  }
  // The project's own tables: a brief in the customer's words, a conversation, a decision, an Avatar root.
  sender.db.prepare(`INSERT INTO project_brief (project_id, intake_mode, customer_request, face_concept, status) VALUES (?, 'conversation', ?, '温柔', 'direction_approved')`)
    .run(projectId, '客户原话：想要樱花色的和服（仅在敏感层）');
  sender.db.prepare(`INSERT INTO project_message (id, project_id, role, content, status) VALUES ('m-proposed', ?, 'user', '对话原文：发饰要换成星星形状', 'proposed')`).run(projectId);
  sender.db.prepare(`INSERT INTO project_message (id, project_id, role, content, status) VALUES ('m-accepted', ?, 'user', '确认使用粉白配色', 'accepted')`).run(projectId);
  sender.db.prepare(`INSERT INTO avatar_root (id, project_id, scene_path, object_path, role, active_state, blueprint_id) VALUES ('root-1', ?, 'Assets/Scenes/Main.unity', '/Luna', 'working', 'active', 'avtr_00000000-1111-2222-3333-444444444444')`)
    .run(projectId);
  const user = (path: string, match: 'file' | 'tree', rights: NewEntry['rights'], reason: string, layer: NewEntry['shareLayer'] = 'A'): NewEntry =>
    ({ path, match, category: 'user-classified', shareLayer: layer, rights, sensitivity: 'normal', source: { type: 'user', ref: 'test' }, reason });
  registerEntries(sender.db, projectId, [user('Assets/', 'tree', 'transferable', '自己做的工程资源'), user('scene/', 'tree', 'transferable', '制作产物'),
    user('_harness/plan.yaml', 'file', 'transferable', '方案'), user('report.json', 'file', 'transferable', '报告'),
    ...(options.paid ? [user('Assets/Paid/', 'tree', 'not_transferable', 'BOOTH 付费素材'), user('Assets/Paid.meta', 'file', 'not_transferable', 'BOOTH 付费素材')] : [])]);
  return { root, sender, project, projectId, workflowId, executor, tick };
}

/** A receiving Harness with an empty state database and a workspace at another path. */
export function receiverSide(t: TestContext, root: string, options: { pack?: boolean } = {}): Side {
  return harnessSide(t, root, 'receiver', options);
}

/** Every file under a directory, relative with `/`. */
export function listTree(dir: string): string[] {
  const out: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) visit(next); else out.push(relative(dir, next).split(sep).join('/'));
    }
  };
  visit(dir);
  return out.sort();
}
/** Files and the empty folders a package lists (Unity keeps a folder's GUID in its .meta). */
export function listTreeWithDirs(dir: string): string[] {
  const files = listTree(dir);
  const withFiles = new Set(files.flatMap(file => file.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
  const dirs: string[] = [];
  const visit = (rel: string): void => {
    for (const entry of readdirSync(join(dir, ...rel.split('/').filter(Boolean)), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (!withFiles.has(path)) dirs.push(path); else visit(path);
    }
  };
  visit('');
  return [...files, ...dirs].sort();
}

/**
 * Seal an unpacked package again after a test changed it, as its sender would have: each archive file's hash and size
 * in `_harness/archive.json` and the archive's digest, the content list, and the manifest's digests (files a test
 * removed leave both lists). Then pack what is there with 7z.
 */
export function resealPackage(dir: string, out: string): void {
  const path = (name: string): string => join(dir, ...name.split('/'));
  const read = (name: string): Record<string, any> => JSON.parse(readFileSync(path(name), 'utf8')) as Record<string, any>;
  const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
  const archive = read('_harness/archive.json');
  archive.files = (archive.files as Array<Record<string, any>>).filter(file => existsSync(path(file.path))).map(file => {
    const bytes = readFileSync(path(file.path));
    return { ...file, sha256: sha256(bytes), bytes: bytes.length };
  });
  archive.digest = projectionDigest(archive.files);
  writeFileSync(path('_harness/archive.json'), `${JSON.stringify(archive, null, 2)}\n`);
  const files = read('share/files.json');
  files.entries = (files.entries as Array<Record<string, any>>).filter(entry => entry.kind !== 'file' || existsSync(path(entry.path))).map(entry => {
    if (entry.kind !== 'file') return entry;
    const bytes = readFileSync(path(entry.path));
    return { ...entry, size: bytes.length, sha256: sha256(bytes), crc32: (crc32(bytes) >>> 0).toString(16).toUpperCase().padStart(8, '0') };
  });
  const filesText = `${JSON.stringify(files, null, 2)}\n`;
  writeFileSync(path('share/files.json'), filesText);
  const manifest = read('share/manifest.json');
  const listed = (files.entries as Array<Record<string, any>>).filter(entry => entry.kind === 'file');
  manifest.project.digest = archive.digest;
  manifest.integrity = { ...manifest.integrity, files: listed.length, bytes: listed.reduce((sum, entry) => sum + (entry.size as number), 0),
    filesSha256: sha256(filesText), archive: { ...manifest.integrity.archive, digest: archive.digest, files: archive.files.length } };
  writeFileSync(path('share/manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  pack7z(out, dir, listTreeWithDirs(dir), `${out}.members.txt`);
}

/** The concatenated text of every file under a directory (for "this text is nowhere else" assertions). */
export function treeText(dir: string, skip: (path: string) => boolean = () => false): Map<string, string> {
  return new Map(listTree(dir).filter(path => !skip(path) && statSync(join(dir, ...path.split('/'))).size < 8 * 1024 * 1024)
    .map(path => [path, readFileSync(join(dir, ...path.split('/')), 'utf8')]));
}
export function copyPack(from: string, to: string): void { cpSync(from, to, { recursive: true }); }
