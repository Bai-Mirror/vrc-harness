import assert from 'node:assert/strict';
import test from 'node:test';
import { renderVerify, text, type VerifyRender } from '../fixtures/verify-component.ts';

// The shipped stage-detail component, executed with controlled dependencies (see the fixture): whether the accept
// control appears is read off the rendered tree, and clicking it goes through the real handler to the real API call.
// The judgement of what is acceptable belongs to the Runtime (`acceptanceRequired`), so this only checks the
// interface honours it.
type Check = Record<string, any>;
/** A warning reading the Runtime says may be accepted, plus whatever other readings the case needs. */
function check(over: Partial<Check> = {}): Check {
  return { id: 'regression_footwear_coverage', severity: 'warning', scope: 'play', on: 'build', rule: 'fit >= 2',
    observe: 'avatar.fit', maturity: 'accepted', acceptanceRequired: false,
    verdict: { result: 'violation', basis: null, recordedAt: '2026-10-04T00:00:00.000Z', id: 'reading-1', current: true,
      scope: 'play', artifactHash: 'a'.repeat(64), boundHash: 'a'.repeat(64), accepted: false, acceptedAt: null },
    ...over };
}
function harness(checks: Check[], answer: string | undefined = undefined): VerifyRender {
  const workflow = { id: 'workflow', project: '/tmp/sample', projectName: 'sample', profile: 'pc-recolor-outfit',
    status: 'active', next: '', processHash: 'p'.repeat(64), knowledgeVersion: 'k'.repeat(64),
    plan: { approved: true, revisions: 1 },
    stages: [{ id: 'regression', status: 'blocked', display: 'blocked', reasons: [], codes: ['warning_unaccepted'], checks }] };
  return renderVerify(workflow, answer);
}

test('only a warning the Runtime would accept gets the banner and the accept control', () => {
  const acceptable = harness([check({ acceptanceRequired: true })]);
  assert.match(text(acceptable.render()), /有 1 条提醒等你确认/);
  assert.equal(text(acceptable.button('接受这条提醒')!.props.children), '接受这条提醒');

  // A blocking failure is the person's repair, not their acceptance: no banner, no button, and not even a hint of one.
  const blocking = harness([check({ severity: 'blocking', acceptanceRequired: false })]);
  assert.doesNotMatch(text(blocking.render()), /提醒等你确认/);
  assert.equal(blocking.button('接受这条提醒'), undefined);
  assert.equal(blocking.warningState(check({ severity: 'blocking' })), 'done');

  // An advisory reading does not block anything, so there is nothing to accept either.
  const advisory = harness([check({ severity: 'advisory', acceptanceRequired: false })]);
  assert.doesNotMatch(text(advisory.render()), /提醒等你确认/);
  assert.equal(advisory.button('接受这条提醒'), undefined);
});

test('a warning that does not apply is shown as measured, without an accept control the Runtime would refuse', () => {
  const notApplicable = check({ acceptanceRequired: false,
    verdict: { ...check().verdict, result: 'not_applicable', basis: 'plan.client_gallery' } });
  const ui = harness([notApplicable]);
  assert.equal(ui.warningState(notApplicable), 'done');
  assert.doesNotMatch(text(ui.render()), /提醒等你确认/);
  assert.equal(ui.button('接受这条提醒'), undefined);
  assert.match(text(ui.render()), /不适用|not_applicable/, 'the reading itself is still shown, just not as an action');
  // An accepted reading with evidence that has moved on is told to measure again, never offered as acceptable now.
  const stale = check({ acceptanceRequired: false, verdict: { ...check().verdict, current: false } });
  assert.equal(ui.warningState(stale), 'stale');
  assert.equal(harness([check({ acceptanceRequired: true, verdict: { ...check().verdict, current: false } })]).button('接受这条提醒'), undefined);
});

test('accepting asks the person for a reason and sends their words, not a channel label', async () => {
  const reason = '鞋底覆盖读数已知，鞋型改造后会重新测量';
  const ui = harness([check({ acceptanceRequired: true })], reason);
  await ui.button('接受这条提醒')!.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.asked.length, 1, 'the existing input dialog is used');
  assert.equal(ui.asked[0].required, true, 'a reason is required');
  assert.equal(ui.asked[0].multiline, true);
  const sent = ui.calls.filter(call => call.method === 'warning.accept');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.params.note, reason, 'the words the person typed are stored verbatim');
  assert.equal(sent[0]!.params.expectedVerdictId, 'reading-1', 'the request binds the reading that was displayed');
  assert.ok(ui.notes.some(note => /已记录你接受这条提醒/.test(note)));
});

test('cancelling the reason dialog asks nothing of the Runtime', async () => {
  const ui = harness([check({ acceptanceRequired: true })], undefined);
  await ui.button('接受这条提醒')!.props.onClick();
  assert.equal(ui.asked.length, 1);
  assert.deepEqual(ui.calls.filter(call => call.method === 'warning.accept'), []);
});
