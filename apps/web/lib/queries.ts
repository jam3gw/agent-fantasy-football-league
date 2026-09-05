import "server-only";
/**
 * Read helpers shared by the public pages. Pages are server components that
 * read the database directly; nothing here is exposed to the client.
 */
import { cache } from "react";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import {
  boardPosts,
  computeStandings,
  decisionLogs,
  getSettings,
  health,
  lineupEntries,
  matchups,
  nflGames,
  players,
  playerWeekStats,
  reporterPosts,
  rosterEntries,
  sessions,
  teams,
  transactions,
  type StandingsRow,
} from "@league/engine";
import { db } from "./db";
import type { SessionListRow } from "./sessionsFilter";

export type TeamRow = typeof teams.$inferSelect;

/**
 * `cache`d per request (React's request memo, a no-op outside a render):
 * the masthead runs on every route and the page under it reads the same
 * teams, settings and live status, so each is one query per request rather
 * than one per caller.
 */
export const allTeams = cache(async (): Promise<TeamRow[]> => {
  return db().select().from(teams);
});

export async function teamBySlug(slug: string): Promise<TeamRow | undefined> {
  return (await db().select().from(teams).where(eq(teams.slug, slug)))[0];
}

export const settings = cache(async () => {
  return getSettings(db());
});

export async function standings(): Promise<StandingsRow[]> {
  return computeStandings(db());
}

export async function weekMatchups(week: number) {
  return db().select().from(matchups).where(eq(matchups.week, week));
}

/**
 * Live scoring status for the public pages (§13.2, §13.4).
 *
 * §13.4: "if the Sleeper feed fails for 10 minutes during games, the site
 * shows 'Live scores delayed' and keeps the last data". That banner existed
 * only on /admin/health, so the one audience the rule is written for — the
 * spectators reading the scores — never saw it, and §13.2's "last update time"
 * was nowhere either.
 */
export const LIVE_STALE_MS = 10 * 60_000;

export interface LiveStatus {
  liveGames: number;
  lastUpdateAt: Date | null;
  delayed: boolean;
}

export const liveStatus = cache(async (now: Date = new Date()): Promise<LiveStatus> => {
  const current = await settings();
  const [live, poll] = await Promise.all([
    db()
      .select({ gameId: nflGames.gameId })
      .from(nflGames)
      .where(and(eq(nflGames.season, current.season), eq(nflGames.status, "live"))),
    db().select().from(health).where(eq(health.key, "live.poll")),
  ]);
  const lastUpdateAt = poll[0]?.lastSuccessAt ?? null;
  return {
    liveGames: live.length,
    lastUpdateAt,
    delayed:
      live.length > 0 && (lastUpdateAt === null || now.getTime() - lastUpdateAt.getTime() > LIVE_STALE_MS),
  };
});

export async function latestReporterPost() {
  return (await db().select().from(reporterPosts).orderBy(desc(reporterPosts.createdAt)).limit(1))[0];
}

export async function latestBoardPosts(limit = 10) {
  return db().select().from(boardPosts).orderBy(desc(boardPosts.createdAt)).limit(limit);
}

export async function recentTransactions(limit = 50) {
  return db().select().from(transactions).orderBy(desc(transactions.createdAt)).limit(limit);
}

/**
 * The newest sessions across every team, for `/sessions`. The reporter's
 * sessions have no team, so this is a left join: `teamSlug` and `teamName`
 * are null for them. Only the columns the page shows leave the server.
 *
 * Queued sessions are left out. The week plan books every team's lineup
 * checks days ahead (§9), so at any moment dozens of sessions exist that
 * have not started and have nothing to show; listing them buried the ones
 * that had run under a wall of "queued". A session appears here once it
 * starts, and /admin/teams still shows what is booked.
 */
export async function allSessions(limit = 300) {
  const rows = await db()
    .select({
      id: sessions.id,
      teamId: sessions.teamId,
      teamSlug: teams.slug,
      teamName: teams.name,
      modelLabel: teams.modelLabel,
      kind: sessions.kind,
      status: sessions.status,
      startedAt: sessions.startedAt,
      createdAt: sessions.createdAt,
      toolCalls: sessions.toolCalls,
      costUsd: sessions.costUsd,
    })
    .from(sessions)
    .leftJoin(teams, eq(teams.id, sessions.teamId))
    .where(ne(sessions.status, "queued"))
    .orderBy(desc(sessions.createdAt))
    .limit(limit);
  return attachSummaries(rows);
}

/**
 * A team's own sessions for its page, in the shape `/sessions` lists them,
 * queued ones left out for the same reason.
 */
