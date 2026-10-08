/**
 * Subscription-driven CLIs are not an execution route (decisions D-34 and D-8).
 *
 * Driving a personal Codex or Claude Code subscription from a third-party product risks that provider's
 * terms of service; its quota is a black box that cannot be budgeted or accounted the way per-use API
 * billing can; and each subscription is a second execution path to maintain. They may still serve the
 * non-executing roles. API providers are unaffected: pi reaches DeepSeek, OpenAI, Anthropic and Google
 * with the person's own key, billed per use.
 *
 * Defined once, here, so every place that writes a provider list agrees. The config loader itself does
 * not strip the role, because a provider entry naming these adapters is also the shape tests use for a
 * generic local CLI executor; the rule belongs where a person's machine is configured.
 */
export const SUBSCRIPTION_ADAPTERS = ['codex-cli', 'claude-cli'] as const;

export function isSubscriptionAdapter(adapter: unknown): boolean {
  return SUBSCRIPTION_ADAPTERS.includes(String(adapter) as typeof SUBSCRIPTION_ADAPTERS[number]);
}

/** The roles a subscription CLI may hold: never `executor`, and never an empty list. */
export function withoutExecutor(roles: readonly string[]): string[] {
  const kept = roles.filter(role => role !== 'executor');
  return kept.length ? kept : ['research'];
}
