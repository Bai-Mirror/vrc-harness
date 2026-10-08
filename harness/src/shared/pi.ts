/**
 * The services Harness reaches through pi (the pi coding agent CLI) with the person's own API key, and how the first-run
 * wizard and settings turn a person's choices into configuration entries. The Runtime (providers/pi.ts, config.ts), the
 * TUI and the GUI all read this file, so it has no imports and no platform APIs: the GUI bundles it.
 */
/** DeepSeek, Zhipu GLM international (z.ai) or GLM mainland (open.bigmodel.cn). */
export type PiUpstream = 'deepseek' | 'zai' | 'zhipu';
export interface PiUpstreamInfo {
  /** pi's own provider name. */
  provider: 'deepseek' | 'zai';
  /** The variable pi reads the key from. */
  keyVariable: 'DEEPSEEK_API_KEY' | 'ZAI_API_KEY';
  /** The credential (providers/secrets.ts) used unless the configuration names another. */
  secret: string;
  /** The model used unless the configuration names another. */
  model: string;
  /** The API address used unless the configuration names another; absent keeps pi's built-in address. */
  baseUrl?: string;
}
/**
 * pi's `zai` provider is Z.AI's GLM Coding Plan endpoint (api.z.ai/api/coding/paas/v4). The mainland service is the same
 * API under open.bigmodel.cn, reached by giving `zai` that address in the Run's models.json; pi 0.74 and later also call
 * it `zai-coding-cn`, which earlier versions lack. Harness explicitly selects the Flash models for both text and
 * visual work instead of inheriting the CLI's text-only defaults.
 */
export const PI_UPSTREAMS: Record<PiUpstream, PiUpstreamInfo> = {
  deepseek: { provider: 'deepseek', keyVariable: 'DEEPSEEK_API_KEY', secret: 'pi-deepseek', model: 'deepseek-flash' },
  zai: { provider: 'zai', keyVariable: 'ZAI_API_KEY', secret: 'pi-zai', model: 'glm-5.3-flash' },
  zhipu: { provider: 'zai', keyVariable: 'ZAI_API_KEY', secret: 'pi-zhipu', model: 'glm-5.3-flash',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
};
/**
 * The models a person can choose for each service, default first: pi 0.87.1's model catalog for its `deepseek` provider, for
 * `zai` (GLM international) and for `zai-coding-cn` (GLM mainland, which Harness reaches as `zai` at the mainland address).
 * Settings offers only these, plus a model the configuration file already names, so a choice is never typed.
 */
export const PI_MODELS: Record<PiUpstream, readonly string[]> = {
  deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
  zai: ['glm-5.3-flash', 'glm-5.3', 'glm-5.3-highspeed', 'glm-5.2', 'glm-5.2-highspeed', 'glm-5-turbo', 'glm-4.7'],
  zhipu: ['glm-5.3-flash', 'glm-5.3', 'glm-5.3-highspeed', 'glm-4.6v'],
};
/** Where GLM keys without a GLM Coding Plan are billed per token: the same host as the region's Coding Plan, under /api/paas/v4. */
export const PI_PAY_AS_YOU_GO: Record<'zai' | 'zhipu', string> = {
  zai: 'https://api.z.ai/api/paas/v4', zhipu: 'https://open.bigmodel.cn/api/paas/v4' };
export function isPiUpstream(value: unknown): value is PiUpstream {
  return typeof value === 'string' && Object.hasOwn(PI_UPSTREAMS, value);
}

/** What the person picks: a service, and optionally a model or address other than its default. */
export interface PiChoice { upstream: PiUpstream; model?: string; baseUrl?: string }
/** The wizard and settings keep one pi Provider per service family: DeepSeek, and GLM in one of its two regions. */
export const PI_FAMILIES: Record<PiUpstream, 'deepseek' | 'glm'> = { deepseek: 'deepseek', zai: 'glm', zhipu: 'glm' };
/** A pi Provider serves the same roles as a first-run Codex: every formal Workflow stage, diagnosis and research. */
export const PI_DEFAULT_ROLES = ['executor', 'diagnostician', 'research'];
/** The configuration entry for a choice. Defaults (model, credential name, address) stay implicit, so they follow Harness. */
export function piProviderEntry(choice: PiChoice, id: string = PI_FAMILIES[choice.upstream]): Record<string, unknown> {
  return { id, type: 'pi-cli', executable: 'pi', upstream: choice.upstream, roles: [...PI_DEFAULT_ROLES], writable: [],
    ...(choice.model?.trim() ? { model: choice.model.trim() } : {}), ...(choice.baseUrl?.trim() ? { baseUrl: choice.baseUrl.trim() } : {}) };
}
/** Choices sent by a caller: known services, at most one per family, text fields only. */
export function piChoices(value: unknown): PiChoice[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('pi 执行方的选择应为列表');
  const choices = value.map((item): PiChoice => {
    const raw = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
    if (!isPiUpstream(raw.upstream)) throw new Error('pi 执行方只能是 DeepSeek、智谱 GLM 国内或国际');
    for (const field of ['model', 'baseUrl'] as const)
      if (raw[field] !== undefined && typeof raw[field] !== 'string') throw new Error(`pi 执行方的 ${field} 应为文字`);
    return { upstream: raw.upstream, ...(typeof raw.model === 'string' && raw.model.trim() ? { model: raw.model.trim() } : {}),
      ...(typeof raw.baseUrl === 'string' && raw.baseUrl.trim() ? { baseUrl: raw.baseUrl.trim() } : {}) };
  });
  const families = choices.map(choice => PI_FAMILIES[choice.upstream]);
  if (new Set(families).size !== families.length) throw new Error('DeepSeek 与智谱 GLM 各只能选一个');
  return choices;
}
/**
 * The configuration's provider list with its pi entries replaced by `choices`: an entry of a chosen family keeps its
 * place and its other settings (roles, limits, tools); a family not chosen loses its entries; a new one is appended.
 */
export function withPiChoices(entries: Record<string, unknown>[], choices: PiChoice[]): Record<string, unknown>[] {
  const typeOf = (entry: Record<string, unknown>): unknown => entry.type ?? entry.adapter;
  const familyOf = (entry: Record<string, unknown>) => isPiUpstream(entry.upstream) ? PI_FAMILIES[entry.upstream] : undefined;
  const placed = new Set<string>();
  const next = entries.flatMap(entry => {
    if (typeOf(entry) !== 'pi-cli') return [entry];
    const family = familyOf(entry), choice = choices.find(item => PI_FAMILIES[item.upstream] === family);
    if (!family || !choice || placed.has(family)) return [];
    placed.add(family);
    const kept: Record<string, unknown> = { ...entry, upstream: choice.upstream };
    delete kept.model; delete kept.baseUrl;
    // A credential named for the other GLM region's default follows the region; one the person named stays.
    if (entry.upstream !== choice.upstream && isPiUpstream(entry.upstream) && entry.secret === PI_UPSTREAMS[entry.upstream].secret) delete kept.secret;
    return [{ ...kept, ...(choice.model ? { model: choice.model } : {}), ...(choice.baseUrl ? { baseUrl: choice.baseUrl } : {}) }];
  });
  const ids = new Set(next.map(entry => String(entry.id)));
  for (const choice of choices) {
    if (placed.has(PI_FAMILIES[choice.upstream])) continue;
    let id: string = PI_FAMILIES[choice.upstream];
    for (let n = 2; ids.has(id); n++) id = `${PI_FAMILIES[choice.upstream]}-${n}`;
    ids.add(id);
    next.push(piProviderEntry(choice, id));
  }
  return next;
}
