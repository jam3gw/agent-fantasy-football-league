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
import { JEV_MODEL, JevCallError } from "@league/engine";
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

type ReplyBody = {
  model?: unknown;
  answers?: unknown;
  usage?: { input_tokens?: unknown };
  provider_metadata?: { gateway?: { cost?: unknown } };
};

/** The gateway reports cost as a decimal string ("0.00001155"); anything else is no cost. */
export function parseGatewayCost(c: unknown): number | null {
  const ok = (typeof c === "string" && c.trim() !== "") || typeof c === "number";
  if (!ok) return null;
  const n = Number(c);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** What a 200 body says was spent, read before the body is validated. */
function usageOf(body: unknown): { inputTokens: number; costUsd: number | null } {
  const b = (body && typeof body === "object" ? body : {}) as ReplyBody;
  const t = b.usage?.input_tokens;
  return {
    inputTokens: typeof t === "number" && Number.isFinite(t) && t >= 0 ? t : 0,
    costUsd: parseGatewayCost(b.provider_metadata?.gateway?.cost),
  };
}

function parseReply(body: unknown): JevReply {
  const { inputTokens, costUsd } = usageOf(body);
  const bad = (msg: string) => new JevCallError(msg, inputTokens, costUsd);
  if (!body || typeof body !== "object") throw bad("jev: response is not an object");
  const b = body as ReplyBody;
  if (typeof b.model !== "string") throw bad("jev: response has no model");
  if (!b.answers || typeof b.answers !== "object") throw bad("jev: response has no answers");
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
  return { model: b.model, answers, inputTokens, costUsd };
}

/** Sleep that ends early when `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      done();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          throw new JevCallError("jev: response is not JSON", 0, null);
        }
        return parseReply(body);
      } catch (err) {
        lastError = err;
        if (err instanceof HttpError && !retryable(err.status)) break;
        if (err instanceof Error && err.message.startsWith("jev: ")) break; // a malformed reply will not fix itself
        if (outer?.aborted) break; // the caller's deadline: no more retries
        if (attempt < retries) await sleep(wait, outer);
      }
    }
    // Stopped by the caller's deadline: say so, not the retry that was cut short.
    if (outer?.aborted) lastError = outer.reason ?? new Error("jev: aborted");
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}
