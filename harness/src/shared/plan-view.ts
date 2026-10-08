/**
 * The plan as a person reads it: the lines an approval actually covers, and the file locations kept behind "details".
 * Both interfaces derive them here, so the same plan is described the same way in the desktop GUI (gui/src) and in the
 * terminal (src/tui) — a plan summarised by the GUI and pasted raw by the TUI would be two different promises for one
 * approval.
 *
 * No imports and no platform APIs on purpose: the Runtime and the TUI load this file directly, and the GUI bundles it.
 *
 * A recolor target is one of three forms and never a mixture (builtin/tools/harness/plan.py, 决定记录 D-73/D-75/D-81):
 * a relative shift of a whole part, a layer inside the vendor's own layered file, or a material that replaces the
 * matching slots of one outfit. Reading only `part` left the layer and material forms rendering as nothing, so a person
 * was asked to approve colours, regions and replacements that were never shown
 * (docs/zh/工作区/证据/界面包装设计评审结论.md).
 */

const PARTS: Record<string, string> = { hair: '头发', eye: '眼睛', eyes: '眼睛', skin: '皮肤', body: '身体' };
type OutfitLike = { id?: unknown; label?: unknown; item?: unknown };
type ParameterLike = { saved?: boolean; synced?: boolean; type?: string };
type GroupLike = { id?: string; label?: string; activation?: string; kind?: string; bindings?: Array<{id?: string; instance?: string; renderer?: string; slot?: number; source_material?: string}>; default?: string; parameter?: ParameterLike;
  members?: Array<OutfitLike & { instance?: string; default?: boolean; parameter?: ParameterLike }> };
type TargetLike = { part?: unknown; requirement_id?: unknown; layered?: unknown; layer?: unknown; color?: unknown;
  semantics?: unknown; outfit?: unknown; material?: unknown; hue_shift?: unknown; saturation?: unknown; value?: unknown };

const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '');
const filename = (value: unknown): string => text(value).split(/[\\/]/).filter(Boolean).at(-1) ?? '';
/** A layer path's last name, shown as the author wrote it (spaces included, so a copy back resolves). */
const layerName = (layer: unknown): string =>
  (Array.isArray(layer) ? layer : []).map(value => (typeof value === 'string' ? value : '')).filter(Boolean).at(-1) ?? '';

/** What a layer target promises: the two claims are different and neither may be read as the other. */
const promised = (semantics: string): string => semantics === 'flat'
  ? '该区域整体换成这个颜色' : semantics === 'shade' ? '换成这个颜色的同时保住作者的明暗' : '';

/**
 * What an approval of the plan covers, from plan.yaml (schema plan/0.2): the lines a person decides on. Locations and
 * path-bearing notes are left to `planDetails`.
 */
