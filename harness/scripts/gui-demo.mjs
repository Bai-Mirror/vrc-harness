// A demo of the GUI on fictional data, for product screenshots and design review.
// Everything lives in a fresh temporary AVH_HOME: the person's real home, projects and services are never touched.
// The scheduler stays off, so no AI stage is ever dispatched; Unity is a stub executable. The GUI's reads of one
// Workflow are dressed as a Workflow in progress, in this process only (see dressDemo below): demo data, not a real run.
// Usage: node scripts/gui-demo.mjs [--shots <dir>] [--port 47831] [--keep]
//   It builds the GUI bundle from `gui/src` first, so what the screenshots show is the interface in this tree (see
//   buildGuiBundle).
//   --shots  capture every page with headless Chrome or Edge, then exit: each page 1440×900 in the light and the dark theme
//            (light-*.png, dark-*.png), a narrow window (narrow-*.png, 880 wide) and a phone-width one (phone-*.png),
//            plus the first-run directory step from an unconfigured home. AVH_DEMO_BROWSER names another browser.
//            A page whose picture is the evidence is only captured after the DOM is checked: the colour decision's
//            approval and change request are inside the viewport, the topmost element at their centre is the control
//            itself, the card carries the condensed strip and points at the full grid, the conversation reserves the
//            measured height of the docked change-request box, and a candidate is really clicked to open the in-app
//            layer that shows that same bound picture at its own pixel size, scrolling rather than shrinking. A shot
//            whose claim does not hold fails the run.
//   --keep   leave the demo running (print the URL) instead of exiting
// AVH_DEMO_THEMES=light or dark captures one theme only, for a shorter run when a long capture is flaky.
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { stringify } from 'yaml';

const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const shots = option('--shots'), port = Number(option('--port') ?? 47831), keep = argv.includes('--keep');
const themeSetting = process.env.AVH_DEMO_THEMES ?? 'light,dark';
const themes = themeSetting.split(',').map(name => name.trim());
if (!themes.length || themes.some(name => !name || !['light', 'dark'].includes(name)))
  throw new Error(`AVH_DEMO_THEMES must contain only light or dark, got: ${JSON.stringify(themeSetting)}`);

/**
 * Backstop for a DevTools call that never answers. Generous on purpose: this host has produced real stalls of ~2
 * minutes that did resolve, so this only ever catches a browser that has wedged for good — one that exited is caught
 * at once by the socket's close/error handlers instead of waiting this long.
 */
const DEVTOOLS_TIMEOUT_MS = 300_000;
/** How long the run waits for the browser's DevTools endpoint, for a page of its own, and for the socket handshake. */
const DEVTOOLS_DISCOVERY_MS = 30_000, DEVTOOLS_HANDSHAKE_MS = 15_000;

// The GUI is served from its built bundle (`src/gui/server.ts` prefers `dist/gui-app` over the source), and `dist/` is
// not tracked: on a clean checkout there is no bundle at all, and one left over from an earlier checkout shows an
// earlier interface — a screenshot run against it is evidence about code that is not the code under review (measured:
// a bundle built before the accept control rendered the stage rows without it, and the warning page could not be
// captured). The demo therefore builds the bundle from the source it documents before starting either GUI.
function buildGuiBundle() {
  const harness = fileURLToPath(new URL('..', import.meta.url));
  const gui = join(harness, 'gui');
  const vite = join(harness, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(vite)) throw new Error(`找不到 Vite（${vite}）；先在 harness/ 下运行 npm install`);
  console.log('building the GUI bundle from source…');
  execFileSync(process.execPath, [vite, 'build', '--config', join(gui, 'vite.config.ts')], { cwd: gui, stdio: 'inherit' });
}
buildGuiBundle();

const root = mkdtempSync(join(tmpdir(), 'avh-demo-'));
let service = null;
let setupApi = null, setupDb = null;
let successful = false;
const guiRuns = [];
/** Stop the Runtime this run started and remove its own temporary root, waiting for the browser to let go of it. */
async function stopDemo() {
  // Cleanup must never be what a person reads about the run: a failure here would otherwise replace the reading of the
  // assertion that failed on the way out.
  for (const run of guiRuns) run.controller.abort();
  await Promise.allSettled(guiRuns.map(run => run.running));
  try { setupApi?.close(); } catch (error) { console.log(`the setup API did not close cleanly: ${error.message}`); }
  try { setupDb?.close(); } catch (error) { console.log(`the setup database did not close cleanly: ${error.message}`); }
  try { await service?.stop(); } catch (error) { console.log(`the demo service did not stop cleanly: ${error.message}`); }
  // Windows: the browser can hold its profile a moment after it was stopped.
  for (let attempt = 0; ; attempt++) {
    try { rmSync(root, { recursive: true, force: true }); break; }
    catch (error) { if (attempt >= 20) { console.log(`demo files left at ${root}: ${error.message}`); break; } await delay(250); }
  }
}

try {
const home = join(root, 'home'), workspace = join(root, 'workspace'), library = join(root, 'library');
process.env.AVH_HOME = home;
const { installBundledPack } = await import('../src/managed-pack.ts');
const { configDocument, findProfiles } = await import('../src/tui/setup.ts');
const { RuntimeService } = await import('../src/api/server.ts');
const { ApiClient } = await import('../src/api/client.ts');
const { runGui, windowsAppBrowser } = await import('../src/gui/server.ts');
const { openDatabase } = await import('../src/state/db.ts');
const { writeSecret } = await import('../src/providers/secrets.ts');
const { upsertBoothFile, upsertBoothItem } = await import('../src/booth/catalog.ts');
// Which page this run may drive, and which failures may be retried: the rules and their counterexample tests are in
// scripts/gui-demo-cdp.mjs.
const { createOwnedTarget, findOwnedTarget, isRetryableDemoError, retryTransport,
  watchDemoBrowser, readOwnedEndpoint, connectDemoSocket } =
  await import('./gui-demo-cdp.mjs');

const file = (path, body = '', mode = 0o644) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, body); chmodSync(path, mode); };
/** Synthetic pictures for the demo's candidate grid and finished photos: gradient portraits, no commercial material. */
function demoPng(seed, width = 310, height = 500) {
  const crc = bytes => { let n = 0xffffffff; for (const b of bytes) { n ^= b; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (type, bytes) => { const out = Buffer.alloc(bytes.length + 12); out.writeUInt32BE(bytes.length); out.write(type, 4); bytes.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, -4)), out.length - 4); return out; };
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const body = Math.abs(x - width / 2) < width * 0.22 && y > height * 0.12 && y < height * 0.92;
    const base = body ? [214 + seed * 6, 168 + seed * 4, 176 + seed * 3] : [60, 60, 65];
    const shade = Math.round((y / height) * 40) + ((x ^ y) % 11);
    for (let c = 0; c < 3; c++) pixels[(y * (width * 3 + 1)) + 1 + x * 3 + c] = Math.max(0, Math.min(255, base[c] - shade));
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
for (const dir of [join(home, 'config'), join(home, 'state'), join(home, 'materialized', 'assets'), workspace, join(root, 'exports')])
  mkdirSync(dir, { recursive: true });
