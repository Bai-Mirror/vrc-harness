import assert from 'node:assert/strict';
import test from 'node:test';
import { renderProjectWorkspace } from '../fixtures/main-app-component.ts';

test('the shipped App passes a successor gate to ProjectWorkspace and its change lookup uses the logical project', () => {
  const gate = { gate: 'successor:plan', project: 'successor-path', workflowId: 'successor', projectName: 'Source', status: 'pending' };
  const projects = [{ id: 'source', path: 'source-path', name: 'Source', workflow: { id: 'successor' }, tasks: { total: 0, open: 0, needsYou: 0 } }];
  const rendered = renderProjectWorkspace(projects, [gate]);
  assert.deepEqual(rendered.tree.props.gates, [gate], 'App must pass the successor gate into the workspace');
  rendered.tree.props.decisions.requestChange(gate);
  assert.equal(rendered.selected.id, 'source', 'change request must locate the logical source project');
  assert.equal(rendered.selected.tab, 'requests');
});
