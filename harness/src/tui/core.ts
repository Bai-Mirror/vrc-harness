import React, { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useCursor, useInput, usePaste, useStdout } from 'ink';
import stringWidth from 'string-width';
import type { EventMessage } from '../api/protocol.ts';
import { TONE_COLOR, type Tone } from './format.ts';

/** Components are written with createElement so the sources run under Node's type stripping without a JSX step. */
export const h = React.createElement;

/** What the TUI needs from the Runtime: the local API client, or a fake in tests. Nothing else. */
export interface Api {
  call<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  subscribe(listener: (event: EventMessage) => void): Promise<number>;
  onClose(listener: () => void): void;
  close(): void;
}
export type Route =
  | { screen: 'inbox' } | { screen: 'projects' } | { screen: 'assets' } | { screen: 'activity' } | { screen: 'providers' } | { screen: 'service' }
  | { screen: 'project'; projectId: string; workflowId?: string } | { screen: 'task'; taskId: string }
  | { screen: 'conversation'; projectId: string }
  | { screen: 'plan'; workflowId: string } | { screen: 'brief'; project: string } | { screen: 'help' };
export interface Ui {
  api: Api;
  /** Bumped when the Runtime reports a change; data hooks refetch on it. */
  version: number;
  connected: boolean;
  rows: number; columns: number;
  push(route: Route): void; pop(): void; tab(route: Route): void;
  modal: ReactNode | undefined;
  openModal(node: ReactNode): void; closeModal(): void;
  notify(text: string, tone?: Tone): void;
  refresh(): void;
  /** Runs a command, reports its outcome in the message line, and refreshes. */
  act(label: string, run: () => Promise<unknown>): Promise<boolean>;
}
export const UiContext = createContext<Ui | undefined>(undefined);
export function useUi(): Ui {
  const ui = useContext(UiContext);
  if (!ui) throw new Error('UiContext missing');
  return ui;
}

/** Fetch through the API; refetch when the Runtime reports a change or the arguments change. Keeps old data while reloading. */
export function useData<T>(method: string, params: Record<string, unknown> = {}): { data?: T; error?: string; loading: boolean } {
  const ui = useUi();
  const key = JSON.stringify(params);
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean; key?: string }>({ loading: true });
  useEffect(() => {
    let live = true;
    setState(previous => ({ ...previous, loading: true, ...(previous.key === key ? {} : { data: undefined, error: undefined }) }));
    ui.api.call<T>(method, JSON.parse(key) as Record<string, unknown>)
      .then(data => { if (live) setState({ data, loading: false, key }); })
      .catch((error: Error) => { if (live) setState(previous => ({ ...previous, error: error.message, loading: false, key })); });
    return () => { live = false; };
  }, [method, key, ui.version, ui.connected]);
  return state;
}

/** Keyboard selection over a list longer than the screen: returns the window to draw. */
export function useListNav(length: number, height: number): {
  index: number; offset: number; setIndex(index: number): void; handle(input: string, key: KeyLike): boolean;
} {
  const [index, setIndexRaw] = useState(0);
  // Keys that arrive together (a held arrow key) are handled before the next render: each one starts from the last.
  const current = useRef(0);
  const [offset, setOffset] = useState(0);
  const clamp = (value: number) => Math.max(0, Math.min(Math.max(length - 1, 0), value));
  const visible = Math.max(1, height);
  const setIndex = useCallback((value: number) => {
    const next = clamp(value);
    current.current = next;
    setIndexRaw(next);
    setOffset(previous => next < previous ? next : next >= previous + visible ? next - visible + 1 : previous);
  }, [length, visible]);
  useEffect(() => { if (index > length - 1) setIndex(length - 1); }, [length]);
  const handle = (input: string, key: KeyLike): boolean => {
    const at = clamp(current.current);
    if (key.upArrow || input === 'k') setIndex(at - 1);
    else if (key.downArrow || input === 'j') setIndex(at + 1);
    else if (key.pageUp) setIndex(at - visible);
    else if (key.pageDown) setIndex(at + visible);
    else if (key.home) setIndex(0);
    else if (key.end) setIndex(length - 1);
    else return false;
    return true;
  };
  return { index: clamp(index), offset: Math.min(offset, Math.max(0, length - visible)), setIndex, handle };
}
export interface KeyLike {
  upArrow: boolean; downArrow: boolean; leftArrow: boolean; rightArrow: boolean; pageUp: boolean; pageDown: boolean;
  home: boolean; end: boolean; return: boolean; escape: boolean; ctrl: boolean; shift: boolean; tab: boolean;
  backspace: boolean; delete: boolean; meta: boolean;
}