// A stub Unity at a Hub-style path, and a template avatar project with a VPM manifest.
const editor = join(root, 'Unity', 'Hub', 'Editor', '2022.3.22f1', 'Editor', process.platform === 'win32' ? 'Unity.exe' : 'Unity');
file(editor, '#!/bin/sh\nexit 0\n', 0o755);
const template = join(root, 'templates', 'avatar-2022');
file(join(template, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
file(join(template, 'Packages', 'vpm-manifest.json'), JSON.stringify({ dependencies: { 'com.vrchat.avatars': { version: '3.10.4' },
  'nadena.dev.modular-avatar': { version: '1.18.1' } } }, null, 2));
// Fictional local assets; names say they are demo data.
const assets = [
  ['luna-body', 'Luna 素体（演示）', 'avatar', 'Luna_Body_v2.unitypackage'],
  ['sakura-kimono', '春樱和服（演示）', 'outfit', 'Sakura_Kimono.unitypackage'],
  ['star-hairpin', '星光发饰（演示）', 'other', 'Star_Hairpin.unitypackage'],
].map(([id, name, kind, fileName]) => { const path = join(library, fileName); file(path, 'demo'); return { id, name, kind, path }; });

const managed = installBundledPack(home), found = findProfiles(managed.knowledgeRoot);
// A pi provider is configured so a formal Workflow can be created at all (a stage whose role has no provider is
// refused). The scheduler stays off, so nothing is dispatched: this is the product's own entry — the first-run wizard
// writes the same entry — and no key is read because no Run is started.
writeFileSync(join(home, 'config', 'harness.yaml'), stringify(configDocument({ workspaceRoot: workspace, exportRoot: join(root, 'exports'),
  knowledgeRoot: managed.knowledgeRoot, toolRoot: managed.toolRoot, profiles: found.profiles, thresholds: found.thresholds,
  defaultProfile: 'pc-recolor-outfit', codex: false, claude: false, pi: [{ upstream: 'deepseek' }],
  assetLibraryRoot: join(home, 'materialized', 'assets'),
  templateProject: template, contributorName: 'demo', unity: { editor, lockPath: join(home, 'state', 'unity-batch.lock') } })));

// The credential a configured service needs before a Workflow may start. This is demo text in a temporary home and no
// Run is ever dispatched (the scheduler is off), so nothing reaches a provider with it.
writeSecret(home, 'pi-deepseek', 'demo-not-a-real-key');

service = new RuntimeService({ home, scheduler: false, pollMs: 200 });
await service.start();
const api = await ApiClient.connect(home);
setupApi = api;
for (const asset of assets) await api.call('asset.save', { id: asset.id, name: asset.name, path: asset.path, kind: asset.kind,
  status: 'ready', license: 'personal', tags: ['演示'] });
const project = await api.call('project.create', { name: 'Luna-春樱', mode: 'selection',
  request: '樱花主题的和服造型：粉白配色，保留素体原有表情，菜单里可以切换发饰', faceConcept: '柔和',
  assetIds: assets.map(asset => asset.id) });
const delivery = await api.call('project.create', { name: 'Luna-夏日泳装', mode: 'selection', request: '夏日海边造型，明亮配色',
  faceConcept: '清爽', assetIds: [assets[0].id] });
const variant = await api.call('project.variant.save', { projectId: project.id, name: '春樱和服', status: 'working',
  description: '粉白渐变的和服与星光发饰；保留素体原有表情' });
for (const asset of assets.slice(1)) await api.call('project.variant.asset.attach', { variantId: variant.id, assetId: asset.id, role: 'used' });
let workflowError, workflowId, deliveryError, deliveryWorkflowId;
try { workflowId = (await api.call('workflow.create', { project: 'Luna-春樱', profile: 'pc-recolor-outfit', projectId: project.id }, 120_000)).id; }
catch (error) { workflowError = error.message; }
// A second Workflow, dressed as one that has reached the upload hand-over, so the finished photos have a page.
try { deliveryWorkflowId = (await api.call('workflow.create', { project: 'Luna-夏日泳装', profile: 'pc-recolor-outfit', projectId: delivery.id }, 120_000)).id; }
catch (error) { deliveryError = error.message; }
const db = openDatabase(join(home, 'state', 'harness.db'));
setupDb = db;
[['7000001', '春樱和服（演示）', 'Demo Atelier', '3D衣装'], ['7000002', '星光发饰（演示）', 'Demo Atelier', '3Dアクセサリー'],
  ['7000003', '夏日泳装（演示）', 'Sample Studio', '3D衣装'], ['7000004', 'Luna 素体（演示）', 'Sample Studio', '3Dキャラクター']]
  .forEach(([itemId, name, shopName, category], i) => {
    upsertBoothItem(db, { itemId, name, shopName, category, owned: true, status: 'available', tags: ['演示'] });
    upsertBoothFile(db, { downloadableId: String(8000000 + i), itemId, filename: `${name}.zip`, byteSize: 48_000_000 + i * 7_000_000,
      status: 'available' });
  });
db.close();
setupDb = null;
await api.call('booth.session.set', { session: 'demo-session-not-a-real-cookie' });
api.close();
setupApi = null;
const resetDemo = workflowId ? dressDemo(workflowId, project, deliveryWorkflowId, delivery) : undefined;

const startGui = (guiHome, guiPort) => {
  const controller = new AbortController();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const running = runGui(guiHome, { open: false, port: guiPort, sessionToken: 'demo', signal: controller.signal,
    onReady: resolveReady });
  // The outer finally owns shutdown and observes this promise; reject readiness without creating a second unhandled
  // promise when the GUI listener cannot start.
  running.catch(error => { rejectReady(error); });
  guiRuns.push({ controller, running });
  return { ready, running };
};
const gui = startGui(home, port);
const url = await gui.ready;
await delay(100);
console.log(`demo: ${url}${workflowError ? `\n(workflow not created: ${workflowError})` : ''}${deliveryError ? `\n(delivery workflow not created: ${deliveryError})` : ''}`);

if (shots) {
  mkdirSync(shots, { recursive: true });
  // First run from a home without configuration: only its screens are captured, nothing is saved there.
  const fresh = join(root, 'fresh-home'); mkdirSync(fresh, { recursive: true });
  const freshGui = startGui(fresh, port + 2);
  const freshUrl = await freshGui.ready;
  await delay(100);
  await capture(url, freshUrl, shots, resetDemo);
}
/** The headless browser: AVH_DEMO_BROWSER, else Edge or Chrome on Windows, else Chrome or Chromium on Linux. */
function demoBrowser() {
  if (process.env.AVH_DEMO_BROWSER) return process.env.AVH_DEMO_BROWSER;
  if (process.platform === 'win32') return windowsAppBrowser() ?? 'chrome.exe';
  return ['google-chrome', 'chromium', 'chromium-browser'].find(name => existsSync(`/usr/bin/${name}`)) ?? 'google-chrome';
}

/**
 * Headless Chrome driven over the DevTools protocol: walk through the navigation and capture each page, once per theme
 * (the system preference is emulated, as the GUI follows it) and in two narrow windows. A browser that has exited
 * mid-run used to leave the capture waiting on a dead socket forever, so a capture that failed for transport reasons —
 * and only for those — is retried once with a fresh browser of its own. An assertion about what a page shows is never
 * retried: its first failure is the run's failure.
 */
async function capture(address, firstRun, dir, resetDemo) {
  return retryTransport(() => captureOnce(address, firstRun, dir, resetDemo), { attempts: 2, waitMs: 1_000,
    onRetry: (error, attempt) => console.log(`capture attempt ${attempt} failed for transport reasons (${error.message}); ` +
      'retrying once with a browser of its own') });
}

async function captureOnce(address, firstRun, dir, resetDemo) {
  // This attempt's own profile directory, under this run's own temporary root: a retry must not fight the previous
  // browser over the same directory, and neither directory belongs to any other lane.
  const profile = mkdtempSync(join(root, 'chrome-'));
  const chrome = spawn(demoBrowser(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1440,900', '--no-first-run',
    // Software rasterisation: the GPU path stalls on tall captures often enough to lose a whole run.
    '--disable-gpu', '--disable-gpu-compositing', 'about:blank'], { stdio: 'ignore' });
  console.log(`browser pid ${chrome.pid}, profile ${profile}`);
  let socket, connection;
  const browserSignal = watchDemoBrowser(chrome);
  // Nothing of this attempt outlives it: the socket, every call's timer, and the browser this run started — identified
  // by the pid just printed and by this attempt's profile directory, never by a name other lanes' browsers share.
  const shutdown = async () => {
    try { connection?.close(); } catch { /* already closed */ } try { socket?.close(); } catch { /* already closed */ }
    if (chrome.exitCode === null && chrome.signalCode === null && chrome.pid) {
      const exited = new Promise(resolve => chrome.once('exit', resolve));
      chrome.kill('SIGTERM');
      await exited;
    }
  };
  try {
    // The browser chooses an unused endpoint and writes it into this fresh profile. A fixed port could belong to a
    // different browser, so no HTTP request is made until this child has written and authenticated its own endpoint.
    const cdpPort = await readOwnedEndpoint(profile, { timeoutMs: DEVTOOLS_DISCOVERY_MS, signal: browserSignal });
    // Own a page of this run's own before driving anything: the id the browser answers with is what makes the page
    // below provably ours rather than whichever tab the browser happened to list.
    const owned = await createOwnedTarget(cdpPort, { timeoutMs: DEVTOOLS_DISCOVERY_MS, signal: browserSignal });
    const target = await findOwnedTarget(cdpPort, owned.id, { timeoutMs: DEVTOOLS_DISCOVERY_MS, signal: browserSignal });
    console.log(`driving the page target this run created: ${target.id}`);
    socket = new WebSocket(target.webSocketDebuggerUrl);
    connection = await connectDemoSocket(socket, { timeoutMs: DEVTOOLS_TIMEOUT_MS, handshakeMs: DEVTOOLS_HANDSHAKE_MS, signal: browserSignal });
    // Every DevTools call is answered or refused. A call that never answers is bounded by DEVTOOLS_TIMEOUT_MS, and once
    // the connection has failed for good every later call rejects at once with that same recorded failure, so a dead
    // browser is reported instead of being waited on once per step.
    const send = (method, params = {}, timeoutMs = DEVTOOLS_TIMEOUT_MS) => {
      return connection.send(method, params, timeoutMs);
    };
    const evaluate = expression => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    /** The value an expression evaluated to, for the checks that a screenshot really shows what it claims. */
    const value = async expression => (await evaluate(expression))?.result?.value;
    /** A line in the log for the steps between captures, so a stall names where it stopped. */
    const mark = label => console.log(`step ${prefix}${label}`);
    let prefix = '';
    // A renderer that stalls once usually answers again, so a screenshot is retried before the run gives up on it. Only
    // the transport is retried here, and only a whole screenshot: a claim about what the page shows is checked once.
    const shoot = async (name, attempt = 0) => {
      try {
        const { data } = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(dir, `${prefix}${name}.png`), Buffer.from(data, 'base64')); console.log(`captured ${prefix}${name}.png`);
      } catch (error) {
        if (attempt >= 2 || !isRetryableDemoError(error)) throw error;
        console.log(`retrying ${prefix}${name}.png after: ${error.message}`);
        await delay(2000); await shoot(name, attempt + 1);
      }
    };
    /**
     * A claim that a control really is visible: its box lies inside the viewport, the topmost element at its centre is
     * the control itself (so nothing covers it, the docked change-request box above all), and it does not run under that
     * box. `find` is a JS expression that evaluates to the element.
     */
    const assertVisible = async (name, find) => {
      const seen = await value(`(() => { const el = ${find}; if (!el) return { found: false };
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        const dock = document.querySelector('.composer-dock');
        return { found: true, rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) },
          viewport: { w: innerWidth, h: innerHeight }, label: (el.textContent || '').trim().slice(0, 20),
          inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
          topmost: Boolean(top && (el === top || el.contains(top))), topmostWhat: top ? top.tagName + (typeof top.className === 'string' ? '.' + top.className.split(' ')[0] : '') : null,
          dockTop: dock ? Math.round(dock.getBoundingClientRect().top) : null }; })()`);
      if (!seen?.found) throw new Error(`${name}: the control does not exist`);
      if (!seen.inView) throw new Error(`${name}: the control is outside the viewport: ${JSON.stringify(seen)}`);
      if (!seen.topmost) throw new Error(`${name}: the control is covered by ${seen.topmostWhat}: ${JSON.stringify(seen)}`);
      if (seen.dockTop !== null && seen.rect.bottom > seen.dockTop) throw new Error(`${name}: the control runs under the change-request box: ${JSON.stringify(seen)}`);
      console.log(`verified ${name}: ${JSON.stringify(seen)}`);
      return seen;
    };
    /** One element in full, for evidence taller than a 900px window: a decision card whose pictures and approval must be
     * seen together does not fit a page shot, and a scroll position is not something a reader can check. The window is
     * grown to the element, the element is scrolled to the top, and the whole viewport is captured.
     */
    const shootElement = async (name, selector, maxHeight = 4000) => {
      const box = await value(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
        const r = el.getBoundingClientRect(); return { width: r.width, height: r.height }; })()`);
      if (!box || box.width < 100 || box.height < 100) throw new Error(`${name}: ${selector} is not measurable: ${JSON.stringify(box)}`);
      // The docked change-request box sits over the bottom of the main column; a window grown to the element alone would
      // capture the element's own last row under it (F27b).
      const dock = await value(`(() => { const d = document.querySelector('.composer-dock'); return d ? Math.ceil(d.getBoundingClientRect().height) : 0; })()`);
      if (box.height + 80 + (dock ?? 0) > maxHeight) throw new Error(`${name}: ${selector} is ${Math.round(box.height)}px tall, above the ${maxHeight}px cap`);
      await view(metrics.theme, 1440, Math.ceil(box.height) + 80 + (dock ?? 0));
      await evaluate(`(() => { document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'start' }); return true; })()`);
      await delay(600);
      await shoot(name);
      await view(metrics.theme, 1440); await delay(300);
    };
    /**
     * The two columns of the project page at once: the conversation (the decision card and its approval) and the work
     * panel (the character preview area). They scroll independently, so the window is grown to the taller column and
     * both are reset to their top before the capture.
     */
    const shootColumns = async (name, selectors, verify, maxHeight = 4200) => {
      await evaluate(`(() => { document.querySelectorAll('.app-main, .app-panel').forEach(el => { el.scrollTop = 0; }); return true; })()`);
      const needed = await value(`(() => Math.max(...${JSON.stringify(selectors)}.map(s => { const el = document.querySelector(s);
        return el ? el.getBoundingClientRect().bottom : 0; })))()`);
      if (!(needed > 200)) throw new Error(`${name}: no measurable column content (${needed})`);
      if (needed + 24 > maxHeight) throw new Error(`${name}: the columns need ${Math.round(needed)}px, above the ${maxHeight}px cap`);
      await view(metrics.theme, 1440, Math.ceil(needed) + 24); await delay(700);
      // Both columns must still hold what the shot claims once the window is the size it is captured at.
      const shown = await value(verify);
      if (!shown?.approval || !(shown?.pictures >= 4) || !shown?.loaded) throw new Error(`${name}: ${JSON.stringify(shown)}`);
      if (!(shown.strip >= 2) || !shown.pointer) throw new Error(`${name}: the decision card is missing its condensed strip: ${JSON.stringify(shown)}`);
      // What this shot claims to be evidence of, checked on the real DOM at the size it is captured: the approval is
      // inside the window and the topmost element at its centre is the approval itself.
      await assertVisible(`${name} approval`, `[...document.querySelectorAll('.gate-card button')].find(b => b.textContent.includes('批准当前版本'))`);
      await shoot(name);
      await view(metrics.theme, 1440); await delay(300);
    };
    // Click the first visible element matching a selector whose text contains the label.
    const click = (label, selector = 'button, a') => evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find(x => x.getClientRects().length && x.textContent.includes(${JSON.stringify(label)})); b?.click(); return Boolean(b); })()`);
    const nav = id => evaluate(`(() => { const b = document.querySelector('[data-nav="${id}"]'); b?.click(); return Boolean(b); })()`);
    const metrics = { theme: 'light', width: 1440, height: 900 };
    const view = async (theme, width, height = 900) => {
      metrics.theme = theme; metrics.width = width; metrics.height = height;
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    };
    // The openProject/nav helpers below click through the product; this one produces the acceptance evidence: the
    // unaccepted-warning banner and its accept button in one frame. The warning sits deep inside a stage that really
    // has sixteen checks, so the panel is far taller than a window: the shot is taken only after both are inside the
    // viewport, aligning the banner at the top and growing the window until the button is inside too. It fails loudly
    // rather than quietly producing a screenshot in which only one of the two is visible.
    const shootWarning = async (name, theme) => {
      // Scrolling the banner to the top of the scrollport is not enough to see it: `.topbar`/`.work-head` are sticky at
      // top 0, at least 60px tall and z-index 5, so the banner landed underneath one of them and a shot that only asked
      // "is it inside the viewport" produced an image of the bar instead (the frame showed the button, never the
      // banner). The scroll offset is therefore taken from the bar that really covers the banner, and the frame is
      // accepted only when both are the topmost thing painted at their own centre.
      const align = `(() => {
        document.querySelectorAll('.verify-stage').forEach(d => { if (d.querySelector('button')) d.open = true; });
        const banner = [...document.querySelectorAll('.banner')].find(x => x.textContent.includes('提醒等你确认'));
        if (!banner) return false;
        const bars = [...document.querySelectorAll('.topbar, .work-head')];
        // How far down the banner must stop: the bottom edge of a sticky bar painted over the banner's own top.
        const covered = () => {
          const r = banner.getBoundingClientRect();
          const x = Math.round(Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1));
          const y = Math.round(Math.min(Math.max(r.top + 2, 1), innerHeight - 1));
          const painted = document.elementsFromPoint(x, y);
          return Math.max(0, ...bars.filter(bar => painted.includes(bar) && bar.getBoundingClientRect().bottom > r.top + 1)
            .map(bar => bar.getBoundingClientRect().bottom));
        };
        banner.scrollIntoView({ block: 'start' });
        // scroll-margin-top is what the stylesheet already uses to keep a scrolled-to element clear of the sticky bar.
        for (let i = 0; i < 4; i++) {
          const edge = covered();
          if (edge <= banner.getBoundingClientRect().top + 1) break;
          banner.style.scrollMarginTop = Math.ceil(edge) + 'px';
          banner.scrollIntoView({ block: 'start' });
        }
        return true; })()`;
      let seen = null;
      for (const height of [900, 1300, 1700, 2100, 2500, 2900, 3300, 3900]) {
        await view(theme, 1440, height);
        await evaluate(align);
        await delay(700);
        seen = await value(`(() => {
          // In the viewport is not the same as visible: the element has to be the topmost one painted at its own
          // centre, or a sticky bar is covering it. One pixel of slack: scrollIntoView leaves sub-pixel positions.
          const shown = el => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0) || r.top < -1 || r.bottom > innerHeight + 1) return false;
            const x = Math.round(Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1));
            const y = Math.round(Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1));
            const hit = document.elementFromPoint(x, y);
            return Boolean(hit) && (hit === el || el.contains(hit)); };
          const banner = [...document.querySelectorAll('.banner')].find(x => x.textContent.includes('提醒等你确认'));
          const button = [...document.querySelectorAll('.verify-stage button')].find(x => x.textContent.includes('接受这条提醒'));
          const rect = el => { const r = el?.getBoundingClientRect(); return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom) } : null; };
          const over = el => { const r = el?.getBoundingClientRect();
            if (!r) return null; const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
            return hit ? hit.className || hit.tagName : null; };
          // What the page actually holds, so a failure says whether the banner was never rendered — a stale bundle, or a
          // reading the panel does not treat as waiting — rather than merely hidden behind a sticky bar.
          const row = [...document.querySelectorAll('.check-row')].find(r =>
            [...r.querySelectorAll('code')].some(c => c.textContent === 'regression_footwear_coverage'));
          return { banner: shown(banner), button: shown(button), height: innerHeight,
            bannerRect: rect(banner), buttonRect: rect(button), bannerTop: over(banner), buttonTop: over(button),
            stages: document.querySelectorAll('.verify-stage').length, rows: document.querySelectorAll('.check-row').length,
            banners: [...document.querySelectorAll('.banner')].map(x => x.textContent.trim().slice(0, 48)),
            footwearRow: row?.textContent?.trim().slice(0, 160) ?? null,
            inVerify: Boolean(row?.closest('.verify-stage')),
            footwearHtml: row?.outerHTML?.slice(0, 400) ?? null };
        })()`);
        if (seen.banner && seen.button) {
          // The measured rectangle and the element on top at each centre are the evidence that the frame really holds
          // both, in the log as well as in the image.
          console.log(`both visible at ${seen.height}px: banner ${JSON.stringify(seen.bannerRect)} topmost=${seen.bannerTop}, ` +
            `button ${JSON.stringify(seen.buttonRect)} topmost=${seen.buttonTop}`);
          await shoot(name); return;
        }
      }
      throw new Error(`the unaccepted-warning banner and its accept button never fit one uncovered viewport: ${JSON.stringify(seen)}`);
    };
    const openProject = async (name = 'Luna-春樱') => {
      await nav('projects'); await delay(1200);
      const opened = await value(`(() => { const card = [...document.querySelectorAll('.project-card')].find(x => x.textContent.includes(${JSON.stringify(name)})); card?.click(); return Boolean(card); })()`);
      await delay(2000);
      return opened;
    };
    /** D-128 workbench evidence: the assertions read rendered DOM state, then the two requested pages are captured. */
    const captureWorkbenchWidths = async () => {
      for (const [label, width] of [['1440', 1440], ['1100', 1100], ['1099', 1099], ['820', 820], ['390', 390]]) {
        await view(metrics.theme, width, 900);
        await send('Page.navigate', { url: address }); await delay(3000);
        await evaluate('sessionStorage.clear(); true');
        await closeNotice(); if (!await openProject()) throw new Error(`D-128 demo project card did not load at ${width}px`);
        if (width < 1100) { if (!await click('工作面', '.pane-switch button')) throw new Error(`D-128 narrow pane switch is missing at ${width}px`); await delay(700); }
        const tabsValue = await value(`JSON.stringify([...document.querySelectorAll('.work-head button')].map(b => b.textContent.trim().replace(/[0-9]+$/, '')))`);
        const tabs = typeof tabsValue === 'string' ? JSON.parse(tabsValue) : tabsValue;
        if (JSON.stringify(tabs) !== JSON.stringify(['场景', '设计目标', '素材', '制作进度']))
          throw new Error(`D-128 tabs are not the four approved workbench tabs at ${width}px: ${JSON.stringify(tabs)}`);
        const scene = await value(`(() => ({ selected: document.querySelector('.work-head button[aria-selected="true"]')?.textContent.trim(),
          cards: document.querySelectorAll('#scene-preview').length, previews: document.querySelectorAll('#preview-cards > .preview-card').length,
          paneSwitchCount: [...document.querySelectorAll('.pane-switch')].filter(x => x.getClientRects().length).length,
          paneSwitch: getComputedStyle(document.querySelector('.pane-switch')).display,
          paneControl: getComputedStyle(document.querySelector('.pane-switch')?.parentElement).display }))()`);
        if (scene.selected !== '场景' || scene.cards !== 1 || scene.previews !== 1 ||
            scene.paneSwitchCount !== (width >= 1100 ? 0 : 1) ||
            (width >= 1100 ? scene.paneControl !== 'none' : scene.paneControl === 'none'))
          throw new Error(`D-128 scene/default/pane assertion failed at ${width}px: ${JSON.stringify(scene)}`);
        await delay(400); await shoot(`w10e-${label}-scene`);
        for (const tab of ['设计目标', '素材']) {
          if (!await click(tab, '.work-head button')) throw new Error(`D-128 could not select ${tab} at ${width}px`);
          await delay(1200);
          const strip = await value(`(() => ({ selected: document.querySelector('.work-head button[aria-selected="true"]')?.textContent.trim(),
            scene: document.querySelectorAll('#scene-preview').length, strips: document.querySelectorAll('.preview-strip').length,
            images: document.querySelectorAll('.preview-strip img').length, source: document.querySelector('.preview-strip')?.textContent.includes('来源：Unity 渲染') }))()`);
          if (strip.selected !== tab || strip.scene !== 0 || strip.strips !== 1 || strip.images !== 1 || !strip.source)
            throw new Error(`D-128 thumbnail strip assertion failed for ${tab} at ${width}px: ${JSON.stringify(strip)}`);
          const stripClicked = await value(`(() => { const strip = document.querySelector('.preview-strip-button'); strip?.click(); return Boolean(strip); })()`);
          if (!stripClicked) throw new Error(`D-128 thumbnail did not offer a scene link for ${tab} at ${width}px`);
          await delay(1400);
          const returned = await value(`(() => ({ selected: document.querySelector('.work-head button[aria-selected="true"]')?.textContent.trim(), cards: document.querySelectorAll('#scene-preview').length }))()`);
          if (returned.selected !== '场景' || returned.cards !== 1) throw new Error(`D-128 thumbnail did not return to scene at ${width}px: ${JSON.stringify(returned)}`);
          if (!await click(tab, '.work-head button')) throw new Error(`D-128 could not restore ${tab} after thumbnail click at ${width}px`);
          await delay(700);
        }
        if (!await click('制作进度', '.work-head button')) throw new Error(`D-128 could not select progress at ${width}px`);
        await delay(1500);
        const progress = await value(`(() => { const details = [...document.querySelectorAll('.progress-l1 details')];
          const names = [['regression_footwear_coverage_pre','鞋履覆盖'],['regression_coverage_recorded_pre','覆盖记录'],
            ['regression_footwear_coverage','鞋履覆盖'],['regression_coverage_recorded','覆盖记录']];
          const l2Text = document.querySelector('#progress-l2')?.textContent || '';
          const labels = names.map(([id, label]) => [...document.querySelectorAll('.check-row')].some(row =>
            [...row.querySelectorAll('code')].some(code => code.textContent === id) && row.querySelector('b')?.textContent.trim() === label));
          return { selected: document.querySelector('.work-head button[aria-selected="true"]')?.textContent.trim().replace(/[0-9]+$/, ''),
            l0: Boolean(document.querySelector('.progress-l0')), l1: Boolean(document.querySelector('.progress-l1')),
            attentionOpen: details.some(d => d.open && d.textContent.includes('需要关注的检查')),
            l2: document.querySelector('#progress-l2')?.open ?? true,
            names: names.map(([id]) => l2Text.includes(id)), labels }; })()`);
        if (progress.selected !== '制作进度' || !progress.l0 || !progress.l1 || !progress.attentionOpen || progress.l2 || progress.names.some(found => !found) || progress.labels.some(found => !found))
          throw new Error(`D-128 progress assertion failed at ${width}px: ${JSON.stringify(progress)}`);
        await evaluate(`(() => { const l2 = document.querySelector('#progress-l2'); if (l2) { l2.open = true; l2.scrollIntoView({ block: 'start' }); }
          return Boolean(l2); })()`);
        await view(metrics.theme, width, 900); await delay(700); await shoot(`w10e-${label}-progress-l2`);
        if (width === 390) {
          const navigation = await value(`(() => {
            const buttons = [...document.querySelectorAll('.nav-list button, .nav-foot > button')];
            const rects = buttons.map(button => { const r = button.getBoundingClientRect(); return { text: button.textContent.trim(), left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
            const settings = buttons.find(button => button.textContent.includes('设置'));
            const sr = settings?.getBoundingClientRect();
            return { rects, allInside: rects.every(r => r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight),
              settingsInside: Boolean(sr && sr.left >= 0 && sr.right <= window.innerWidth), settings: Boolean(settings) };
          })()`);
          if (!navigation.allInside || !navigation.settingsInside || !navigation.settings)
            throw new Error(`D-128 390px navigation is not fully accessible: ${JSON.stringify(navigation)}`);
          if (!await click('设置', '[data-nav="settings"]')) throw new Error('D-128 settings navigation button is not clickable at 390px');
          await delay(500);
          const settingsActive = await value(`document.querySelector('[data-nav="settings"]')?.classList.contains('active')`);
          if (!settingsActive) throw new Error('D-128 settings navigation did not activate at 390px');
          await nav('projects'); await delay(500); await openProject();
        }
        if (width === 1440) {
          await click('设计目标', '.work-head button'); await delay(700);
          await openProject('Luna-夏日泳装'); await openProject('Luna-春樱');
          const remembered = await value(`document.querySelector('.work-head button[aria-selected="true"]')?.textContent.trim()`);
          if (remembered !== '设计目标') throw new Error(`D-128 tab selection was not remembered after switching projects: ${remembered}`);
        }
      }
      // Continue the original evidence walk from its desktop decision state after the width matrix.
      await view(metrics.theme, 1440, 900); await send('Page.navigate', { url: address }); await delay(2500);
      await closeNotice(); await openProject(); await click('场景', '.work-head button'); await delay(1500);
    };
    // The contribution notice is a real modal the product shows once per fresh state (main.tsx Root). It answers
    // "关闭回传", which the Runtime records, so it does not come back — but it is modal, so every page after it would
    // otherwise be a screenshot of the dialog. It lives in `.dialog` (ui.tsx Dialog), not in a drawer.
    const closeNotice = async () => {
      await click('关闭回传', '.dialog button'); await delay(700);
    };
    await send('Page.enable');
    for (const theme of themes) {
      prefix = `${theme}-`;
      // Each theme starts from the same fictional state. The reading this script accepted in the previous theme is demo
      // data that never reached the Runtime, so without this the second theme would inherit "accepted" and the
      // unaccepted-warning page could not be captured in it at all (measured: the dark run failed there with the row
      // already showing an accepted reading).
      resetDemo?.();
      await view(theme, 1440);
      await send('Page.navigate', { url: address }); await delay(2500);
      await closeNotice();
      await shoot('home');
      await nav('projects'); await delay(1500); await shoot('projects');
      await click('接管已有工程', '.toolbar button'); await delay(800); await shoot('takeover');
      await click('取消', '.drawer button'); await delay(400);
      await openProject(); await shoot('project');
      await captureWorkbenchWidths();
      if (process.env.AVH_W10C_ONLY === '1') return;
      // The colour decision as evidence: the whole card — the condensed strip, its source and the approval — captured as
      // one element, with the window grown by the docked change-request box so the card's own last row is not under it.
      await evaluate(`(() => { document.querySelector('.gate-card')?.scrollIntoView({ block: 'start' }); return true; })()`);
      await delay(1500);
      // The shot is only evidence if the card shows the loaded strip, the pointer at the grid, and the approval — and if
      // it does not repeat the tier × outfit grid the scene preview card beside it already draws (F27b).
      const decision = await value(`(() => { const card = document.querySelector('.gate-card');
        const strip = card ? card.querySelectorAll('.evidence-strip img') : [];
        return { card: document.querySelectorAll('.gate-card').length,
          pictures: document.querySelectorAll('.gate-card img').length,
          loaded: [...strip].every(i => i.complete && i.naturalWidth > 0),
          marked: card ? [...card.querySelectorAll('.evidence-strip .pill')].filter(p => p.textContent.includes('方案选定档')).length : -1,
          pointer: card ? /完整候选与前后对比见右侧 Unity 场景预览/.test(card.textContent) : false,
          comparison: card ? /前后对比用/.test(card.textContent) : true,
          cardRect: card ? (r => ({ top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }))(card.getBoundingClientRect()) : null,
          // The column reserves the real box's height (project.tsx measures it onto --composer-h), so the box cannot
          // cover the end of a decision whatever the textarea's height is. The check is exact and reads the inline
          // property, so the static fallback in style.css cannot stand in for the measurement.
          reserve: (() => { const column = document.querySelector('.conversation'), dock = document.querySelector('.composer-dock');
            const style = getComputedStyle(column);
            return { measured: parseInt(style.getPropertyValue('--composer-h'), 10), box: Math.ceil(dock.getBoundingClientRect().height),
              inline: column.style.getPropertyValue('--composer-h'), padding: parseFloat(style.paddingBottom) }; })(),
          approval: card ? [...card.querySelectorAll('button')].some(b => b.textContent.includes('批准当前版本')) : false }; })()`);
      if (decision?.card !== 1 || !(decision?.pictures >= 2) || !decision?.loaded || !decision?.approval)
        throw new Error(`colour decision shot is missing evidence: ${JSON.stringify(decision)}`);
      if (decision.reserve.inline !== `${decision.reserve.box}px` || !(decision.reserve.padding >= decision.reserve.box))
        throw new Error(`the conversation must reserve the change-request box's measured height: ${JSON.stringify(decision.reserve)}`);
      // One thumbnail per outfit (two in this demo), each carrying the marker, and a pointer at the full grid instead.
      if (decision.marked !== decision.pictures || !decision.pointer || decision.comparison)
        throw new Error(`the decision card must carry the condensed strip and point at the scene preview: ${JSON.stringify(decision)}`);
      await assertVisible('project-colour-decision approval', `[...document.querySelectorAll('.gate-card button')].find(b => b.textContent.includes('批准当前版本'))`);
      await shootElement('project-colour-decision', '.gate-card');
      // The Unity scene preview card in the right work panel: the same candidates, with source and time (D-121: the
      // larger, always available card; the smaller collapsible menu preview of dev.1.1 is deliberately not here).
      const preview = await value(`(() => { const area = document.querySelector('#scene-preview');
        const openers = area ? [...area.querySelectorAll('[data-evidence-image="true"]')] : [];
        return { area: Boolean(area), text: area ? area.textContent : '',
          cards: document.querySelectorAll('#preview-cards > .preview-card').length,
          collapsing: area ? area.querySelectorAll('details').length : -1,
          pictures: area ? area.querySelectorAll('img').length : 0,
          loaded: area ? [...area.querySelectorAll('img')].every(i => i.complete && i.naturalWidth > 0) : false,
          openers: openers.length,
          bound: openers.every(o => { const image = o.querySelector('img');
            return image && !o.href && image.complete && image.naturalWidth === Number(image.getAttribute('width'))
              && image.naturalHeight === Number(image.getAttribute('height')); }),
          approval: area ? [...area.querySelectorAll('button')].some(b => b.textContent.includes('批准当前版本')) : false }; })()`);
      if (!preview?.area || !(preview?.pictures >= 4) || !preview?.loaded) throw new Error(`scene preview is empty: ${JSON.stringify(preview)}`);
      if (!/Unity 场景预览/.test(preview.text) || !/来源：Unity 渲染/.test(preview.text))
        throw new Error(`scene preview lost its title or source line: ${preview.text.slice(0, 120)}`);
      if (preview.cards !== 1 || preview.collapsing !== 0) throw new Error(`D-121 layout: ${JSON.stringify(preview)}`);
      if (preview.approval) throw new Error('the approval belongs to the decision card, not to the preview card');
      if (!preview.openers || !preview.bound)
        throw new Error(`candidates are not controls showing their bound picture: ${JSON.stringify(preview)}`);
      // The full grid stays here: the decision points at it instead of repeating it (F27b).
      if (!(preview.pictures > decision.pictures))
        throw new Error(`the scene preview must keep the grid the decision no longer repeats: ${JSON.stringify({ preview: preview.pictures, decision: decision.pictures })}`);
      // F27f: the candidate must open inside the app at its own pixel size. A link to a data: URL is a control that
      // changes nothing in the desktop host, so the run really clicks a thumbnail and reads the layer that opened —
      // an href assertion alone would pass while the click did nothing.
      const clicked = await value(`(() => { const thumb = document.querySelector('#scene-preview [data-evidence-image="true"]');
        if (!thumb) return { clicked: false };
        const picture = thumb.querySelector('img');
        const bound = { src: picture.src, width: Number(picture.getAttribute('width')), height: Number(picture.getAttribute('height')) };
        thumb.click();
        return { clicked: true, bound }; })()`);
      if (!clicked?.clicked || !clicked.bound?.src) throw new Error(`no candidate to open: ${JSON.stringify(clicked)}`);
      await delay(400);
      const layer = await value(`(() => { const layers = document.querySelectorAll('.native-view');
        const image = layers.length === 1 ? layers[0].querySelector('[data-native-size="true"]') : null;
        const box = image ? image.getBoundingClientRect() : null;
        return { layers: layers.length, src: image ? image.src : null,
          natural: image ? { width: image.naturalWidth, height: image.naturalHeight } : null,
          shown: box ? { width: Math.round(box.width), height: Math.round(box.height) } : null,
          dialog: layers.length === 1 ? (layers[0].getAttribute('role') ?? '') : '' }; })()`);
      if (layer.layers !== 1 || !layer.natural?.width || layer.dialog !== 'dialog')
        throw new Error(`clicking a candidate did not open the native-size layer: ${JSON.stringify(layer)}`);
      if (layer.src !== clicked.bound.src)
        throw new Error(`the layer must show the picture the thumbnail bound, not a second read: ${JSON.stringify({ layer: layer.src?.slice(0, 48), bound: clicked.bound.src?.slice(0, 48) })}`);
      if (layer.natural.width !== clicked.bound.width || layer.natural.height !== clicked.bound.height)
        throw new Error(`the opened picture is not the size the record bound: ${JSON.stringify({ natural: layer.natural, bound: clicked.bound })}`);
      if (layer.shown.width !== layer.natural.width || layer.shown.height !== layer.natural.height)
        throw new Error(`the picture must not be scaled down: shown ${JSON.stringify(layer.shown)} of ${JSON.stringify(layer.natural)}`);
      console.log(`verified open original: ${JSON.stringify({ bound: clicked.bound.width + 'x' + clicked.bound.height, shown: layer.shown.width + 'x' + layer.shown.height })}`);
      await assertVisible('project-candidate-native close', `document.querySelector('.native-view button')`);
      await shoot('project-candidate-native');
      // Larger than the window: the layer scrolls instead of shrinking the picture. Only a window narrower than the
      // picture makes "scrolls both ways" mean anything, so the reading is taken in one.
      await view(metrics.theme, 700); await delay(400);
      const scroll = await value(`(() => { const box = document.querySelector('.native-view-scroll');
        const image = box ? box.querySelector('[data-native-size="true"]') : null;
        if (!box || !image) return null;
        const width = Math.round(image.getBoundingClientRect().width);
        box.scrollLeft = 100000; box.scrollTop = 100000;
        const frame = box.getBoundingClientRect(), shown = image.getBoundingClientRect();
        return { width, natural: image.naturalWidth, overflowX: box.scrollWidth > box.clientWidth, overflowY: box.scrollHeight > box.clientHeight,
          left: box.scrollLeft, top: box.scrollTop, rightGap: Math.round(shown.right - frame.right), bottomGap: Math.round(shown.bottom - frame.bottom) }; })()`);
      await view(metrics.theme, 1440); await delay(300);
      if (!scroll || scroll.width !== scroll.natural)
        throw new Error(`a narrow window must scroll the picture, not scale it down: ${JSON.stringify(scroll)}`);
      if (!scroll.overflowX || !scroll.overflowY || !(scroll.left > 0) || !(scroll.top > 0))
        throw new Error(`a picture larger than the window must scroll both ways: ${JSON.stringify(scroll)}`);
      if (scroll.rightGap > 1 || scroll.bottomGap > 1)
        throw new Error(`scrolling must reach the far edge of the picture: ${JSON.stringify(scroll)}`);
      console.log(`verified native-size scroll: ${JSON.stringify(scroll)}`);
      // And the layer goes away again, so the page is left as it was found.
      const closed = await value(`(() => { const button = document.querySelector('.native-view button'); button?.click(); return Boolean(button); })()`);
      if (!closed) throw new Error('the native-size layer has no close control');
      await delay(400);
      const left = await value(`(() => document.querySelectorAll('.native-view').length)()`);
      if (left !== 0) throw new Error(`closing the native-size layer left ${left} behind`);
      await shootElement('project-scene-preview', '#scene-preview');
      // Both columns in one shot: the preview area on the right, the decision card with its approval on the left.
      await shootColumns('project-preview-decision', ['.gate-card', '#scene-preview'], `(() => { const card = document.querySelector('.gate-card');
        return { approval: card ? [...card.querySelectorAll('button')].some(b => b.textContent.includes('批准当前版本')) : false,
          strip: card ? card.querySelectorAll('.evidence-strip img').length : 0,
          pointer: card ? /完整候选与前后对比见右侧 Unity 场景预览/.test(card.textContent) : false,
          pictures: document.querySelectorAll('#scene-preview img').length,
          loaded: [...document.querySelectorAll('#scene-preview img')].every(i => i.complete && i.naturalWidth > 0) }; })()`);
      // The window the person actually has: 1440×900, the conversation scrolled to the decision, and the approval inside
      // it with nothing over it. This is the state F27b has to show, so it is asserted and captured at that size.
      await view(metrics.theme, 1440, 900); await delay(400);
      await evaluate(`(() => { document.querySelector('.gate-card')?.scrollIntoView({ block: 'start' }); return true; })()`);
      await delay(900);
      await assertVisible('project-decision-window approval', `[...document.querySelectorAll('.gate-card button')].find(b => b.textContent.includes('批准当前版本'))`);
      await shoot('project-decision-window'); await delay(200);
      await assertVisible('project-decision-window change request', `[...document.querySelectorAll('.gate-card button')].find(b => b.textContent.includes('修改要求'))`);
      // What the approval covers, as the person reads it: the plan summary names colours, layers and material swaps.
      await click('依据的制作方案', '.gate-plan-more summary'); await delay(700); await shoot('project-plan');
      await click('素材', '.work-head button'); await delay(1500); await shoot('project-materials');
      await click('制作进度', '.work-head button'); await delay(1500); await shoot('workflow');
      // Each conclusion's evidence identity, read from the Runtime's own record.
      await evaluate(`(() => { document.querySelectorAll('.verify-stage').forEach(d => d.open = true); document.querySelector('.verify-stage')?.scrollIntoView({ block: 'start' }); return true; })()`);
      await delay(700); await shoot('workflow-verify');
      // The delivered project: the finished photos the regression stage took of each outfit, before the upload.
      await nav('projects'); await delay(1200);
      await evaluate(`(() => { const card = [...document.querySelectorAll('.project-card')].find(x => x.textContent.includes('Luna-夏日泳装')); card?.click(); return Boolean(card); })()`);
      await delay(2000);
      await click('制作进度', '.work-head button'); await delay(2000);
      await click('场景', '.work-head button'); await delay(1200);
      await evaluate(`(() => { document.querySelector('#scene-preview')?.scrollIntoView({ block: 'start' }); return true; })()`);
      await delay(1200);
      const delivered = await value(`(() => { const area = document.querySelector('#scene-preview');
        return { area: Boolean(area), text: area ? area.textContent : '',
          cards: document.querySelectorAll('#preview-cards > .preview-card').length,
          pictures: area ? area.querySelectorAll('img').length : 0,
          loaded: area ? [...area.querySelectorAll('img')].every(i => i.complete && i.naturalWidth > 0) : false,
          failed: area ? /没有可核对/.test(area.textContent) : true }; })()`);
      if (!delivered?.area || !(delivered?.pictures >= 2) || !delivered?.loaded || delivered?.failed)
        throw new Error(`delivery preview is missing the finished photos: ${JSON.stringify(delivered)}`);
      if (!/交付成品/.test(delivered.text) || !/成品照片/.test(delivered.text) || delivered.cards !== 1)
        throw new Error(`delivery preview does not name the finished photos: ${delivered.text.slice(0, 120)}`);
      await shootElement('project-delivery', '#scene-preview');
      // Back to the project under review: the delivery shoot above left the page on the other project, and the
      // unaccepted-warning shot and the acceptance that follows are evidence about this one's unfinished verification.
      // Its verification area is what the run opens here, so the warning page starts from the state a person would find.
      await openProject();
      await click('制作进度', '.work-head button'); await delay(1500);
      // The acceptance entry point itself, as the evidence it is asked to be.
      await shootWarning('workflow-warning', theme);
      // Then accept through the product, in the same tall window where the control is visible: the dialog asks for a
      // reason, and the demo's warning.accept refuses a request that does not bind the reading it displayed, so the row
      // reaching "已接受" proves the control sent back the right reading and the words the person typed.
      await click('接受这条提醒', '.verify-stage button'); await delay(600);
      await evaluate(`(() => { const field = document.querySelector('.dialog textarea, .dialog input');
        const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, '演示：鞋底覆盖读数已知，先继续');
        field.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await delay(300);
      await click('接受并记录', '.dialog-actions button'); await delay(1500);
      const acceptance = await value(`(() => {
        // Match the exact check id: regression_footwear_coverage_pre is a different row whose text starts the same.
        const row = [...document.querySelectorAll('.check-row')].find(r =>
          [...r.querySelectorAll('code')].some(c => c.textContent === 'regression_footwear_coverage'));
        return { accepted: Boolean(row && row.textContent.includes('已接受')),
          banner: Boolean([...document.querySelectorAll('.banner')].find(x => x.textContent.includes('提醒等你确认'))),
          error: document.querySelector('.toast.bad')?.textContent ?? '', row: row?.textContent?.slice(0, 120) ?? '' }; })()`);
      if (!acceptance.accepted || acceptance.banner)
        throw new Error(`the demo did not record the acceptance: ${JSON.stringify(acceptance)}`);
      await shoot('workflow-warning-accepted');
      await view(theme, 1440);
      await nav('assets'); await delay(1500); await shoot('booth');
      await click('本地零散素材', '.source-tabs button'); await delay(800); await shoot('local-assets');
      await nav('activity'); await delay(1500); await shoot('activity');
      await nav('core'); await delay(1500);
      // A page load raises the notice again if it was never answered; answer it so the capability list is visible.
      await closeNotice();
      await shoot('core');
      mark('settings');
      await nav('settings'); await delay(5000); await shoot('settings');
      await evaluate(`(() => { const f = document.querySelector('.config-form'); f?.scrollIntoView({ block: 'start' }); return Boolean(f); })()`);
      await delay(600); await shoot('settings-locations');
      mark('first-run');
      await send('Page.navigate', { url: firstRun }); await delay(3000);
      // First run, one shot per step: the environment check, the AI source (where the material carries the most),
      // and the directories. Step 0's 下一步 is enabled when nothing Harness itself needs is missing.
      await shoot('setup-environment');
      await click('下一步', '.setup-nav button'); await delay(900);
      await shoot('setup-ai');
      await click('下一步', '.setup-nav button'); await delay(900);
      await evaluate(`(() => { document.querySelectorAll('.setup-advanced').forEach(d => d.open = true); return true; })()`);
      await delay(300); await shoot('setup-directories');
    }
    // Narrow windows: the conversation and the work panel take turns; at phone width the navigation is a row.
    for (const [name, width] of [['narrow', 880], ['phone', 420]]) {
      prefix = `${name}-`;
      mark('narrow-window');
      await view(name === 'narrow' ? 'light' : 'dark', width);
      await send('Page.navigate', { url: address }); await delay(2500);
      await closeNotice();
      await shoot('home');
      await openProject();
      // The same decision in a narrow window: the pane switch shows the conversation, and the approval must still be in
      // view and unobstructed (F27b). The work panel is behind the switch here, so the condensed strip is the only
      // picture in sight — the full grid is one click away. At phone width the card is taller than the space above the
      // docked box, so the check is the scroll a person makes to reach the buttons: the column's end, which the reserved
      // space keeps clear of the box.
      await evaluate(`(() => { const main = document.querySelector('.app-main'); main.scrollTop = main.scrollHeight; return true; })()`);
      await delay(900);
      await assertVisible(`${prefix}project-conversation approval`, `[...document.querySelectorAll('.gate-card button')].find(b => b.textContent.includes('批准当前版本'))`);
      await assertVisible(`${prefix}project-conversation change request`, `[...document.querySelectorAll('.gate-card button')].find(b => b.textContent.includes('修改要求'))`);
      await shoot('project-conversation');
      await click('工作面', '.pane-switch button'); await delay(1200); await shoot('project-work');
    }
  } finally {
    // Ask this run's own browser to close over its own DevTools socket, then fall back to the pid this attempt started.
    // Nothing is ever identified by process name: another lane's headless browser shares that name and is not ours.
    try { if (connection && !connection.lost && socket?.readyState === 1) await connection.send('Browser.close', {}, 5_000); }
    catch { /* the kill below is the backstop */ }
    await shutdown();
  }
}

/**
 * Demo data only. The Workflow created above has not run, so its reads are dressed in this process as a Workflow in
 * progress, in an order a real run of this linear process can reach: intake, plan and setup passed with verdicts; the
 * outfit stage failed one check, was reworked and passed on its second attempt; the recolour stage finished and waits
 * for the person's approval, and nothing after it has started.
 * The scheduler is simulated as running, and its pause/resume never reach the Runtime, so the demo cannot start a
 * scheduler that would dispatch AI. Product code paths are unchanged: only this process's ApiClient is wrapped.
 */
function dressDemo(workflowId, project, deliveryWorkflowId, delivery) {
  const minutes = n => new Date(Date.now() - n * 60_000).toISOString();
  const projectPath = project.path, projectId = project.id, deliveryPath = delivery.path;
  // One reading, one id: the accept control binds the id it displayed, and the demo refuses a request that binds
  // anything else, exactly as the Runtime does, so a screenshot of an accepted reading proves the binding was sent.
  const demoVerdictId = checkId => `demo-verdict-${checkId}`;
  const gateId = `${workflowId}:recolor_approval`, hash = 'd3m0c0101a7e5f2b9e4a', planHash = 'd3m0914ae2c6b0f1d875';
  const next = () => approved ? '阶段 menu 进行中（RUNNING）' : '需要你决定：recolor_approval（批准或驳回，绑定 materials）';
  let approved = false, scheduler = 'running';
  // The demo's one warning reading: a current warning the person has not accepted, so the stage detail renders the
  // accept control this change added. Accepting it in the demo is simulated like gate.decide is.
  let warningAccepted = false;
  const tasks = [['intake', 'PASSED', 1, 95], ['plan', 'PASSED', 1, 80], ['setup', 'PASSED', 1, 62], ['outfit', 'PASSED', 2, 24],
    ['recolor', 'PASSED', 1, 6]].map(([stage, status, attempts, ago]) => ({ id: `demo-${stage}`, workflowId, formal: true, project: projectPath,
    projectName: 'Luna-春樱', stage, status, attempts, goal: `阶段 ${stage}`, updatedAt: minutes(ago), needsYou: false }));
  // The evidence identity the product now shows (src/workflow/view.ts CheckView): scope and artifact version judged,
  // and the version it still matches. `current` follows from those, so the demo data has to carry them.
  const verdict = (result, ago) => ({ result, basis: result === 'not_applicable' ? 'plan.client_gallery' : null, recordedAt: minutes(ago),
    scope: 'edit', artifactHash: 'a7c31f9be204d8e5c6f1a93b0d72e8455aa10c3f6e9d2b47', boundHash: 'a7c31f9be204d8e5c6f1a93b0d72e8455aa10c3f6e9d2b47', current: true });
  const stages = {
    intake: { status: 'passed', display: 'passed', reasons: [], result: 'pass', ago: 90 },
    plan: { status: 'passed', display: 'passed', reasons: [], result: 'pass', ago: 78 },
    setup: { status: 'passed', display: 'passed', reasons: [], result: 'pass', ago: 60 },
    // Passed on the second attempt: the first failed skeleton_missing_zero, and the event list shows the rework.
    outfit: { status: 'passed', display: 'passed', reasons: [], result: 'pass', ago: 24 },
    recolor: { status: 'blocked', display: 'deciding', reasons: ['gate recolor_approval: undecided'], result: 'pass', ago: 6 },
  };
  const dressWorkflow = view => ({ ...view, status: 'active', next: next(),
    plan: { hash: planHash, revisions: 1, approved: true },
    gates: view.gates.map(gate => gate.gate === gateId ? { ...gate, status: approved ? 'approved' : 'pending', artifactHash: hash } : gate),
    stages: view.stages.map(stage => {
      const demo = stages[stage.id];
      // The build, performance and delivery checks the verification panel reads. A conclusion carries the artifact
      // version it was judged against and the version it must still match, so the demo dresses all three states the
      // panel has to render: standing, left behind by a newer version, and a level the observer could not measure.
      if (!demo) {
        if (!/regression|performance|package/.test(stage.id)) return stage;
        const activeRegression = /regression/.test(stage.id);
        return { ...stage, status: activeRegression ? 'blocked' : 'open', display: activeRegression ? 'running' : 'open', reasons: [],
          checks: stage.checks.map((check, index) => {
            const judged = index % 2 ? 'b4e8f1c27a90d3e64b0f5a81c2d7e93f0a6b4c85d1e27f39' : 'c91f7d2a4e5b8063f1a2c7d94e0b385f6a2d1c70b8e93465';
            const newer = 'a1d0c62b58e4f793a2b6c80d1e5f94723b0a8c6e4d21f953';
            const stale = stage.id === 'regression' && index === 1;
            // A warning the person has not accepted yet: the stage detail has to show the reading and the way to accept it.
            const footwear = check.id === 'regression_footwear_coverage';
            const result = footwear ? 'violation' : stage.id === 'performance' && index === 0 ? 'no_data' : index === 2 ? 'not_applicable' : 'pass';
            // Every reading has a stable id, and the demo's accept below checks the binding the control sends against
            // it — the same guarantee the Runtime gives, so the screenshot is evidence the real request is well formed.
            return { ...check, acceptanceRequired: footwear && !warningAccepted,
              verdict: { id: demoVerdictId(check.id), result, basis: `演示数据：${check.id}`, recordedAt: minutes(12),
              scope: check.scope, artifactHash: judged, boundHash: stale ? newer : judged, current: !stale,
              ...(check.severity === 'warning' ? { accepted: footwear ? warningAccepted : false,
                ...(footwear && warningAccepted ? { acceptedAt: minutes(1) } : {}) } : {}) } };
          }) };
      }
      const task = tasks.find(item => item.stage === stage.id);
      const done = stage.id === 'recolor' && approved;
      return { ...stage, status: done ? 'passed' : demo.status, display: done ? 'passed' : demo.display, reasons: done ? [] : demo.reasons,
        task: { id: task.id, status: task.status, attempts: task.attempts },
        checks: stage.checks.map(check => ({ ...check, verdict: verdict(check.id === demo.failed ? 'violation' : demo.result, demo.ago) })) };
    }) });
  const plan = { schema: 'plan/0.2', client_gallery: false, body: 'Luna 素体（演示）',
    outfits: [{ id: 'kimono', item: '7000001', label: '春樱和服' }], default_outfit: 'kimono',
    menu: { selector: { type: 'radial', label: '衣装', parameter: 'AVH/Outfit' }, saved: true },
    recolor: { targets: [{ part: 'hair', hue_shift: -18, saturation: 0.9, value: 1.1 }, { part: 'outfit:kimono', hue_shift: 12, saturation: 0.8, value: 1.15 },
      // The other two target forms the schema allows, so the approval a person reads shows all three: a region inside
      // the vendor's own layered file, and a material that replaces an outfit's matching slots (决定记录 D-73/D-81).
      { requirement_id: 'trim_cream', layered: 'Luna_v1.5.0/PSD/Costume_default.psd', layer: ['Trim'], color: '#FAF3EE', semantics: 'shade' },
      { requirement_id: 'skirt_tier2', outfit: 'kimono', material: 'Assets/Demo/Tier2/Kimono_Skirt.mat' }],
      candidates: 3 }, notes: '粉白配色，保留素体原有表情；星光发饰放进菜单，可以单独开关。' };
  // The pictures the stages already rendered, dressed as the two read-only sets the interface asks for: the recolour
  // candidates of the version this Gate binds, and the finished photos of the delivered project. Synthetic gradient
  // portraits only — demo data must not carry vendor art, and no Unity render is claimed by this file.
  const outfitSet = [{ id: 'kimono', label: '春樱和服' }, { id: 'haori', label: '外披' }];
  const tierSet = [{ id: 'A', label: '原值', chosen: false }, { id: 'B', label: '粉白', chosen: true }, { id: 'C', label: '更亮', chosen: false }];
  const candidateImages = tierSet.flatMap((tier, t) => outfitSet.map((outfit, o) => ({ id: `${tier.id}_${outfit.id}`, tier: tier.id,
    outfit: outfit.id, outfitLabel: outfit.label, chosen: tier.chosen, sha256: String(t * 7 + o + 1).padStart(64, '0'),
    width: 928, height: 1500, seed: t * 3 + o })));
  const candidatePreview = { status: 'ready', source: 'unity', artifactHash: hash, previewSha256: 'demo-candidate-set', chosenTier: 'B',
    generatedAt: minutes(6),
    tiers: tierSet.map(tier => ({ id: tier.id, label: tier.label, chosen: tier.chosen })),
    images: candidateImages.map(({ seed, ...image }) => image) };
  const finishedPhotos = ['泳装（主套）', '外披', '发饰搭配'].map((label, index) => ({ id: `demo-photo-${index}`, label,
    sha256: String(index + 40).padStart(64, '0'), width: 310, height: 500, seed: 20 + index }));
  const finishedPreview = { status: 'ready', source: 'unity', buildHash: 'd3m0b1a1d9c7f3e5a2b4', previewSha256: 'demo-photo-set',
    generatedAt: minutes(35), photos: finishedPhotos.map(({ seed, ...photo }) => photo) };
  const events = [
    ['task', 'demo-intake', 'READY->RUNNING', 'dispatch', 96], ['verdict', 'demo-intake', 'recorded', '检查结论已记录', 91],
    ['gate', `${workflowId}:material_gap_confirm`, 'approved', '素材齐全，确认缺口为零', 88], ['task', 'demo-plan', 'VERIFYING->PASSED', 'checks passed', 80],
    ['gate', `${workflowId}:plan_approval`, 'approved', '批准方案：春樱和服，粉白配色', 76], ['task', 'demo-setup', 'VERIFYING->PASSED', 'checks passed', 62],
    ['task', 'demo-outfit', 'VERIFYING->BLOCKED', 'skeleton_missing_zero: violation', 44],
    ['task', 'demo-outfit', 'requested_redo', '鞋子缺少对应骨骼，按检查结果返工', 43], ['task', 'demo-outfit', 'READY->RUNNING', 'dispatch', 40],
    ['task', 'demo-outfit', 'VERIFYING->PASSED', 'checks passed', 24], ['task', 'demo-recolor', 'READY->RUNNING', 'dispatch', 22],
    ['task', 'demo-recolor', 'VERIFYING->PASSED', 'checks passed', 6],
  ].map(([entityType, entityId, action, reason, ago], i) => ({ seq: 100_000 + i, at: minutes(ago), workflowId, actor: 'runtime',
    entityType, entityId, action, reason }));
  // The second Workflow is dressed as one that has reached the hand-over: every stage passed, nothing waiting on the
  // person, and the finished photos the regression stage took are the ones the project page reads.
  const dressDelivery = view => ({ ...view, status: 'upload_ready', next: '已到 UPLOAD_READY：请上传并按清单自测',
    plan: { hash: planHash, revisions: 1, approved: true },
    stages: view.stages.map(stage => ({ ...stage, status: 'passed', display: 'passed', reasons: [], codes: [],
      task: { id: `demo2-${stage.id}`, status: 'PASSED', attempts: 1 },
      checks: stage.checks.map(check => ({ ...check, verdict: verdict('pass', 30) })) })) });
  const original = ApiClient.prototype.call;
  ApiClient.prototype.call = async function call(method, params = {}, ...rest) {
    switch (method) {
      case 'service.pause': scheduler = 'paused'; return { state: 'pausing' };
      case 'service.resume': scheduler = 'running'; return { state: 'running' };
      case 'gate.decide': if (params.gate === gateId) { approved = Boolean(params.approve); return { message: '演示：已记录决定' }; } break;
      case 'warning.accept': if (params.workflowId === workflowId) {
        // The control must have sent back the reading it displayed; a mismatch is refused, never silently accepted.
        if (params.expectedVerdictId !== demoVerdictId(params.checkId))
          throw new Error('演示：这条读数在你查看之后已变化，请重新查看后再接受');
        warningAccepted = true;
        return { verdictId: demoVerdictId(params.checkId), checkId: params.checkId, recordedAt: minutes(1), alreadyAccepted: false };
      } break;
      case 'plan.show': if (params.workflowId === workflowId)
        return { current: plan, revisions: [{ seq: 1, hash: planHash, observedAt: minutes(79), approved: true }] }; break;
      case 'project.recolor.preview': if (params.workflowId === workflowId) return candidatePreview; break;
      case 'project.recolor.preview.images': if (params.workflowId === workflowId) return candidateImages
        .filter(image => params.ids.includes(image.id))
        .map(image => ({ id: image.id, previewSha256: params.previewSha256, sha256: image.sha256, dataUrl: demoPng(image.seed, image.width, image.height) })); break;
      case 'project.delivery.photos': if (params.workflowId === deliveryWorkflowId) return finishedPreview; break;
      case 'project.delivery.photos.images': if (params.workflowId === deliveryWorkflowId) return finishedPhotos
        .filter(photo => params.ids.includes(photo.id))
        .map(photo => ({ id: photo.id, previewSha256: params.previewSha256, sha256: photo.sha256, dataUrl: demoPng(photo.seed) })); break;
      case 'task.redo': case 'task.cancel': case 'task.recover': case 'task.show':
        if (String(params.id).startsWith('demo-')) return { message: '演示数据：不会执行' }; break;
    }
    const result = await original.call(this, method, params, ...rest);
    switch (method) {
      case 'service.status': return { ...result, scheduler: { ...result.scheduler, state: scheduler } };
      case 'workflow.show': return params.id === workflowId ? dressWorkflow(result) : params.id === deliveryWorkflowId ? dressDelivery(result) : result;
      case 'project.list': return result.map(row => row.path === deliveryPath && row.workflow
        ? { ...row, workflow: { ...row.workflow, status: 'upload_ready', next: '已到 UPLOAD_READY：请上传并按清单自测', stagesPassed: 13, stagesTotal: 13 }, tasks: { total: 13, open: 0, needsYou: 0 } }
        : row.path === projectPath && row.workflow
        ? { ...row, workflow: { ...row.workflow, status: 'active', next: next(), stagesPassed: approved ? 5 : 4, stagesTotal: 13 }, tasks: { total: tasks.length, open: approved ? 1 : 0, needsYou: 0 } } : row);
      case 'gate.list': return [...result.filter(gate => gate.workflowId !== workflowId && gate.workflowId !== deliveryWorkflowId), ...(approved ? [] : [{ gate: gateId, workflowId,
        formal: true, project: projectPath, projectId, projectName: 'Luna-春樱', owner: 'stage:recolor', status: 'pending', question: '查看 Unity 渲染的配色候选图，批准当前版本或提出调整要求',
        binds: 'materials', artifactHash: hash, preview: 'recolor-candidates' }])];
      case 'task.list': return [...tasks.map(({ attempts, ...task }) => task), ...result.filter(task => task.workflowId !== workflowId && task.workflowId !== deliveryWorkflowId)];
      case 'events.recent': return [...result.filter(event => event.workflowId !== workflowId && event.workflowId !== deliveryWorkflowId), ...events].sort((a, b) => a.at.localeCompare(b.at));
      default: return result;
    }
  };
  // The capture loop starts each theme over: this fiction lives in this process only, so nothing it "accepted" may
  // survive into the next theme. A real Runtime would keep the acceptance — and then no later screenshot of one
  // session could show the same warning still unaccepted.
  return () => { warningAccepted = false; };
}

successful = true;
} finally {
  // Initialization, capture, and normal shutdown share one cleanup boundary. A failed setup cannot leave a service,
  // GUI listener, or this run's temporary root behind, even when --keep was requested.
  if (!successful || !keep) await stopDemo();
}
if (!keep) process.exit(0);
