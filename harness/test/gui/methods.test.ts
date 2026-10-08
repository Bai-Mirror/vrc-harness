import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { GUI_METHODS } from '../../src/gui/server.ts';

/**
 * The GUI server forwards only allow-listed Runtime methods; a page calling any other gets 「不允许的 GUI 方法」. A
 * method the GUI sources name must therefore be on the list (the core page's update and knowledge checks were not).
 */
test('every Runtime method the GUI calls passes the GUI server\'s allowlist', () => {
  const api = new Set([...readFileSync(new URL('../../src/api/server.ts', import.meta.url), 'utf8').matchAll(/case '([a-z][a-zA-Z]*(?:\.[a-zA-Z]+)*)'/g)]
    .map(match => match[1]!));
  const dir = new URL('../../gui/src/', import.meta.url);
  const named = readdirSync(dir).filter(name => /\.tsx?$/.test(name)).flatMap(name =>
    [...readFileSync(new URL(name, dir), 'utf8').matchAll(/["']([a-z]+(?:\.[a-zA-Z]+)+)["']/g)]
      .map(match => match[1]!).filter(method => api.has(method)).map(method => `${method} (${name})`));
  assert.ok(named.length > 50, 'the GUI sources were read');
  assert.deepEqual(named.filter(entry => !GUI_METHODS.has(entry.split(' ')[0]!)), []);
  assert.deepEqual([...GUI_METHODS].filter(method => !api.has(method)), [], 'every allow-listed method exists');
});

/**
 * The other direction, which the audit of methods without a consumer asked for (证据/界面能力面审计.md): an entry here
 * with no page behind it reads as "supported" beyond what the interface can do. Eight entries had none — a records
 * view, a plan list, an incremental event pull, a contribution export, a conversation search, a message revision, a
 * trial disable and the workflow list — and were removed rather than left to look like features.
 *
 * A method named through a template literal cannot be found by its full name; what the source shows is its family
 * (`secret.${method}`, `project.production.${action}`), so those families stand in for their members. `hello` is the
 * protocol handshake a client sends on connect, not a capability a page offers.
 */
test('the allowlist carries no method the GUI never calls', () => {
  const dir = new URL('../../gui/src/', import.meta.url);
  const text = readdirSync(dir).filter(name => /\.tsx?$/.test(name))
    .map(name => readFileSync(new URL(name, dir), 'utf8')).join('\n');
  const families = new Set([...text.matchAll(/["'`]([a-z][a-zA-Z]*(?:\.[a-zA-Z]+)*)\.\$\{/g)].map(match => `${match[1]}.`));
  assert.ok(families.has('secret.') && families.has('project.production.'), 'both dynamic families were found');
  const unconsumed = [...GUI_METHODS].filter(method => method !== 'hello' && !text.includes(method)
    && ![...families].some(family => method.startsWith(family)));
  assert.deepEqual(unconsumed, [], 'an allow-listed method must be reached by a page');
});
