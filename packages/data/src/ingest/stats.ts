/** Sleeper weekly stats ingest (SPEC §5.3, §3.2): upsert player_week_stats with engine_pts and discrepancy logging. */
import { sql } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "@league/engine";
import { getSettings, playerWeekProj, playerWeekStats, scoringDiscrepancies } from "@league/engine";
import type { SleeperStatsEntry } from "../sleeper.ts";

export function computeEnginePts(scoring: Record<string, number>, stats: Record<string, number>): number {
  let total = 0;
  for (const [k, v] of Object.entries(stats)) {
    const c = scoring[k];
    if (c) total += c * v;
  }
  return Math.round(total * 100) / 100;
}

export async function upsertWeekStats(
  db: EngineDb,
  clock: Clock,
  input: {
    season: number;
    week: number;
    entries: SleeperStatsEntry[];
    markFinal: boolean;
    source?: "sleeper" | "nflverse";
  },
): Promise<{ count: number; discrepancies: number }> {
  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    const scoring = settings.scoringSettings;
    let count = 0;
    let discrepancies = 0;
    for (const e of input.entries) {
      const stats = e.stats ?? {};
      const ptsPpr = typeof stats.pts_ppr === "number" ? stats.pts_ppr : null;
      const enginePts = computeEnginePts(scoring, stats);
      const values = {
        playerId: e.player_id,
        season: input.season,
        week: input.week,
        // The feed's own team/opponent for this game (may be absent on
        // nflverse rows); kept per row so a mid-season trade cannot smear a
        // player's early games onto his new team.
        nflTeam: typeof e.team === "string" ? e.team : null,
        opponent: typeof e.opponent === "string" ? e.opponent : null,
        stats,
        ptsPpr,
        enginePts,
        source: input.source ?? ("sleeper" as const),
        final: input.markFinal,
        updatedAt: clock.now(),
      };
      await tx
        .insert(playerWeekStats)
        .values(values)
        .onConflictDoUpdate({
          target: [playerWeekStats.playerId, playerWeekStats.season, playerWeekStats.week],
          set: { ...values },
        });
      count++;
      // §3.2's fit check compares Sleeper's own `pts_ppr` with what our
      // scoring settings produce from Sleeper's stat line. A FantasyPros or
      // nflverse row carries computed points and no comparable stat line, so
      // `engine_pts` is 0 there and every player would look like a mismatch.
      const auditable = (input.source ?? "sleeper") === "sleeper";
      if (auditable && input.markFinal && ptsPpr !== null && Math.abs(ptsPpr - enginePts) > 0.01) {
        discrepancies++;
        await tx.insert(scoringDiscrepancies).values({
          playerId: e.player_id,
          season: input.season,
          week: input.week,
          ptsPpr,
          enginePts,
          diff: Math.round((ptsPpr - enginePts) * 100) / 100,
        });
      }
    }
    return { count, discrepancies };
  });
}

/**
 * §5.4 — the weeks one scheduled projections run covers: the current week plus
 * the next two, capped at the end of the regular season. Lookahead projections
 * feed trade valuation and bye-week planning (get_player_stats,
 * player_research); the on-demand refresher (projections.ts) keeps any single
 * week fresh between runs.
 */
export function projectionWeeks(from: number): number[] {
  const out: number[] = [];
  for (let week = from; week <= Math.min(from + 2, 18); week++) out.push(week);
  return out;
}

/**
 * §5.4 — one scheduled projections run: fetch and upsert every week in the
 * lookahead window. A week whose fetch returns null (feed down or absent) is
 * skipped without failing the others. The fetcher is injectable for tests.
 */
export async function ingestProjections(
  db: EngineDb,
  input: {
    season: number;
    from: number;
    fetchWeek: (season: number, week: number) => Promise<SleeperStatsEntry[] | null>;
  },
): Promise<number> {
  let n = 0;
  for (const week of projectionWeeks(input.from)) {
    const entries = await input.fetchWeek(input.season, week);
    if (entries) n += await upsertProjections(db, { season: input.season, week, entries });
  }
  return n;
}

/**
 * §5.4 projections — optional; same entry shape with projected pts_ppr.
 *
 * Batched: the season feed carries ~1,700 rows and this also runs on the
 * on-demand path inside agent tool calls, where 1,700 sequential round trips
 * would eat a draft clock. Rows are deduped by player (last wins) because a
 * multi-row INSERT ... ON CONFLICT cannot touch the same key twice. `now`
 * lets the on-demand refresher stamp rows with Clock time so its TTL reader
 * and this writer share one clock; the scheduled job uses wall time as before.
 */
export async function upsertProjections(
  db: EngineDb,
  input: { season: number; week: number; entries: SleeperStatsEntry[]; now?: Date },
): Promise<number> {
  const at = input.now ?? new Date();
  const byId = new Map<string, number>();
  for (const e of input.entries) {
    if (typeof e.stats?.pts_ppr === "number") byId.set(e.player_id, e.stats.pts_ppr);
  }
  const rows = [...byId.entries()].map(([playerId, proj]) => ({
    playerId,
    season: input.season,
    week: input.week,
    projPtsPpr: proj,
    updatedAt: at,
  }));
  if (rows.length === 0) return 0;

  const CHUNK = 500;
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      await tx
        .insert(playerWeekProj)
        .values(rows.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: [playerWeekProj.playerId, playerWeekProj.season, playerWeekProj.week],
          set: {
            projPtsPpr: sql`excluded.proj_pts_ppr`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
  });
  return rows.length;
}
