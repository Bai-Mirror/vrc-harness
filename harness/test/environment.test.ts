import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { blenderStatus, dependencyStatus, installPlan, layeredRecolorStatus, runInstallPlan, runInstallPlanAsync, wingetScript } from '../src/environment.ts';
import { vpmStatus } from '../src/vpm-manager.ts';
import { runMachineSteps } from '../src/windows-setup-script.ts';
import { fakeCommand, removeTemp, windows } from './fixtures/platform.ts';

/** A host made of fake programs: PATH holds only them, HOME is private. */
function host(t: TestContext, programs: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'avh-env-')), bin = join(root, 'bin'), home = join(root, 'home');
  mkdirSync(bin); mkdirSync(home);
  const write = (path: string, body: string) => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); };
  for (const [name, body] of Object.entries(programs)) write(join(bin, name), body);
  const prior = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.PATH = bin; process.env.HOME = home;
  t.after(() => { process.env.PATH = prior.PATH; process.env.HOME = prior.HOME; removeTemp(root); });
  return { root, bin, home, write };
}
const complete = {
  git: 'echo "git version 2.53.0"', bwrap: 'echo "bubblewrap 0.11.1"', python3: 'echo "Python 3.14.4"',
  '7z': 'echo; echo "7-Zip 26.00 (x64) : Copyright (c) 1999-2026 Igor Pavlov"',
  systemctl: 'echo running', dotnet: 'echo "Microsoft.NETCore.App 10.0.12 [/usr/lib/dotnet/shared]"',
  codex: 'echo "codex-cli 0.156.0"', claude: 'echo "2.1.283 (Claude Code)"', 'google-chrome': 'exit 0',
};
/** The VPM CLI is built for .NET 8: on a newer runtime it runs only with major roll-forward. */
const vpm = '[ "$DOTNET_ROLL_FORWARD" = Major ] || { echo "You must install or update .NET to run this application."; exit 150; }; echo "0.1.28+4747c32"';

test('Blender is found under Program Files without a workflow setting; a broken newer installation does not hide a usable one', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-blender-discovery-'));
  t.after(() => removeTemp(root));
  const programs = ['5.2', '5.10'].map(version => join(root, 'Blender Foundation', `Blender ${version}`, 'blender.exe'));
  for (const program of programs) { mkdirSync(join(program, '..'), { recursive: true }); writeFileSync(program, 'private probe fixture'); }
  const calls: string[] = [];
  const found = blenderStatus({ ProgramFiles: root, ProgramW6432: root }, 'win32', (command, args) => {
    assert.deepEqual(args, ['--version']);
    if (!programs.includes(command)) return undefined;
    calls.push(command);
    return command === programs[0] ? 'Blender 5.2.0' : undefined;
  });
  assert.deepEqual(calls, [programs[1], programs[0]], 'try newest installed version first, deduplicating Program Files roots');
  assert.equal(found.ok, true); assert.equal(found.required, false);
  assert.equal(found.version, 'Blender 5.2.0'); assert.equal(found.install, undefined);
  assert.match(found.purpose, /保留原外形时不需要/);
  const missing = blenderStatus({ ProgramFiles: root }, 'win32', () => 'unrelated program');
  assert.equal(missing.ok, false); assert.equal(missing.required, false);
  assert.deepEqual(missing.install, { kind: 'system', packages: [['BlenderFoundation.Blender']] });
  assert.match(missing.detail, /保留原外形仍可继续/);
  const manual = blenderStatus({}, 'linux', () => undefined);
  assert.equal(manual.required, false); assert.equal(manual.install?.kind, 'manual');
});

test('dependencies are read from this computer, and a VPM CLI in ~/.dotnet/tools runs with roll-forward', { skip: windows && 'a Linux host of shell programs with apt and pkexec' }, t => {
  const h = host(t, complete);
  mkdirSync(join(h.home, '.dotnet', 'tools'), { recursive: true });
  h.write(join(h.home, '.dotnet', 'tools', 'vpm'), vpm);
  const deps = Object.fromEntries(dependencyStatus().map(item => [item.id, item]));
  for (const id of ['node', 'git', 'bwrap', 'systemd', 'python', '7z', 'dotnet', 'vpm', 'codex', 'claude', 'browser'])
    assert.equal(deps[id]?.ok, true, `${id}: ${deps[id]?.detail}`);
  assert.equal(deps['7z']!.version, '7-Zip 26.00 (x64)');
  assert.equal(deps.vpm!.version, '0.1.28');
  assert.equal(deps.unity!.ok, false, 'no configuration and no Hub install');
  const project = join(h.root, 'project'); mkdirSync(join(project, 'Packages'), { recursive: true });
  assert.equal(vpmStatus(project).available, true, 'Harness itself finds and runs the tool');
});

