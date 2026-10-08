import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemp } from './fixtures/platform.ts';
import test from 'node:test';

const tool = fileURLToPath(new URL('../builtin/tools/审查/perception/strip_audit.py', import.meta.url));
test('strip audit classifies real deleted Git paths on Windows and POSIX without hiding outside changes', t => {
  const base = mkdtempSync(join(tmpdir(), 'avh-strip-test-'));
  t.after(() => removeTemp(base));
  const code = `
import importlib.util,sys,tempfile,shutil,os
spec=importlib.util.spec_from_file_location('audit',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
base=sys.argv[2]
try:
 p=m.build_fixture(base)
 m._write(os.path.join(p,'Assets','Keep.asset'),'original')
 m._git(p,'add','Assets/Keep.asset');m._git(p,'commit','-qm','outside baseline')
 guids=m.audit_script_guids(p);m.apply_strip(p,m.scan(p,guids),'HEAD')
 inside,outside=m.classify_status(p)
 assert len(inside)>=9,(inside,outside)
 assert not [x for x in outside if x[0]!='??'],outside
 m._write(os.path.join(p,'Assets','Keep.asset'),'changed')
 inside,outside=m.classify_status(p)
 assert [(x,path) for x,path in outside if x!='??']==[(' M','Assets/Keep.asset')],outside
finally:pass
`;
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-X', 'utf8', '-c', code, tool, base], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
