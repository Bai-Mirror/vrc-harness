import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';
import { attentionChecks, progressCheckCounts, progressEvidenceText, progressStageSummary, stageView } from '../../gui/src/model.ts';

const source = readFileSync(new URL('../../gui/src/project.tsx', import.meta.url), 'utf8');
const component = source.slice(source.indexOf('function ProgressL1('), source.indexOf('function ProgressAttention('));
const compiled = ts.transpileModule(`${component}\nglobalThis.renderProgressL1=ProgressL1;`, {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (!value || typeof value !== 'object' || !('props' in value)) return typeof value === 'string' ? value : '';
  return text((value as { props: { children?: unknown } }).props.children);
}

export function renderProgressL1(workflow: unknown): string {
  const context: Record<string, unknown> = {
    React, attentionChecks, progressCheckCounts, progressEvidenceText, progressStageSummary, stageView,
    stageLabel: (id: string) => id, Status: 'span', ProgressAttention: () => null,
  };
  runInNewContext(compiled, context);
  return text((context.renderProgressL1 as (props: unknown) => unknown)({ workflow, changed: () => {} }));
}