test('missing system packages come from one elevated command, before the user-level VPM install', { skip: windows && 'a Linux host of shell programs with apt and pkexec' }, t => {
  // Shell built-ins only: PATH holds nothing but the fake programs.
  const log = (name: string) => `echo "${name} $*" >> "$HOME/calls"; [ -n "$DOTNET_ROLL_FORWARD" ] && echo "DOTNET_ROLL_FORWARD=$DOTNET_ROLL_FORWARD" >> "$HOME/calls"; exit 0`;
  const h = host(t, { ...complete, bwrap: 'exit 127', '7z': 'exit 127', 'apt-get': 'exit 0', pkexec: log('pkexec'),
    dotnet: `[ "$1" = --list-runtimes ] && { ${complete.dotnet}; exit 0; }; ${log('dotnet')}` });
  rmSync(join(h.bin, 'bwrap')); rmSync(join(h.bin, '7z'));
  const deps = dependencyStatus();
  // Ubuntu 26.04 offers 7zip, not p7zip-full: the first alternative with a candidate wins.
  const plan = installPlan(deps, name => name !== 'p7zip-full');
  assert.deepEqual(plan.system, ['bubblewrap', '7zip']);
  assert.deepEqual(plan.user.map(step => [step.id, step.argv.join(' ')]), [['vpm', 'dotnet tool install --global vrchat.vpm.cli']]);
  assert.ok(plan.manual.some(step => step.id === 'unity'));
  const results = runInstallPlan(plan);
  assert.deepEqual(results.map(result => result.ok), [true, true]);
  const calls = readFileSync(join(h.home, 'calls'), 'utf8').trim().split('\n');
  assert.equal(calls[0], 'pkexec sh -c apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y bubblewrap 7zip');
  assert.equal(calls.filter(line => line.startsWith('pkexec')).length, 1, 'one password prompt for every system package');
  assert.equal(calls.at(-2), 'dotnet tool install --global vrchat.vpm.cli');
  assert.equal(calls.at(-1), 'DOTNET_ROLL_FORWARD=Major');
});

test('a failed elevated install stops before user-level steps, and the async runner agrees', { skip: windows && 'a Linux host of shell programs with apt and pkexec' }, async t => {
  const h = host(t, { ...complete, bwrap: 'exit 127', 'apt-get': 'exit 0', pkexec: 'echo "Request dismissed" >&2; exit 126',
    dotnet: 'echo "dotnet $*" >> "$HOME/calls"' });
  rmSync(join(h.bin, 'bwrap'));
  const plan = { system: ['bubblewrap'], user: [{ id: 'vpm', argv: ['dotnet', 'tool', 'install', '--global', 'vrchat.vpm.cli'] }], manual: [] };
  for (const results of [runInstallPlan(plan), await runInstallPlanAsync(plan)]) {
    assert.equal(results.length, 1);
    assert.equal(results[0]!.ok, false);
    assert.match(results[0]!.output, /Request dismissed/);
  }
  assert.throws(() => runInstallPlan({ system: ['bad;rm -rf /'], user: [], manual: [] }), /无效的包名/);
});

test('without apt, a missing system package is a manual step naming its alternatives', { skip: windows && 'a Linux host of shell programs with apt and pkexec' }, t => {
  const h = host(t, complete);
  rmSync(join(h.bin, 'git'));
  const plan = installPlan(dependencyStatus(), () => true);
  assert.deepEqual(plan.system, []);
  assert.ok(plan.manual.some(step => step.id === 'git' && /git/.test(step.hint)));
});

