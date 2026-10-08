import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { PLACEHOLDER_HUES } from '../../gui/src/model.ts';

// The GUI's stylesheets as the browser receives them (comments removed).
const dir = new URL('../../gui/src/', import.meta.url);
const sheets = readdirSync(dir).filter(name => name.endsWith('.css'))
  .map(name => ({ name, css: readFileSync(new URL(name, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') }));
const all = sheets.map(sheet => sheet.css).join('\n');

type Rule = { context: string; selector: string; body: string };
/** Every style rule with the at-rules it sits in (the sheets have no nested rules and no braces inside values). */
function rules(css: string): Rule[] {
  const found: Rule[] = [], open: string[] = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '}') { open.pop(); start = i + 1; continue; }
    if (css[i] !== '{') continue;
    const prelude = css.slice(start, i).trim().replace(/\s+/g, ' ');
    if (prelude.startsWith('@')) { open.push(prelude); start = i + 1; continue; }
    const end = css.indexOf('}', i);
    found.push({ context: open.join(' '), selector: prelude, body: css.slice(i + 1, end) });
    i = end; start = end + 1;
  }
  return found;
}
const declarations = (body: string) => body.split(';').map(item => item.split(':')).filter(parts => parts.length >= 2)
  .map(([property, ...value]) => [property!.trim(), value.join(':').trim().replace(/\s+/g, ' ')] as const);
const tokensOf = (body: string): Record<string, string> =>
  Object.fromEntries(declarations(body).filter(([property]) => property.startsWith('--')));
const parsed = rules(all);
const find = (context: string, selector: string) => parsed.find(rule => rule.context === context && rule.selector === selector);
const base = find('', ':root'), darkSystem = find('@media (prefers-color-scheme: dark)', ':root:not([data-theme="light"])');
const darkChosen = find('', ':root[data-theme="dark"]');
const light = tokensOf(base?.body ?? ''), dark = { ...light, ...tokensOf(darkChosen?.body ?? '') };
const RAW = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(|\b(white|black)\b/i;
/** A colour value built only from tokens, such as the covers' hsl(var(--hue) var(--cover-bg-s) var(--cover-bg-l)). */
const fromTokens = (value: string) => value.replace(/\b(rgba?|hsla?)\((\s*var\(--[\w-]+\)\s*[,/]?)+\)/gi, '');

function rgb(value: string): [number, number, number, number] {
  if (value.startsWith('#')) {
    const digits = value.slice(1), full = digits.length === 3 ? [...digits].map(d => d + d).join('') : digits;
    return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)).concat(1) as [number, number, number, number];
  }
  const [r, g, b, a = 1] = value.match(/[\d.]+/g)!.map(Number);
  return [r!, g!, b!, a];
}
function hsl(h: number, s: number, l: number): [number, number, number, number] {
  const k = (n: number) => (n + h / 30) % 12, a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  return [0, 8, 4].map(n => Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))))).concat(1) as [number, number, number, number];
}
/** A translucent colour as it shows over an opaque one. */
const over = ([r, g, b, a]: number[], [R, G, B]: number[]): number[] => [r! * a! + R! * (1 - a!), g! * a! + G! * (1 - a!), b! * a! + B! * (1 - a!), 1];
const luminance = (colour: number[]) => colour.slice(0, 3).map(c => c / 255)
  .map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
