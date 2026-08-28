/**
 * Shared roster helpers: roster reads, active counts, IR legality (§3.6),
 * slot eligibility (§3.1), trade freezes and roster reservations (§3.5).
 */
import { and, eq, inArray, or } from "drizzle-orm";
import type { EngineDb } from "./db/index.ts";
import type { LineupSlot, StartingSlot } from "./db/schema.ts";
import { lineupEntries, players, rosterEntries, trades } from "./db/schema.ts";
import type { LeagueSettings } from "./settings.ts";

export const STARTING_SLOTS: StartingSlot[] = ["QB", "RB1", "RB2", "WR1", "WR2", "TE", "FLEX", "DST", "K"];
export const ALL_LINEUP_SLOTS: LineupSlot[] = [...STARTING_SLOTS, "IR"];

/** Eligible fantasy positions per slot (§3.1). DST uses Sleeper position DEF. */
export const SLOT_ELIGIBILITY: Record<StartingSlot, string[]> = {
  QB: ["QB"],
  RB1: ["RB"],
  RB2: ["RB"],
  WR1: ["WR"],
  WR2: ["WR"],
  TE: ["TE"],
  FLEX: ["RB", "WR", "TE"],
  DST: ["DEF"],
  K: ["K"],
};

export function eligibleForSlot(slot: StartingSlot, fantasyPositions: string[] | null): boolean {
  if (!fantasyPositions || fantasyPositions.length === 0) return false;
  return SLOT_ELIGIBILITY[slot].some((p) => fantasyPositions.includes(p));
}

export interface RosterPlayer {
  playerId: string;
  fullName: string;
  position: string | null;
  fantasyPositions: string[] | null;
  nflTeam: string | null;
  status: string | null;
  injuryStatus: string | null;
  acquiredVia: string;
  acquiredAt: Date;
}

export async function getRoster(db: EngineDb, teamId: number): Promise<RosterPlayer[]> {
  return db
    .select({
      playerId: rosterEntries.playerId,
      fullName: players.fullName,
      position: players.position,
      fantasyPositions: players.fantasyPositions,
      nflTeam: players.nflTeam,
      status: players.status,
      injuryStatus: players.injuryStatus,
      acquiredVia: rosterEntries.acquiredVia,
      acquiredAt: rosterEntries.acquiredAt,
    })
    .from(rosterEntries)
    .innerJoin(players, eq(players.playerId, rosterEntries.playerId))
    .where(eq(rosterEntries.teamId, teamId));
}

/** The team that rosters `playerId`, or null. */
export async function rosteredBy(db: EngineDb, playerId: string): Promise<number | null> {
  const rows = await db
    .select({ teamId: rosterEntries.teamId })
    .from(rosterEntries)
    .where(eq(rosterEntries.playerId, playerId));
  return rows[0]?.teamId ?? null;
}

/** Current IR occupant for the week (lineup entry with slot IR), or null. */
export async function irOccupant(db: EngineDb, teamId: number, week: number): Promise<string | null> {
  const rows = await db
    .select({ playerId: lineupEntries.playerId })
    .from(lineupEntries)
    .where(and(eq(lineupEntries.teamId, teamId), eq(lineupEntries.week, week), eq(lineupEntries.slot, "IR")));
  return rows[0]?.playerId ?? null;
}

/**
 * Active count (§7.1 check 5): roster size, minus 1 when the IR slot is
 * filled for the week by a player still on the roster.
 */
export async function activeCount(db: EngineDb, teamId: number, week: number): Promise<number> {
  const roster = await db
    .select({ playerId: rosterEntries.playerId })
    .from(rosterEntries)
    .where(eq(rosterEntries.teamId, teamId));
  const ir = await irOccupant(db, teamId, week);
  const irOnRoster = ir !== null && roster.some((r) => r.playerId === ir);
  return roster.length - (irOnRoster ? 1 : 0);
}

export function isIrEligible(
  settings: Pick<LeagueSettings, "irEligibleStatuses">,
  player: { status: string | null; injuryStatus: string | null },
): boolean {
  const set = settings.irEligibleStatuses;
  return (
    (player.injuryStatus !== null && set.includes(player.injuryStatus)) ||
    (player.status !== null && set.includes(player.status))
  );
}

/**
 * IR-illegal roster (§3.6): the week's IR occupant is on the roster but no
 * longer IR-eligible. Such a team cannot add players until it clears IR.
 */
export async function isIrIllegal(
  db: EngineDb,
  settings: Pick<LeagueSettings, "irEligibleStatuses">,
  teamId: number,
  week: number,
): Promise<boolean> {
  const ir = await irOccupant(db, teamId, week);
  if (ir === null) return false;
  const owner = await rosteredBy(db, ir);
  if (owner !== teamId) return false; // ghost IR entry — not this team's problem
  const rows = await db
    .select({ status: players.status, injuryStatus: players.injuryStatus })
    .from(players)
    .where(eq(players.playerId, ir));
  const p = rows[0];
  if (!p) return false;
  return !isIrEligible(settings, p);
}

/**
 * Players of `teamId` frozen by trades (§3.5): give-side of its own `proposed`
 * offers; both sides of `accepted` trades it is a party to. A frozen player
 * cannot be dropped, traded elsewhere, or put in another offer.
 */
export async function frozenPlayerIds(db: EngineDb, teamId: number): Promise<Set<string>> {
  const frozen = new Set<string>();
  const open = await db
    .select()
    .from(trades)
    .where(
      and(
        inArray(trades.status, ["proposed", "accepted"]),
        or(eq(trades.proposerTeamId, teamId), eq(trades.counterpartyTeamId, teamId)),
      ),
    );
  for (const t of open) {
    if (t.status === "proposed") {
      // only the proposer's give-side is frozen while proposed
      if (t.proposerTeamId === teamId) for (const p of t.givePlayerIds) frozen.add(p);
    } else {
      // accepted (in review): both sides
      if (t.proposerTeamId === teamId) for (const p of t.givePlayerIds) frozen.add(p);
      if (t.counterpartyTeamId === teamId) for (const p of t.getPlayerIds) frozen.add(p);
    }
  }
  return frozen;
}

/**
 * Roster reservation (§3.5): players incoming to `teamId` from trades in
 * review count toward its 14-active limit for free-agent adds and waiver
 * claims. Returns the count of such players.
 */
export async function incomingReservedCount(db: EngineDb, teamId: number): Promise<number> {
  const inReview = await db
    .select()
    .from(trades)
    .where(
      and(
        eq(trades.status, "accepted"),
        or(eq(trades.proposerTeamId, teamId), eq(trades.counterpartyTeamId, teamId)),
      ),
    );
  let count = 0;
  for (const t of inReview) {
    // proposer receives get-side; counterparty receives give-side
    count += t.proposerTeamId === teamId ? t.getPlayerIds.length : t.givePlayerIds.length;
  }
  return count;
}
