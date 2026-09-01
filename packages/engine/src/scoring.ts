/**
 * Scoring and week finalization (SPEC §7.4, §7.7, §13.3).
 * The data fetch and the degradation ladder live in the M6 workflow; this is
 * the pure engine core that scores from whatever `player_week_stats` holds.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "./db/index.ts";
import {
  lineupEntries,
  matchups,
  nflGames,
  playerWeekStats,
  rosterEntries,
  teamWeekResults,
  teams,
} from "./db/schema.ts";
import type { EngineResult } from "./errors.ts";
import { ok } from "./errors.ts";
import { handleEvent } from "./events.ts";
import { computeOptimalLineup, optimalCandidates } from "./optimal.ts";
import { STARTING_SLOTS } from "./roster.ts";
import { getPlayoffSeeds } from "./standings.ts";
import { getSettings, updateSettings } from "./settings.ts";

/** Dot product of scoring settings and a stats object; missing keys count 0 (§3.2). */
export function computePoints(scoring: Record<string, number>, stats: Record<string, number>): number {
  let total = 0;
  for (const [k, v] of Object.entries(stats)) {
    const c = scoring[k];
    if (c) total += c * v;
  }
  return Math.round(total * 100) / 100;
}

const STARTING_SET: ReadonlySet<string> = new Set<string>(STARTING_SLOTS);

/** Points of one team's starting slots in a week; ghosts count, IR and bench never do (§7.4, §7.5). */
export async function teamWeekPoints(
  db: EngineDb,
  season: number,
  teamId: number,
  week: number,
): Promise<number> {
  const entries = await db
    .select({ playerId: lineupEntries.playerId, slot: lineupEntries.slot })
    .from(lineupEntries)
    .where(and(eq(lineupEntries.teamId, teamId), eq(lineupEntries.week, week)));
  const starters = entries.filter((e) => STARTING_SET.has(e.slot));
  if (starters.length === 0) return 0;
  const rows = await db
    .select({ playerId: playerWeekStats.playerId, ptsPpr: playerWeekStats.ptsPpr })
    .from(playerWeekStats)
    .where(
      and(
        eq(playerWeekStats.season, season),
        eq(playerWeekStats.week, week),
        inArray(
          playerWeekStats.playerId,
          starters.map((s) => s.playerId),
        ),
      ),
    );
  const pts = new Map(rows.map((r) => [r.playerId, r.ptsPpr ?? 0]));
  let total = 0;
  for (const s of starters) total += pts.get(s.playerId) ?? 0;
  return Math.round(total * 100) / 100;
}

/**
 * Recompute every matchup's points for a week from the latest stats (§7.4).
 * Used by the live poll; leaves `final` untouched.
 */
export async function scoreWeek(
  db: EngineDb,
  clock: Clock,
  week: number,
): Promise<Array<{ matchupId: number; homePoints: number; awayPoints: number }>> {
  const settings = await getSettings(db);
  const weekMatchups = await db.select().from(matchups).where(eq(matchups.week, week));
  const out: Array<{ matchupId: number; homePoints: number; awayPoints: number }> = [];
  for (const m of weekMatchups) {
    const homePoints = await teamWeekPoints(db, settings.season, m.homeTeamId, week);
    const awayPoints = await teamWeekPoints(db, settings.season, m.awayTeamId, week);
    await db
      .update(matchups)
      .set({ homePoints, awayPoints, updatedAt: clock.now() })
      .where(eq(matchups.id, m.id));
    out.push({ matchupId: m.id, homePoints, awayPoints });
  }
  return out;
}

export interface FinalizeResult {
  week: number;
  matchupsFinalized: number;
  resultsWritten: number;
  currentWeek: number;
}

/**
 * Finalize a week (§7.4): score, set winners, write team_week_results, advance
 * current_week, emit `week.finalized`. A week with no matchups (pre-draft or
 * before start_week) is a no-op that still advances the week (§4.3).
 * Stats for the week must already be in `player_week_stats` (M6 fetches them).
 */
