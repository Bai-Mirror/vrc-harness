import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { removeTemp } from '../fixtures/platform.ts';

test('container release provenance accepts only an explicit 12-character lowercase commit',t=>{
  const root=mkdtempSync(join(tmpdir(),'avh-provenance-'));t.after(()=>removeTemp(root));
  const script=new URL('../../scripts/build.mjs',import.meta.url);
  const invalid=execFileSync(process.execPath,['-e',`process.env.AVH_BUILD_COMMIT='HEAD';import(${JSON.stringify(script.href)}).catch(e=>{console.log(e.message)})`],{encoding:'utf8'});
  assert.match(invalid,/12-character lowercase Git hash/);
  assert.match(readFileSync(new URL('../../scripts/build.mjs',import.meta.url),'utf8'),/suppliedCommit \? false/);
});

test('the Debian baseline exports outside disposable compiler output',()=>{
  const script=readFileSync(new URL('../../scripts/build-linux-baseline.sh',import.meta.url),'utf8');
  assert.match(script,/harness\/release\/linux-debian12/);
  assert.doesNotMatch(script,/harness\/dist\/linux-debian12/);
  assert.match(script,/AVH_RELEASE_OUTPUT/);
  const ignore=readFileSync(new URL('../../.gitignore',import.meta.url),'utf8');
  assert.match(ignore,/^\/release\/$/m);
});
