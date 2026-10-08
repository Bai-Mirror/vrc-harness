/**
 * The terminal's view of the shared vocabulary (src/shared/labels.ts, also used by the GUI), plus the terminal colours.
 */
import type { Tone } from '../shared/labels.ts';

export * from '../shared/labels.ts';
export const TONE_COLOR: Record<Tone, string | undefined> = { ok: 'green', bad: 'red', warn: 'yellow', info: 'cyan', muted: 'gray' };
