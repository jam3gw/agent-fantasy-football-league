/**
 * Model registry and BYOK routing (SPEC §8.1, §8.9).
 *
 * Hard rule from §8.1: no model-side limits anywhere. No `maxOutputTokens`,
 * no reasoning/thinking budget or effort flag, no temperature. Provider
 * defaults for every model. The only guards are the loop guards (§8.3).
 * Prompt caching is on wherever the provider supports it — caching changes
 * cost, never behavior.
 */

export type ByokProvider = "openai" | "xai" | "vertex" | "anthropic";

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
 * BYOK routes (§8.9): gateway model id → provider credential name. A routed
 * request bills the provider account; `only` pins the provider so the request
 * cannot silently reroute at a different price.
 *
 * `anthropic/claude-sonnet-5` → `vertex` is deliberately NOT routed by
 * default: §8.9 makes it conditional on the build confirming that the Google
 * Cloud trial credit covers Anthropic models on Vertex. Left on the gateway
 * until that is verified in the provider console.
 */
export const DEFAULT_BYOK_ROUTES: Record<string, ByokProvider> = {
  "spacexai/grok-4.6": "xai",
  "openai/gpt-5.6-sol": "openai",
  "openai/gpt-5.6-terra": "openai",
  "google/gemini-3.1-pro-preview": "vertex",
};

/** Provider slug the gateway routes to for a BYOK credential name. */
const BYOK_PROVIDER_SLUG: Record<ByokProvider, string> = {
  openai: "openai",
  xai: "xai",
  vertex: "vertex",
  anthropic: "anthropic",
};

export interface ByokCredentials {
  openai?: string;
  xai?: string;
  anthropic?: string;
  vertex?: {
    project: string;
    location: string;
    clientEmail: string;
    privateKey: string;
  };
}

/** Read BYOK credentials from the environment (§14). Never logged, never returned to a model. */
export function byokCredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): ByokCredentials {
  const creds: ByokCredentials = {};
  if (env.BYOK_OPENAI_API_KEY) creds.openai = env.BYOK_OPENAI_API_KEY;
  if (env.BYOK_XAI_API_KEY) creds.xai = env.BYOK_XAI_API_KEY;
  if (env.BYOK_ANTHROPIC_API_KEY) creds.anthropic = env.BYOK_ANTHROPIC_API_KEY;
  if (
    env.BYOK_VERTEX_PROJECT &&
    env.BYOK_VERTEX_LOCATION &&
    env.BYOK_VERTEX_CLIENT_EMAIL &&
    env.BYOK_VERTEX_PRIVATE_KEY
  ) {
    creds.vertex = {
      project: env.BYOK_VERTEX_PROJECT,
      location: env.BYOK_VERTEX_LOCATION,
      clientEmail: env.BYOK_VERTEX_CLIENT_EMAIL,
      // Vercel env vars keep newlines escaped.
      privateKey: env.BYOK_VERTEX_PRIVATE_KEY.replace(/\\n/g, "\n"),
    };
  }
  return creds;
}

export type BilledTo = "gateway" | `byok:${ByokProvider}`;

/** JSON-safe gateway options (the AI SDK requires a JSON object here). */
export interface GatewayOptions {
  /** provider slug → credential objects (§8.9 request-scoped BYOK). */
  byok?: Record<string, Array<Record<string, string>>>;
  /** Pin routing so a request cannot silently reroute at a different price. */
  only?: string[];
}

export interface GatewayCallOptions {
  providerOptions?: { gateway: GatewayOptions };
  billedTo: BilledTo;
}

/**
 * Build the gateway provider options for one model call.
 * Returns `billed_to` for the ledger (§8.9): a routed call with a usable
 * credential bills the provider account; anything else bills the gateway.
 */
export function gatewayCallOptions(
  modelId: string,
  routes: Record<string, ByokProvider>,
  creds: ByokCredentials,
): GatewayCallOptions {
  const provider = routes[modelId];
  if (!provider) return { billedTo: "gateway" };

  let credential: Record<string, string> | null = null;
  if (provider === "vertex" && creds.vertex) {
    credential = {
      project: creds.vertex.project,
      location: creds.vertex.location,
      clientEmail: creds.vertex.clientEmail,
      privateKey: creds.vertex.privateKey,
    };
  } else if (provider !== "vertex") {
    const apiKey = creds[provider];
    if (apiKey) credential = { apiKey };
  }
  if (!credential) return { billedTo: "gateway" }; // no credential configured → gateway balance

  return {
    providerOptions: {
      gateway: {
        byok: { [BYOK_PROVIDER_SLUG[provider]]: [credential] },
        only: [BYOK_PROVIDER_SLUG[provider]],
      },
    },
    billedTo: `byok:${provider}`,
  };
}

/**
 * Anthropic prompt caching (§8.1): cache_control breakpoints on the system
 * prompt and the context snapshot. Other providers (OpenAI, Gemini, DeepSeek)
 * cache prefixes automatically and need nothing here.
 */
export function supportsExplicitCaching(modelId: string): boolean {
  return modelId.startsWith("anthropic/");
}
