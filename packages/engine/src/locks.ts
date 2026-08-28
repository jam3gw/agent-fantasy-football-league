/**
 * Player locks (§3.3). Lock is computed, never stored: a player is locked in
 * week W from the kickoff of his NFL team's week-W game until the week
 * finalizes. Past weeks are immutable through week checks (§7.1 check 7), so
 * lock only needs "kickoff ≤ now". Bye weeks and team-less players never lock.
 */
import { and, eq, inArray, lte, or } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "./db/index.ts";
import { nflGames, players } from "./db/schema.ts";

/** NFL teams whose week-W game has kicked off at `now`. */
export async function kickedOffTeams(
  db: EngineDb,
  season: number,
  week: number,
  now: Date,
): Promise<Set<string>> {
  const games = await db
    .select({ home: nflGames.home, away: nflGames.away })
    .from(nflGames)
    .where(and(eq(nflGames.season, season), eq(nflGames.week, week), lte(nflGames.kickoffAt, now)));
  const teams = new Set<string>();
  for (const g of games) {
    teams.add(g.home);
    teams.add(g.away);
  }
  return teams;
}

/** Subset of `playerIds` locked for week `week` at clock.now(). */
export async function lockedPlayerIds(
  db: EngineDb,
  clock: Clock,
  season: number,
  week: number,
  playerIds: string[],
): Promise<Set<string>> {
  if (playerIds.length === 0) return new Set();
  const locked = new Set<string>();
  const started = await kickedOffTeams(db, season, week, clock.now());
  if (started.size === 0) return locked;
  const rows = await db
    .select({ playerId: players.playerId, nflTeam: players.nflTeam })
    .from(players)
    .where(inArray(players.playerId, playerIds));
  for (const r of rows) {
    if (r.nflTeam && started.has(r.nflTeam)) locked.add(r.playerId);
  }
  return locked;
}

export async function isPlayerLocked(
  db: EngineDb,
  clock: Clock,
  season: number,
  week: number,
  playerId: string,
): Promise<boolean> {
  const locked = await lockedPlayerIds(db, clock, season, week, [playerId]);
  return locked.has(playerId);
}

/** Kickoff instant of the player's week-W game, or null (bye / no team / no schedule row). */
export async function playerKickoff(
  db: EngineDb,
  season: number,
  week: number,
  playerId: string,
): Promise<Date | null> {
  const playerRows = await db
    .select({ nflTeam: players.nflTeam })
    .from(players)
    .where(eq(players.playerId, playerId));
  const nflTeam = playerRows[0]?.nflTeam;
  if (!nflTeam) return null;
  const games = await db
    .select({ kickoffAt: nflGames.kickoffAt })
    .from(nflGames)
    .where(
      and(
        eq(nflGames.season, season),
        eq(nflGames.week, week),
        or(eq(nflGames.home, nflTeam), eq(nflGames.away, nflTeam)),
      ),
    );
  return games[0]?.kickoffAt ?? null;
}
