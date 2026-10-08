import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import React from 'react';
import ts from 'typescript';

// The decision card as the person reads it: what it shows, and which variant of the evidence it asks for. The evidence
// component itself is rendered as a stand-in, so this only asserts the card's own wiring (F27b: the card carries the
// condensed strip and never the whole candidate grid, which the scene preview card beside it already draws).
const source = readFileSync(new URL('../../gui/src/decide.tsx', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/export function/g, 'function');
const compiled = ts.transpileModule(source + '\nglobalThis.Components={GateCard};',
  { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
type Element = { type: unknown; props: Record<string, any> };
function elements(value: any): Element[] { if (Array.isArray(value)) return value.flatMap(elements); return value?.props ? [value, ...elements(value.props.children)] : []; }
const text = (value: any): string => Array.isArray(value) ? value.map(text).join('') : value?.props ? text(value.props.children) : typeof value === 'string' ? value : '';

function harness() {
  const states = new Map<unknown, any[]>(), cursors = new Map<unknown, number>();
  let current: unknown = null;
  const context: Record<string, unknown> = {
    React,
    useState: (initial: any) => { const slots = states.get(current) ?? []; states.set(current, slots);
      const slot = cursors.get(current) ?? 0; cursors.set(current, slot + 1);
      if (slots[slot] === undefined) slots[slot] = initial;
      return [slots[slot], (value: any) => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; }]; },
    useEffect: () => { /* the card's plan lookup is not what these assertions are about */ },
    call: async () => ({ current: {} }),
    artifactLabel: (binds: string) => `产物(${binds})`,
    FOUR_STATE_LABEL: { "needs-you": "需要你决定" },
    gateHint: () => '', gateState: () => ["待决定", "warn"],
    gateText: () => ({ title: '确认配色', question: '查看 Unity 渲染的配色候选图，批准当前版本或提出调整要求', approve: true }),
    shortHash: (hash: string) => hash.slice(0, 7),
    planSummary: () => [], planDetails: () => [],
    Status: 'status',
    useAction: () => ({ busy: '', run: async (_key: string, action: () => Promise<unknown>) => { await action(); } }),
    FacePreviewView: 'face-preview-view', RecolorPreviewView: 'recolor-preview-view',
    Components: undefined,
  };
  runInNewContext(compiled, context);
  const components = context.Components as Record<string, any>;
  const expand = (value: any): any => {
    if (Array.isArray(value)) return value.map(expand);
    if (!value || !value.props) return value;
    if (typeof value.type === 'function') {
      const previous = current; current = value.type; cursors.set(value.type, 0);
      const rendered = expand(value.type(value.props));
      current = previous; return rendered;
    }
    if (value.props.children === undefined) return value;
    return { ...value, props: { ...value.props, children: expand(value.props.children) } };
  };
  return { render: (props: any) => { current = components.GateCard; cursors.set(current, 0); return expand(components.GateCard(props)); } };
}

const gate = { gate: 'workflow:recolor_approval', workflowId: 'workflow', formal: true, project: '/w/p', projectId: 'project',
  projectName: 'Luna-春樱', owner: 'stage:recolor', status: 'pending', question: '', binds: 'materials',
  artifactHash: 'materials-version', preview: 'recolor-candidates' as const };
const card = (extra: Record<string, unknown>) => ({ changed: () => {}, onRequestChange: () => {}, onDismiss: () => {}, ...extra });

test('the colour decision card asks for the condensed strip, draws no grid of its own, and keeps its change request', () => {
  const h = harness();
  const body = h.render(card({ gate }));
  const evidence = elements(body).find(element => element.type === 'recolor-preview-view');
  assert.ok(evidence, 'the decision carries the recolour evidence');
  assert.equal(evidence!.props.compact, true, 'the decision card asks for the condensed strip, not the whole grid');
  assert.equal(evidence!.props.expectedHash, 'materials-version', 'the evidence stays bound to the version the decision covers');
  assert.equal(evidence!.props.approve.gate, 'workflow:recolor_approval');
  assert.equal(evidence!.props.approve.label, '批准当前版本');
  assert.equal(elements(body).filter(element => element.type === 'img').length, 0, 'the card repeats none of the pictures');
  const labels = elements(body).filter(element => element.type === 'button').map(element => text(element));
  assert.ok(labels.includes('修改要求'), 'the change request stays beside the decision');
  assert.ok(!labels.includes('批准当前版本'), 'the approval is rendered with the evidence it rests on');
});

test('a decision without picture evidence keeps its own full card and approval', () => {
  const h = harness();
  const body = h.render(card({ gate: { ...gate, gate: 'workflow:plan_approval', binds: 'plan', preview: undefined } }));
  assert.equal(elements(body).some(element => element.type === 'recolor-preview-view'), false, 'only the colour decision asks for the strip');
  assert.ok(elements(body).some(element => element.type === 'button' && text(element).includes('批准此方案')));
});