test('the layered-recolour dependency row reports what this Python imports, from an injected probe, with the pinned install hint', () => {
  const ready = layeredRecolorStatus('/usr/bin/python3', () => 'psd-tools=1.18.0,Pillow=12.3.0,NumPy=2.5.2');
  assert.equal(ready.id, 'layered-recolor'); assert.equal(ready.required, false, 'drafting without it is still allowed (D-100)');
  assert.equal(ready.ok, true); assert.match(ready.detail, /psd-tools 1\.18\.0/);
  const partial = layeredRecolorStatus('/usr/bin/python3', () => 'psd-tools=missing,Pillow=12.3.0,NumPy=2.5.2');
  assert.equal(partial.ok, false, 'a missing import is reported as not ready, not as a degraded pass');
  assert.match(partial.detail, /缺少 psd-tools/);
  assert.match(partial.detail, /\/usr\/bin\/python3 -m pip install --user psd-tools==1\.18\.0 Pillow==12\.3\.0 NumPy==2\.5\.2/);
  const none = layeredRecolorStatus('/usr/bin/python3', () => undefined);
  assert.equal(none.ok, false);
  assert.match(none.detail, /缺少 psd-tools、Pillow、NumPy/);
});

test('Windows installs every missing system package through winget in one elevated script, then the user-level steps', () => {
  const deps = [
    { id: 'git', name: 'git', purpose: '', required: true, ok: false, detail: '未找到', install: { kind: 'system' as const, packages: [['Git.Git']] } },
    { id: '7z', name: '7-Zip', purpose: '', required: true, ok: false, detail: '未找到', install: { kind: 'system' as const, packages: [['7zip.7zip']] } },
    { id: 'python', name: 'Python 3', purpose: '', required: true, ok: true, detail: 'Python 3.13', install: { kind: 'system' as const, packages: [['Python.Python.3.13']] } },
    { id: 'vpm', name: 'VPM CLI', purpose: '', required: false, ok: false, detail: '未安装',
      install: { kind: 'user' as const, argv: ['dotnet', 'tool', 'install', '--global', 'vrchat.vpm.cli'], env: { DOTNET_ROLL_FORWARD: 'Major' } } },
    { id: 'unity', name: 'Unity', purpose: '', required: true, ok: false, detail: '未配置', install: { kind: 'manual' as const, hint: '用 Unity Hub 安装' } },
  ];
  const plan = installPlan(deps, () => true, 'win32');
  assert.deepEqual(plan.system, ['Git.Git', '7zip.7zip']);
  assert.deepEqual(plan.user.map(step => step.id), ['vpm']);
  assert.deepEqual(plan.manual.map(step => step.id), ['unity']);
  assert.deepEqual(installPlan(deps, () => false, 'win32').manual.map(step => step.id), ['git', '7z', 'unity'], 'without winget they are manual');
  const script = wingetScript(plan.system, 'C:\\tmp\\result.txt');
  assert.match(script, /winget install --id 'Git\.Git' -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity/);
  assert.match(script, /winget install --id '7zip\.7zip'/);
  assert.match(script, /Set-Content -LiteralPath 'C:\\tmp\\result\.txt'/);
  assert.throws(() => wingetScript(["Git.Git'; Remove-Item C:\\ -Recurse; '"], 'x'), /无效的包名/);
});

