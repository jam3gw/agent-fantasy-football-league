/**
 * Optimal lineup (SPEC §7.7): the legal 9-slot lineup with the maximum points
 * from the players available to a team in a finalized week.
 *
 * Greedy per-position selection is wrong when players carry several
 * `fantasy_positions` (Sleeper does this), so this is a true exhaustive
 * search — backtracking over slots, scarcest first, with a branch bound. A
 * roster is at most 15 players over 9 slots, so the search is tiny.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { EngineDb } from "./db/index.ts";
import type { StartingSlot } from "./db/schema.ts";
import { lineupEntries, playerWeekStats, rosterEntries } from "./db/schema.ts";
import { SLOT_ELIGIBILITY, STARTING_SLOTS, eligibleForSlot } from "./roster.ts";

export interface OptimalCandidate {
  playerId: string;
  fantasyPositions: string[] | null;
  pts: number;
}

export interface OptimalLineup {
  total: number;
  /** Slot → playerId for the slots that could be filled. */
  assignment: Partial<Record<StartingSlot, string>>;
}

/**
 * Slot fill order: most constrained first (FLEX last, as §7.7 requires),
 * which prunes the search early.
 */
const SLOT_ORDER: StartingSlot[] = ["DST", "K", "QB", "TE", "RB1", "RB2", "WR1", "WR2", "FLEX"];

export function computeOptimalLineup(candidates: OptimalCandidate[]): OptimalLineup {
  const eligible = new Map<StartingSlot, OptimalCandidate[]>();
  for (const slot of SLOT_ORDER) {
    eligible.set(
      slot,
      candidates
        .filter((c) => eligibleForSlot(slot, c.fantasyPositions))
        .sort((a, b) => b.pts - a.pts),
    );
  }

  // Upper bound on what slots from index i onward can still add.
  const suffixBound: number[] = new Array(SLOT_ORDER.length + 1).fill(0);
  for (let i = SLOT_ORDER.length - 1; i >= 0; i--) {
    const best = eligible.get(SLOT_ORDER[i]!)![0]?.pts ?? 0;
    suffixBound[i] = suffixBound[i + 1]! + Math.max(0, best);
  }

  let bestTotal = -Infinity;
  let bestAssignment: Partial<Record<StartingSlot, string>> = {};
  const used = new Set<string>();
  const current: Partial<Record<StartingSlot, string>> = {};

  const search = (i: number, total: number): void => {
    if (i === SLOT_ORDER.length) {
      if (total > bestTotal) {
        bestTotal = total;
        bestAssignment = { ...current };
      }
      return;
    }
    if (total + suffixBound[i]! <= bestTotal) return; // cannot beat the best found

    const slot = SLOT_ORDER[i]!;
    for (const c of eligible.get(slot)!) {
      if (used.has(c.playerId)) continue;
      used.add(c.playerId);
      current[slot] = c.playerId;
      search(i + 1, total + c.pts);
      used.delete(c.playerId);
      delete current[slot];
    }
    // Leaving the slot empty is always legal (§3.1: an empty slot scores 0),
    // and is the right move when every eligible player would score negative.
    search(i + 1, total);
  };

  search(0, 0);
  return { total: Math.round((bestTotal === -Infinity ? 0 : bestTotal) * 100) / 100, assignment: bestAssignment };
}

/**
 * Candidates for a team's week (§7.7): every player on the roster at call time
 * plus any ghost entries for that week (a traded-away locked starter still
 * scores for the old team).
 */
export async function optimalCandidates(
  db: EngineDb,
  season: number,
  teamId: number,
  week: number,
): Promise<OptimalCandidate[]> {
  const { players } = await import("./db/schema.ts");
  const rostered = await db
    .select({
      playerId: rosterEntries.playerId,
      fantasyPositions: players.fantasyPositions,
    })
    .from(rosterEntries)
    .innerJoin(players, eq(players.playerId, rosterEntries.playerId))
    .where(eq(rosterEntries.teamId, teamId));

  const entries = await db
    .select({ playerId: lineupEntries.playerId, slot: lineupEntries.slot })
    .from(lineupEntries)
    .where(and(eq(lineupEntries.teamId, teamId), eq(lineupEntries.week, week)));

  const rosterIds = new Set(rostered.map((r) => r.playerId));
  const ghostIds = entries.filter((e) => !rosterIds.has(e.playerId)).map((e) => e.playerId);
  let ghosts: Array<{ playerId: string; fantasyPositions: string[] | null }> = [];
  if (ghostIds.length > 0) {
    ghosts = await db
      .select({ playerId: players.playerId, fantasyPositions: players.fantasyPositions })
      .from(players)
      .where(inArray(players.playerId, ghostIds));
  }

  const all = [...rostered, ...ghosts];
  if (all.length === 0) return [];
  const statRows = await db
    .select({ playerId: playerWeekStats.playerId, ptsPpr: playerWeekStats.ptsPpr })
    .from(playerWeekStats)
    .where(
      and(
        eq(playerWeekStats.season, season),
        eq(playerWeekStats.week, week),
        inArray(
          playerWeekStats.playerId,
          all.map((p) => p.playerId),
        ),
      ),
    );
  const pts = new Map(statRows.map((r) => [r.playerId, r.ptsPpr ?? 0]));
  return all.map((p) => ({
    playerId: p.playerId,
    fantasyPositions: p.fantasyPositions,
    pts: pts.get(p.playerId) ?? 0,
  }));
}

export async function optimalForTeamWeek(
  db: EngineDb,
  season: number,
  teamId: number,
  week: number,
): Promise<OptimalLineup> {
  return computeOptimalLineup(await optimalCandidates(db, season, teamId, week));
}

/** Exported for tests: the slots a brute-force check must fill. */
export const OPTIMAL_SLOTS = STARTING_SLOTS;
export { SLOT_ELIGIBILITY };