/**
 * A game is over, by elapsed time alone, this long after kickoff — the same
 * backstop §13.2's live poll uses. Time, not `status`, because status is only
 * advanced while the tick is polling and must not gate finalization.
 */
const WEEK_COMPLETE_GAME_MS = 4.5 * 3600_000;

export type WeekCompletion =
  | { complete: true; lastGameEndsAt?: Date }
  | { complete: false; reason: "games_pending"; lastGameEndsAt: Date }
  | { complete: false; reason: "no_games_recorded" };

/**
 * Whether week `week`'s NFL games have all been played, i.e. whether the week
 * may finalize (§7.4). The 2026-09-01 incident: `stats.finalize` is booked
 * for every Tuesday 4:00 AM ET by the calendar, and the first Tuesday of the
 * "regular" phase fell nine days before week 1's first kickoff — the ladder
 * found no stats anywhere and finalized six 0.00–0.00 matchups, advancing
 * `current_week` past a week nobody had played. §7.4's "no-op that still
 * advances" is only for a week with no matchups at all.
 *
 * - No matchups for the week → complete (finalization is the spec'd no-op).
 * - Matchups but no `nfl_games` rows → NOT complete: the schedule feed is
 *   missing, and finalizing blind would repeat the incident.
 * - Otherwise → complete once every game's kickoff is `WEEK_COMPLETE_GAME_MS`
 *   in the past. Known limit: this trusts whatever rows the schedule ingest
 *   captured — a week where only its early games made it into `nfl_games`
 *   reads complete once those end. The daily `ingest.schedule` keeps the
 *   table whole in practice; the guard is against unplayed weeks, not a
 *   partially ingested one.
 */
export async function weekGamesComplete(db: EngineDb, clock: Clock, week: number): Promise<WeekCompletion> {
  const settings = await getSettings(db);
  const hasMatchups = await db.select({ id: matchups.id }).from(matchups).where(eq(matchups.week, week)).limit(1);
  if (hasMatchups.length === 0) return { complete: true };

  const games = await db
    .select({ kickoffAt: nflGames.kickoffAt })
    .from(nflGames)
    .where(and(eq(nflGames.season, settings.season), eq(nflGames.week, week)));
  if (games.length === 0) return { complete: false, reason: "no_games_recorded" };

  const lastEnd = new Date(Math.max(...games.map((g) => g.kickoffAt.getTime())) + WEEK_COMPLETE_GAME_MS);
  if (clock.now().getTime() < lastEnd.getTime()) {
    return { complete: false, reason: "games_pending", lastGameEndsAt: lastEnd };
  }
  return { complete: true, lastGameEndsAt: lastEnd };
}

export async function finalizeWeekCore(
  db: EngineDb,
  clock: Clock,
  week: number,
): Promise<EngineResult<FinalizeResult>> {
  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    const season = settings.season;
    const seeds = await getPlayoffSeeds(tx);
    const weekMatchups = await tx.select().from(matchups).where(eq(matchups.week, week));

    let resultsWritten = 0;
    for (const m of weekMatchups) {
      const homePoints = await teamWeekPoints(tx, season, m.homeTeamId, week);
      const awayPoints = await teamWeekPoints(tx, season, m.awayTeamId, week);

      let winnerTeamId: number | null;
      if (homePoints > awayPoints) winnerTeamId = m.homeTeamId;
      else if (awayPoints > homePoints) winnerTeamId = m.awayTeamId;
      else if (m.isPlayoff) {
        // §3.7: a playoff tie goes to the higher seed.
        const hs = seeds[String(m.homeTeamId)] ?? 99;
        const as = seeds[String(m.awayTeamId)] ?? 99;
        winnerTeamId = hs <= as ? m.homeTeamId : m.awayTeamId;
      } else {
        winnerTeamId = null; // regular-season tie: both credited 0.5 in standings
      }

      await tx
        .update(matchups)
        .set({ homePoints, awayPoints, final: true, winnerTeamId, updatedAt: clock.now() })
        .where(eq(matchups.id, m.id));

      for (const [teamId, actual] of [
        [m.homeTeamId, homePoints] as const,
        [m.awayTeamId, awayPoints] as const,
      ]) {
        await writeTeamWeekResult(tx, season, teamId, week, actual);
        resultsWritten++;
      }
    }

    const nextWeek = week + 1;
    const patch: Parameters<typeof updateSettings>[1] = { currentWeek: nextWeek };
    if (settings.phase === "regular" && nextWeek >= settings.playoffStartWeek) patch.phase = "playoffs";
    if (settings.phase === "playoffs" && nextWeek > settings.playoffStartWeek + 2) patch.phase = "complete";
    await updateSettings(tx, patch);

    await handleEvent(tx, clock, { type: "week.finalized", week });
    return ok({
      week,
      matchupsFinalized: weekMatchups.length,
      resultsWritten,
      currentWeek: nextWeek,
    });
  });
}

