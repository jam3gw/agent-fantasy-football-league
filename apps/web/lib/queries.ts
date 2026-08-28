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

/**
 * Pages use ISR (§12.1: revalidate 30 s live, 5 min otherwise), so Next
 * prerenders them at build time. A database that is unreachable or empty
 * during a build must not fail the deploy, and a blip at request time must not
 * 500 a public page — an empty section is the right degradation for a site
 * whose whole job is showing league state. `safeRead` runs one page query and
 * degrades to a fallback instead of throwing.
 *
 * Once one read has proved the database unreachable, the rest of the page's
 * reads would each wait out their own connect timeout — a page with a dozen
 * of them can blow past the 60 seconds Next allows a prerender and fail the
 * deploy. So the first connection failure opens a breaker: reads return their
 * fallback immediately until it lapses, and the page renders its empty state
 * at once. It closes on its own, so the next revalidation tries again.
 */
const BREAKER_MS = 5_000;
let unreachableUntil = 0;

const CONNECTION_CODES = new Set([
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "CONNECTION_REFUSED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

/** Is this "the database is not answering" rather than "that query is wrong"? */
function isConnectionFailure(error: unknown): boolean {
  for (let cause: unknown = error, depth = 0; cause && depth < 5; depth++) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && CONNECTION_CODES.has(code)) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

/** Test seam: forget that the database was unreachable. */
export function resetDatabaseBreaker(): void {
  unreachableUntil = 0;
}

export async function safeRead<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  if (Date.now() < unreachableUntil) return fallback;
  try {
    return await read();
  } catch (error) {
    if (isConnectionFailure(error)) unreachableUntil = Date.now() + BREAKER_MS;
    // Surfaced in the function logs and on /admin/health via the health table;
    // the page itself just renders empty.
    console.error("[page query failed]", error instanceof Error ? error.message : error);
    return fallback;
  }
}