function ratio(foreground: number[], background: number[]): number {
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
const THEMES = { light, dark } as const;

test('the theme follows the system, can be overridden on :root[data-theme], and both themes define every colour', () => {
  assert.ok(base && darkSystem && darkChosen, 'a base token block, a dark block for the system preference, and one for data-theme="dark"');
  assert.match(base!.body, /color-scheme:\s*light\s*;/);
  for (const block of [darkSystem!, darkChosen!]) assert.match(block.body, /color-scheme:\s*dark\s*;/);
  assert.deepEqual(declarations(darkSystem!.body), declarations(darkChosen!.body), 'the two dark blocks are the same theme');
  const colours = Object.entries(light).filter(([, value]) => RAW.test(value)).map(([name]) => name);
  assert.ok(colours.length > 25);
  assert.deepEqual(colours.filter(name => !(name in tokensOf(darkChosen!.body))), [], 'every light colour has its dark value');
  assert.deepEqual(Object.keys(tokensOf(darkChosen!.body)).filter(name => !(name in light)), [], 'dark defines no token light lacks');
  const html = readFileSync(new URL('../../gui/index.html', import.meta.url), 'utf8');
  assert.match(html, /<meta name="color-scheme" content="light dark" \/>/, 'form controls follow the theme before the styles load');
});

test('colours are tokens: no raw colour outside the :root blocks, so a component cannot keep a fixed colour from one theme', () => {
  const themeBlocks = new Set([base, darkSystem, darkChosen]);
  const raw = parsed.filter(rule => !themeBlocks.has(rule))
    .flatMap(rule => declarations(rule.body).filter(([, value]) => RAW.test(fromTokens(value))).map(([property, value]) => `${rule.selector} { ${property}: ${value} }`));
  assert.deepEqual(raw, []);
  const known = new Set(parsed.filter(rule => rule.selector.startsWith(':root')).flatMap(rule => Object.keys(tokensOf(rule.body))));
  for (const rule of parsed) for (const [, value] of declarations(rule.body))
    for (const [, name] of value.matchAll(/var\((--[\w-]+)/g)) assert.ok(known.has(name!), `unknown token ${name} in ${rule.selector}`);
});

test('text sizes follow the six-step scale (12 13 14 16 20 24) and nothing is smaller than 12px', () => {
  const sizes = parsed.flatMap(rule => declarations(rule.body)).filter(([property]) => property === 'font-size').map(([, value]) => value);
  assert.ok(sizes.length > 20);
  assert.deepEqual(sizes.filter(size => !['12px', '13px', '14px', '16px', '20px', '24px'].includes(size)), []);
  assert.deepEqual(parsed.flatMap(rule => declarations(rule.body)).filter(([property, value]) => property === 'font' && /\d/.test(value)), [],
    'no size hidden in a font shorthand');
});

test('text reaches WCAG AA (4.5:1) in the light and the dark theme, on opaque and on frosted surfaces', () => {
  for (const [theme, tokens] of Object.entries(THEMES)) {
    const colour = (name: string) => rgb(tokens[name]!);
    const check = (text: number[], background: number[], label: string) =>
      assert.ok(ratio(text, background) >= 4.5, `${theme}: ${label}: ${ratio(text, background).toFixed(2)}`);
    for (const background of ['--bg-panel', '--bg-app', '--bg-side', '--bg-subtle', '--bg-hover'])
      for (const text of ['--text', '--text-2', '--text-3']) check(colour(text), colour(background), `${text} on ${background}`);
    const pairs: Array<[string, string]> = [['--on-accent', '--accent'], ['--on-accent', '--accent-hover'], ['--accent', '--bg-panel'],
      ['--accent', '--accent-soft'], ['--ok-text', '--ok-soft'], ['--warn-text', '--warn-soft'], ['--bad-text', '--bad-soft'],
      ['--ok', '--bg-panel'], ['--warn', '--bg-panel'], ['--bad', '--bg-panel'], ['--text-2', '--accent-soft'], ['--text-2', '--bg-hover'],
      ['--on-accent', '--warn']];
    for (const [text, background] of pairs) check(colour(text), colour(background), `${text} on ${background}`);
    // The navigation, the bars and the first-run card are translucent over the page; overlays over the dimmed page are
    // near-opaque. Each layer is checked on its own token, because a layer's values are what a reader actually sees.
    for (const glass of ['--glass-struct', '--glass', '--glass-strong'])
      for (const text of ['--text', '--text-2', '--text-3', '--accent']) check(colour(text), over(colour(glass), colour('--bg-app')), `${text} on ${glass}`);
    // The worst background under a frosted surface is the environment field itself: the frosted layer is composited on
    // top of an ambient blob rather than on the flat page, which is what the material rule asks to measure.
    for (const ambient of ['--ambient-a', '--ambient-b', '--ambient-c']) {
      const field = over(colour(ambient), colour('--bg-app'));
      for (const glass of ['--glass-struct', '--glass', '--glass-strong'])
        for (const text of ['--text', '--text-2', '--text-3']) check(colour(text), over(colour(glass), field), `${text} on ${glass} over ${ambient}`);
    }
    for (const hue of PLACEHOLDER_HUES) {
      const n = (name: string) => parseFloat(tokens[name]!);
      check(hsl(hue, n('--cover-fg-s'), n('--cover-fg-l')), hsl(hue, n('--cover-bg-s'), n('--cover-bg-l')), `cover of hue ${hue}`);
    }
  }
});

test('frost stays on structural surfaces, reading surfaces stay opaque, and the material degrades to opaque', () => {
  const frosted = parsed.filter(rule => /var\(--(surface-struct|surface-panel|surface-overlay|frost-deco|frost-struct|frost-panel|frost-overlay)\)/.test(rule.body))
    .flatMap(rule => rule.selector.split(',').map(selector => selector.trim()));
  assert.deepEqual([...new Set(frosted)].sort(),
    ['.dialog', '.drawer', '.menu', '.native-view', '.nav-shell', '.setup-card', '.toast', '.topbar', '.work-head'],
    'navigation, the bars, the first-run card and the overlays; never a panel, card, form or decision');
  for (const selector of ['.panel', '.gate-card', '.project-card', '.next', '.composer', '.drawer-body', '.path-value']) {
    const background = parsed.filter(rule => !rule.context && rule.selector === selector)
      .flatMap(rule => declarations(rule.body)).find(([property]) => property === 'background')?.[1];
    assert.match(background ?? '', /^var\(--bg-(panel|subtle)\)$/, `${selector} is a reading surface`);
  }
  // The rule that makes a frosted card allowed: what it carries sits on the solid layer. Every control on the first-run
  // card is a global form control, so the check is that those stay opaque and that a layer token never colours one.
  const control = parsed.filter(rule => !rule.context && rule.selector.startsWith('input:not(')).flatMap(rule => declarations(rule.body));
  assert.match(control.find(([property]) => property === 'background')?.[1] ?? '', /^var\(--bg-panel\)$/,
    'form controls carry what the person types on an opaque surface');
  assert.deepEqual(parsed.filter(rule => /var\(--(glass|glass-strong|glass-struct|glass-deco)/.test(rule.body) && /^(input|textarea|select)/.test(rule.selector)), []);
  for (const rule of parsed.filter(rule => /(^|;)\s*backdrop-filter/.test(rule.body)))
    assert.match(rule.body, /-webkit-backdrop-filter/, `${rule.selector}: WebKitGTK and Safari need the prefixed property too`);
  for (const context of ['@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))',
    '@media (prefers-reduced-transparency: reduce)', '@media (prefers-contrast: more)', '@media (forced-colors: active)']) {
    const tokens = tokensOf(find(context, ':root')?.body ?? '');
    for (const frost of ['--frost-deco', '--frost-struct', '--frost-panel', '--frost-overlay'])
      assert.equal(tokens[frost], 'none', `${context}: ${frost}`);
    for (const surface of ['--surface-struct', '--surface-panel', '--surface-overlay'])
      assert.match(tokens[surface] ?? '', /^(var\(--bg-(side|panel)\)|Canvas)$/, `${context}: ${surface} is opaque`);
    assert.equal(tokens['--glass-deco'], 'transparent', `${context}: the decorative layer carries nothing and goes away`);
  }
  const still = parsed.find(rule => rule.context === '@media (prefers-reduced-motion: reduce)');
  assert.match(still?.body ?? '', /transition-duration:\s*0s/);
  assert.match(still?.body ?? '', /scroll-behavior:\s*auto/);
});

test('status pills have a readable base and one variant per tone, each a text token on its soft background', () => {
  const rule = (selector: string) => parsed.find(item => !item.context && item.selector === selector)?.body ?? '';
  assert.match(rule('.pill'), /color:\s*var\(--text-2\)/);
  assert.match(rule('.pill'), /font-size:\s*12px/);
  for (const [tone, text, background] of [['ok', '--ok-text', '--ok-soft'], ['warn', '--warn-text', '--warn-soft'],
    ['bad', '--bad-text', '--bad-soft'], ['info', '--accent', '--accent-soft']]) {
    const body = rule(`.pill.${tone}`);
    assert.match(body, new RegExp(`color:\\s*var\\(${text}\\)`), `.pill.${tone}`);
    assert.match(body, new RegExp(`background:\\s*var\\(${background}\\)`), `.pill.${tone}`);
  }
});

test('disabled controls look disabled and keyboard focus is visible', () => {
  const disabled = /(^|[\s,}])button:disabled[^{]*\{([^}]*)\}/.exec(all)?.[2] ?? '';
  assert.match(disabled, /opacity:\s*\.45/);
  assert.match(disabled, /cursor:\s*not-allowed/);
  assert.match(all, /:is\([^)]*button[^)]*\):focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/);
  // The composer draws its focus ring around the whole box instead of the borderless text area inside it.
  assert.match(all, /\.composer:focus-within\s*\{[^}]*outline:\s*2px solid var\(--accent\)/);
});