/** team_week_results for one team and week (§7.7). */
async function writeTeamWeekResult(
  db: EngineDb,
  season: number,
  teamId: number,
  week: number,
  actualPoints: number,
): Promise<void> {
  const entries = await db
    .select({ playerId: lineupEntries.playerId, slot: lineupEntries.slot })
    .from(lineupEntries)
    .where(and(eq(lineupEntries.teamId, teamId), eq(lineupEntries.week, week)));
  const starters = entries.filter((e) => STARTING_SET.has(e.slot));
  const emptyStartingSlots = STARTING_SLOTS.length - starters.length;

  const candidates = await optimalCandidates(db, season, teamId, week);
  const optimal = computeOptimalLineup(candidates);

  // fa_points: starting-slot points from players acquired via waiver or free
  // agency. Ghosts are off-roster, so they are never counted here.
  let faPoints = 0;
  if (starters.length > 0) {
    const acquired = await db
      .select({ playerId: rosterEntries.playerId, via: rosterEntries.acquiredVia })
      .from(rosterEntries)
      .where(eq(rosterEntries.teamId, teamId));
    const faIds = new Set(
      acquired.filter((a) => a.via === "waiver" || a.via === "free_agent").map((a) => a.playerId),
    );
    const faStarters = starters.filter((s) => faIds.has(s.playerId));
    if (faStarters.length > 0) {
      const rows = await db
        .select({ playerId: playerWeekStats.playerId, ptsPpr: playerWeekStats.ptsPpr })
        .from(playerWeekStats)
        .where(
          and(
            eq(playerWeekStats.season, season),
            eq(playerWeekStats.week, week),
            inArray(
              playerWeekStats.playerId,
              faStarters.map((s) => s.playerId),
            ),
          ),
        );
      for (const r of rows) faPoints += r.ptsPpr ?? 0;
    }
  }

  const values = {
    teamId,
    week,
    actualPoints,
    optimalPoints: optimal.total,
    pointsLeftOnBench: Math.round((optimal.total - actualPoints) * 100) / 100,
    faPoints: Math.round(faPoints * 100) / 100,
    emptyStartingSlots,
  };
  await db
    .insert(teamWeekResults)
    .values(values)
    .onConflictDoUpdate({
      target: [teamWeekResults.teamId, teamWeekResults.week],
      set: values,
    });
}

/** Teams with a matchup in a week (helper for the M6 workflow). */
export async function teamsWithMatchup(db: EngineDb, week: number): Promise<number[]> {
  const rows = await db.select().from(matchups).where(eq(matchups.week, week));
  const ids = new Set<number>();
  for (const m of rows) {
    ids.add(m.homeTeamId);
    ids.add(m.awayTeamId);
  }
  return [...ids];
}

/** All team ids (helper). */
export async function allTeamIds(db: EngineDb): Promise<number[]> {
  return (await db.select({ id: teams.id }).from(teams)).map((t) => t.id);
}