export function Tag(props: { text: string; tone?: Tone; bold?: boolean }): ReactNode {
  return h(Text, { color: TONE_COLOR[props.tone ?? 'info'], bold: props.bold ?? false, wrap: 'truncate-end' }, props.text);
}
/** A fixed-width cell; CJK text is measured by display width and truncated with an ellipsis. */
export function Cell(props: { width: number; children?: ReactNode; tone?: Tone; bold?: boolean; dim?: boolean }): ReactNode {
  return h(Box, { width: props.width, flexShrink: 0, overflow: 'hidden' },
    h(Text, { color: props.tone ? TONE_COLOR[props.tone] : undefined, bold: props.bold ?? false, dimColor: props.dim ?? false,
      wrap: 'truncate-end' }, props.children));
}
export function Line(props: { children?: ReactNode; tone?: Tone; bold?: boolean; dim?: boolean; inverse?: boolean }): ReactNode {
  return h(Text, { color: props.tone ? TONE_COLOR[props.tone] : undefined, bold: props.bold ?? false, dimColor: props.dim ?? false,
    inverse: props.inverse ?? false, wrap: 'truncate-end' }, props.children);
}
export function Title(props: { text: string; hint?: string }): ReactNode {
  return h(Box, null, h(Text, { bold: true }, props.text), props.hint ? h(Text, { dimColor: true }, `  ${props.hint}`) : null);
}
export function Loading(props: { what?: string; error?: string }): ReactNode {
  return props.error ? h(Text, { color: 'red', wrap: 'wrap' }, `读取失败：${props.error}`)
    : h(Text, { dimColor: true }, `正在读取${props.what ?? ''}…`);
}

/** Lines of text with a scroll position; long lines wrap inside the given width. */
export function ScrollText(props: { lines: string[]; height: number; offset: number }): ReactNode {
  const visible = props.lines.slice(props.offset, props.offset + props.height);
  return h(Box, { flexDirection: 'column', height: props.height, overflow: 'hidden' },
    ...visible.map((line, i) => h(Text, { key: i, wrap: 'truncate-end' }, line || ' ')),
    props.lines.length > props.height ? h(Text, { dimColor: true },
      `— ${props.offset + 1}-${Math.min(props.offset + props.height, props.lines.length)}/${props.lines.length} 行（↑↓ PgUp PgDn）`) : null);
}

/**
 * Splits `text` into lines that fit `width` display columns. Truncating a sentence instead would hide its tail — a
 * plan line naming three requirements showed only the first, so the person approved what they could not read. Breaks
 * are preferred after '；', which separates one requirement from the next.
 */
export function wrapText(text: string, width: number, indent = ''): string[] {
  const limit = Math.max(8, width - stringWidth(indent));
  const lines: string[] = [];
  let line = '';
  let lastBreak = -1;
  for (const char of text) {
    line += char;
    if (char === '；') lastBreak = line.length;
    if (stringWidth(line) > limit) {
      if (lastBreak > 0 && stringWidth(line.slice(0, lastBreak)) <= limit) {
        lines.push(indent + line.slice(0, lastBreak));
        line = line.slice(lastBreak);
      } else if (line.length > 1) {
        lines.push(indent + line.slice(0, -1));
        line = char;
      }
      lastBreak = -1;
    }
  }
  if (line) lines.push(indent + line);
  return lines.length ? lines : [indent];
}

/**
 * Single-line input. The real terminal cursor is placed at the insertion point so input methods (Chinese IME)
 * show their composition where the text will go. Enter submits, Esc cancels, pasted text is inserted as one piece.
 */
/**
 * The part of a one-line input that fits `width` columns with the cursor in view; '…' marks text cut off on either side.
 * `cursorX` is the cursor's column within the returned text.
 */
export function inputWindow(chars: string[], cursor: number, width: number): { text: string; cursorX: number } {
  const at = [0];
  for (const char of chars) at.push(at.at(-1)! + stringWidth(char));
  const span = (from: number, to: number): number => at[to]! - at[from]!;
  if (span(0, chars.length) < width) return { text: chars.join(''), cursorX: span(0, cursor) };
  // The character under the cursor stays visible; at the end, one free column holds the cursor itself.
  const need = Math.min(cursor + 1, chars.length);
  const reserve = need < chars.length || cursor === chars.length ? 1 : 0;
  let start = 0;
  while (start < cursor && (start > 0 ? 1 : 0) + span(start, need) + reserve > width) start++;
  const lead = start > 0 ? 1 : 0;
  let end = need;
  while (end < chars.length && lead + span(start, end + 1) + (end + 1 < chars.length ? 1 : 0) <= width) end++;
  return { text: `${lead ? '…' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '…' : ''}`, cursorX: lead + span(start, cursor) };
}

