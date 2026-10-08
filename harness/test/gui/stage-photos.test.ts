import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import React from 'react';
import ts from 'typescript';

const source = readFileSync(new URL('../../gui/src/stage-photos.tsx', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/export function/g, 'function');
const compiled = ts.transpileModule(source + '\nglobalThis.Components={RecolorPreviewView,DeliveryPhotosView,ScenePreview,PreviewStrip};',
  { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
type Element = { type: unknown; props: Record<string, any> };
function elements(value: any): Element[] { if (Array.isArray(value)) return value.flatMap(elements); return value?.props ? [value, ...elements(value.props.children)] : []; }
const text = (value: any): string => Array.isArray(value) ? value.map(text).join('') : value?.props ? text(value.props.children) : typeof value === 'string' ? value : '';
// Candidates are buttons of their own now (F27f), so the approval is found by its label rather than by its type.
const approvalButton = (body: any) => elements(body).find(element => element.type === 'button' && text(element).includes('批准当前版本'));

/**
 * The Browser the components talk to: one batch read per listed set, with injectable integrity faults. The harness
 * renders like React does for the parts these assertions need — a component element is called, with its own state
 * slots, so a view nested in the preview area is really rendered.
 */
function harness(options: { recolor?: any; delivery?: any; fault?: string; faceMode?: string | null }) {
  const states = new Map<unknown, any[]>(), cursors = new Map<unknown, number>();
  let current: unknown = null;
  const calls: Array<{ method: string; params: any }> = [], effects: Array<() => any> = [];
  // The window the components listen on: the native-size layer closes on Escape, so the key it reacts to is a reading.
  const keyListeners = new Set<(event: { key: string }) => void>();
  const portals: any[] = [];
  const context: Record<string, unknown> = {
    React,
    // The layer is portalled to the body so a hidden column cannot take it off the screen. React's real portal is a
    // container reference, which this renderer has no tree for: the child comes back in place, and the container it was
    // asked for is recorded so the test can still read where it went. The browser run checks the real thing.
    createPortal: (child: any, container: any) => { portals.push(container); return child; },
    document: { body: 'document-body' },
    window: {
      addEventListener: (type: string, handler: (event: { key: string }) => void) => { if (type === 'keydown') keyListeners.add(handler); },
      removeEventListener: (type: string, handler: (event: { key: string }) => void) => { if (type === 'keydown') keyListeners.delete(handler); },
    },
    useState: (initial: any) => { const slots = states.get(current) ?? []; states.set(current, slots);
      const slot = cursors.get(current) ?? 0; cursors.set(current, slot + 1);
      if (slots[slot] === undefined) slots[slot] = initial;
      return [slots[slot], (value: any) => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; }]; },
    useEffect: (action: () => any) => { effects.push(action); },
    useLoad: (method: string) => [method === 'project.recolor.preview' ? options.recolor : options.delivery, null],
    useAction: () => ({ busy: '', run: async (_key: string, action: () => Promise<void>) => { await action(); } }),
    errorText: (error: Error) => error.message, when: (iso: string) => `时间(${iso})`, stageLabel: (id: string) => `阶段(${id})`,
    facePreviewMode: () => options.faceMode ?? null, FacePreviewView: 'face-preview-view',
    Panel: 'section',
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (!method.endsWith('.images')) return { message: 'fixture' };
      const listed = params.ids.map((id: string) => {
        if (method === 'project.recolor.preview.images') {
          const image = options.recolor.images.find((item: any) => item.id === id);
          return { id, previewSha256: params.previewSha256, sha256: image?.sha256, dataUrl: `data:image/png;base64,fixture:${id}` };
        }
        const photo = options.delivery.photos.find((item: any) => item.id === id);
        return { id, previewSha256: params.previewSha256, sha256: photo?.sha256, dataUrl: `data:image/png;base64,fixture:${id}` };
      });
      if (options.fault === 'missing') listed.pop();
      if (options.fault === 'sha') listed[0].sha256 = 'changed';
      if (options.fault === 'preview') listed[0].previewSha256 = 'other';
      if (options.fault === 'data') listed[0].dataUrl = 'file:///private';
      return listed;
    },
    Components: undefined,
  };
  runInNewContext(compiled, context);
  const components = context.Components as Record<string, any>;
  const expand = (value: any): any => {
    if (Array.isArray(value)) return value.map(expand);
    if (!value || !value.props) return value;
    if (typeof value.type === 'function') {
      const previous = current; current = value.type; cursors.set(value.type, 0);
      const rendered = expand(value.type(value.props));
      current = previous; return rendered;
    }
    if (value.props.children === undefined) return value;
    return { ...value, props: { ...value.props, children: expand(value.props.children) } };
  };
  return { calls, effects, components, portals,
    // The key a person presses, delivered to whatever the mounted layer registered on the window.
    press: (key: string) => { for (const handler of [...keyListeners]) handler({ key }); },
    render: (name: string, props: any) => { current = components[name]; cursors.set(current, 0); return expand(components[name]!(props)); },
    runEffects: async () => { for (const effect of effects.splice(0)) effect(); await new Promise(resolve => setImmediate(resolve)); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
// Three tiers: A 方案原值 (the before side of the comparison), B chosen, C another option; two outfits.
const recolour = {
  status: 'ready', source: 'unity', artifactHash: 'materials-version', previewSha256: 'set-digest', chosenTier: 'B',
  generatedAt: '2026-10-05T06:20:00.000Z',
  tiers: [{ id: 'A', label: '方案原值', chosen: false }, { id: 'B', label: '粉白', chosen: true }, { id: 'C', label: '更亮', chosen: false }],
  images: [{ id: 'A_kimono', tier: 'A', outfit: 'kimono', outfitLabel: '春樱和服', chosen: false, sha256: 'sha-A', width: 928, height: 1500 },
    { id: 'B_kimono', tier: 'B', outfit: 'kimono', outfitLabel: '春樱和服', chosen: true, sha256: 'sha-B', width: 928, height: 1500 },
    { id: 'C_kimono', tier: 'C', outfit: 'kimono', outfitLabel: '春樱和服', chosen: false, sha256: 'sha-C', width: 928, height: 1500 }],
};
// The same recipe rendered on two outfits: the decision card's strip has to show the chosen tier once per outfit.
const twoOutfits = { ...recolour, images: [
  { id: 'A_kimono', tier: 'A', outfit: 'kimono', outfitLabel: '春樱和服', chosen: false, sha256: 'sha-Ak', width: 928, height: 1500 },
  { id: 'A_haori', tier: 'A', outfit: 'haori', outfitLabel: '外披', chosen: false, sha256: 'sha-Ah', width: 928, height: 1500 },
  { id: 'B_kimono', tier: 'B', outfit: 'kimono', outfitLabel: '春樱和服', chosen: true, sha256: 'sha-Bk', width: 928, height: 1500 },
  { id: 'B_haori', tier: 'B', outfit: 'haori', outfitLabel: '外披', chosen: true, sha256: 'sha-Bh', width: 928, height: 1500 },
  { id: 'C_kimono', tier: 'C', outfit: 'kimono', outfitLabel: '春樱和服', chosen: false, sha256: 'sha-Ck', width: 928, height: 1500 },
  { id: 'C_haori', tier: 'C', outfit: 'haori', outfitLabel: '外披', chosen: false, sha256: 'sha-Ch', width: 928, height: 1500 },
] };
const delivery = { status: 'ready', source: 'unity', buildHash: 'build-version', previewSha256: 'photo-digest',
  generatedAt: '2026-10-05T07:00:00.000Z',
  photos: [{ id: 'outfit_0', label: '春樱和服', sha256: 'sha-p0', width: 928, height: 1500 },
    { id: 'outfit_1', label: '夏日浴衣', sha256: 'sha-p1', width: 928, height: 1500 }] };
const approveProps = { gate: 'workflow:recolor_approval', label: '批准当前版本', success: '已批准', expectedHash: 'materials-version', changed: () => { approvals++; } };
let approvals = 0;

test('the colour decision shows the rendered candidates, the before/after pair and the approval only once all displayed', async () => {
  const h = harness({ recolor: recolour });
  approvals = 0;
  const props = { projectId: 'project', workflowId: 'workflow', refresh: 1, expectedHash: 'materials-version', approve: approveProps };
  const render = () => h.render('RecolorPreviewView', props);
  const button = () => elements(render()).find(element => element.type === 'button' && text(element).includes('批准当前版本'));
  h.render('RecolorPreviewView', props); await h.runEffects();
  assert.equal(h.calls.length, 1, 'one batch read, not one call per picture');
  assert.equal(h.calls[0]!.method, 'project.recolor.preview.images');
  assert.deepEqual([...h.calls[0]!.params.ids], ['A_kimono', 'B_kimono', 'C_kimono']);
  // Three grid cells plus the two-picture before/after pair (原值 A → 选定 B) for the one outfit.
  const rendered = elements(render()).filter(element => element.type === 'img');
  assert.equal(rendered.length, 5);
  const openers = elements(render()).filter(element => element.type === 'button' && element.props['data-evidence-image'] === 'true');
  assert.equal(openers.length, rendered.length, 'every candidate is a control that opens the bound original');
  assert.equal(elements(render()).filter(element => element.type === 'a' && element.props['data-evidence-image'] === 'true').length, 0,
    'no candidate is a link: a new window to a data: URL never opens in the desktop host, so it would be a dead button (D-42)');
  assert.deepEqual(openers.map(opener => opener.props.children?.props?.src).sort(),
    ['A_kimono', 'B_kimono', 'C_kimono', 'A_kimono', 'B_kimono'].map(id => `data:image/png;base64,fixture:${id}`).sort(),
    'each control carries the picture its own cell bound');
  assert.match(text(render()), /方案选定档：B 档（粉白）/);
  assert.match(text(render()), /前后对比用A 档（方案原值）与B 档（粉白）并排（同一机位）/);
  assert.match(text(render()), /生成于 时间\(2026-10-05T06:20:00.000Z\)/, 'the set carries its source time');
  assert.match(text(render()), /原值（A）/);
  assert.match(text(render()), /选定（B）/);
  assert.doesNotMatch(text(render()), /完整候选与前后对比见右侧/, 'the full grid does not point at itself');
  assert.equal(button(), undefined, 'a decision whose pictures have not displayed yet offers no approval');
  assert.match(text(render()), /全部显示出来后才可以批准/);
  rendered.filter(image => typeof image.props.onLoad === 'function')[0]!.props.onLoad();
  assert.equal(button(), undefined, 'a single picture is not the whole set');
  for (const image of rendered.filter(image => typeof image.props.onLoad === 'function')) image.props.onLoad();
  const approve = button()!;
  assert.equal(approve.props.disabled, false);
  approve.props.onClick(); await settle();
  const decide = h.calls.find(call => call.method === 'gate.decide')!;
  assert.deepEqual(JSON.parse(JSON.stringify(decide.params)), { gate: 'workflow:recolor_approval', approve: true, note: '经 GUI 批准当前版本', expectedHash: 'materials-version', expectedPreviewSha256: 'set-digest' });
  assert.equal(approvals, 1);
});

test('clicking a candidate shows that same bound picture at its own size in the app, and closing it takes the layer away', async () => {
  const h = harness({ recolor: recolour });
  const props = { projectId: 'project', workflowId: 'workflow', refresh: 1, expectedHash: 'materials-version', approve: approveProps };
  h.render('RecolorPreviewView', props); await h.runEffects();
  const openers = () => elements(h.render('RecolorPreviewView', props))
    .filter(element => element.type === 'button' && element.props['data-evidence-image'] === 'true');
  const layers = () => elements(h.render('RecolorPreviewView', props)).filter(element => element.props?.className === 'native-view');
  const native = () => elements(layers()[0]).filter(element => element.type === 'img' && element.props['data-native-size'] === 'true');
  assert.equal(openers().length, 5);
  assert.equal(layers().length, 0, 'no layer is drawn before anything is clicked');

  // The third grid cell: the control under the pointer, not whichever candidate happens to come first.
  const clicked = openers()[2]!;
  clicked.props.onClick?.();
  assert.equal(layers().length, 1, 'clicking a candidate opens exactly one layer');
  assert.deepEqual(h.portals, ['document-body'],
    'the layer is drawn on the body, not inside a column that a narrow window can hide');
  const shown = native();
  assert.equal(shown.length, 1, 'the layer draws one picture');
  assert.equal(shown[0]!.props.src, clicked.props.children?.props?.src,
    'the layer shows the bytes the thumbnail bound, so what is compared is the evidence itself');
  assert.equal(shown[0]!.props.src, 'data:image/png;base64,fixture:C_kimono', 'and it is the candidate that was clicked');
  assert.equal(shown[0]!.props.width, 928, 'the layer keeps the size the record bound');
  assert.equal(shown[0]!.props.height, 1500);
  assert.equal(shown[0]!.props.style, undefined, 'the layer sets no inline size, so the picture keeps its own pixels');

  // Closing by the layer's own control.
  const close = elements(layers()[0]).find(element => element.type === 'button');
  assert.ok(close, 'the layer carries its own close control');
  assert.equal(text(close), '关闭');
  close!.props.onClick();
  assert.equal(layers().length, 0, 'closing removes the layer');

  // Closing from the keyboard alone. The layer registers on the window when it mounts.
  openers()[0]!.props.onClick?.();
  assert.equal(layers().length, 1);
  await h.runEffects();
  assert.equal(openers().length, 5, 'the candidates are still on screen behind the layer');
  h.press('Escape');
  assert.equal(layers().length, 0, 'Escape closes the layer');
});

test('an open original is withdrawn with the evidence it shows, instead of staying up as a stale picture', async () => {
  // The evidence is mutable here because these are the ways a set stops being current (F37): another project or Workflow,
  // a version that moved on, and a re-read that fails its hash check. The layer must go with the evidence every time.
  const source: { recolor: any; fault?: string } = { recolor: recolour };
  const h = harness(source);
  const props = { projectId: 'project', workflowId: 'workflow', refresh: 1, expectedHash: 'materials-version', approve: approveProps };
  const render = (overrides: Record<string, unknown> = {}) => h.render('RecolorPreviewView', { ...props, ...overrides });
  const openers = (overrides: Record<string, unknown> = {}) => elements(render(overrides))
    .filter(element => element.type === 'button' && element.props['data-evidence-image'] === 'true');
  const layers = (overrides: Record<string, unknown> = {}) => elements(render(overrides)).filter(element => element.props?.className === 'native-view');
  const shownOriginal = (overrides: Record<string, unknown> = {}) =>
    elements(layers(overrides)[0]).filter(element => element.type === 'img' && element.props['data-native-size'] === 'true');
  // The control that carries one picture's verified bytes, found by those bytes: this holds whatever order the grid or
  // strip happens to place its cells in, so the same assertions cover a differently shaped set (D-110).
  const openerFor = (id: string) => openers().find(element => element.props.children?.props?.src === `data:image/png;base64,fixture:${id}`)!;

  render(); await h.runEffects();
  openerFor('B_kimono').props.onClick?.();
  assert.equal(layers().length, 1, 'the layer opens on the current evidence');
  assert.equal(shownOriginal()[0]!.props.src, 'data:image/png;base64,fixture:B_kimono');

  // The evidence belongs to a project, a Workflow and one artifact version: another one is looking at different evidence,
  // so the layer goes with the set it was opened under, and comes back only for the set that is still current.
  assert.equal(layers({ projectId: 'other-project' }).length, 0, 'another project cannot keep this layer up');
  assert.equal(layers({ workflowId: 'other-workflow' }).length, 0, 'another Workflow cannot keep this layer up');
  assert.equal(layers().length, 1, 'the project and Workflow the layer was opened under still show it');
  await h.runEffects();

  // The artifact version moves on, to a set of a different shape — two outfits, six pictures, other ids, labels and cell
  // order (D-110: the counter-example is not the one fixture that happened to be at hand). This is asserted before the
  // new set is read back, so the old data URL is still in memory: leaving it on screen is the defect, and the layer must
  // not wait for a re-read to notice.
  source.recolor = { ...twoOutfits, artifactHash: 'materials-version-2', previewSha256: 'set-digest-2' };
  assert.equal(layers().length, 0, 'a version that moved on takes the open layer with it, without waiting for a re-read');

  // Re-open on the now-current set, then make its re-read fail its hash check: the thumbnails and the layer go together.
  await h.runEffects();
  openerFor('B_haori').props.onClick?.();
  assert.equal(layers().length, 1, 'the layer opens on the new current evidence');
  assert.equal(shownOriginal()[0]!.props.src, 'data:image/png;base64,fixture:B_haori', 'and on the picture that was opened');
  source.fault = 'sha';
  render({ refresh: 2 });
  assert.equal(layers().length, 1, 'the layer is still up until the re-read it asked for comes back');
  await h.runEffects();
  assert.equal(elements(render()).filter(element => element.type === 'img' && element.props['data-native-size'] !== 'true').length, 0,
    'the mismatched set leaves no thumbnails');
  assert.equal(shownOriginal().length, 0, 'and the layer keeps no picture of it');
  assert.equal(layers().length, 0, 'a re-read that fails its hash check withdraws the layer');
});

test('a decision whose pictures are missing or belong to another version offers no approval', async () => {
  const missing = harness({ recolor: { status: 'missing', reason: '当前配色版本还没有 Unity 渲染的候选图；' } });
  const props = { projectId: 'project', workflowId: 'workflow', refresh: 1, expectedHash: 'materials-version', approve: approveProps };
  const render = (h: ReturnType<typeof harness>) => h.render('RecolorPreviewView', props);
  missing.render('RecolorPreviewView', props); await settle();
  assert.equal(elements(render(missing)).filter(element => element.type === 'img').length, 0);
  assert.equal(approvalButton(render(missing)), undefined);
  assert.match(text(render(missing)), /重新运行配色阶段|还没有 Unity 渲染的候选图/);

  // The set on screen belongs to a version the Gate is not deciding on: nothing to approve, and it says so.
  const stale = harness({ recolor: { ...recolour, artifactHash: 'another-version' } });
  stale.render('RecolorPreviewView', props); await stale.runEffects();
  assert.equal(elements(render(stale)).filter(element => element.type === 'img').length, 5);
  assert.equal(approvalButton(render(stale)), undefined);
  assert.match(text(render(stale)), /绑定的版本不一致/);

  // No separate pre-recolour render exists, so a single tier (all fixed colours) shows no before/after pair.
  const single = harness({ recolor: { ...recolour, chosenTier: 'A',
    tiers: [{ id: 'A', label: '方案原值', chosen: true }], images: recolour.images.slice(0, 1) } });
  single.render('RecolorPreviewView', props); await single.runEffects();
  assert.equal(elements(render(single)).filter(element => element.type === 'img').length, 1, 'a one-tier recipe invents no comparison');
  assert.doesNotMatch(text(render(single)), /前后对比/);
});

test('a picture set that does not read back whole withdraws the display and the approval', async () => {
  const props = { projectId: 'project', workflowId: 'workflow', refresh: 1, expectedHash: 'materials-version', approve: approveProps };
  for (const fault of ['missing', 'sha', 'preview', 'data']) {
    const h = harness({ recolor: recolour, fault });
    h.render('RecolorPreviewView', props); await h.runEffects();
    const body = h.render('RecolorPreviewView', props);
    assert.equal(elements(body).filter(element => element.type === 'img').length, 0, fault + ' must not leave pictures on screen');
    assert.equal(approvalButton(body), undefined, fault + ' must withdraw the approval');
    assert.match(text(body), /清单不完整|版本不一致|无法显示/, fault + ' must say why');
  }
});

test('the decision card carries the condensed evidence and points at the grid, instead of repeating it', async () => {
  const props = { projectId: 'project', workflowId: 'workflow', refresh: 1, expectedHash: 'materials-version', approve: approveProps, compact: true };
  const h = harness({ recolor: twoOutfits });
  approvals = 0;
  const render = () => h.render('RecolorPreviewView', props);
  const button = () => elements(render()).find(element => element.type === 'button' && text(element).includes('批准当前版本'));
  h.render('RecolorPreviewView', props); await h.runEffects();
  // Only the chosen tier's row is read: the whole six-picture grid belongs to the scene preview card beside the decision.
  assert.equal(h.calls.length, 1, 'one batch read, not one call per picture');
  assert.equal(h.calls[0]!.method, 'project.recolor.preview.images');
  assert.deepEqual([...h.calls[0]!.params.ids], ['B_kimono', 'B_haori'], 'the strip asks for the chosen tier on each outfit only');
  const rendered = elements(render()).filter(element => element.type === 'img');
  assert.equal(rendered.length, 2, 'two thumbnails, not the tier × outfit grid');
  const body = render();
  assert.match(text(body), /方案选定档：B 档（粉白）/, 'the strip names the tier the plan chose');
  assert.equal(elements(body).filter(element => text(element) === '方案选定档').length, 2, 'every thumbnail carries the marker');
  assert.match(text(body), /春樱和服/);
  assert.match(text(body), /外披/);
  assert.match(text(body), /生成于 时间\(2026-10-05T06:20:00.000Z\)/, 'the strip carries the source time');
  assert.match(text(body), /完整候选与前后对比见右侧 Unity 场景预览/, 'the decision points at the grid it no longer repeats');
  assert.doesNotMatch(text(body), /前后对比用/, 'the comparison stays in the scene preview card');
  assert.doesNotMatch(text(body), /原值（A）|选定（B）/);
  assert.doesNotMatch(text(body), /过滤与渲染方式/);
  assert.equal(button(), undefined, 'the approval waits for the pictures the decision itself shows');
  rendered.filter(image => typeof image.props.onLoad === 'function')[0]!.props.onLoad();
  assert.equal(button(), undefined, 'one thumbnail is not the whole strip');
  rendered.filter(image => typeof image.props.onLoad === 'function')[1]!.props.onLoad();
  const approve = button()!;
  assert.equal(approve.props.disabled, false);
  approve.props.onClick(); await settle();
  assert.equal(approvals, 1);

  // The binding rule is untouched: a set from another version still withdraws the approval and says why.
  const stale = harness({ recolor: { ...twoOutfits, artifactHash: 'another-version' } });
  stale.render('RecolorPreviewView', props); await stale.runEffects();
  const staleBody = stale.render('RecolorPreviewView', props);
  assert.equal(elements(staleBody).filter(element => element.type === 'img').length, 2);
  assert.equal(approvalButton(staleBody), undefined);
  assert.match(text(staleBody), /绑定的版本不一致/);

  // A strip whose pictures do not read back whole leaves no thumbnails and no approval.
  const broken = harness({ recolor: twoOutfits, fault: 'missing' });
  broken.render('RecolorPreviewView', props); await broken.runEffects();
  const brokenBody = broken.render('RecolorPreviewView', props);
  assert.equal(elements(brokenBody).filter(element => element.type === 'img').length, 0);
  assert.equal(approvalButton(brokenBody), undefined);
  assert.match(text(brokenBody), /清单不完整|版本不一致|无法显示/);
});

test('the project page shows the finished outfit photos with their labels and time, and nothing when they are missing', async () => {
  const ready = harness({ delivery });
  ready.render('DeliveryPhotosView', { projectId: 'project', workflowId: 'workflow', refresh: 1 });
  await ready.runEffects();
  const rendered = ready.render('DeliveryPhotosView', { projectId: 'project', workflowId: 'workflow', refresh: 1 });
  assert.equal(elements(rendered).filter(element => element.type === 'img').length, 2);
  assert.equal(ready.calls[0]!.method, 'project.delivery.photos.images');
  assert.match(text(rendered), /春樱和服/);
  assert.match(text(rendered), /夏日浴衣/);
  assert.match(text(rendered), /Unity 在最终工程里按每套服装/);
  assert.match(text(rendered), /生成于 时间\(2026-10-05T07:00:00.000Z\)/);

  const none = harness({ delivery: { status: 'missing', reason: '制作还没到可上传；回归阶段拍完成品照后会显示在这里。' } });
  none.render('DeliveryPhotosView', { projectId: 'project', workflowId: 'workflow', refresh: 1 }); await settle();
  const body = none.render('DeliveryPhotosView', { projectId: 'project', workflowId: 'workflow', refresh: 1 });
  assert.equal(elements(body).filter(element => element.type === 'img').length, 0);
  assert.match(text(body), /还没到可上传/);
});

test('the scene preview card shows the stage the Workflow is in, with its source, and never invents a picture', async () => {
  const project = { id: 'project', path: '/w/p', name: 'Luna-春樱', kind: 'sample', workflow: { id: 'workflow', profile: 'pc-recolor-outfit', status: 'active', next: '' }, tasks: { total: 0, open: 0, needsYou: 0 } };
  const workflow = { id: 'workflow', project: '/w/p', projectName: 'Luna-春樱', profile: 'pc-recolor-outfit', status: 'active', next: '',
    plan: { approved: true, revisions: 1 }, stages: [{ id: 'recolor', status: 'blocked', display: 'deciding', reasons: [], checks: [] }] };
  const gate = { gate: 'workflow:recolor_approval', workflowId: 'workflow', formal: true, project: '/w/p', projectName: 'Luna-春樱', owner: 'stage:recolor',
    status: 'pending', question: '', binds: 'materials', artifactHash: 'materials-version', preview: 'recolor-candidates' as const };

  // The Gate is open: the card shows the rendered candidates and offers no approval of its own.
  const open = harness({ recolor: recolour, faceMode: null });
  open.render('ScenePreview', { project, workflow, gates: [gate], refresh: 1 }); await open.runEffects();
  const shown = open.render('ScenePreview', { project, workflow, gates: [gate], refresh: 1 });
  assert.match(text(shown), /Unity 场景预览/);
  assert.match(text(shown), /配色阶段/);
  assert.match(text(shown), /来源：Unity 渲染/);
  assert.equal(elements(shown).filter(element => element.type === 'img').length, 5);
  assert.equal(approvalButton(shown), undefined, 'the approval stays in the decision card');
  // D-121: this card never collapses, it sits in a wrapping row that can host a smaller sibling, and the menu preview
  // card is deliberately absent — no placeholder and no "coming soon".
  const card = elements(shown).find(element => element.props?.id === 'preview-cards');
  assert.ok(card, 'the scene preview lives in the two-card container');
  assert.equal(elements(shown).filter(element => element.props?.className === 'preview-card').length, 1,
    'only the scene card exists; the menu preview is not rendered as a placeholder');
  assert.equal(elements(shown).some(element => element.type === 'details' || element.type === 'summary'), false, 'the scene preview does not collapse');
  assert.doesNotMatch(text(shown), /即将推出|菜单预览/);

  // Delivery ready: the finished photos take over the same area.
  const delivered = harness({ delivery, faceMode: null });
  const deliveredProject = { ...project, workflow: { ...project.workflow!, status: 'upload_ready' } };
  delivered.render('ScenePreview', { project: deliveredProject, workflow, gates: [gate], refresh: 1 }); await delivered.runEffects();
  const photos = delivered.render('ScenePreview', { project: deliveredProject, workflow, gates: [gate], refresh: 1 });
  assert.match(text(photos), /交付成品/);
  assert.equal(elements(photos).filter(element => element.type === 'img').length, 2);

  // Nothing rendered for the current stage yet: an explained empty state, not a drawing.
  const empty = harness({ faceMode: null });
  empty.render('ScenePreview', { project, workflow, gates: [], refresh: 1 }); await settle();
  const blank = empty.render('ScenePreview', { project, workflow, gates: [], refresh: 1 });
  assert.equal(elements(blank).filter(element => element.type === 'img').length, 0);
  assert.match(text(blank), /还没有出图/);
  assert.match(text(blank), /阶段\(recolor\)」阶段还没有出图/);
  assert.match(text(blank), /不是实时 3D 预览/);

  // The face stage: the existing face component is what fills the area.
  const face = harness({ faceMode: 'output' });
  face.render('ScenePreview', { project, workflow, gates: [], refresh: 1 }); await settle();
  const faceBody = face.render('ScenePreview', { project, workflow, gates: [], refresh: 1 });
  assert.match(text(faceBody), /脸型阶段/);
  assert.equal(elements(faceBody).filter(element => element.type === 'face-preview-view').length, 1);
});

test('non-scene tabs expose one verified thumbnail strip that returns to the full scene card', async () => {
  const h = harness({ recolor: recolour });
  let opened = 0;
  const props = { project: { id: 'project', workflow: { id: 'workflow', status: 'active' } },
    workflow: { id: 'workflow', stages: [] }, gates: [{ gate: 'workflow:recolor_approval', workflowId: 'workflow', project: 'project', projectName: 'project',
      status: 'pending', question: '确认', binds: 'materials', preview: 'recolor-candidates', artifactHash: 'materials-version' }],
    refresh: 1, onOpen: () => { opened += 1; } };
  h.render('PreviewStrip', props); await h.runEffects();
  const body = h.render('PreviewStrip', props);
  const opener = elements(body).find(element => element.props?.className === 'preview-strip-button');
  assert.ok(opener, 'the non-scene tab has one return control');
  assert.equal(elements(body).filter(element => element.props?.className === 'preview-strip').length, 1);
  assert.equal(elements(body).filter(element => element.type === 'img').length, 1);
  assert.match(text(body), /来源：Unity 渲染/);
  opener!.props.onClick();
  assert.equal(opened, 1, 'clicking the strip returns to the scene tab');
});

