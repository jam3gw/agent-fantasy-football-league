/**
 * Power rankings (SPEC §11). The reporter ranks the twelve teams and gives a
 * reason for each place; the site shows the newest edition and how each team
 * moved since the one before. The page computes nothing: a ranking is an
 * opinion, and the reporter is the one with opinions.
 */
import { desc, eq, inArray } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "./db/index.ts";
import { powerRankings, teams } from "./db/schema.ts";
import type { EngineResult } from "./errors.ts";
import { fail, ok } from "./errors.ts";

export const MAX_RANKING_REASON_LENGTH = 400;

export interface PowerRankingEntry {
  teamId: number;
  rank: number;
  reason: string;
}

export interface PowerRankingRow extends PowerRankingEntry {
  sessionId: number;
  week: number;
  createdAt: Date;
}

export interface PowerRankingEdition {
  sessionId: number;
  week: number;
  createdAt: Date;
  entries: PowerRankingRow[];
}

/**
 * Write one edition: every team exactly once, ranks 1..N with no gaps, a
 * non-empty reason for each. One transaction; a second call from the same
 * session returns the edition already written rather than a second one.
 */
export async function publishPowerRankings(
  db: EngineDb,
  clock: Clock,
  args: { sessionId: number; week: number; entries: PowerRankingEntry[] },
): Promise<EngineResult<{ count: number; alreadyPublished: boolean }>> {
  const allTeams = await db.select({ id: teams.id, name: teams.name }).from(teams);
  const teamIds = new Set(allTeams.map((t) => t.id));
  const seenTeams = new Set<number>();
  const seenRanks = new Set<number>();
  for (const e of args.entries) {
    if (!teamIds.has(e.teamId)) return fail("not_found", `there is no team ${e.teamId}`);
    if (seenTeams.has(e.teamId)) return fail("invalid_args", `team ${e.teamId} appears twice`);
    seenTeams.add(e.teamId);
    if (!Number.isInteger(e.rank) || e.rank < 1 || e.rank > allTeams.length)
      return fail("invalid_args", `rank ${e.rank} is not between 1 and ${allTeams.length}`);
    if (seenRanks.has(e.rank)) return fail("invalid_args", `rank ${e.rank} is used twice`);
    seenRanks.add(e.rank);
    if (!e.reason.trim()) return fail("invalid_args", `team ${e.teamId} has no reason`);
    if (e.reason.length > MAX_RANKING_REASON_LENGTH)
      return fail(
        "too_long",
        `the reason for team ${e.teamId} is ${e.reason.length} characters; the maximum is ${MAX_RANKING_REASON_LENGTH}`,
      );
  }
  if (seenTeams.size !== allTeams.length) {
    const missing = allTeams.filter((t) => !seenTeams.has(t.id)).map((t) => `${t.id} (${t.name ?? "unnamed"})`);
    return fail("invalid_args", `every team must be ranked; missing: ${missing.join(", ")}`);
  }

  const now = clock.now();
  return db.transaction(async (tx) => {
    // A session publishes once. An edition already under this session is the
    // interrupted-and-resumed case (§8.2): the insert landed, the tool result
    // did not, and the model is calling again — that is a success, not a
    // second edition, so the session can end on it.
    const existing = await tx
      .select({ id: powerRankings.id })
      .from(powerRankings)
      .where(eq(powerRankings.sessionId, args.sessionId));
    if (existing.length > 0) return ok({ count: existing.length, alreadyPublished: true });
    await tx.insert(powerRankings).values(
      args.entries.map((e) => ({
        week: args.week,
        teamId: e.teamId,
        rank: e.rank,
        reason: e.reason.trim(),
        sessionId: args.sessionId,
        createdAt: now,
      })),
    );
    return ok({ count: args.entries.length, alreadyPublished: false });
  });
}

/**
 * The newest `limit` editions, newest first, each with its rows in rank order.
 * An edition is a session's set of rows; `limit` 2 gives the current one and
 * the one to measure movement against.
 */
export async function latestPowerRankings(db: EngineDb, limit = 2): Promise<PowerRankingEdition[]> {
  const heads = await db
    .selectDistinctOn([powerRankings.sessionId], {
      sessionId: powerRankings.sessionId,
      week: powerRankings.week,
      createdAt: powerRankings.createdAt,
    })
    .from(powerRankings)
    .orderBy(powerRankings.sessionId, desc(powerRankings.createdAt));
  const sorted = heads
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.sessionId - a.sessionId)
    .slice(0, limit);
  if (sorted.length === 0) return [];
  const rows = await db
    .select()
    .from(powerRankings)
    .where(
      inArray(
        powerRankings.sessionId,
        sorted.map((h) => h.sessionId),
      ),
    )
    .orderBy(powerRankings.rank);
  return sorted.map((h) => ({
    sessionId: h.sessionId,
    week: h.week,
    createdAt: h.createdAt,
    entries: rows.filter((r) => r.sessionId === h.sessionId),
  }));
}

/** Places gained since `previous` (positive is up); 0 when unchanged or unranked before. */
export function rankingMovement(
  current: PowerRankingEdition,
  previous: PowerRankingEdition | undefined,
): Map<number, number> {
  const before = new Map((previous?.entries ?? []).map((e) => [e.teamId, e.rank]));
  const out = new Map<number, number>();
  for (const e of current.entries) {
    const b = before.get(e.teamId);
    out.set(e.teamId, b === undefined ? 0 : b - e.rank);
  }
  return out;
}
