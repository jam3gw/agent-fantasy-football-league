/**
 * On-demand projection refresh (SPEC §5.4).
 *
 * The daily `ingest.projections` job is a floor, not a ceiling: agent tools
 * that show projections call this before reading `player_week_proj`, so a
 * lineup set on Sunday morning sees the feed as it stands, not as it stood at
 * 6:00 AM Tuesday. The refresh lands in the shared table and every reader gets
 * the stored value, so "same information for all twelve agents" (§2) holds by
 * construction — the refresher only changes *when* the shared rows update.
 *
 * Week 0 is the season-long board (§5.7's feed, projected `pts_ppr` per
 * player for the whole season); it is what `get_available_players.proj_points`
 * reads during the draft. Weeks 1–18 use the per-week endpoint.
 *
 * This runs inside agent tool calls, so it is built to never add latency when
 * it has nothing to do and to fail fast when the feed is down:
 * - a fresh week (stored within PROJECTIONS_TTL_MS) is one indexed MAX query;
 * - a fetch is a single attempt with a short timeout — the daily job is the
 *   patient path with retries;
 * - a miss (feed down, empty body, unknown week) is remembered in-process for
 *   MISS_TTL_MS so a session with five projection reads pays for one attempt;
 * - nothing here ever throws — projections are optional (§5.4) and the caller
 *   serves whatever is stored.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "@league/engine";
import { playerWeekProj } from "@league/engine";
import { fetchSeasonProjections, fetchWeekProjections } from "../sleeper.ts";
import { upsertProjections } from "./stats.ts";

/** Stored rows younger than this are served without touching the feed. */
export const PROJECTIONS_TTL_MS = 60 * 60_000;

/** How long a failed or empty pull suppresses re-fetching (per process). */
export const PROJECTIONS_MISS_TTL_MS = 5 * 60_000;

/** Single attempt, short timeout: this path runs inside an agent tool call. */
const FETCH_OPTS = { retries: 0, timeoutMs: 10_000 };

export interface EnsureProjectionsResult {
  /** fresh: stored rows are within TTL; refreshed: the feed was stored; unavailable: nothing new. */
  outcome: "fresh" | "refreshed" | "unavailable";
  /** Rows upserted this call. */
  rows: number;
}

const inflight = new Map<string, Promise<EnsureProjectionsResult>>();
const lastMissAt = new Map<string, number>();

/** Test hook: clears the in-process inflight and miss caches. */
export function resetProjectionsRefreshState(): void {
  inflight.clear();
  lastMissAt.clear();
}

/**
 * Make `player_week_proj` for (season, week) as fresh as the Sleeper feed
 * allows, then return. Concurrent calls for the same week share one pull.
 */
export async function ensureFreshProjections(
  db: EngineDb,
  clock: Clock,
  opts: { season: number; week: number; ttlMs?: number },
): Promise<EnsureProjectionsResult> {
  const key = `${opts.season}:${opts.week}`;
  const running = inflight.get(key);
  if (running) return running;
  const run = refresh(db, clock, key, opts).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

async function refresh(
  db: EngineDb,
  clock: Clock,
  key: string,
  { season, week, ttlMs = PROJECTIONS_TTL_MS }: { season: number; week: number; ttlMs?: number },
): Promise<EnsureProjectionsResult> {
  const now = clock.now().getTime();

  const stored = await db
    .select({ at: sql<string | Date | null>`max(${playerWeekProj.updatedAt})` })
    .from(playerWeekProj)
    .where(and(eq(playerWeekProj.season, season), eq(playerWeekProj.week, week)));
  const at = stored[0]?.at ? new Date(stored[0].at).getTime() : null;
  if (at !== null && now - at < ttlMs) return { outcome: "fresh", rows: 0 };

  const missedAt = lastMissAt.get(key);
  if (missedAt !== undefined && now - missedAt < PROJECTIONS_MISS_TTL_MS) {
    return { outcome: "unavailable", rows: 0 };
  }

  let entries;
  try {
    entries =
      week === 0
        ? await fetchSeasonProjections(season, { db, ...FETCH_OPTS })
        : await fetchWeekProjections(season, week, { db, ...FETCH_OPTS });
  } catch {
    entries = null;
  }

  const rows = entries && entries.length > 0 ? await upsertProjections(db, { season, week, entries }) : 0;
  if (rows === 0) {
    lastMissAt.set(key, now);
    return { outcome: "unavailable", rows: 0 };
  }
  lastMissAt.delete(key);
  return { outcome: "refreshed", rows };
}
