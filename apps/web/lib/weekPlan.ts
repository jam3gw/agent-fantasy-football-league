import "server-only";
/**
 * Week planning details (SPEC §9.2 `weekPlanWorkflow` steps 3 and 5).
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Clock } from "@league/shared";
import { sessionKey } from "@league/shared";
import type { EngineDb } from "@league/engine";
import {
  advancePlayoffs,
  createSession,
  getSettings,
  groupKickoffWindows,
  lineupCheckDueAt,
  nflGames,
  players,
  rosterEntries,
  seedPlayoffs,
  teams,
} from "@league/engine";

// The window grouping and the 90-minute lead live in the engine so the
// context snapshot can tell an agent when these checks run (§8.5).
export { groupKickoffWindows, LINEUP_CHECK_LEAD_MS } from "@league/engine";
export type { GameWindow } from "@league/engine";

/**
 * Book a `lineup_check` 90 minutes before each window, for every active team
 * with at least one rostered player in that window (§9.2 step 3).
 */
export async function bookLineupChecks(db: EngineDb, clock: Clock, week: number): Promise<number> {
  const settings = await getSettings(db);
  if (!["regular", "playoffs"].includes(settings.phase)) return 0;
  if (week < settings.startWeek) return 0;

  const games = await db
    .select({ kickoffAt: nflGames.kickoffAt, home: nflGames.home, away: nflGames.away })
    .from(nflGames)
    .where(and(eq(nflGames.season, settings.season), eq(nflGames.week, week)));
  if (games.length === 0) return 0;

  const windows = groupKickoffWindows(games);
  const allTeams = (await db.select().from(teams)).filter((t) => !t.paused && !t.eliminated);

  // Which NFL teams each fantasy team rosters.
  const rosters = await db
    .select({ teamId: rosterEntries.teamId, nflTeam: players.nflTeam })
    .from(rosterEntries)
    .innerJoin(players, eq(players.playerId, rosterEntries.playerId));
  const nflTeamsByTeam = new Map<number, Set<string>>();
  for (const r of rosters) {
    if (!r.nflTeam) continue;
    const set = nflTeamsByTeam.get(r.teamId) ?? new Set<string>();
    set.add(r.nflTeam);
    nflTeamsByTeam.set(r.teamId, set);
  }

  const now = clock.now();
  let booked = 0;
  for (const window of windows) {
    const dueAt = lineupCheckDueAt(window);
    if (dueAt.getTime() <= now.getTime()) continue; // window already upon us
    const windowTeams = new Set(window.nflTeams);
    // Staggered a minute apart, like the other per-team bookings (§9.1). Only
    // six sessions run at once (§9.2), so booking all twelve for the same
    // instant just means six of them spend their first minutes waiting for a
    // slot — and the lead time is 90 minutes, so a stagger costs nothing.
    let offset = 0;
    for (const team of allTeams) {
      const mine = nflTeamsByTeam.get(team.id);
      if (!mine || ![...mine].some((t) => windowTeams.has(t))) continue;
      const created = await createSession(db, settings, {
        teamId: team.id,
        kind: "lineup_check",
        trigger: "week.plan",
        idempotencyKey: sessionKey(
          team.id,
          "lineup_check",
          settings.season,
          week,
          window.key.toISOString(),
        ),
        modelId: team.modelId,
        dueAt: new Date(dueAt.getTime() + offset * 60_000),
        now,
        // The deadline is the real event: this window's kickoff (§8.3).
        deadlineAt: window.key,
        context: { week, window_kickoff_et: window.key.toISOString() },
      });
      offset++;
      if (created !== null) booked++;
    }
  }
  return booked;
}

/**
 * Seed the playoffs at `playoff_start_week`, or create the next round from the
 * previous one (§9.2 step 5).
 */
export async function seedOrAdvancePlayoffs(db: EngineDb, clock: Clock, week: number): Promise<void> {
  const settings = await getSettings(db);
  if (week === settings.playoffStartWeek) {
    await seedPlayoffs(db, clock);
    return;
  }
  if (week > settings.playoffStartWeek && week <= settings.playoffStartWeek + 2) {
    await advancePlayoffs(db, clock, week - 1);
  }
}

/** Teams that roster a player on any of the given NFL teams (helper for tests). */
export async function teamsWithPlayersIn(db: EngineDb, nflTeams: string[]): Promise<number[]> {
  if (nflTeams.length === 0) return [];
  const rows = await db
    .select({ teamId: rosterEntries.teamId })
    .from(rosterEntries)
    .innerJoin(players, eq(players.playerId, rosterEntries.playerId))
    .where(inArray(players.nflTeam, nflTeams));
  return [...new Set(rows.map((r) => r.teamId))];
}
