import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';
import { checkLabel } from '../../gui/src/labels.ts';

/**
 * The shipped stage-detail component (gui/src/project.tsx `Verify`), compiled once and executed with controlled
 * dependencies, so a test can read what a projection would actually put on screen. Shared by the GUI suite and by
 * tests that hold a real Runtime projection: the judgement of what may be accepted belongs to the Runtime
 * (`acceptanceRequired`), and this only checks that the interface honours what it was given.
 */
const project = readFileSync(new URL('../../gui/src/project.tsx', import.meta.url), 'utf8');
const component = project.slice(project.indexOf('function Verify('), project.indexOf('type ContextPreview ='));
const compiled = ts.transpileModule(`${component}\nglobalThis.renderVerify=Verify;\nglobalThis.warningState=warningState;`, {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

export type Element = { type: unknown; props: Record<string, any> };
export function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  // The shipped component is executed the way React would render it, so a control a child component returns is read
  // from its real props (the button's own onClick) instead of being asserted from its source.
  if (typeof element.type === 'function') return elements((element.type as (props: unknown) => unknown)(element.props));
  return [element, ...elements(element.props.children)];
}
export function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && 'props' in value) {
    const element = value as Element;
    // A component's own output is its words too: `WarningAction` is where "已接受" and "证据已过期，重新取证后再接受" are
    // written, and reading only the JSX around it made those two states invisible to every assertion in the suite.
    if (typeof element.type === 'function') return text((element.type as (props: unknown) => unknown)(element.props));
    return text(element.props.children);
  }
  return typeof value === 'string' ? value : '';
}

export interface VerifyRender {
  /** The rendered tree of the shipped `Verify`, with `changed` recorded as a call. */
  render(): unknown;
  /** Everything the tree would show, as words. */
  text(): string;
  /** The first button whose label contains `label`, or undefined when the tree offers none. */
  button(label: string): Element | undefined;
  /** The shipped `warningState` itself: what the component's banner and control are gated on. */
  warningState(check: unknown): string;
  calls: Array<{ method: string; params: any; timeout?: number }>;
  asked: any[];
  notes: string[];
}
/**
 * Render the shipped `Verify` over `workflow` (the shape `describeWorkflow`/`workflow.show` returns). The answer of
 * the reason dialog is controlled: `undefined` cancels it, as the product does.
 */
export function renderVerify(workflow: unknown, answer: string | undefined = undefined): VerifyRender {
  const calls: VerifyRender['calls'] = []; const asked: any[] = []; const notes: string[] = []; let busy = '';
  const context: Record<string, unknown> = {
    React, call: async (method: string, params: any, timeout?: number) => { calls.push({ method, params, timeout }); return {}; },
    useAction: () => ({ get busy() { return busy; }, run: async (key: string, action: () => Promise<unknown>, success?: string) => {
      busy = key; try { await action(); if (success) notes.push(success); return true; } finally { busy = ''; } } }),
    useFeedback: () => ({ ask: async (options: any) => { asked.push(options); return answer; } }),
    Panel: 'section', Status: 'span', Empty: 'div',
    verdictCounts: (items: unknown[]) => ({ total: items.length, pass: 0, fail: 0, noData: 0, error: 0, unsure: 0, stale: 0, pending: 0, na: 0 }),
    verdictTally: () => '', stageView: () => ({ state: 'blocked' }), stageLabel: (id: string) => id, observerLabel: (x: string) => x, checkLabel,
    verdictState: (result: string) => [result, 'ok'], severityLabel: (x: string) => x, verdictNext: () => undefined,
    artifactLabel: (x: string) => x, shortHash: (x: string) => x, when: () => '刚刚', renderVerify: undefined, warningState: undefined,
  };
  runInNewContext(compiled, context);
  const render = () => (context.renderVerify as (props: unknown) => unknown)({ workflow,
    changed: () => { calls.push({ method: 'changed', params: {} }); } });
  return { render, text: () => text(render()),
    button: (label: string) => elements(render()).find(element => element.type === 'button' && text(element.props.children).includes(label)),
    warningState: (check: unknown) => (context.warningState as (check: unknown) => string)(check), calls, asked, notes };
}
