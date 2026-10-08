// Local stand-in for CI (the only remote is public; Harness branches stay local until release).
// Usage: node scripts/check.mjs [--integration] [--skip-tests] [--test-concurrency <n>] [--keep] [--log <file>]
//        [--nginx-boundary]
//   typecheck (Runtime, GUI and the server beside it) → server tests → unit tests → build → npm pack
//   → install the tarball under a clean HOME → installed `avh --version`, `avh doctor` and a state-database round trip.
//   --nginx-boundary adds the DATA/D7 deployment check; without Docker it is reported as skipped, never as passed.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { superviseSuite, unitTestArgs, silenceBudgetMs } from './unit-suite.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const logArg = args.indexOf('--log');
const concurrencyArg = args.indexOf('--test-concurrency');
const testConcurrency = concurrencyArg < 0 ? undefined : Number(args[concurrencyArg + 1]);
if (testConcurrency !== undefined && (!Number.isSafeInteger(testConcurrency) || testConcurrency < 1))
  throw new Error('--test-concurrency 需要正整数');
const work = mkdtempSync(join(tmpdir(), 'avh-check-'));
const log = logArg >= 0 ? args[logArg + 1] : join(work, 'check.log');
mkdirSync(dirname(log), { recursive: true });
writeFileSync(log, `avh check ${new Date().toISOString()} node=${process.version} root=${root}\n`);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const results = [];
const skipped = [];

