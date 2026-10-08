import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import React from 'react';
import ts from 'typescript';
const source = readFileSync(new URL('../../gui/src/face-manual.tsx', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/export function/g, 'function');
const compiled = ts.transpileModule(source + '\nglobalThis.Component=ManualFaceView;', { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
function elements(value: any): any[] { if (Array.isArray(value)) return value.flatMap(elements); return value?.props ? [value, ...elements(value.props.children)] : []; }
const text = (value: any): string => Array.isArray(value) ? value.map(text).join('') : value?.props ? text(value.props.children) : typeof value === 'string' ? value : '';
test('shipped manual UI keeps choices and open/stop/resume reachable and shares the existing acceptance consumer', async () => {
  const state: any = { mode: 'manual', revision: 4, acceptedSessionId: null, current: { id: 'draft', workflowId: 'manual-workflow', viewProjectId: 'version-project', status: 'processing', expectedHash: 'output' }, versions: [{ id: 'accepted', version: 1 }], targets: [], blender: { minimumVersion: '4.2', downloadUrl: 'https://www.blender.org/download/' } };
  const calls: any[] = []; let cursor = 0; const slots: any[] = [];
  const context = { React, useState: (initial: any) => { const i = cursor++; if (slots[i] === undefined) slots[i] = initial; return [slots[i], (v: any) => slots[i] = v]; }, useEffect: () => {},
    useLoad: () => [state, null], useAction: () => ({ busy: 'processing', run: async (_key: string, fn: any) => fn() }), Panel: 'section', FacePreviewView: 'shared-preview', call: async (method: string, params: any) => calls.push({ method, params }), Component: undefined };
  runInNewContext(compiled, context); const render = () => { cursor = 0; return (context.Component as any)({ projectId: 'project', refresh: 1, changed: () => {} }); };
  const button = (label: string) => elements(render()).find(e => e.type === 'button' && text(e) === label);
  for (const status of ['preparing', 'opened', 'processing', 'awaiting', 'warning', 'stopping']) {
    state.current.status = status; assert.equal(button('在 Blender 中打开').props.disabled, true); assert.equal(button('取消 / 中断').props.disabled, undefined);
    for (const label of ['保留原脸', '让 AI 设计', '我自己来']) assert.ok(button(label));
  }
  state.current.status = 'processing'; await button('取消 / 中断').props.onClick(); assert.equal(calls.at(-1).method, 'project.face.manual.cancel');
  await button('让 AI 设计').props.onClick(); assert.equal(calls.at(-1).params.mode, 'ai'); assert.equal(calls.at(-1).params.expectedRevision, 4);
  state.current.status = 'cancelled'; await button('继续手动捏脸').props.onClick(); assert.equal(calls.at(-1).method, 'project.face.manual.resume');
  state.current.status = 'opened'; assert.equal(button('捏好了').props.disabled, true);
  context.useAction = () => ({ busy: '', run: async (_key: string, fn: any) => fn() });
  assert.equal(button('在 Blender 中打开').props.disabled,false);
  await button('捏好了').props.onClick(); assert.equal(calls.at(-1).method, 'project.face.manual.done');
  state.current.status = 'awaiting'; const preview = elements(render()).find(e => e.type === 'shared-preview'); assert.equal(preview.props.projectId, 'version-project'); assert.equal(preview.props.accept.expectedHash, 'output');
  await button('回退到此版本').props.onClick(); assert.equal(calls.at(-1).params.sessionId, 'accepted');
  state.production={requirement:{mode:'manual',manualVersion:2},making:{mode:'manual',manualVersion:1,preparing:false},application:null,deliveries:[]};
  assert.match(text(render()),/当前要求：手动脸型版本 2/);assert.match(text(render()),/正在制作的版本：手动脸型版本 1/);
});
