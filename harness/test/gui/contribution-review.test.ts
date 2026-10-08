import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { guiRoute } from '../../src/gui/server.ts';

// Execute the shipped Core handler and render its actual confirmation body. API outcomes are controlled;
// exact Runtime preview/bundle/revision binding is tested separately through real TUI→Runtime requests.
const source = readFileSync(new URL('../../gui/src/main.tsx', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('  async function authorizeCandidateContribution('), source.indexOf('  async function submitCandidateContribution('));
const compiled = ts.transpileModule(handler + '\nglobalThis.authorizeReport=authorizeCandidateContribution;', {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const preview = { version: '0.1.0-candidate.1', reason: '合成修复候选', basePackId: 'synthetic-base', contentHash: 'a'.repeat(64), evaluationId: 'evaluation-viewed', reportHash: 'b'.repeat(64),
  evaluation: { suiteId: 'synthetic-regression', suiteVersion: '2', isolation: 'process' }, rateDenominators: { baseline: 2, candidate: 2 },
  report: { sourceKind: 'human', evaluation: { status: 'failed',
    baseline: { cases: 2, modelFamilies: 1, attempts: 2, passes: 2, failures: 0, firstPassRate: 1, secondPassRate: 1 },
    candidate: { cases: 2, modelFamilies: 1, attempts: 3, passes: 1, failures: 2, firstPassRate: .5, secondPassRate: .5 } } } };
function harness(options: { confirm?: boolean; previewFailure?: boolean; stale?: boolean } = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [], prompts: Array<{ title: string; body: React.ReactElement; confirm: string }> = [];
  const successes: string[] = [], errors: string[] = []; let reloads = 0;
  const context = { React, candidateSource: () => '人工', reload: () => { reloads++; },
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'managed.contribution.preview') { if (options.previewFailure) throw Error('候选内容已变化'); return structuredClone(preview); }
      assert.equal(method, 'managed.contribution.authorize');
      if (options.stale) throw Error('报告或候选版本已变化，请重新查看后授权');
      return { id: 'synthetic-report' };
    },
    feedback: { confirm: async (prompt: { title: string; body: React.ReactElement; confirm: string }) => { prompts.push(prompt); return options.confirm === true; } },
    run: async (_key: string, action: () => Promise<unknown>, success?: string) => {
      try { await action(); if (success) successes.push(success); return true; } catch (error) { errors.push(String((error as Error).message)); return false; }
    }, authorizeReport: undefined as unknown,
  };
  runInNewContext(compiled, context);
  return { run: () => (context.authorizeReport as (id: string) => Promise<void>)('candidate-selected'), calls, prompts, successes, errors, reloads: () => reloads };
}

test('GUI renders the actual failed report, baseline, denominators and upload exclusions before explicit authorization', async () => {
  const ui = harness({ confirm: true }); await ui.run();
  assert.deepEqual(ui.calls.map(item => item.method), ['managed.contribution.preview', 'managed.contribution.authorize']);
  const shown = renderToStaticMarkup(ui.prompts[0]!.body);
  for (const label of ['synthetic-base', 'synthetic-regression', '未通过', '案例数', '尝试次数', '通过尝试', '未通过尝试', '基准', '候选', '50.0%', '比率分母：案例×模型组合', '仅包含', '不发送工程、素材、客户要求、提示词、知识和工具原文']) assert.ok(shown.includes(label), label);
  assert.match(shown, /<th>尝试次数<\/th><td>2<\/td><td>3<\/td>/);
  assert.match(shown, /<th>比率分母：案例×模型组合<\/th><td>2<\/td><td>2<\/td>/);
  const authorization = ui.calls[1]!.params; assert.equal(authorization.candidateId, 'candidate-selected');
  assert.equal(authorization.expectedEvaluationId, preview.evaluationId); assert.equal(authorization.expectedContentHash, preview.contentHash); assert.equal(authorization.expectedReportHash, preview.reportHash);
  assert.deepEqual(ui.successes, ['已加入贡献队列']); assert.equal(ui.reloads(), 1);
});

test('GUI preview has no preselected authorization and cancelling makes no authorization call', async () => {
  const ui = harness(); await ui.run(); assert.equal(ui.prompts.length, 1);
  assert.deepEqual(ui.calls.map(item => item.method), ['managed.contribution.preview']); assert.deepEqual(ui.successes, []); assert.equal(ui.reloads(), 0);
});

test('GUI cannot confirm or claim success when actual report preview fails', async () => {
  const ui = harness({ confirm: true, previewFailure: true }); await ui.run();
  assert.equal(ui.prompts.length, 0); assert.equal(ui.calls.length, 1); assert.deepEqual(ui.successes, []); assert.deepEqual(ui.errors, ['候选内容已变化']);
});

test('GUI preserves viewed-version expectations and reports stale rejection without success', async () => {
  const ui = harness({ confirm: true, stale: true }); await ui.run(); assert.equal(ui.calls.length, 2);
  assert.equal(ui.calls[1]!.params.expectedReportHash, preview.reportHash); assert.deepEqual(ui.successes, []); assert.equal(ui.reloads(), 0); assert.match(ui.errors[0]!, /重新查看后授权/);
});

test('GUI permits only the declared readonly report preview method through its existing Runtime bridge', () => {
  assert.equal(guiRoute('managed.contribution.preview', true), 'runtime'); assert.equal(guiRoute('managed.contribution.previewFiles', true), 'refused');
});
