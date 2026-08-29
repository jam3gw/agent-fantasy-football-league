/** Sleeper weekly stats ingest (SPEC §5.3, §3.2): upsert player_week_stats with engine_pts and discrepancy logging. */
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

/** §5.4 projections — optional; same entry shape with projected pts_ppr. */
export async function upsertProjections(
  db: EngineDb,
  input: { season: number; week: number; entries: SleeperStatsEntry[] },
): Promise<number> {
  return db.transaction(async (tx) => {
    let n = 0;
    for (const e of input.entries) {
      const proj = typeof e.stats?.pts_ppr === "number" ? e.stats.pts_ppr : null;
      if (proj === null) continue;
      await tx
        .insert(playerWeekProj)
        .values({ playerId: e.player_id, season: input.season, week: input.week, projPtsPpr: proj, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [playerWeekProj.playerId, playerWeekProj.season, playerWeekProj.week],
          set: { projPtsPpr: proj, updatedAt: new Date() },
        });
      n++;
    }
    return n;
  });
}