export async function teamSessions(
  team: Pick<TeamRow, "id" | "slug" | "name" | "modelLabel">,
  limit = 100,
): Promise<SessionListRow[]> {
  const rows = await db()
    .select({
      id: sessions.id,
      teamId: sessions.teamId,
      kind: sessions.kind,
      status: sessions.status,
      startedAt: sessions.startedAt,
      createdAt: sessions.createdAt,
      toolCalls: sessions.toolCalls,
      costUsd: sessions.costUsd,
    })
    .from(sessions)
    .where(and(eq(sessions.teamId, team.id), ne(sessions.status, "queued")))
    .orderBy(desc(sessions.createdAt))
    .limit(limit);
  return attachSummaries(rows.map((r) => ({ ...r, teamSlug: team.slug, teamName: team.name, modelLabel: team.modelLabel })));
}

/**
 * The decision log a session ended with is the line its row leads with. A
 * team session writes at most one (§8.4); the reporter and a draft pick
 * write none. Read in one query rather than joined, so a session that
 * somehow has two logs still yields one row and not two.
 */
export async function attachSummaries<T extends { id: number }>(
  rows: T[],
): Promise<Array<T & { summary: string | null }>> {
  if (rows.length === 0) return [];
  const logs = await db()
    .select({ sessionId: decisionLogs.sessionId, summary: decisionLogs.summary })
    .from(decisionLogs)
    .where(
      inArray(
        decisionLogs.sessionId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(desc(decisionLogs.createdAt));
  const summaryOf = new Map<number, string>();
  for (const log of logs) {
    if (log.sessionId !== null && !summaryOf.has(log.sessionId)) summaryOf.set(log.sessionId, log.summary);
  }
  return rows.map((r) => ({ ...r, summary: summaryOf.get(r.id) ?? null }));
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
  return (await teamLineups([teamId], week, season)).get(teamId) ?? [];
}

/**
 * The lineups of several teams in one round trip each: one query for the
 * entries, then the player names and the week's points for all of them at
 * once. A week's matchups page needs every team's lineup, and twelve calls
 * to `teamLineup` cost thirty-six serial round trips to the database; this
 * costs three. A team with no entries that week is left out of the map.
 */
export async function teamLineups(
  teamIds: number[],
  week: number,
  season: number,
): Promise<Map<number, LineupPlayer[]>> {
  const byTeam = new Map<number, LineupPlayer[]>();
  if (teamIds.length === 0) return byTeam;
  const entries = await db()
    .select({ teamId: lineupEntries.teamId, playerId: lineupEntries.playerId, slot: lineupEntries.slot })
    .from(lineupEntries)
    .where(and(inArray(lineupEntries.teamId, teamIds), eq(lineupEntries.week, week)));
  if (entries.length === 0) return byTeam;
  const ids = [...new Set(entries.map((e) => e.playerId))];
  const [meta, stats] = await Promise.all([
    db()
      .select({ playerId: players.playerId, name: players.fullName, position: players.position, nflTeam: players.nflTeam })
      .from(players)
      .where(inArray(players.playerId, ids)),
    db()
      .select({ playerId: playerWeekStats.playerId, ptsPpr: playerWeekStats.ptsPpr })
      .from(playerWeekStats)
      .where(and(eq(playerWeekStats.season, season), eq(playerWeekStats.week, week), inArray(playerWeekStats.playerId, ids))),
  ]);
  const metaOf = new Map(meta.map((m) => [m.playerId, m]));
  const ptsOf = new Map(stats.map((s) => [s.playerId, s.ptsPpr ?? 0]));
  for (const e of entries) {
    const list = byTeam.get(e.teamId) ?? [];
    list.push({
      slot: e.slot,
      playerId: e.playerId,
      name: metaOf.get(e.playerId)?.name ?? e.playerId,
      position: metaOf.get(e.playerId)?.position ?? null,
      nflTeam: metaOf.get(e.playerId)?.nflTeam ?? null,
      points: ptsOf.get(e.playerId) ?? 0,
    });
    byTeam.set(e.teamId, list);
  }
  return byTeam;
}

/** Bench = rostered players with no lineup entry that week (§3.1). */
export async function teamBench(teamId: number, week: number, season: number): Promise<LineupPlayer[]> {
  const [roster, entries] = await Promise.all([
    db()
      .select({ playerId: rosterEntries.playerId, name: players.fullName, position: players.position, nflTeam: players.nflTeam })
      .from(rosterEntries)
      .innerJoin(players, eq(players.playerId, rosterEntries.playerId))
      .where(eq(rosterEntries.teamId, teamId)),
    db()
      .select({ playerId: lineupEntries.playerId })
      .from(lineupEntries)
      .where(and(eq(lineupEntries.teamId, teamId), eq(lineupEntries.week, week))),
  ]);
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

/**
 * Codes that mean the database could not be reached at all. Deliberately not
 * here: `ECONNRESET` and `CONNECTION_CLOSED`, which are how a pooler drops an
 * idle connection — a single one of those must not blank a page, least of all
 * a page whose empty render the CDN would then cache for five minutes.
 */
const CONNECTION_CODES = new Set([
  "CONNECT_TIMEOUT",
  "CONNECTION_REFUSED",
  "ECONNREFUSED",
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