export function TextPrompt(props: { label: string; initial?: string; row: number; hint?: string; secret?: boolean;
  onSubmit(value: string): void; onCancel(): void; allowEmpty?: boolean }): ReactNode {
  // Read and written through a ref: keys that arrive together (a held Backspace) each see the previous one's result.
  const state = useRef({ value: props.initial ?? '', cursor: [...(props.initial ?? '')].length });
  const [, rerender] = useState(0);
  const update = (value: string, cursor: number) => { state.current = { value, cursor }; rerender(n => n + 1); };
  const { value, cursor } = state.current;
  const { setCursorPosition } = useCursor();
  const { stdout } = useStdout();
  const chars = [...value];
  // A long note scrolls sideways with the cursor, so the person always sees what they are typing.
  const shown = inputWindow(props.secret ? chars.map(() => '•') : chars, cursor,
    Math.max(8, (stdout?.columns || 80) - stringWidth(props.label) - 1));
  setCursorPosition({ x: stringWidth(props.label) + shown.cursorX, y: props.row });
  const insert = (text: string) => {
    const { value, cursor } = state.current;
    const chars = [...value], clean = [...text.replace(/[\r\n\t]+/g, ' ')];
    update([...chars.slice(0, cursor), ...clean, ...chars.slice(cursor)].join(''), cursor + clean.length);
  };
  usePaste(insert);
  useInput((input, key) => {
    const { value, cursor } = state.current;
    const chars = [...value];
    if (key.escape) props.onCancel();
    else if (key.return) { if (value.trim() || props.allowEmpty) props.onSubmit(value.trim()); }
    else if (key.backspace) { if (cursor > 0) update([...chars.slice(0, cursor - 1), ...chars.slice(cursor)].join(''), cursor - 1); }
    else if (key.delete) { if (cursor < chars.length) update([...chars.slice(0, cursor), ...chars.slice(cursor + 1)].join(''), cursor); }
    else if (key.leftArrow) update(value, Math.max(0, cursor - 1));
    else if (key.rightArrow) update(value, Math.min(chars.length, cursor + 1));
    else if (key.home || (key.ctrl && input === 'a')) update(value, 0);
    else if (key.end || (key.ctrl && input === 'e')) update(value, chars.length);
    else if (key.ctrl && input === 'u') update(chars.slice(cursor).join(''), 0);
    else if (!key.ctrl && !key.meta && input && !key.tab && !key.upArrow && !key.downArrow) insert(input);
  });
  return h(Box, { flexDirection: 'column' },
    h(Text, { wrap: 'truncate-end' }, h(Text, { color: 'cyan' }, props.label), shown.text),
    h(Text, { dimColor: true, wrap: 'truncate-end' }, props.hint ?? 'Enter 确认  Esc 取消  Ctrl+U 清空'));
}

/** A decision box. Options are single keys; Esc always backs out without doing anything. */
export function Dialog(props: { title: string; body: ReactNode[]; options: Array<{ key: string; label: string; tone?: Tone }>;
  onChoose(key: string): void; onCancel(): void; width?: number }): ReactNode {
  useInput((input, key) => {
    if (key.escape) { props.onCancel(); return; }
    const pressed = key.return ? 'enter' : input.toLowerCase();
    if (props.options.some(option => option.key === pressed)) props.onChoose(pressed);
  });
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1, width: props.width },
    h(Text, { bold: true }, props.title),
    ...props.body.map((line, i) => typeof line === 'string' ? h(Text, { key: i, wrap: 'wrap' }, line) : h(Box, { key: i }, line)),
    h(Box, { marginTop: 1 }, ...props.options.map(option => h(Box, { key: option.key, marginRight: 2 },
      h(Text, { color: TONE_COLOR[option.tone ?? 'info'], bold: true }, `[${option.key === 'enter' ? 'Enter' : option.key}]`),
      h(Text, null, ` ${option.label}`)))),
    h(Text, { dimColor: true }, 'Esc 返回'));
}

/** Keeps the latest value of something in a ref, for callbacks that must not re-subscribe. */
export function useLatest<T>(value: T): { current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
