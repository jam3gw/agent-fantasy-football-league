/**
 * Lineup writes (§7.1): setLineup validates a full slot mapping, runs every
 * check and reports every violation, then replaces the team's non-ghost
 * lineup entries for the week. Ghost entries (§7.5 — rows whose player is not
 * on the team's roster) are ignored in input validation, block their slot
 * (unique team/week/slot), and are never modified or deleted here.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "./db/index.ts";
import type { LineupSlot, StartingSlot } from "./db/schema.ts";
import { lineupEntries, teams } from "./db/schema.ts";
import type { EngineErrorCode, EngineResult } from "./errors.ts";
import { fail, ok } from "./errors.ts";
import { lockedPlayerIds } from "./locks.ts";
import { ALL_LINEUP_SLOTS, STARTING_SLOTS, eligibleForSlot, getRoster, isIrEligible } from "./roster.ts";
import { getSettings } from "./settings.ts";
import { recordTransaction } from "./transactions.ts";

/** Full slot mapping input: missing key = null = empty slot. */
export type LineupSlotsInput = Partial<Record<LineupSlot, string | null>>;

/** One §7.1 violation. setLineup reports ALL of them, not only the first. */
export interface LineupViolation {
  check:
    | "input"
    | "on_roster"
    | "duplicate"
    | "slot_eligibility"
    | "ir_eligibility"
    | "active_count"
    | "ghost_slot"
    | "lock"
    | "week";
  code: EngineErrorCode;
  playerId?: string;
  slot?: LineupSlot;
  message: string;
}

export interface LineupState {
  /** The 9 starting slots as stored (non-ghost). */
  starters: Record<StartingSlot, string | null>;
  /** Rostered players with no lineup entry. */
  bench: string[];
  /** IR occupant as stored, or null. */
  ir: string | null;
}

/**
 * Set a team's full lineup for `week` (§7.1). `slots` maps each of the 9
 * starting slots and IR to a playerId or null; every rostered player not
 * named lands on the bench. Runs all checks and returns every failure in
 * `details` (top-level code = the first violation's code).
 */
