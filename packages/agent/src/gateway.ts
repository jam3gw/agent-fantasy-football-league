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
const CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";

export interface GatewayCatalog {
  ok: boolean;
  ids: string[];
  /** Why the catalog could not be read, when `ok` is false. */
  error?: string;
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
  if (!apiKey) return { ok: false, ids: [], error: "AI_GATEWAY_API_KEY is not set" };
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await doFetch(CATALOG_URL, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, ids: [], error: `gateway returned ${res.status}` };
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (body.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
    return ids.length > 0 ? { ok: true, ids } : { ok: false, ids: [], error: "gateway returned no models" };
  } catch (err) {
    return { ok: false, ids: [], error: String(err) };
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