export function planSummary(plan: unknown): Array<[string, string]> {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return [];
  const p = plan as { body?: unknown; outfits?: unknown; default_outfit?: unknown;
    avatar_config?: { groups?: GroupLike[]; instances?: OutfitLike[]; shared_switches?: Array<{ label?: string; default?: boolean; parameter?: ParameterLike }> };
    recolor?: { targets?: unknown; candidates?: unknown };
    menu?: { selector?: { label?: unknown } }; face?: { mode?: unknown; intent?: unknown }; notes?: unknown };
  const rows: Array<[string, string]> = [];
  if (text(p.body)) rows.push(['素体', filename(p.body)]);
  const outfits = (Array.isArray(p.outfits) ? p.outfits : p.avatar_config?.groups?.flatMap(g => g.members ?? []) ?? []) as OutfitLike[];
  const outfitName = (outfit: OutfitLike) => text(outfit.label) || filename(outfit.item) || text(outfit.id);
  const persistence = (parameter?: ParameterLike) => parameter ? `${parameter.saved ? '保存选择' : '加载时恢复默认'}、${parameter.synced ? '同步给其他玩家' : '仅本地'}` : '';
  if (Array.isArray(p.avatar_config?.groups)) for (const group of p.avatar_config.groups) {
    const members = group.members ?? [];
    const fallback = members.find(m => text(m.id) === group.default);
    const detail = group.activation === 'fixed' ? '全部共同穿戴' : group.activation === 'exclusive'
      ? `${group.parameter?.type === 'Int' ? '离散选项' : '连续轮盘'}，默认「${fallback ? outfitName(fallback) : ''}」，${persistence(group.parameter)}`
      : members.map(m => `${outfitName(m)}默认${m.default ? '开启' : '关闭'}（${persistence(m.parameter)}）`).join('；');
    const scope = group.kind === 'material' ? `独立材质选择，作用于 ${new Set(group.bindings?.map(b => b.instance)).size} 个造型，切换造型保留颜色；` : '';
    rows.push([group.label || '造型组', scope +  `${group.activation === 'independent' ? '独立开关' : members.map(outfitName).join('、')}（${detail}）`]);
  }
  else if (outfits.length) {
    const fallback = outfits.find(outfit => text(outfit.id) === text(p.default_outfit));
    rows.push(['服装', `${outfits.map(outfitName).filter(Boolean).join('、')}${fallback ? `（默认穿「${outfitName(fallback)}」）` : ''}`]);
  }
  for (const s of p.avatar_config?.shared_switches ?? []) rows.push([s.label || '共享部件', `跨造型记忆，默认${s.default ? '开启' : '关闭'}，${persistence(s.parameter)}`]);
  const targets = (Array.isArray(p.recolor?.targets) ? p.recolor.targets : []) as TargetLike[];
  if (targets.length) {
    const part = (value: string) => value.startsWith('outfit:')
      ? `服装「${outfitName(outfits.find(outfit => text(outfit.id) === value.slice(7)) ?? { id: value.slice(7) })}」` : PARTS[value] ?? value;
    /**
     * The shift a relative target asks for. Naming only the part hid the numbers the stage will actually apply, so a
     * person approved "hair" without seeing "hue -18". A field at its no-change value is left out rather than printed
     * as a no-op.
     */
    const shift = (target: TargetLike): string => {
      const number = (value: unknown): number | undefined => {
        const parsed = typeof value === 'number' ? value : Number.NaN;
        return Number.isFinite(parsed) ? parsed : undefined;
      };
      const hue = number(target.hue_shift), saturation = number(target.saturation), value = number(target.value);
      const parts = [
        hue ? `色相 ${hue > 0 ? '+' : ''}${hue}°` : '',
        saturation !== undefined && saturation !== 1 ? `饱和度 ×${saturation}` : '',
        value !== undefined && value !== 1 ? `明度 ×${value}` : '',
      ].filter(Boolean);
      return parts.length ? `（${parts.join('、')}）` : '';
    };
    /** A material target names one outfit; its id is what ties the replacement back to the order's requirement. */
    const outfitOf = (value: unknown): string => {
      const id = text(value);
      return outfitName(outfits.find(outfit => text(outfit.id) === id) ?? { id }) || id;
    };
    const described = targets.map(target => {
      const fromPart = text(target.part) ? `${part(text(target.part))}${shift(target)}` : '';
      if (fromPart) return fromPart;
      const requirement = text(target.requirement_id);
      // Not through `text` for the layer name: trimming would show "eyelash" for a layer actually called
      // "eyelash ", which is a different region and cannot be copied back (决定记录 D-73、D-82).
      const region = layerName(target.layer);
      if (region || text(target.color)) {
        // The region is the author's own layer name, so it is shown as theirs rather than renamed.
        return [region ? `作者分层「${region}」` : requirement, text(target.color).toUpperCase(), promised(text(target.semantics))]
          .filter(Boolean).join(' → ');
      }
      if (text(target.material)) {
        return [requirement ? `要求 ${requirement}` : '',
          `服装「${outfitOf(target.outfit)}」的对应槽位换成「${filename(target.material)}」`].filter(Boolean).join('：');
      }
      return '';
    }).filter(Boolean);
    const count = Number(p.recolor?.candidates);
    rows.push(['改色', `${described.join('；')}${count > 0 ? `，给出 ${count} 档候选` : ''}`]);
  }
  if (text(p.menu?.selector?.label)) rows.push(['菜单', `一个轮盘「${text(p.menu!.selector!.label)}」切换服装`]);
  if (p.face?.mode === 'design') rows.push(['脸型目标', `${text(p.face.intent) || '探索脸型候选'}（制作后再看实际候选；此处不代表接受效果）`]);
  if (p.face?.mode === 'preserve') rows.push(['脸型', '保留原有脸型与表情系统；仍需制作检查']);
  if (text(p.notes) && !planTextContainsPath(text(p.notes))) rows.push(['说明', text(p.notes)]);
  return rows;
}