export async function setLineup(
  db: EngineDb,
  clock: Clock,
  teamId: number,
  week: number,
  slots: LineupSlotsInput,
): Promise<EngineResult<LineupState>> {
  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    const team = (await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)))[0];
    if (!team) return fail("not_found", `team ${teamId} does not exist`);

    const violations: LineupViolation[] = [];

    // Normalize input to a full mapping; flag unknown keys / non-string values.
    const input = {} as Record<LineupSlot, string | null>;
    for (const slot of ALL_LINEUP_SLOTS) input[slot] = slots[slot] ?? null;
    for (const [key, value] of Object.entries(slots)) {
      if (!(ALL_LINEUP_SLOTS as string[]).includes(key)) {
        violations.push({
          check: "input",
          code: "invalid_args",
          message: `"${key}" is not a lineup slot (slots: ${ALL_LINEUP_SLOTS.join(", ")})`,
        });
      } else if (value !== null && value !== undefined && typeof value !== "string") {
        violations.push({
          check: "input",
          code: "invalid_args",
          slot: key as LineupSlot,
          message: `slot ${key} must be a playerId string or null`,
        });
      }
    }

    const roster = await getRoster(tx, teamId);
    const rosterMap = new Map(roster.map((p) => [p.playerId, p]));

    const named: Array<{ slot: LineupSlot; playerId: string }> = [];
    for (const slot of ALL_LINEUP_SLOTS) {
      const pid = input[slot];
      if (pid !== null && typeof pid === "string") named.push({ slot, playerId: pid });
    }

    // Current entries for the week, split into ghosts and non-ghosts (§7.5).
    const thisWeek = await tx
      .select({ id: lineupEntries.id, playerId: lineupEntries.playerId, slot: lineupEntries.slot })
      .from(lineupEntries)
      .where(and(eq(lineupEntries.teamId, teamId), eq(lineupEntries.week, week)));
    const ghosts = thisWeek.filter((r) => !rosterMap.has(r.playerId));
    const nonGhost = thisWeek.filter((r) => rosterMap.has(r.playerId));

    // 1. Every named player is on the roster.
    for (const { slot, playerId } of named) {
      if (!rosterMap.has(playerId)) {
        violations.push({
          check: "on_roster",
          code: "not_on_roster",
          playerId,
          slot,
          message: `player ${playerId} (named for ${slot}) is not on your roster`,
        });
      }
    }

    // 2. No player appears twice.
    const seen = new Map<string, LineupSlot>();
    const flaggedDup = new Set<string>();
    for (const { slot, playerId } of named) {
      const first = seen.get(playerId);
      if (first !== undefined && !flaggedDup.has(playerId)) {
        flaggedDup.add(playerId);
        violations.push({
          check: "duplicate",
          code: "duplicate_player",
          playerId,
          slot,
          message: `player ${playerId} appears in more than one slot (${first} and ${slot})`,
        });
      }
      seen.set(playerId, slot);
    }

    // 3. Slot eligibility via fantasy_positions (§3.1).
    for (const { slot, playerId } of named) {
      if (slot === "IR") continue;
      const p = rosterMap.get(playerId);
      if (!p) continue; // already flagged by check 1
      if (!eligibleForSlot(slot as StartingSlot, p.fantasyPositions)) {
        violations.push({
          check: "slot_eligibility",
          code: "slot_ineligible",
          playerId,
          slot,
          message: `${p.fullName} (${(p.fantasyPositions ?? []).join("/") || "?"}) is not eligible for ${slot}`,
        });
      }
    }

    // 4. IR: a CHANGED occupant must be IR-eligible; the current one is grandfathered (§3.6).
    const currentIr = nonGhost.find((r) => r.slot === "IR")?.playerId ?? null;
    const newIr = input.IR;
    if (newIr !== null && newIr !== currentIr) {
      const p = rosterMap.get(newIr);
      if (p && !isIrEligible(settings, p)) {
        violations.push({
          check: "ir_eligibility",
          code: "ir_ineligible",
          playerId: newIr,
          slot: "IR",
          message: `${p.fullName} is not IR-eligible (status ${p.injuryStatus ?? p.status ?? "unknown"}; eligible: ${settings.irEligibleStatuses.join(", ")})`,
        });
      }
    }

    // 5. Active count ≤ 14: roster size − 1 when the NEW IR slot is filled by a rostered player.
    const rs = settings.rosterSlots;
    const maxActive = rs.QB + rs.RB + rs.WR + rs.TE + rs.FLEX + rs.DST + rs.K + rs.BN;
    const newIrFilled = newIr !== null && rosterMap.has(newIr);
    const active = roster.length - (newIrFilled ? 1 : 0);
    if (active > maxActive) {
      violations.push({
        check: "active_count",
        code: "roster_full",
        message: `${active} active players exceeds the limit of ${maxActive}; fill IR with an eligible player or drop someone`,
      });
    }

    // Ghost-occupied slots are blocked for the week (unique team/week/slot; §7.5).
    const ghostBySlot = new Map(ghosts.map((g) => [g.slot, g]));
    for (const { slot, playerId } of named) {
      const ghost = ghostBySlot.get(slot);
      if (ghost) {
        violations.push({
          check: "ghost_slot",
          code: "locked",
          playerId,
          slot,
          message: `slot ${slot} is held by a ghost entry for traded player ${ghost.playerId} until the week finalizes`,
        });
      }
    }

    // 6. Locks (§3.3): a locked player cannot change slot (starter↔bench, into/out of IR).
    // lockedPlayerIds is naturally empty for week + 1 (no kickoffs yet).
    const lockIds = new Set<string>(named.map((n) => n.playerId));
    for (const r of nonGhost) lockIds.add(r.playerId);
    const locked = await lockedPlayerIds(tx, clock, settings.season, week, [...lockIds]);
    const currentSlotOf = new Map(nonGhost.map((r) => [r.playerId, r.slot]));
    const newSlotOf = new Map(named.map((n) => [n.playerId, n.slot]));
    for (const pid of locked) {
      const cur = currentSlotOf.get(pid) ?? null; // null = bench
      const next = newSlotOf.get(pid) ?? null;
      if (cur !== next) {
        violations.push({
          check: "lock",
          code: "locked",
          playerId: pid,
          slot: (next ?? cur)!,
          message:
            cur === null
              ? `player ${pid} is locked (game started) and cannot be moved into ${next}`
              : next === null
                ? `player ${pid} is locked (game started) and must stay in ${cur}`
                : `player ${pid} is locked (game started) and cannot move from ${cur} to ${next}`,
        });
      }
    }

    // 7. Week must be current_week or current_week + 1.
    if (week !== settings.currentWeek && week !== settings.currentWeek + 1) {
      violations.push({
        check: "week",
        code: "bad_week",
        message: `week ${week} is not settable; only week ${settings.currentWeek} or ${settings.currentWeek + 1}`,
      });
    }

    if (violations.length > 0) {
      const n = violations.length;
      return fail(violations[0]!.code, `lineup rejected: ${n} violation${n === 1 ? "" : "s"} (see details)`, {
        details: violations,
      });
    }

    // Apply: replace non-ghost entries for the week; ghosts stay untouched.
    const before = {} as Record<LineupSlot, string | null>;
    for (const slot of ALL_LINEUP_SLOTS) before[slot] = null;
    for (const r of nonGhost) before[r.slot] = r.playerId;

    if (nonGhost.length > 0) {
      await tx.delete(lineupEntries).where(
        inArray(
          lineupEntries.id,
          nonGhost.map((r) => r.id),
        ),
      );
    }
    if (named.length > 0) {
      await tx.insert(lineupEntries).values(named.map(({ slot, playerId }) => ({ teamId, week, playerId, slot })));
    }

    const diff: Partial<Record<LineupSlot, { from: string | null; to: string | null }>> = {};
    for (const slot of ALL_LINEUP_SLOTS) {
      if (before[slot] !== input[slot]) diff[slot] = { from: before[slot], to: input[slot] };
    }

    await recordTransaction(tx, {
      type: "lineup",
      week,
      teamIds: [teamId],
      payload: { week, before, after: input, diff },
    });

    const starters = {} as Record<StartingSlot, string | null>;
    for (const slot of STARTING_SLOTS) starters[slot] = input[slot];
    const namedSet = new Set(named.map((n) => n.playerId));
    const bench = roster.map((p) => p.playerId).filter((pid) => !namedSet.has(pid));
    return ok({ starters, bench, ir: input.IR });
  });
}
