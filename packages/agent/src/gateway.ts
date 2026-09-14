/**
 * The AI Gateway's own model catalog (§8.1).
 *
 * Used to check a model id before it is written to a team. The runbook told
 * the commissioner to "verify the new id exists on the gateway first", which
 * was advice, not a guard: a typo went straight into `teams.model_id` and that
 * team's next three sessions failed before the outage detector noticed — and
 * if the swap was *because* of an outage, the streak is keyed on the old id,
 * so it would not have noticed at all.
 */
import type { Clock } from "@league/shared";
import type { EngineDb } from "@league/engine";
import { modelPrices } from "@league/engine";
import { LEAGUE_MODELS, REPORTER_MODEL } from "./models.ts";

const CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";

export interface GatewayCatalog {
  ok: boolean;
  ids: string[];
  /** The catalog entries by id, as far as the sync needs them. */
  entries: Map<string, GatewayCatalogEntry>;
  /** Why the catalog could not be read, when `ok` is false. */
  error?: string;
}

/** The slice of a catalog entry `model_prices` is built from. */
export interface GatewayCatalogEntry {
  id: string;
  /** $ per token in the catalog; per-million in `model_prices`. */
  input: number | null;
  output: number | null;
  cachedInput: number | null;
  contextWindow: number | null;
}

