import "server-only";
/**
 * Read helpers shared by the public pages. Pages are server components that
 * read the database directly; nothing here is exposed to the client.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  boardPosts,
  computeStandings,
  getSettings,
  lineupEntries,
  matchups,
  players,
  playerWeekStats,
  reporterPosts,
  rosterEntries,
  teams,
  transactions,
  type StandingsRow,
} from "@league/engine";
import { db } from "./db";

export type TeamRow = typeof teams.$inferSelect;

export async function allTeams(): Promise<TeamRow[]> {
  return db().select().from(teams);
}

export async function teamBySlug(slug: string): Promise<TeamRow | undefined> {
  return (await db().select().from(teams).where(eq(teams.slug, slug)))[0];
}

export async function settings() {
  return getSettings(db());
}

export async function standings(): Promise<StandingsRow[]> {
  return computeStandings(db());
}

export async function weekMatchups(week: number) {
  return db().select().from(matchups).where(eq(matchups.week, week));
}

export async function latestReporterPost() {
  return (await db().select().from(reporterPosts).orderBy(desc(reporterPosts.createdAt)).limit(1))[0];
}

export async function latestBoardPosts(limit = 10) {
  return db().select().from(boardPosts).orderBy(desc(boardPosts.createdAt)).limit(limit);
}

export async function recentTransactions(limit = 50) {
  return db().select().from(transactions).orderBy(desc(transactions.createdAt)).limit(limit);
}

export interface LineupPlayer {
  slot: string;
  playerId: string;
  name: string;
  position: string | null;
  nflTeam: string | null;
  points: number;
}

/** A team's lineup for a week with points by player, ghosts included (§7.5). */
export async function teamLineup(teamId: number, week: number, season: number): Promise<LineupPlayer[]> {
  const entries = await db()
    .select({ playerId: lineupEntries.playerId, slot: lineupEntries.slot })
    .from(lineupEntries)
    .where(and(eq(lineupEntries.teamId, teamId), eq(lineupEntries.week, week)));
  if (entries.length === 0) return [];
  const ids = entries.map((e) => e.playerId);
  const meta = await db()
    .select({ playerId: players.playerId, name: players.fullName, position: players.position, nflTeam: players.nflTeam })
    .from(players)
    .where(inArray(players.playerId, ids));
  const stats = await db()
    .select({ playerId: playerWeekStats.playerId, ptsPpr: playerWeekStats.ptsPpr })
    .from(playerWeekStats)
    .where(and(eq(playerWeekStats.season, season), eq(playerWeekStats.week, week), inArray(playerWeekStats.playerId, ids)));
  const metaOf = new Map(meta.map((m) => [m.playerId, m]));
  const ptsOf = new Map(stats.map((s) => [s.playerId, s.ptsPpr ?? 0]));
  return entries.map((e) => ({
    slot: e.slot,
    playerId: e.playerId,
    name: metaOf.get(e.playerId)?.name ?? e.playerId,
    position: metaOf.get(e.playerId)?.position ?? null,
    nflTeam: metaOf.get(e.playerId)?.nflTeam ?? null,
    points: ptsOf.get(e.playerId) ?? 0,
  }));
}

/** Bench = rostered players with no lineup entry that week (§3.1). */
export async function teamBench(teamId: number, week: number, season: number): Promise<LineupPlayer[]> {
  const roster = await db()
    .select({ playerId: rosterEntries.playerId, name: players.fullName, position: players.position, nflTeam: players.nflTeam })
    .from(rosterEntries)
    .innerJoin(players, eq(players.playerId, rosterEntries.playerId))
    .where(eq(rosterEntries.teamId, teamId));
  const entries = await db()
    .select({ playerId: lineupEntries.playerId })
    .from(lineupEntries)
    .where(and(eq(lineupEntries.teamId, teamId), eq(lineupEntries.week, week)));
  const placed = new Set(entries.map((e) => e.playerId));
  const bench = roster.filter((r) => !placed.has(r.playerId));
  if (bench.length === 0) return [];
  const stats = await db()
    .select({ playerId: playerWeekStats.playerId, ptsPpr: playerWeekStats.ptsPpr })
    .from(playerWeekStats)
    .where(
      and(
        eq(playerWeekStats.season, season),
        eq(playerWeekStats.week, week),
        inArray(playerWeekStats.playerId, bench.map((b) => b.playerId)),
      ),
    );
  const ptsOf = new Map(stats.map((s) => [s.playerId, s.ptsPpr ?? 0]));
  return bench.map((b) => ({
    slot: "BN",
    playerId: b.playerId,
    name: b.name,
    position: b.position,
    nflTeam: b.nflTeam,
    points: ptsOf.get(b.playerId) ?? 0,
  }));
}