test('dependency probes run in the temporary directory: a program that writes where it runs leaves nothing in Harness\'s folder', t => {
  // The VPM CLI's crash reporter writes Sentry/<hash>/.installation into its working directory; any probe may do the same.
  const marker = `avh-probe-marker-${process.pid}-${Date.now()}`;
  const root = mkdtempSync(join(tmpdir(), 'avh-env-cwd-')), bin = join(root, 'bin');
  mkdirSync(bin);
  const prior = { PATH: process.env.PATH, HOME: process.env.HOME };
  t.after(() => {
    process.env.PATH = prior.PATH; process.env.HOME = prior.HOME; removeTemp(root);
    for (const place of [tmpdir(), process.cwd()]) rmSync(join(place, marker), { force: true });
  });
  if (windows) fakeCommand(join(bin, 'git'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, ''); console.log('git version 2.99.0');`);
  else { writeFileSync(join(bin, 'git'), `#!/bin/sh\n: > ${marker}\necho "git version 2.99.0"\n`); chmodSync(join(bin, 'git'), 0o755); }
  process.env.PATH = bin; process.env.HOME = root;
  const git = dependencyStatus().find(item => item.id === 'git')!;
  assert.equal(git.version, 'git version 2.99.0', 'the probe ran the stand-in');
  assert.equal(existsSync(join(process.cwd(), marker)), false, 'nothing written where Harness runs');
  assert.equal(existsSync(join(tmpdir(), marker)), true, 'it ran in the temporary directory');
});

test('on Windows the helper is required, Claude Code and pi install with npm like Codex, and the machine setup rows are there', { skip: !windows }, () => {
  const deps = Object.fromEntries(dependencyStatus().map(item => [item.id, item]));
  assert.equal(deps['avh-win']?.required, true);
  assert.doesNotMatch(deps.claude?.detail ?? '', /暂不启用/);
  assert.deepEqual(deps.claude?.install, { kind: 'user', argv: ['npm', 'install', '--global', '@anthropic-ai/claude-code'] });
  assert.deepEqual(deps.codex?.install, { kind: 'user', argv: ['npm', 'install', '--global', '@openai/codex'] });
  assert.deepEqual(deps.pi?.install, { kind: 'user', argv: ['npm', 'install', '--global', '@earendil-works/pi-coding-agent'] });
  for (const id of ['pwsh', 'unity-hub', 'unity-license', 'npm']) assert.ok(deps[id], id);
  assert.deepEqual(deps.npm?.install, { kind: 'system', packages: [['OpenJS.NodeJS.LTS']] });
  assert.equal(deps.bwrap, undefined); assert.equal(deps.systemd, undefined);
});

test('a refused Windows setup plan leaves no setup folder behind either', { skip: !windows }, async t => {
  // A private temporary directory: other test files create setup folders of their own meanwhile.
  const temp = mkdtempSync(join(tmpdir(), 'avh-env-refused-'));
  const prior = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  t.after(() => { process.env.TEMP = prior.TEMP; process.env.TMP = prior.TMP; removeTemp(temp); });
  process.env.TEMP = temp; process.env.TMP = temp;
  assert.equal(tmpdir(), temp);
  const plan = { system: ['not a package!'], user: [], manual: [] };
  assert.throws(() => runInstallPlan(plan), /无效的包名/);
  await assert.rejects(runInstallPlanAsync(plan), /无效的包名/);
  await assert.rejects(runMachineSteps([{ id: 'defender', kind: 'defender', paths: ['not\\absolute'] }], {}), /绝对路径/);
  assert.deepEqual(readdirSync(temp), []);
});

test('a refused Windows install plan leaves no script folder behind', { skip: !windows }, async () => {
  const folders = () => readdirSync(tmpdir()).filter(name => name.startsWith('avh-winget-')).sort();
  const before = folders();
  // An invalid package name is refused while the script is written, before anything asks for elevation.
  const plan = { system: ['not a package!'], user: [], manual: [] };
  assert.throws(() => runInstallPlan(plan), /无效的包名/);
  await assert.rejects(runInstallPlanAsync(plan), /无效的包名/);
  assert.deepEqual(folders(), before);
});

test('before the first setup a Unity editor found in Hub counts as ready and is named; a configuration without one still asks for it', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-env-unity-')); t.after(() => removeTemp(root));
  const prior = { HOME: process.env.HOME, ProgramFiles: process.env.ProgramFiles, APPDATA: process.env.APPDATA };
  t.after(() => { for (const [name, value] of Object.entries(prior)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  // A fake Hub install: under Program Files on Windows, under the home directory on Linux.
  process.env.HOME = join(root, 'home'); process.env.ProgramFiles = join(root, 'Program Files'); process.env.APPDATA = join(root, 'AppData');
  const editor = windows ? join(root, 'Program Files', 'Unity', 'Hub', 'Editor', '2022.3.22f1', 'Editor', 'Unity.exe')
    : join(root, 'home', 'Unity', 'Hub', 'Editor', '2022.3.22f1', 'Editor', 'Unity');
  mkdirSync(join(editor, '..'), { recursive: true }); writeFileSync(editor, ''); chmodSync(editor, 0o755);
  const first = dependencyStatus().find(item => item.id === 'unity')!;
  assert.equal(first.ok, true, first.detail);
  assert.equal(first.version, '2022.3.22f1');
  assert.ok(first.detail.includes(editor), first.detail);
  const configured = dependencyStatus({ unity: null }).find(item => item.id === 'unity')!;
  assert.equal(configured.ok, false, 'Harness is set up and its configuration names no editor');
  assert.equal(configured.install?.kind, 'manual');
});
