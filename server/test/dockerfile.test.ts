import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { repoRoot, serverRoot } from './helpers.ts';

/** Modules loaded at run time from an entry point: relative imports and re-exports, not `import type`/`export type`. */
function runtimeClosure(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>(), packages = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) {
      if (specifier!.startsWith('node:')) continue;
      if (specifier!.startsWith('.')) visit(resolve(dirname(file), specifier!));
      else packages.add(specifier!);
    }
  };
  visit(entry);
  // Forward slashes, as the Dockerfile names them, on any platform the test runs on.
  return { files: [...files].map(file => relative(repoRoot, file).split(sep).join('/')).sort(), packages: [...packages].sort() };
}

test('the image copies exactly the client modules and packages the server loads at run time', () => {
  const closure = runtimeClosure(join(serverRoot, 'src', 'main.ts'));
  const dockerfile = readFileSync(join(serverRoot, 'Dockerfile'), 'utf8');
  const copied = [...dockerfile.matchAll(/^COPY\s+(?!--)(.+)$/gm)]
    .flatMap(([, line]) => line!.trim().split(/\s+/).slice(0, -1)).filter(source => source.startsWith('harness/src/')).sort();
  assert.deepEqual(copied, closure.files.filter(file => file.startsWith('harness/src/')));
  assert.ok(closure.files.filter(file => file.startsWith('server/')).every(file => file.startsWith('server/src/')));
  assert.deepEqual(closure.packages, [], 'the reused client modules need no npm package');
  assert.doesNotMatch(dockerfile, /node_modules/);
  const ignore = readFileSync(join(serverRoot, 'Dockerfile.dockerignore'), 'utf8');
  for (const needed of ['harness/src/**', 'harness/package.json', 'server/package.json', 'server/src/**'])
    assert.match(ignore, new RegExp(`^!${needed.replace(/[.*]/g, char => `\\${char}`)}$`, 'm'), needed);
});

test('the image carries the label that keeps its rollback tag through an image prune', () => {
  const dockerfile = readFileSync(join(serverRoot, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^LABEL moe\.nymiro\.keep="true"$/m);
  // deploy/README.md tells the maintainer to prune with exactly this filter.
  assert.match(readFileSync(join(repoRoot, 'deploy', 'README.md'), 'utf8'), /--filter 'label!=moe\.nymiro\.keep=true'/);
});
