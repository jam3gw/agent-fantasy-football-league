/**
 * Courtesy rate limit for the public JSON API (SPEC §12.1: 60 requests per
 * minute per IP).
 *
 * This is an in-memory sliding window held in module scope. Each serverless
 * instance therefore holds its OWN window: with N warm instances a client can
 * make up to N x 60 requests per minute, and a cold start resets the count.
 * It is a courtesy limit that keeps a naive client from hammering a single
 * instance — it is NOT a security control. Anything that must actually be
 * enforced belongs in a shared store or at the edge, not here.
 */

/** Requests allowed per window, per IP (§12.1). */
export const RATE_LIMIT = 60;
/** Window length in milliseconds. */
export const WINDOW_MS = 60_000;
/** Sweep the map when it grows past this, so a long-lived instance is bounded. */
const MAX_KEYS = 5_000;

/** key (IP) -> timestamps of the requests still inside the window */
const windows = new Map<string, number[]>();

/**
 * The client IP as seen by the proxy. Vercel sets `x-forwarded-for`; the first
 * entry is the original client. Spoofable, which is another reason this is a
 * courtesy limit only.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

export interface RateLimitVerdict {
  ok: boolean;
  /** Requests left in the current window (0 when over the limit). */
  remaining: number;
  /** Seconds until the oldest request leaves the window; 0 when allowed. */
  retryAfterSeconds: number;
}

function sweep(now: number): void {
  const cutoff = now - WINDOW_MS;
  for (const [key, hits] of windows) {
    const live = hits.filter((t) => t > cutoff);
    if (live.length === 0) windows.delete(key);
    else windows.set(key, live);
  }
}

/** Record a request for `key` and say whether it is allowed. */
export function checkRateLimit(key: string, now: number = Date.now()): RateLimitVerdict {
  const cutoff = now - WINDOW_MS;
  const hits = (windows.get(key) ?? []).filter((t) => t > cutoff);
  if (hits.length >= RATE_LIMIT) {
    windows.set(key, hits);
    const oldest = hits[0] ?? now;
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)),
    };
  }
  hits.push(now);
  windows.set(key, hits);
  if (windows.size > MAX_KEYS) sweep(now);
  return { ok: true, remaining: RATE_LIMIT - hits.length, retryAfterSeconds: 0 };
}

/** Test/debug helper: forget every window. */
export function resetRateLimits(): void {
  windows.clear();
}

/**
 * Guard for a public API route: returns a 429 response when the caller is over
 * the limit, or `null` when the request may proceed.
 *
 * `bucket` gives an endpoint its own window per IP. The site's own polling
 * endpoints (the pulse stamp, the live transcript) use it so a spectator with
 * a live tab open cannot starve the data API of its §12.1 budget — or the
 * reverse. Data-API routes omit it and share the plain per-IP window as
 * before.
 */
export function rateLimitResponse(request: Request, bucket?: string): Response | null {
  const ip = clientIp(request);
  const verdict = checkRateLimit(bucket ? `${bucket}:${ip}` : ip);
  if (verdict.ok) return null;
  return Response.json(
    {
      error: "rate_limited",
      limit: RATE_LIMIT,
      windowSeconds: WINDOW_MS / 1000,
      retryAfterSeconds: verdict.retryAfterSeconds,
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(verdict.retryAfterSeconds),
        "Cache-Control": "no-store",
      },
    },
  );
}

/** JSON body for a public API response: never cached, always fresh. */
export function publicJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
