/**
 * FantasyPros client (SPEC §5.8): one shared client with a global rate limit
 * (≤ 1 request/second), a global daily cap (FANTASYPROS_DAILY_CAP), a response
 * cache keyed by normalized URL, per-agent daily allowances (league rule: a
 * call that returns data counts, cache hit or not), and health tracking.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { Clock } from "@league/shared";
import { etDay } from "@league/shared";
import type { EngineDb } from "@league/engine";
import { fpCache, fpUsage, getSettings, health } from "@league/engine";

export type FpCaller =
  | { kind: "engine" }
  | { kind: "agent"; teamId: number; sessionId?: number }
  | { kind: "reporter"; sessionId?: number };

export interface FpConfig {
  apiKey: string;
  baseUrl?: string;
  /** Global safety cap on real upstream requests per ET day (default 100). */
  dailyCap?: number;
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export const FP_DEFAULT_BASE_URL = "https://api.fantasypros.com/public/v2/json";

/** Cache TTLs by endpoint family (§5.8). */
export function cacheTtlMs(path: string): number {
  if (path.includes("/players")) return 24 * 3600_000;
  if (path.includes("injuries") || path.includes("news")) return 3600_000;
  return 6 * 3600_000; // rankings, projections, player-points
}

export type FpOutcome =
  | { ok: true; body: unknown; cacheHit: boolean; remainingToday: number | null }
  | { ok: false; error: "fantasypros_quota" | "fantasypros_unavailable"; message: string; hint?: string };

/** Normalized cache key: path plus sorted query params. */
export function normalizeUrlKey(path: string, params: Record<string, string | number | undefined>): string {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return q ? `${path}?${q}` : path;
}

async function countedCallsToday(db: EngineDb, day: string, caller: FpCaller): Promise<number> {
  const callerKey = caller.kind === "agent" ? String(caller.teamId) : caller.kind;
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(fpUsage)
    .where(
      and(
        eq(fpUsage.dayEt, day),
        caller.kind === "agent"
          ? eq(fpUsage.teamId, caller.teamId)
          : sql`${fpUsage.teamId} is null and ${fpUsage.params}->>'caller' = ${callerKey}`,
      ),
    );
  return rows[0]?.n ?? 0;
}

async function realRequestsToday(db: EngineDb, day: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(fpUsage)
    .where(and(eq(fpUsage.dayEt, day), eq(fpUsage.cacheHit, false)));
  return rows[0]?.n ?? 0;
}

/** How many real upstream requests remain under the global cap today. */
export async function fpGlobalRemaining(db: EngineDb, clock: Clock, dailyCap = 100): Promise<number> {
  const used = await realRequestsToday(db, etDay(clock.now()));
  return Math.max(0, dailyCap - used);
}

/**
 * Make one FantasyPros request on behalf of a caller.
 * Counting rules (§5.8): a call that returns data (cache hit or 2xx) counts
 * against an agent/reporter allowance; a call blocked by the quota, the global
 * cap, or an upstream failure does not.
 */
export async function fpRequest(
  db: EngineDb,
  clock: Clock,
  cfg: FpConfig,
  caller: FpCaller,
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<FpOutcome> {
  const now = clock.now();
  const day = etDay(now);
  const dailyCap = cfg.dailyCap ?? 100;
  const urlKey = normalizeUrlKey(path, params);

  // 1. Agent/reporter allowance (league rule; engine pulls are exempt).
  let allowance: number | null = null;
  let usedToday = 0;
  if (caller.kind !== "engine") {
    const settings = await getSettings(db);
    allowance = settings.fantasyprosDailyAllowance;
    usedToday = await countedCallsToday(db, day, caller);
    if (usedToday >= allowance) {
      return {
        ok: false,
        error: "fantasypros_quota",
        message: `You have used your ${allowance} FantasyPros requests for today. The allowance resets at midnight ET.`,
      };
    }
  }

  const record = async (cacheHit: boolean) => {
    if (caller.kind === "engine" && cacheHit) return; // engine cache hits need no accounting
    await db.insert(fpUsage).values({
      teamId: caller.kind === "agent" ? caller.teamId : null,
      dayEt: day,
      requestNo: caller.kind === "engine" ? 0 : usedToday + 1,
      endpoint: path,
      params: { ...params, caller: caller.kind === "agent" ? String(caller.teamId) : caller.kind },
      cacheHit,
      sessionId: caller.kind !== "engine" ? (caller.sessionId ?? null) : null,
    });
  };

  // 2. Fresh cache?
  const cached = (await db.select().from(fpCache).where(eq(fpCache.urlKey, urlKey)))[0];
  if (cached && cached.expiresAt > now) {
    await record(true);
    return {
      ok: true,
      body: cached.body,
      cacheHit: true,
      remainingToday: allowance === null ? null : allowance - usedToday - 1,
    };
  }

  // 3. Global daily cap on real upstream requests.
  if ((await realRequestsToday(db, day)) >= dailyCap) {
    return {
      ok: false,
      error: "fantasypros_unavailable",
      message: "The league's FantasyPros request budget for today is exhausted.",
      hint: "Try later or use web_search.",
    };
  }

  // 4. Global rate limit ≤ 1 request/second (wall clock).
  const last = await db
    .select({ t: sql<Date | null>`max(${fpUsage.createdAt})` })
    .from(fpUsage)
    .where(and(eq(fpUsage.cacheHit, false), gte(fpUsage.createdAt, new Date(Date.now() - 5_000))));
  const lastAt = last[0]?.t ? new Date(last[0].t).getTime() : 0;
  const waitMs = lastAt + 1_000 - Date.now();
  if (waitMs > 0) {
    const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    await sleep(Math.min(waitMs, 1_100));
  }

  // 5. Fetch upstream.
  const base = cfg.baseUrl ?? FP_DEFAULT_BASE_URL;
  const url = `${base}${urlKey}`;
  const fetchImpl = cfg.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(url, {
      headers: { "x-api-key": cfg.apiKey },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    await db
      .insert(fpCache)
      .values({ urlKey, body, fetchedAt: now, expiresAt: new Date(now.getTime() + cacheTtlMs(path)) })
      .onConflictDoUpdate({
        target: fpCache.urlKey,
        set: { body, fetchedAt: now, expiresAt: new Date(now.getTime() + cacheTtlMs(path)) },
      });
    await record(false);
    await db
      .insert(health)
      .values({ key: "fantasypros", lastSuccessAt: now })
      .onConflictDoUpdate({ target: health.key, set: { lastSuccessAt: now } });
    return {
      ok: true,
      body,
      cacheHit: false,
      remainingToday: allowance === null ? null : allowance - usedToday - 1,
    };
  } catch (err) {
    await db
      .insert(health)
      .values({ key: "fantasypros", lastError: String(err), lastErrorAt: now })
      .onConflictDoUpdate({ target: health.key, set: { lastError: String(err), lastErrorAt: now } });
    return {
      ok: false,
      error: "fantasypros_unavailable",
      message: "FantasyPros did not return data.",
      hint: "Try later or use web_search.",
    };
  }
}