function run(title, command, commandArgs, options = {}) {
  const started = Date.now();
  const spawnOptions = { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === 'win32' && command.endsWith('.cmd'), ...options };
  let result = spawnSync(command, commandArgs, spawnOptions);
  // One more attempt, with other arguments, for a failure that is known to go away that way.
  if (result.status !== 0 && options.retry?.when(result)) {
    appendFileSync(log, `\n## ${title} (first attempt)\n$ ${command} ${commandArgs.join(' ')}\nexit=${result.status}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
    commandArgs = options.retry.args;
    result = spawnSync(command, commandArgs, spawnOptions);
  }
  const ok = options.expect ? options.expect(result) : result.status === 0;
  appendFileSync(log, `\n## ${title}\n$ ${command} ${commandArgs.join(' ')}\nexit=${result.status}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  results.push({ title, ok, seconds: ((Date.now() - started) / 1000).toFixed(1) });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${title} (${results.at(-1).seconds}s)`);
  if (!ok) finish();
  return result;
}
function finish() {
  const failed = results.filter(item => !item.ok);
  const removeAll = !failed.length && !flag('--keep') && logArg < 0;
  console.log(`\n${failed.length ? '失败' : '全部通过'}：${results.length - failed.length}/${results.length}${skipped.length ? `；跳过 ${skipped.length} 项（不算通过）：${skipped.join('、')}` : ''}；${removeAll ? '临时目录与日志已删除（要保留日志用 --log <文件>）' : `日志 ${log}`}`);
  if (removeAll) rmSync(work, { recursive: true, force: true });
  else if (!failed.length && !flag('--keep')) rmSync(join(work, 'install'), { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}

// Source tests and doctor call the native supervisor before the later build/package phase.
// A new Windows worktree has no helper yet; build the locked sources before any consumers run.
if (process.platform === 'win32') run('build Windows helper', process.execPath, [join(root, 'scripts/build-native.mjs')]);
run('typecheck', process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit']);
run('typecheck GUI', process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', join(root, 'gui/tsconfig.json')]);
// The server that receives contributions and serves signed releases is part of this repository and of what must keep
// working, so the total check runs its typecheck and tests too. It lives beside the Runtime; a packaging bootstrap
// worktree carries only the harness sources, so this repository-level step is absent there, like the tier check below.
const serverRoot = join(root, '..', 'server');
if (existsSync(join(serverRoot, 'package.json'))) {
  run('server typecheck', npm, ['run', 'typecheck'], { cwd: serverRoot });
  if (!flag('--skip-tests')) run('server tests', npm, ['test'], { cwd: serverRoot });
}
// Every managed document must declare the change-permission tier its directory implies. A packaging
// bootstrap worktree carries only the harness sources, so this repository-level step is absent there.
const tierCheck = join(root, 'tools/doc-tier.mjs');
if (existsSync(tierCheck)) run('document tier markers', process.execPath, [tierCheck, '--check']);
// The two verification avatars are a development set, not a proof of capability (order D-110): the generic tools
// and criteria must not name their assets, vendors, directories, layers, materials, rig names or GUIDs, because a
// rule keyed on one of them stops applying to the next asset of the same kind. Every occurrence that stays carries
// a reviewed reason in the committed identity list. Like the tier check, this is a repository-level step: a
// packaging bootstrap worktree carries only the harness sources and does not have the tools directory.
const specificity = join(root, 'tools/specificity-scan.mjs');
if (existsSync(specificity)) run('specificity scan', process.execPath, [specificity]);
// A control that opens with nothing wired to it is either a design mistake, a capability never connected,
// or a leftover; the repository should not accumulate them. Skipped silently when python is absent, the
// same way the tier check is skipped when this worktree does not carry the tools.
const controls = join(root, 'tools/audit-controls.py');
if (existsSync(controls)) {
  const python = process.platform === 'win32' ? 'python3' : 'python3';
  const probed = spawnSync(python, ['--version'], { stdio: 'ignore' });
  if (probed.status === 0) run('GUI controls wired', python, [controls, '--check']);
}
// DATA/D7: the shipped nginx API boundary is only provable with Docker, an nginx image, a Node image and openssl.
// The step is opt-in (--nginx-boundary); its wrapper exits 3 when it cannot run, which is reported as skipped and is
// never counted as a pass, because an unrun deployment check is not evidence.
if (flag('--nginx-boundary')) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [join(root, 'scripts/nginx-boundary.mjs')],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  appendFileSync(log, `\n## nginx api boundary\n$ node scripts/nginx-boundary.mjs\nexit=${result.status}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.status === 3) {
    skipped.push('nginx api boundary');
    console.log(`SKIP nginx api boundary (${seconds}s) — Docker/openssl/Python/image 不满足，未运行，不算通过`);
  } else {
    const ok = result.status === 0;
    results.push({ title: 'nginx api boundary', ok, seconds });
    console.log(`${ok ? 'OK  ' : 'FAIL'} nginx api boundary (${seconds}s)`);
    if (!ok) finish();
  }
}
if (!flag('--skip-tests')) {
  const integration = flag('--integration') ? '1' : '0';
  const title = `unit tests${flag('--integration') ? ' + host integration' : ''}`;
  const started = Date.now();
  // The suite runs supervised rather than through `run()` above: a test that blocks the event loop cannot be
  // stopped by `--test-timeout` (measured), so only a parent process can end a stalled run, and the step must
  // still report which test it was in rather than waiting for a person to notice.
  const result = await superviseSuite(unitTestArgs(testConcurrency === undefined ? [] : [`--test-concurrency=${testConcurrency}`]), {
    cwd: root, env: { ...process.env, AVH_PROVIDER_IT: integration, AVH_SYSTEMD_IT: integration, AVH_CODEX_TRUST_IT: '0' },
    onOutput: text => appendFileSync(log, text) });
  const ok = !result.stalled && result.status === 0;
  results.push({ title, ok, seconds: ((Date.now() - started) / 1000).toFixed(1) });
  appendFileSync(log, `\n## ${title}\n$ node ${unitTestArgs().join(' ')} (supervised: silence ${silenceBudgetMs() / 60000}min)\nexit=${result.status}${result.stalled ? ` stalled=${result.stalled}` : ''}\n`);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${title} (${results.at(-1).seconds}s)${result.stalled ? ` — 已停止：${result.stalled}` : ''}`);
  if (result.stalled) {
    const seen = result.tail.slice(-20).join('\n');
    appendFileSync(log, `${seen}\n`);
    console.error(`最后看到的测试输出（用于定位卡住的用例）：\n${seen}`);
  }
  if (!ok) finish();
}
run('build', process.execPath, [join(root, 'scripts/build.mjs')]);
const packed = run('npm pack', npm, ['pack', '--json', '--pack-destination', work]);
// Lifecycle scripts may write build progress before npm's JSON document.
const jsonStart = packed.stdout.split('\n').findIndex(line => line.trim() === '[');
if (jsonStart < 0) throw new Error('npm pack 没有返回 JSON 清单');
const pack = JSON.parse(packed.stdout.split('\n').slice(jsonStart).join('\n'))[0];
const tarball = join(work, pack.filename);
const names = pack.files.map(file => file.path);
const required = ['bin/avh.js', 'dist/cli.js', 'dist/build-info.json', 'dist/state/migrations/0001_init.sql',
  'dist/state/migrations/0009_product_catalog.sql', 'dist/state/migrations/0010_project_assets.sql',
  'dist/state/migrations/0014_workflow_variables.sql', 'dist/gui-app/index.html', 'dist/exec/unit-wrapper.mjs',
  'builtin/pack.json', 'builtin/knowledge/context/plan-avatar-v1.md', 'builtin/tools/harness/intake.py',
  'builtin/evaluation/smoke/suite.json', 'builtin/evaluation/smoke/verify-pack-contract.mjs',
  'builtin/tools/unpack_unitypackage.py', 'builtin/tools/构建/BuildArtifact.cs', 'builtin/tools/审查/unity/Editor/AuditIO.cs',
  'LICENSE', 'NOTICE.md', 'package.json',
  ...(process.platform === 'win32' ? ['dist/native/avh-win.exe', 'dist/native/avh-win-launch.exe'] : [])];
const forbidden = names.filter(name => /^(src|test|scripts)\//.test(name) || name.endsWith('.ts') || /(^|\/)__pycache__\/|\.pyc$/.test(name));
const missing = required.filter(name => !names.includes(name));
results.push({ title: 'package contents', ok: !missing.length && !forbidden.length, seconds: '0.0' });
appendFileSync(log, `\n## package contents\n${names.join('\n')}\nmissing=${missing.join(',')}\nforbidden=${forbidden.join(',')}\n`);
console.log(`${results.at(-1).ok ? 'OK  ' : 'FAIL'} package contents (${names.length} files${missing.length ? `; missing ${missing.join(', ')}` : ''}${forbidden.length ? `; forbidden ${forbidden.slice(0, 5).join(', ')}` : ''})`);
if (!results.at(-1).ok) finish();

// Install under a clean HOME, reusing the caller's npm cache so the check works offline once warmed.
const cache = spawnSync(npm, ['config', 'get', 'cache'], { encoding: 'utf8', shell: process.platform === 'win32' }).stdout.trim();
const home = join(work, 'home'); const prefix = join(work, 'install'); mkdirSync(home); mkdirSync(prefix);
const cleanEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, LANG: process.env.LANG ?? 'C.UTF-8',
  ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}) };
// --prefer-offline trusts cached registry metadata, which can predate the versions package.json asks for (ETARGET);
// that install asks the registry again.
const installArgs = freshness => ['install', '--prefix', prefix, '--cache', cache, freshness, '--no-audit', '--no-fund', tarball];
run('install tarball (clean HOME)', npm, installArgs('--prefer-offline'), { env: cleanEnv,
  retry: { when: result => /\bETARGET\b/.test(`${result.stdout}${result.stderr}`), args: installArgs('--prefer-online') } });
const avh = join(prefix, 'node_modules/avatar-harness/bin/avh.js');
run('installed avh --version', process.execPath, [avh, '--version'], { env: cleanEnv,
  expect: result => result.status === 0 && result.stdout.includes(`avh ${pack.version} (`) && !/\+nogit|unknown/.test(result.stdout) });
if (process.platform === 'linux') {
  const dataHome=join(work,'xdg-data');
  run('installed GUI desktop launcher', process.execPath, [avh,'gui','install'], { env: { ...cleanEnv, XDG_DATA_HOME:dataHome },
    expect: result => result.status===0 && readFileSync(join(dataHome,'applications/avatar-harness.desktop'),'utf8').includes('Terminal=false') });
  run('uninstalled GUI desktop launcher', process.execPath, [avh,'gui','uninstall'], { env: { ...cleanEnv, XDG_DATA_HOME:dataHome },
    expect: result => result.status===0 });
}
if (process.platform === 'win32') {
  // The shortcut starts node through the packaged helper's windowless launcher, so this also proves the helper shipped.
  const appData=join(work,'appdata'), shortcut=join(appData,'Microsoft','Windows','Start Menu','Programs','Harness (avh gui).lnk');
  run('installed GUI Start menu shortcut', process.execPath, [avh,'gui','install'], { env: { ...cleanEnv, APPDATA:appData },
    expect: result => result.status===0 && existsSync(shortcut) });
  run('uninstalled GUI Start menu shortcut', process.execPath, [avh,'gui','uninstall'], { env: { ...cleanEnv, APPDATA:appData },
    expect: result => result.status===0 && !existsSync(shortcut) });
}

// Minimal synthetic workspace so doctor and the state database run from the installed files only.
const avhHome = join(work, 'avh-home'); const workspace = join(work, 'workspace'); const knowledge = join(work, 'knowledge');
for (const dir of [join(avhHome, 'config'), workspace, join(workspace, 'tools'), join(knowledge, 'process'), join(work, 'export')])
  mkdirSync(dir, { recursive: true });
writeFileSync(join(knowledge, 'process/synthetic-flow.yaml'), readFileSync(join(root, 'test/fixtures/process.yaml')));
// doctor requires the read-only review scripts under toolRoot; the package does not ship them yet (RC-L L6).
mkdirSync(join(workspace, 'tools/审查/perception'), { recursive: true });
for (const file of ['project_fingerprint.py', 'vpm_baseline_check.py', '审查/perception/strip_audit.py'])
  writeFileSync(join(workspace, 'tools', file), '');
writeFileSync(join(knowledge, 'thresholds.yaml'),
  'schema: thresholds/0.1\nversion: "1"\nt:\n  max_count: {value: 10, unit: items, maturity: accepted, source: check}\n');
writeFileSync(join(avhHome, 'config/harness.yaml'), [
  `workspaceRoot: ${JSON.stringify(workspace)}`, `toolRoot: ${JSON.stringify(join(workspace, 'tools'))}`,
  `knowledgeRoot: ${JSON.stringify(knowledge)}`, `exportRoots: [${JSON.stringify(join(work, 'export'))}]`,
  'knownBodies: [ExampleBody]', 'projectAliases: {}', 'sampleNames: []', 'defaultProfile: synthetic-flow',
  'processDefinitions: {synthetic-flow: process/synthetic-flow.yaml}', 'thresholdsFile: thresholds.yaml', 'providers: []', ''].join('\n'));
const avhEnv = { ...cleanEnv, AVH_HOME: avhHome };
run('installed avh doctor', process.execPath, [avh, 'doctor'], { env: avhEnv,
  expect: result => result.status === 0 && !/FAIL/.test(result.stdout) && /OK\t配置/.test(result.stdout) });
run('installed avh task list (creates and migrates the state database)', process.execPath, [avh, 'task', 'list'],
  { env: avhEnv, expect: result => result.status === 0 && result.stdout.startsWith('id\tproject\tstatus\tgoal') });
finish();
