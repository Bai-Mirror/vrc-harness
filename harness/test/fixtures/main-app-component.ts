import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';
import { projectForGate, projectWorkspaceGates } from '../../gui/src/model.ts';

const source = readFileSync(new URL('../../gui/src/main.tsx', import.meta.url), 'utf8');
const component = source.slice(source.indexOf('function App('), source.indexOf('function NavShell('));
const compiled = ts.transpileModule(`${component}\nglobalThis.renderApp=App;`, {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

export function renderProjectWorkspace(projects: unknown[], gates: unknown[]): any {
  const states: unknown[] = ['home', { anchor: undefined, seq: 0 }, 0, { id: 'source' }, []];
  let selectedState: unknown = states[3];
  let stateIndex = 0;
  let load = 0;
  const context: Record<string, unknown> = {
    React,
    useState: (initial: unknown) => {
      const index = stateIndex++; const value = index === 3 ? selectedState : states[index] ?? initial;
      return [value, (next: unknown) => { if (index === 3) selectedState = next; }];
    },
    useRef: (current: unknown) => ({ current }), useEffect: () => {},
    useFeedback: () => ({ dialog: async () => undefined, error: () => {} }),
    useLoad: () => {
      const values = [projects, gates, [], [], { scheduler: 'paused' }, null];
      return [values[load++] ?? [], null];
    },
    events: () => () => {}, call: async () => ({}),
    ProjectWorkspace: 'ProjectWorkspace', NavShell: 'NavShell',
    recentProjects: (value: unknown[]) => value,
    projectForGate, projectWorkspaceGates,
    gateText: () => ({ title: '' }), isOpenGate: (gate: { status: string }) => gate.status === 'pending' || gate.status === 'stale',
    onMissingLabel: () => {}, import: undefined,
  };
  runInNewContext(compiled, context);
  const tree = (context.renderApp as (props: unknown) => any)({});
  return { tree, get selected() { return selectedState; } };
}
