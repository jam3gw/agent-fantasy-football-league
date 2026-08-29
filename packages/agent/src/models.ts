/**
 * Model registry (SPEC §8.1).
 *
 * Hard rule from §8.1: no model-side limits anywhere. No `maxOutputTokens`,
 * no reasoning/thinking budget or effort flag, no temperature. Provider
 * defaults for every model. The only guards are the loop guards (§8.3).
 * Prompt caching is on wherever the provider supports it — caching changes
 * cost, never behavior.
 *
 * Calls route through the AI Gateway; who pays depends on the provider — see `BilledTo` below.
 */


export interface LeagueModel {
  /** Team slot 1–12 (the reporter has no slot). */
  slot: number | null;
  /** AI Gateway model id, verified against the live catalog (docs/VERIFIED.md). */
  modelId: string;
  /** Human label shown on the site and given to the agent as its identity. */
  label: string;
  /** Gateway provider prefix. */
  provider: string;
}

/**
 * The twelve league models. IDs verified against the gateway catalog on
 * 2026-08-28: the spec's `google/gemini-3.1-pro` and `xai/grok-4.6` do not
 * exist; the live ids are `google/gemini-3.1-pro-preview` and
 * `spacexai/grok-4.6` (xAI is published under the `spacexai/` prefix).
 */
export const LEAGUE_MODELS: LeagueModel[] = [
  { slot: 1, modelId: "anthropic/claude-fable-5", label: "Claude Fable 5", provider: "anthropic" },
  { slot: 2, modelId: "anthropic/claude-opus-5", label: "Claude Opus 5", provider: "anthropic" },
  { slot: 3, modelId: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic" },
  { slot: 4, modelId: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "openai" },
  { slot: 5, modelId: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "openai" },
  { slot: 6, modelId: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", provider: "google" },
  { slot: 7, modelId: "spacexai/grok-4.6", label: "Grok 4.6", provider: "spacexai" },
  { slot: 8, modelId: "deepseek/deepseek-v4-pro", label: "DeepSeek V4-Pro", provider: "deepseek" },
  { slot: 9, modelId: "moonshotai/kimi-k3", label: "Kimi K3", provider: "moonshotai" },
  { slot: 10, modelId: "alibaba/qwen3.8-max", label: "Qwen 3.8-Max", provider: "alibaba" },
  { slot: 11, modelId: "meta/muse-spark-1.2", label: "Muse Spark 1.2", provider: "meta" },
  { slot: 12, modelId: "zai/glm-5.3", label: "GLM-5.3", provider: "zai" },
];

export const REPORTER_MODEL: LeagueModel = {
  slot: null,
  modelId: "anthropic/claude-sonnet-5",
  label: "Claude Sonnet 5",
  provider: "anthropic",
};

/** Catalog list prices ($ per 1M tokens) captured 2026-08-28 — seeds `model_prices`. */
export const MODEL_PRICE_SEED: Record<
  string,
  { input: number; output: number; cachedInput?: number; contextWindow: number }
> = {
  "anthropic/claude-fable-5": { input: 10, output: 50, cachedInput: 1, contextWindow: 1_000_000 },
  "anthropic/claude-opus-5": { input: 5, output: 25, cachedInput: 0.5, contextWindow: 1_000_000 },
  "anthropic/claude-sonnet-5": { input: 2, output: 10, cachedInput: 0.2, contextWindow: 1_000_000 },
  "openai/gpt-5.6-sol": { input: 2, output: 10, cachedInput: 0.2, contextWindow: 1_050_000 },
  "openai/gpt-5.6-terra": { input: 2, output: 12, cachedInput: 0.2, contextWindow: 1_050_000 },
  "google/gemini-3.1-pro-preview": { input: 2, output: 12, cachedInput: 0.2, contextWindow: 1_000_000 },
  "spacexai/grok-4.6": { input: 2, output: 6, cachedInput: 0.5, contextWindow: 500_000 },
  "deepseek/deepseek-v4-pro": { input: 0.66, output: 1.98, cachedInput: 0.022, contextWindow: 1_000_000 },
  "moonshotai/kimi-k3": { input: 3, output: 15, cachedInput: 0.3, contextWindow: 1_000_000 },
  "alibaba/qwen3.8-max": { input: 2, output: 6, cachedInput: 0.25, contextWindow: 1_000_000 },
  "meta/muse-spark-1.2": { input: 1.25, output: 4.25, cachedInput: 0.15, contextWindow: 1_048_576 },
  "zai/glm-5.3": { input: 1.4, output: 4.4, cachedInput: 0.14, contextWindow: 1_000_000 },
};

/**
 * Every model call bills the AI Gateway — the commissioner's decision on
 * 2026-08-28, superseding §8.9's BYOK routing. One billing path means one
 * price list, one balance to watch on /spend, and no provider account whose
 * credential can quietly expire mid-season and reroute a model.
 *
 * Revisited 2026-08-29: the commissioner loaded his own Anthropic, OpenAI and
 * xAI keys into the gateway (gateway-held BYOK). Requests still carry no
 * credential and no routing hint — the gateway routes them itself — but it
 * reports $0 for a BYOK call, so the ledger prices those steps from the price
 * table and `billed_to` names who actually paid.
 */
export type BilledTo = "gateway" | "byok:openai" | "byok:xai" | "byok:vertex" | "byok:anthropic";

/** Gateway-held BYOK keys by provider prefix (commissioner, 2026-08-29). */
const BYOK_BY_PREFIX: Record<string, BilledTo> = {
  anthropic: "byok:anthropic",
  openai: "byok:openai",
  // xAI publishes under the spacexai/ prefix (docs/VERIFIED.md).
  spacexai: "byok:xai",
};

export function billedToFor(modelId: string): BilledTo {
  return BYOK_BY_PREFIX[modelId.split("/")[0] ?? ""] ?? "gateway";
}

/**
 * Anthropic prompt caching (§8.1): cache_control breakpoints on the system
 * prompt and the context snapshot. Other providers (OpenAI, Gemini, DeepSeek)
 * cache prefixes automatically and need nothing here.
 */
export function supportsExplicitCaching(modelId: string): boolean {
  return modelId.startsWith("anthropic/");
}