function priceOf(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function entryOf(m: Record<string, unknown>): GatewayCatalogEntry | null {
  const id = String(m.id ?? "");
  if (!id) return null;
  // The base price, not the region-pinned one: the ledger's gateway-reported
  // costs match the base rate for every gateway-billed seat (checked
  // 2026-09-05), and for a BYOK provider the base rate is that provider's
  // list price, which is what a price-table step should be billed at.
  const pricing = (m.pricing ?? {}) as Record<string, unknown>;
  const ctx = Number(m.context_window);
  return {
    id,
    input: priceOf(pricing.input),
    output: priceOf(pricing.output),
    cachedInput: priceOf(pricing.input_cache_read),
    contextWindow: Number.isInteger(ctx) && ctx > 0 ? ctx : null,
  };
}

export async function fetchGatewayModelIds(
  opts: { apiKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<GatewayCatalog> {
  let apiKey = opts.apiKey ?? process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    // Preview deployments carry no AI_GATEWAY_API_KEY (Production scope); the
    // gateway accepts the deployment's OIDC token in the same Bearer header,
    // which is how the AI SDK itself authenticates there. Outside Vercel the
    // import or the call fails and the original error stands.
    try {
      const { getVercelOidcToken } = await import("@vercel/oidc");
      apiKey = await getVercelOidcToken();
    } catch {
      /* not on Vercel; fall through */
    }
  }
  if (!apiKey) return { ok: false, ids: [], entries: new Map(), error: "AI_GATEWAY_API_KEY is not set" };
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await doFetch(CATALOG_URL, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, ids: [], entries: new Map(), error: `gateway returned ${res.status}` };
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const entries = new Map<string, GatewayCatalogEntry>();
    for (const m of body.data ?? []) {
      const e = entryOf(m);
      if (e) entries.set(e.id, e);
    }
    const ids = [...entries.keys()];
    return ids.length > 0
      ? { ok: true, ids, entries }
      : { ok: false, ids: [], entries, error: "gateway returned no models" };
  } catch (err) {
    return { ok: false, ids: [], entries: new Map(), error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is this id on the gateway? A catalog that cannot be read returns `unknown`
 * rather than `false`: refusing a swap because the network is down would take
 * the commissioner's only response to a retired model away exactly when a
 * provider is having a bad day.
 */
export async function checkGatewayModelId(
  modelId: string,
  opts: Parameters<typeof fetchGatewayModelIds>[0] = {},
): Promise<"ok" | "not_found" | "unknown"> {
  const catalog = await fetchGatewayModelIds(opts);
  if (!catalog.ok) return "unknown";
  return catalog.ids.includes(modelId) ? "ok" : "not_found";
}

export interface PriceSyncResult {
  ok: boolean;
  /** Rows written (a row is written even when nothing changed; the stamp moves). */
  updated: string[];
  /** Ids in `model_prices` the catalog no longer lists; their rows are left alone. */
  missing: string[];
  /** The subset of `missing` a seat is running on right now: a promo or a retired id. */
  missingInUse: string[];
  error?: string;
}

/**
 * §8.7: `model_prices` is "filled from the gateway catalog and refreshed
 * weekly". The seed filled it once (2026-08-29) and nothing refreshed it, so a
 * price the gateway changed later — Mistral Large 3 went from $2/$6 to
 * $0.50/$1.50 — sat wrong in the table. Gateway-billed steps were unaffected
 * (they record the gateway's own cost); the table prices BYOK steps as they
 * are written, and those should be right.
 *
 * Every id already in the table is refreshed, plus every league and reporter
 * model, so a seat swapped on /admin/teams gets a row the next Monday even if
 * the swap forgot one. An id the catalog no longer carries is reported and
 * left as it was: a retired promo entry keeps its last known price, which is
 * what its historical rows were billed at. The catalog's cache-write price
 * is not stored; `computeStepCost` derives it from the input rate. A sync
 * changes what later steps are billed at; ledger rows already written keep
 * the price they were written with, so `/spend` history does not move.
 *
 * `missingInUse` drives the `/admin/health` alert, so it has to mean "a seat
 * is running on this id right now" — `LEAGUE_MODELS` and `REPORTER_MODEL` are
 * in-repo defaults, not that: a swap on /admin/teams changes `teams.model_id`,
 * and a swap on /admin/settings changes the reporter's model
 * (`reporterModelId`, §11), neither touching the code. A caller that wants a
 * live answer must pass every current seat as `opts.modelIds` — trusted
 * completely when given, so a swapped-off default never keeps alerting.
 * A caller that omits it, or passes an empty list, gets the static defaults
 * as a fallback answer, right only for a seat that has never been swapped at
 * runtime; the production job passes the live `teams.model_id` values plus
 * the live reporter model instead.
 */
export async function syncModelPrices(
  db: EngineDb,
  clock: Clock,
  opts: Parameters<typeof fetchGatewayModelIds>[0] & { modelIds?: string[] } = {},
): Promise<PriceSyncResult> {
  const catalog = await fetchGatewayModelIds(opts);
  if (!catalog.ok) {
    return { ok: false, updated: [], missing: [], missingInUse: [], error: catalog.error ?? "catalog unreadable" };
  }

  const existing = await db.select({ modelId: modelPrices.modelId }).from(modelPrices);
  const wanted = new Set<string>([
    ...existing.map((r) => r.modelId),
    ...LEAGUE_MODELS.map((m) => m.modelId),
    REPORTER_MODEL.modelId,
    ...(opts.modelIds ?? []),
  ]);

  const updated: string[] = [];
  const missing: string[] = [];
  for (const id of [...wanted].sort()) {
    const e = catalog.entries.get(id);
    if (!e || e.input === null || e.output === null) {
      missing.push(id);
      continue;
    }
    const row = {
      inputUsdPerM: round4(e.input * 1_000_000),
      outputUsdPerM: round4(e.output * 1_000_000),
      cachedInputUsdPerM: e.cachedInput === null ? null : round4(e.cachedInput * 1_000_000),
      source: "catalog_sync",
      updatedAt: clock.now(),
    };
    // A catalog entry without a context window must not erase a stored one:
    // `contextWindowFor` (session.ts) reads this column for §8.1 context
    // management, and a swapped-in model has no seed to fall back on.
    const window = e.contextWindow === null ? {} : { contextWindow: e.contextWindow };
    await db
      .insert(modelPrices)
      .values({ modelId: id, ...row, ...window })
      .onConflictDoUpdate({ target: modelPrices.modelId, set: { ...row, ...window } });
    updated.push(id);
  }
  const inUse =
    opts.modelIds && opts.modelIds.length > 0
      ? new Set(opts.modelIds)
      : new Set([...LEAGUE_MODELS.map((m) => m.modelId), REPORTER_MODEL.modelId]);
  return { ok: true, updated, missing, missingInUse: missing.filter((id) => inUse.has(id)) };
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
