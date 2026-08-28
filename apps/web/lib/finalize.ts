import "server-only";
/**
 * Week finalization and the scoring degradation ladder (SPEC §13.3, §13.4).
 *
 * Finalization is never skipped and never waits for a person. The engine walks
 * down the source list on its own and records which source scored the week.
 */
import { eq } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "@league/engine";
import {
  finalizeWeekCore,
  getSettings,
  health,
  playerWeekStats,
  updateSettings,
} from "@league/engine";
import { fetchWeekStats, fpRequest, upsertWeekStats } from "@league/data";
import type { SleeperStatsEntry } from "@league/data";
import { env } from "./env";

export type ScoringSource = "sleeper" | "fantasypros" | "nflverse";

export interface FinalizeResult {
  week: number;
  source: ScoringSource | "none";
  playersScored: number;
  matchupsFinalized: number;
  currentWeek: number;
  degraded: boolean;
}

/**
 * Finalize a week. Tries Sleeper, then FantasyPros player-points, then
 * nflverse; whichever succeeds is recorded on the week (§13.4).
 */
export async function finalizeWeek(db: EngineDb, clock: Clock, week: number): Promise<FinalizeResult> {
  const settings = await getSettings(db);
  const season = settings.season;
  let source: ScoringSource | "none" = "none";
  let playersScored = 0;

  // Source 1 — Sleeper stats (primary).
  try {
    const entries = await fetchWeekStats(season, week, { db });
    if (entries.length > 0) {
      const res = await upsertWeekStats(db, { season, week, entries, markFinal: true, source: "sleeper" });
      playersScored = res.count;
      source = "sleeper";
    }
  } catch {
    source = "none";
  }

  // Source 2 — FantasyPros player-points (documented; one request per week).
  if (source === "none") {
    try {
      const entries = await fetchFantasyProsPoints(db, clock, season, week);
      if (entries.length > 0) {
        const res = await upsertWeekStats(db, {
          season,
          week,
          entries,
          markFinal: true,
          source: "fantasypros",
        });
        playersScored = res.count;
        source = "fantasypros";
      }
    } catch {
      source = "none";
    }
  }

  // Source 3 — nflverse weekly stats through scoring_settings. Offense and
  // kickers only; D/ST scores 0 and the week is flagged (§13.4).
  if (source === "none") {
    try {
      const entries = await fetchNflverseWeek(db, season, week);
      if (entries.length > 0) {
        const res = await upsertWeekStats(db, {
          season,
          week,
          entries,
          markFinal: true,
          source: "nflverse",
        });
        playersScored = res.count;
        source = "nflverse";
      }
    } catch {
      source = "none";
    }
  }

  // Whatever happened above, the week finalizes from whatever stats exist —
  // §13.4: "Finalization is never skipped and never waits for a person."
  const core = await finalizeWeekCore(db, clock, week);
  if (!core.ok) throw new Error(`finalizeWeekCore failed: ${core.message}`);

  // Record the source so the site and health page can show it.
  const extra = (await getSettings(db)).extra as Record<string, unknown>;
  const weekSources = { ...((extra.weekScoringSources as Record<string, string>) ?? {}), [String(week)]: source };
  await updateSettings(db, { extra: { ...extra, weekScoringSources: weekSources } });

  await db
    .insert(health)
    .values({
      key: "stats.finalize",
      lastSuccessAt: clock.now(),
      ...(source === "none" ? { lastError: `week ${week} finalized with no stats source`, lastErrorAt: clock.now() } : {}),
    })
    .onConflictDoUpdate({
      target: health.key,
      set: { lastSuccessAt: clock.now() },
    });

  return {
    week,
    source,
    playersScored,
    matchupsFinalized: core.value.matchupsFinalized,
    currentWeek: core.value.currentWeek,
    degraded: source !== "sleeper",
  };
}

/** Source 2: FantasyPros PPR player-points for one week (§13.4). */
async function fetchFantasyProsPoints(
  db: EngineDb,
  clock: Clock,
  season: number,
  week: number,
): Promise<SleeperStatsEntry[]> {
  const apiKey = env.toolConfig.fantasyprosApiKey;
  if (!apiKey) return [];
  const res = await fpRequest(
    db,
    clock,
    {
      apiKey,
      baseUrl: env.toolConfig.fantasyprosBaseUrl,
      dailyCap: env.toolConfig.fantasyprosDailyCap,
    },
    { kind: "engine" },
    `/nfl/${season}/player-points`,
    { scoring: "PPR", position: "ALL", start: week, end: week },
  );
  if (!res.ok) return [];

  const body = res.body as {
    players?: Array<{ player_id?: string | number; weeks?: Record<string, number> }>;
  };
  const out: SleeperStatsEntry[] = [];
  const { fpPlayerMap } = await import("@league/engine");
  const map = await db.select().from(fpPlayerMap);
  const toSleeper = new Map(map.map((m) => [m.fpPlayerId, m.playerId]));

  for (const p of body.players ?? []) {
    const fpId = p.player_id === undefined ? null : String(p.player_id);
    if (!fpId) continue;
    const sleeperId = toSleeper.get(fpId);
    if (!sleeperId) continue;
    const points = p.weeks?.[String(week)];
    if (typeof points !== "number") continue;
    out.push({
      player_id: sleeperId,
      season,
      week,
      // FantasyPros gives points, not the stat lines, so the stats object
      // carries only the computed total.
      stats: { pts_ppr: points },
    });
  }
  return out;
}

/**
 * Source 3: nflverse weekly player stats scored through `scoring_settings`.
 * D/ST needs play-by-play, which is a stretch goal (§13.4), so team defenses
 * score 0 in this path and the week is flagged as degraded.
 */
async function fetchNflverseWeek(db: EngineDb, season: number, week: number): Promise<SleeperStatsEntry[]> {
  const { fetchNflverseWeeklyStats } = await import("@league/data");
  const rows = await fetchNflverseWeeklyStats(season, { db });
  const settings = await getSettings(db);
  const { players } = await import("@league/engine");
  const byGsis = new Map(
    (await db.select({ playerId: players.playerId, gsisId: players.gsisId }).from(players))
      .filter((p) => p.gsisId)
      .map((p) => [p.gsisId!, p.playerId]),
  );
  const out: SleeperStatsEntry[] = [];
  for (const r of rows) {
    if (r.week !== week) continue;
    const playerId = byGsis.get(r.gsisId);
    if (!playerId) continue;
    out.push({ player_id: playerId, season, week, stats: { ...r.stats, pts_ppr: scoreStats(settings.scoringSettings, r.stats) } });
  }
  return out;
}

function scoreStats(scoring: Record<string, number>, stats: Record<string, number>): number {
  let total = 0;
  for (const [k, v] of Object.entries(stats)) {
    const c = scoring[k];
    if (c) total += c * v;
  }
  return Math.round(total * 100) / 100;
}

/** Which source scored a week (site + health page). */
export async function weekScoringSource(db: EngineDb, week: number): Promise<ScoringSource | "none" | null> {
  const settings = await getSettings(db);
  const sources = (settings.extra as { weekScoringSources?: Record<string, string> }).weekScoringSources;
  return (sources?.[String(week)] as ScoringSource | "none" | undefined) ?? null;
}

/** Rows still missing stats for a week (health page). */
export async function missingStatsCount(db: EngineDb, season: number, week: number): Promise<number> {
  const rows = await db
    .select()
    .from(playerWeekStats)
    .where(eq(playerWeekStats.week, week));
  return rows.filter((r) => r.season === season && r.ptsPpr === null).length;
}