const planTextContainsPath = (value: string) => /[A-Za-z]:[\\/]|\\\\|(?:^|[\s「（(])(?:Assets|Packages|_harness)[\\/]/.test(value);
/** File locations and path-bearing notes remain available only when the person asks for details. */
export function planDetails(plan: unknown): Array<[string, string]> {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return [];
  const p = plan as { body?: unknown; outfits?: unknown; avatar_config?: { groups?: GroupLike[]; material_presets?: Array<{id?: string; material?: string; adjustment?: unknown}>; instances?: Array<OutfitLike & { prefab?: string; variants?: Array<{ id?: string; prefab?: string }> }> }; recolor?: { targets?: unknown }; notes?: unknown };
  const rows: Array<[string, string]> = [];
  if (typeof p.body === 'string' && /[\\/]/.test(p.body)) rows.push(['素体文件', p.body]);
  if (Array.isArray(p.outfits)) for (const item of p.outfits) {
    if (item && typeof item === 'object' && typeof (item as { item?: unknown }).item === 'string' &&
      /[\\/]/.test((item as { item: string }).item))
      rows.push([`${typeof (item as { label?: unknown }).label === 'string' ? (item as { label: string }).label : '服装'}文件`,
        (item as { item: string }).item]);
  }
  for (const instance of p.avatar_config?.instances ?? []) {
    if (text(instance.item)) rows.push([`素材文件（${text(instance.id)}）`, text(instance.item)]);
    if (instance.prefab) rows.push([`装配来源（${text(instance.id)}）`, instance.prefab]);
    for (const variant of instance.variants ?? []) if (variant.prefab) rows.push([`档位来源（${text(instance.id)}/${variant.id ?? ''}）`, variant.prefab]);
  }
  for (const group of p.avatar_config?.groups ?? []) for (const binding of group.bindings ?? [])
    rows.push([`材质槽（${group.label ?? group.id}/${binding.instance}）`, `${binding.renderer ?? ''} [${binding.slot}] ← ${binding.source_material ?? ''}`]);
  for (const preset of p.avatar_config?.material_presets ?? []) if (preset.material)
    rows.push([`颜色预设（${preset.id}）`, `${preset.material}${preset.adjustment ? `；相对调整 ${JSON.stringify(preset.adjustment)}` : ''}`]);
  // A layer target reads the region from a source file the vendor shipped; a material target names the asset that
  // replaces the slots. Both are locations, so they belong where locations live rather than in the summary.
  for (const target of (Array.isArray(p.recolor?.targets) ? p.recolor.targets : []) as TargetLike[]) {
    const requirement = text(target.requirement_id);
    if (text(target.layered)) rows.push([`分层源文件${requirement ? `（${requirement}）` : ''}`, text(target.layered)]);
    if (text(target.material)) rows.push([`材质资产${requirement ? `（${requirement}）` : ''}`, text(target.material)]);
  }
  if (typeof p.notes === 'string' && planTextContainsPath(p.notes)) rows.push(['完整说明', p.notes]);
  return rows;
}
