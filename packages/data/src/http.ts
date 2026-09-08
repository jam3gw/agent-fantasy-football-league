/**
 * Shared HTTP fetch for all external clients (SPEC §5): timeout, retry with
 * backoff, and a health record per source (engine `health` table).
 */
import type { EngineDb } from "@league/engine";
import { health } from "@league/engine";

export interface FetchJsonOptions {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  headers?: Record<string, string>;
  /** Health key to record success/failure under (skipped when db is absent). */
  healthKey?: string;
  db?: EngineDb;
}

/**
 * Retry timing for every external source. Tests set `backoffMs` to 0: with
 * the default, one dead source costs seven seconds of sleep (1 s + 2 s + 4 s)
 * per call, which is right in production and a waste in a test that makes
 * Sleeper fail on purpose.
 */
export const RETRY_POLICY = { retries: 3, backoffMs: 1_000 };

export class HttpError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} for ${url}`);
  }
}

async function recordHealth(db: EngineDb | undefined, key: string | undefined, error: string | null): Promise<void> {
  if (!db || !key) return;
  const now = new Date();
  if (error === null) {
    await db
      .insert(health)
      .values({ key, lastSuccessAt: now })
      .onConflictDoUpdate({ target: health.key, set: { lastSuccessAt: now } });
  } else {
    await db
      .insert(health)
      .values({ key, lastError: error, lastErrorAt: now })
      .onConflictDoUpdate({ target: health.key, set: { lastError: error, lastErrorAt: now } });
  }
}

/** GET a URL and parse JSON (or text when `parse: "text"`), with retry/backoff. */
export async function fetchWithRetry(
  url: string,
  opts: FetchJsonOptions & { parse?: "json" | "text" } = {},
): Promise<unknown> {
  const {
    timeoutMs = 30_000,
    retries = RETRY_POLICY.retries,
    backoffMs = RETRY_POLICY.backoffMs,
    headers,
    healthKey,
    db,
    parse = "json",
  } = opts;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new HttpError(url, res.status);
      const body = parse === "json" ? await res.json() : await res.text();
      await recordHealth(db, healthKey, null);
      return body;
    } catch (err) {
      lastError = err;
      // 4xx (except 429) never succeeds on retry
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) break;
      if (attempt < retries) await new Promise((r) => setTimeout(r, backoffMs * 2 ** attempt));
    }
  }
  await recordHealth(db, healthKey, String(lastError));
  throw lastError;
}
