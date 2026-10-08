import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { deflateSync } from 'node:zlib';
import { parse } from 'yaml';
import { loadProcess } from '../../src/process/load.ts';
import type { ProcessDefinition, Verdict } from '../../src/process/types.ts';
import { artifactFingerprint } from '../../src/workflow/artifacts.ts';
import { aggregateWorkflow } from '../../src/state/aggregate-input.ts';
import { openDatabase } from '../../src/state/db.ts';
import { Scheduler } from '../../src/runtime/scheduler.ts';
import type { Executor, Fingerprinter, RunHandle, RunResult, RunSpec, Verifier } from '../../src/runtime/interfaces.ts';
import { transitionTask } from '../../src/runtime/transitions.ts';
import { decideFormalGate, formalGates } from '../../src/workflow/runtime.ts';
import { renderedImageDigest } from '../../src/stage-photos.ts';
import { removeTemp } from '../fixtures/platform.ts';

const PROCESS_ROOT = join(import.meta.dirname, '../../builtin/knowledge/process');
function crc(bytes: Buffer): number { let n = 0xffffffff; for (const byte of bytes) { n ^= byte; for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; }
function chunk(type: string, bytes: Buffer): Buffer { const out = Buffer.alloc(bytes.length + 12); out.writeUInt32BE(bytes.length); out.write(type, 4); bytes.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, -4)), out.length - 4); return out; }
function previewPng(): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(128); header.writeUInt32BE(128, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((128 * 3 + 1) * 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) for (let channel = 0; channel < 3; channel++)
    pixels[y * (128 * 3 + 1) + 1 + x * 3 + channel] = (x ^ y ^ (channel * 47)) & 255;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

class ImmediateExecutor implements Executor {
  starts: RunSpec[] = [];
  start(spec: RunSpec): RunHandle { this.starts.push(spec); return { ref: spec.runId }; }
  observe(): { state: 'exited' } { return { state: 'exited' }; }
  cancel(): 'confirmed' { return 'confirmed'; }
  collect(): RunResult { return { exitStatus: 0, outputs: {} }; }
}

class RecolorVerifier implements Verifier {
  calls = 0;
  readonly definition: ProcessDefinition;
  constructor(definition: ProcessDefinition) { this.definition = definition; }
  verify(_spec: RunSpec, _result: RunResult, hashes: Record<string, string>): Verdict[] {
    this.calls++;
    return this.definition.checks.map(check => ({ id: '', checkId: check.id, scope: check.scope,
      artifactHash: hashes[check.on] ?? '', result: this.calls === 1 && check.id === 'recolor_source_mapped' ? 'violation' : 'pass',
      basis: 'deterministic independent observation' }));
  }
}

test('the actual recolor definition repairs a blocking check before opening its approval gate', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-gate-check-retry-'));
  const home = join(root, 'home'), project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  const db = openDatabase(join(home, 'state.sqlite'));
  t.after(() => { db.close(); removeTemp(root); });
  mkdirSync(join(project, 'Assets/_Harness/Recolor'), { recursive: true });
  writeFileSync(join(project, 'Assets/_Harness/Recolor/recipe.json'), JSON.stringify({ tiers: [{ id: 'primary', label: 'Primary' }], chosen: 'primary' }));

  const real = loadProcess(readFileSync(join(PROCESS_ROOT, 'pc-recolor-outfit.process.yaml'), 'utf8'),
    parse(readFileSync(join(PROCESS_ROOT, 'thresholds.yaml'), 'utf8')));
  const recolor = real.stages.find(stage => stage.id === 'recolor')!;
  const definition: ProcessDefinition = { ...real, artifacts: [...new Set(['materials', ...recolor.requires.map(id => real.checks.find(check => check.id === id)!.on)])],
    stages: [{ ...recolor, needs: [], invalidated_by: [] }], checks: real.checks.filter(check => recolor.requires.includes(check.id)),
    gates: real.gates.filter(gate => recolor.gates.includes(gate.id)), milestones: [] };
  const materialHash = artifactFingerprint(project, { paths: ['Assets/_Harness/Recolor'], includeIgnored: true })!;
  const hashes = Object.fromEntries(definition.artifacts.map(kind => [kind, kind === 'materials' ? materialHash : 'e'.repeat(64)]));
  const capabilities = { schema: 'capabilities/0.1', process: definition.id, version: 'test',
    artifacts: { materials: { paths: ['Assets/_Harness/Recolor'], includeIgnored: true } },
    stages: { recolor: { resources: [], maxRetries: 0, maxCheckRetries: 2 } }, observers: {} };

  db.prepare("INSERT INTO workspace(id,path) VALUES('ws',?)").run(root);
  db.prepare("INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version) VALUES('p','ws','sample',?,'{}','active','h','k')").run(project);
  db.prepare("INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json) VALUES('w','p',?,'hash','k','active',?)")
    .run(definition.id, JSON.stringify({ avatar_config: { groups: [] } }));
  db.prepare(`INSERT INTO workflow_definition(workflow_id,profile,definition_json,capabilities_json,thresholds_json,tool_root)
    VALUES('w','pc-recolor-outfit',? ,?,'{}',?)`).run(JSON.stringify(definition), JSON.stringify(capabilities), root);
  for (const [kind, hash] of Object.entries(hashes)) db.prepare('INSERT INTO artifact_version(workflow_id,kind,hash) VALUES(?,?,?)').run('w', kind, hash);
  db.prepare(`INSERT INTO task(id,workflow_id,stage_id,goal,capability,status,retry_policy_json)
    VALUES('t','w','recolor','synthetic recolor','recolor','PENDING',?)`).run(JSON.stringify({ maxRetries: 0, maxCheckRetries: 2 }));
  transitionTask(db, 't', 'READY', 'ready', 'test setup');

  const executor = new ImmediateExecutor(), verifier = new RecolorVerifier(definition);
  const fingerprinter: Fingerprinter = { fingerprint: () => hashes };
  const scheduler = new Scheduler(db, 'w', definition, executor, verifier, fingerprinter,
    { maxRetries: 0, stageCheckRetries: { recolor: 2 }, slotCapacity: {}, stageSlots: {} });
  await scheduler.tick();
  let run = db.prepare('SELECT id FROM run ORDER BY attempt DESC LIMIT 1').get() as { id: string };
  assert.equal((db.prepare("SELECT status FROM task WHERE id='t'").get() as { status: string }).status, 'READY');
  assert.equal(executor.starts.length, 1, 'the blocking observation creates a repair Run before the Gate is actionable');
  assert.equal(formalGates(db, 'w')[0]!.status, 'waiting');

  await scheduler.tick();
  run = db.prepare('SELECT id FROM run ORDER BY attempt DESC LIMIT 1').get() as { id: string };
  assert.equal(executor.starts.length, 2);
  assert.equal((db.prepare("SELECT status FROM task WHERE id='t'").get() as { status: string }).status, 'WAITING_HUMAN');
  assert.deepEqual(aggregateWorkflow(db, 'w', definition).stages.recolor!.reasonCodes, ['gate_pending']);
  const gate = formalGates(db, 'w')[0]!;
  assert.equal(gate.status, 'pending');

  const candidates = join(root, 'runs', run.id, 'candidates');
  mkdirSync(candidates, { recursive: true });
  writeFileSync(join(candidates, 'primary_original.png'), previewPng());
  writeFileSync(join(candidates, 'primary_original.json'), JSON.stringify({ schema: 'camera-spec/0.1', projection: 'orthographic', ortho_size: 1,
    position: [0, 0, 0], rotation: [0, 0, 0], background: [0, 0, 0, 1], lights: [], width: 128, height: 128, candidate: 'primary' }));
  const previewDigest = renderedImageDigest(join(root, 'runs', run.id), 'candidates')!;
  const result = JSON.parse((db.prepare('SELECT result_json FROM run WHERE id=?').get(run.id) as { result_json: string }).result_json);
  db.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify({ ...result, previewStates: ['original'],
    previewDigests: { recolor: previewDigest }, unitySteps: [{ method: 'AVH.Harness.RecolorStage.Run', exitCode: 0 }] }), run.id);
  db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason) VALUES('w','runtime','run',?,'unity_unit_intended','test evidence')").run(run.id);
  const preview = (await import('../../src/stage-photos.ts')).projectRecolorPreview(db, 'p', 'w', materialHash);
  assert.equal(preview.status, 'ready');
  if (preview.status !== 'ready') return;
  await decideFormalGate(db, { home, toolRoot: root, unitySlots: { count: 1 }, providers: [] } as any,
    'w', 'recolor_approval', true, '[代办:fx2/gpt-5.6-terra] tested repair path', gate.artifactHash,
    undefined, undefined, gate.inputHashes, undefined, preview.previewSha256);
  await scheduler.tick();
  assert.equal((db.prepare("SELECT status FROM task WHERE id='t'").get() as { status: string }).status, 'PASSED');
});