test('the conversation reserves the docked change-request box, so the box cannot cover what a decision ends with', () => {
  // project.tsx measures the real box onto --composer-h and the column reserves it at its bottom; the dock itself stays
  // docked (F27b: the input box is not made to scroll away with the content, and it is not left covering the buttons).
  const reserved = (rule: Rule | undefined) => /padding-bottom:\s*calc\([^)]*var\(--composer-h\)/.test(rule?.body ?? '');
  assert.ok(reserved(find('', '.conversation')), 'the conversation reserves the box at its bottom');
  for (const context of ['@media (max-width: 1099px)', '@media (max-width: 760px)'])
    assert.ok(reserved(find(context, '.conversation')), `${context} keeps the reserved space`);
  assert.ok(Object.keys(tokensOf(base?.body ?? '')).includes('--composer-h'),
    'the token has a fallback for a window that has not measured the box yet');
  const dock = find('', '.composer-dock')?.body ?? '';
  assert.match(dock, /position:\s*sticky/, 'the change-request box stays docked');
  assert.match(dock, /bottom:\s*0/, 'the change-request box stays at the bottom');
});

test('narrow windows switch between the conversation and the work panel, both staying mounted', () => {
  const narrow = parsed.filter(rule => rule.context === '@media (max-width: 1099px)');
  const hides = narrow.find(rule => /display:\s*none/.test(rule.body) && rule.selector.includes('[data-pane="main"] > .app-panel'));
  assert.ok(hides?.selector.includes('[data-pane="panel"] > .app-main'), 'each pane hides the other column');
  assert.ok(narrow.some(rule => rule.selector.includes('.pane-switch') && /display:\s*inline-flex/.test(rule.body)), 'the switch appears');
  assert.ok(parsed.some(rule => !rule.context && rule.selector === '.pane-switch' && /display:\s*none/.test(rule.body)), 'and only there');
});
