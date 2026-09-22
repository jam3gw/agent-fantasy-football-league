/**
 * TypeSafe AI's Jev through the Vercel AI Gateway (SPEC §11.1). The gateway's
 * TypeSafe-compatible endpoint takes TypeSafe's own request and returns its
 * own answer shapes, plus the gateway's cost for the call. The engine sees
 * only a `JevAsk`; this is the one implementation that touches the network.
 *
 * The key (`AI_GATEWAY_API_KEY`, the one every model call already uses) goes
 * in the Authorization header and nowhere else: never into an error message,
 * a log line, or a stored row.
 */
import type { JevAnswer, JevAsk, JevReply, JevRequest } from "@league/engine";
import { JEV_MODEL } from "@league/engine";
import { HttpError, RETRY_POLICY } from "./http.ts";

export const JEV_URL = "https://ai-gateway.vercel.sh/typesafe/v1/systemone";

export interface JevClientOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  fetchImpl?: typeof fetch;
}

/** 429 (rate limit), 529 (overloaded) and 5xx retry; any other 4xx never will. */
function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function parseReply(body: unknown): JevReply {
  if (!body || typeof body !== "object") throw new Error("jev: response is not an object");
  const b = body as {
    model?: unknown;
    answers?: unknown;
    usage?: { input_tokens?: unknown };
    provider_metadata?: { gateway?: { cost?: unknown } };
  };
  if (typeof b.model !== "string") throw new Error("jev: response has no model");
  if (!b.answers || typeof b.answers !== "object") throw new Error("jev: response has no answers");
  const answers: Record<string, JevAnswer> = {};
  for (const [key, raw] of Object.entries(b.answers as Record<string, unknown>)) {
    const a = raw as Record<string, unknown>;
    if (a?.type === "noul" && typeof a.noul === "number") {
      answers[key] = { type: "noul", noul: a.noul };
    } else if (a?.type === "choice" && typeof a.choice === "string" && a.probabilities && typeof a.probabilities === "object") {
      answers[key] = {
        type: "choice",
        choice: a.choice,
        probabilities: a.probabilities as Record<string, number>,
        confidence: typeof a.confidence === "number" && Number.isFinite(a.confidence) ? a.confidence : null,
      };
    }
    // Other answer types (score) are not asked for; an answer out of shape is
    // left out, and the caller fails on the missing key.
  }
  const inputTokens = typeof b.usage?.input_tokens === "number" ? b.usage.input_tokens : 0;
  // The gateway reports cost as a decimal string ("0.00001155").
  const rawCost = Number(b.provider_metadata?.gateway?.cost);
  const costUsd = b.provider_metadata?.gateway?.cost !== undefined && Number.isFinite(rawCost) ? rawCost : null;
  return { model: b.model, answers, inputTokens, costUsd };
}

export function jevClient(opts: JevClientOptions): JevAsk {
  const {
    apiKey,
    model = JEV_MODEL,
    timeoutMs = 30_000,
    retries = RETRY_POLICY.retries,
    backoffMs = RETRY_POLICY.backoffMs,
    fetchImpl = fetch,
  } = opts;
  return async (req: JevRequest, callOpts: { signal?: AbortSignal } = {}): Promise<JevReply> => {
    const outer = callOpts.signal;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (outer?.aborted) break;
      let wait = backoffMs * 2 ** attempt;
      try {
        const res = await fetchImpl(JEV_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, state: req.state, questions: req.questions }),
          signal: outer ? AbortSignal.any([AbortSignal.timeout(timeoutMs), outer]) : AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          // The body names the offending field on a 422; it never echoes the key.
          const detail = (await res.text().catch(() => "")).slice(0, 300);
          const retryAfter = Number(res.headers.get("retry-after"));
          if (Number.isFinite(retryAfter) && retryAfter > 0) wait = Math.min(30_000, retryAfter * 1000);
          throw new HttpError(JEV_URL, res.status, `HTTP ${res.status} from Jev via AI Gateway${detail ? `: ${detail}` : ""}`);
        }
        return parseReply(await res.json());
      } catch (err) {
        lastError = err;
        if (err instanceof HttpError && !retryable(err.status)) break;
        if (err instanceof Error && err.message.startsWith("jev: ")) break; // a malformed reply will not fix itself
        if (outer?.aborted) break; // the caller's deadline: no more retries
        if (attempt < retries) await new Promise((r) => setTimeout(r, wait));
      }
    }
    if (lastError === undefined && outer?.aborted) lastError = outer.reason ?? new Error("jev: aborted");
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}
