import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { GUI_METHODS, guiRoute } from '../../src/gui/server.ts';

// DATA/D8: the trace chain has to be readable from the interface, not only from a client that speaks the API.
// This executes the shipped Core handler and renders the dialog it actually shows.
const source = readFileSync(new URL('../../gui/src/main.tsx', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('  async function showContributionTrace('), source.indexOf('  const runDoctor ='));
const compiled = ts.transpileModule(handler + '\nglobalThis.showTrace=showContributionTrace;', {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

// Synthetic identities only: a repo test must not name a real receipt or a published release id, or it silently
// pins the assertions to one deployment and reads as if that deployment were the contract.
const RECEIPT = 'd'.repeat(32);
const RELEASE = 'vrc-knowledge-9.9.9-trace';
const complete = { schema: 'harness-contribution-trace/0.1', receiptId: RECEIPT, candidateId: 'synthetic-candidate',
  evaluationId: 'synthetic-evaluation', contributionStatus: 'submitted', submittedAt: '2026-01-02T03:04:05.678Z',
  release: { releaseId: RELEASE, packId: RELEASE, version: '9.9.9-trace',
    status: 'active', installedAt: '2026-01-02T03:06:07.890Z', activatedAt: '2026-01-02T03:08:09.012Z' },
  installed: { releaseId: RELEASE, packId: RELEASE, version: '9.9.9-trace', active: true },
  complete: true, refresh: { recorded: 0 } };

function harness(trace: unknown, failure?: string) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const prompts: Array<{ title: string; body: React.ReactElement; confirm: string }> = [];
  const errors: string[] = [];
  const context = { React, showTrace: undefined as unknown,
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (failure) throw Error(failure);
      return structuredClone(trace);
    },
    busy: '', feedback: { confirm: async (prompt: { title: string; body: React.ReactElement; confirm: string }) => { prompts.push(prompt); return true; } },
    run: async (_key: string, action: () => Promise<unknown>) => { try { await action(); return true; } catch (error) { errors.push(String((error as Error).message)); return false; } } };
  runInNewContext(compiled, context);
  return { run: () => (context.showTrace as (id: string) => Promise<void>)(RECEIPT), calls, prompts, errors };
}

test('the core page renders which signed release accepted the report and which version this computer runs', async () => {
  const ui = harness(complete);
  await ui.run();
  // The call crosses a vm realm, so compare what the Runtime receives field by field.
  assert.deepEqual(ui.calls.map(item => item.method), ['managed.contribution.trace']);
  assert.equal(ui.calls[0]!.params.receiptId, RECEIPT);
  assert.equal(ui.prompts.length, 1);
  const shown = renderToStaticMarkup(ui.prompts[0]!.body);
  assert.match(shown, /已被纳入一个签名发行，本机当前使用该版本/);
  assert.ok(shown.includes(RELEASE), 'the release the report went into is named');
  assert.match(shown, /9\.9\.9-trace（当前启用）/);
  assert.match(shown, /提交 2026-01-02 03:04:05Z/);
  assert.match(shown, new RegExp(RECEIPT), 'the receipt stays visible as the evidence behind the sentence');
});

test('a chain the server never confirmed reads as "not adopted", not as a failure, and names the unreachable read', async () => {
  const ui = harness({ ...complete, release: null, installed: null, complete: false, refresh: { recorded: 0, error: 'fetch failed' } });
  await ui.run();
  const shown = renderToStaticMarkup(ui.prompts[0]!.body);
  assert.match(shown, /接受回执不等于被采纳/);
  assert.match(shown, /维护者采纳：尚无/);
  assert.match(shown, /本次没能向服务端核对（fetch failed）/);
  assert.doesNotMatch(shown, /当前启用/);
});

test('a failed read shows the error and opens no dialog', async () => {
  const ui = harness(complete, '没有这条贡献记录');
  await ui.run();
  assert.deepEqual(ui.errors, ['没有这条贡献记录']);
  assert.deepEqual(ui.prompts, []);
});

test('the trace method is reachable through the GUI server, and the allowlist is what makes it so', () => {
  assert.ok(GUI_METHODS.has('managed.contribution.trace'));
  assert.equal(guiRoute('managed.contribution.trace', false), 'runtime');
  assert.equal(guiRoute('managed.contribution.export', false), 'refused',
    'a method the page does not call stays out: this is the list that made the chain unreachable');
});
