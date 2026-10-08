import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openDatabase } from '../src/state/db.ts';
import { compactProjectContext, durableState } from '../src/project-state.ts';
import { effectiveFacePlan, facePreference } from '../src/face-policy.ts';

/**
 * The face choice is durable project state, not a conversation detail: the executor is told which mode production is
 * in, and a handoff that nobody has accepted yet must not stall production or silently start AI design.
 */
function fixture(t: test.TestContext): { db: DatabaseSync; project: string; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'avh-face-policy-'));
  const db = openDatabase(join(directory, 'state.sqlite'));
  t.after(() => { if (db.isOpen) db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.prepare('INSERT INTO workspace (id, path) VALUES (?, ?)').run('workspace', directory);
  db.prepare(`INSERT INTO project (id, workspace_id, kind, path, identity_json, lifecycle, harness_version, knowledge_version)
    VALUES ('project','workspace','sample',?,'{}','active','h','k')`).run(join(directory, 'source'));
  return { db, project: 'project', directory };
}

const choose = (db: DatabaseSync, project: string, mode: string, accepted: string | null = null): void => {
  db.prepare(`INSERT INTO face_preference (project_id, mode, revision, accepted_session_id) VALUES (?, ?, 1, ?)
    ON CONFLICT(project_id) DO UPDATE SET mode=excluded.mode, accepted_session_id=excluded.accepted_session_id`)
    .run(project, mode, accepted);
};

test('the chosen face mode reaches the injected project context, and an unaccepted handoff says production keeps the original face', t => {
  const { db, project } = fixture(t);
  const context = (): string => compactProjectContext(durableState(db, project));
  assert.equal(context().includes('脸型方式：'), false, 'a project that has not chosen must not claim a face mode');

  choose(db, project, 'preserve');
  assert.match(context(), /脸型方式：保留原脸，不设计脸型/);
  choose(db, project, 'ai');
  assert.match(context(), /脸型方式：让 AI 设计/);
  // The manual mode is the one the executor could misread as "wait for the person": without an accepted input the
  // effective plan is the original face, and the context has to say so in those words.
  choose(db, project, 'manual');
  assert.match(context(), /脸型方式：我自己来，尚未接受手动版本，制作保留原脸；不等待用户、不进行 AI 脸型设计/);
  choose(db, project, 'manual', 'session-1');
  assert.match(context(), /脸型方式：我自己来，制作使用已接受的手动输入/);
  assert.equal(facePreference(db, project)!.acceptedSessionId, 'session-1');
});

test('effective face plan is pure and clears mode-specific fields', () => {
  const base = { face: { mode: 'manual', manualSessionId: 's1', request: 'design', candidates: ['a'], selection: 'a' }, unchanged: true };
  assert.deepEqual(effectiveFacePlan(base), base);
  assert.deepEqual(effectiveFacePlan(base, { schema: 'face-input/0.1', mode: 'preserve' }), { face: { mode: 'preserve' }, unchanged: true });
  assert.deepEqual(effectiveFacePlan(base, { schema: 'face-input/0.1', mode: 'manual', manualSessionId: 's2' }), { face: { mode: 'manual', manualSessionId: 's2' }, unchanged: true });
  assert.equal(effectiveFacePlan(base, { schema: 'face-input/0.1', mode: 'design' }).face.manualSessionId, undefined);
  assert.equal(base.face.manualSessionId, 's1');
});
