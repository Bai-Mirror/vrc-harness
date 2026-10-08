import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { stringify } from 'yaml';
import { importProject } from '../../src/import/index.ts';
import type { ProcessDefinition } from '../../src/process/types.ts';
import { openDatabase } from '../../src/state/db.ts';
import { artifactFingerprint } from '../../src/workflow/artifacts.ts';
import { removeTemp } from './platform.ts';

/** Synthetic projects for the project archive tests: a Unity project in a workspace, a state database under AVH_HOME. */
export const IMPORT_DEFINITION: ProcessDefinition = { schema: 'process/0.1', id: 'synthetic', version: '1', applies_to: {}, artifacts: [],
  stages: [{ id: 'setup', needs: [], produces: [], requires: [], gates: [], invalidated_by: [] },
    { id: 'menu', needs: [], produces: [], requires: [], gates: [], invalidated_by: [] }], checks: [], gates: [], milestones: [] };

export function archiveFixture(t: TestContext, options: { record?: boolean; git?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'avh-archive-'));
  const workspace = join(root, 'workspace'), project = join(workspace, 'Sample');
  for (const dir of ['ProjectSettings', 'Packages/com.vrchat.avatars', 'Assets/Avatar']) mkdirSync(join(project, dir), { recursive: true });
  writeFileSync(join(project, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
  writeFileSync(join(project, 'Packages/vpm-manifest.json'), JSON.stringify({ locked: { 'com.vrchat.avatars': { version: '3.7.0' },
    'nadena.dev.modular-avatar': { version: '1.13.0' } } }));
  writeFileSync(join(project, 'Packages/com.vrchat.avatars/package.json'), '{"name":"com.vrchat.avatars"}');
  writeFileSync(join(project, 'Assets/Avatar/Avatar.prefab'), 'prefab');
  writeFileSync(join(project, 'Assets/Avatar/Avatar.prefab.meta'), 'guid: 1');
  if (options.record) writeFileSync(join(project, '_施工记录.md'), `## 2026-09-20 10:00 · setup（执行者）
- **做了什么**：导入素体
- **结果**：✓ 完成
`);
  if (options.git) execFileSync('git', ['init', '-q', project]);
  mkdirSync(join(root, 'home', 'state'), { recursive: true });
  const db = openDatabase(join(root, 'home', 'state', 'harness.db'));
  t.after(() => { if (db.isOpen) db.close(); removeTemp(root); });
  const imported = () => importProject(db, { workspacePath: workspace, projectPath: project, definition: IMPORT_DEFINITION, kind: 'private',
    config: { toolRoot: '/synthetic/no-tools' } });
  return { root, workspace, project, db, imported };
}

export const FLOW: ProcessDefinition = { schema: 'process/0.1', id: 'flow', version: '1', applies_to: {}, artifacts: ['plan'],
  stages: [{ id: 'plan', needs: [], produces: ['plan'], requires: ['titled'], gates: ['approval'], invalidated_by: ['plan'] }],
  checks: [{ id: 'titled', observe: 'plan.inspect', on: 'plan', scope: 'edit', rule: 'title > 0', severity: 'blocking', maturity: 'accepted' }],
  gates: [{ id: 'approval', kind: 'approve', binds: 'plan' }], milestones: [] };
export const FLOW_CAPABILITIES = { schema: 'capabilities/0.1', process: 'flow', version: '1',
  artifacts: { plan: { paths: ['_harness/plan/plan.yaml'], format: 'yaml' as const } },
  stages: { plan: { mode: 'provider', goal: '写方案', context: [], contextBudgetChars: 2000, contextCoverage: [], allowedWrites: ['_harness/plan/'],
    resources: [], maxRetries: 0, maxCheckRetries: 0 } }, observers: {} };
/** A formal Workflow whose plan was checked and approved at its current version; returns the plan's fingerprint. */
export function approvedWorkflow(db: DatabaseSync, projectId: string, project: string, workflowId = 'flow-1'): string {
  mkdirSync(join(project, '_harness/plan'), { recursive: true });
  writeFileSync(join(project, '_harness/plan/plan.yaml'), stringify({ title: '冬装' }));
  const hash = artifactFingerprint(project, FLOW_CAPABILITIES.artifacts.plan)!;
  db.prepare(`INSERT INTO workflow (id, project_id, process_id, process_hash, knowledge_version, status, plan_json)
    VALUES (?, ?, 'flow', 'process-hash', 'k', 'active', '{}')`).run(workflowId, projectId);
  db.prepare(`INSERT INTO workflow_definition (workflow_id, profile, definition_json, capabilities_json, thresholds_json) VALUES (?, 'flow', ?, ?, '{}')`)
    .run(workflowId, JSON.stringify(FLOW), JSON.stringify(FLOW_CAPABILITIES));
  db.prepare("INSERT INTO artifact_version (workflow_id, kind, hash) VALUES (?, 'plan', ?)").run(workflowId, hash);
  db.prepare(`INSERT INTO verdict (id, workflow_id, check_id, scope, artifact_hash, result, basis) VALUES (?, ?, 'titled', 'edit', ?, 'pass', 'title=1')`)
    .run(`${workflowId}-run:titled`, workflowId, hash);
  db.prepare("INSERT INTO gate_decision (workflow_id, gate_id, artifact_hash, result) VALUES (?, 'approval', ?, 'approved')").run(workflowId, hash);
  db.prepare("INSERT INTO stage_completion (workflow_id, stage_id, artifact_hashes_json) VALUES (?, 'plan', ?)").run(workflowId, JSON.stringify({ plan: hash }));
  return hash;
}
