/**
 * Waivers and free agency (SPEC §3.4, §7.2, §7.3).
 *
 * - `submitWaiverClaims` / `cancelWaiverClaims`: manage a team's pending claim
 *   list (claims are not public transactions until processed).
 * - `addFreeAgent` / `dropPlayer`: immediate roster moves.
 * - `runWaivers`: the §7.2 rolling-priority algorithm.
 * - `gameStartWaivers`: §7.3 game-start waiver rule.
 */
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, notExists, notInArray, or } from "drizzle-orm";
import type { Clock } from "@league/shared";
import { nextEtTime, nextEtWeekdayTime } from "@league/shared";
import type { EngineDb } from "./db/index.ts";
import type { WaiverRunSummary } from "./db/schema.ts";
import { lineupEntries, nflGames, players, rosterEntries, teams, waiverClaims, waiverRuns } from "./db/schema.ts";
import type { EngineErrorCode, EngineResult } from "./errors.ts";
import { fail, ok } from "./errors.ts";
import { handleEvent } from "./events.ts";
import { lockedPlayerIds } from "./locks.ts";
import { frozenPlayerIds, incomingReservedCount, irOccupant, isIrIllegal, maxActiveRoster, rosteredBy } from "./roster.ts";
import type { LeagueSettings } from "./settings.ts";
import { getSettings } from "./settings.ts";
import { recordTransaction } from "./transactions.ts";

export type StoredWaiverClaim = typeof waiverClaims.$inferSelect;

export interface WaiverClaimInput {
  addPlayerId: string;
  dropPlayerId?: string | null;
  /** Orders the team's own claims at a run (lower first). */
  priority: number;
}

interface ClaimFailure {
  index: number;
  addPlayerId: string;
  error: EngineErrorCode;
  message: string;
  hint?: string;
}

/** Parsed `waiver_run_time_et` ("HH:MM", default 04:30). */
function runTimeEt(settings: Pick<LeagueSettings, "waiverRunTimeEt">): { hh: number; mm: number } {
  const [hh, mm] = settings.waiverRunTimeEt.split(":");
  return { hh: Number(hh ?? "4"), mm: Number(mm ?? "30") };
}

/** First daily waiver run time (waiver_run_time_et, every day) at or after `at`. */
export function nextWaiverRunTime(settings: Pick<LeagueSettings, "waiverRunTimeEt">, at: Date): Date {
  const { hh, mm } = runTimeEt(settings);
  return nextEtTime(at, hh, mm);
}

/**
 * `waiver_until` for a player dropped at `from` (§3.4 rule 1): the first daily
 * run time at or after `from + waiver_clear_hours`.
 */
export function dropWaiverUntil(
  settings: Pick<LeagueSettings, "waiverRunTimeEt" | "waiverClearHours">,
  from: Date,
): Date {
  return nextWaiverRunTime(settings, new Date(from.getTime() + settings.waiverClearHours * 3600_000));
}

const maxActive = maxActiveRoster;

/**
 * Shared drop path (§7.2): delete the roster entry, delete the player's lineup
 * entries for the current week and the next (never creates ghosts), put him on
 * waivers until the first run at or after `refTime + waiver_clear_hours`, and
 * record the public `drop` transaction. Returns the new `waiver_until`.
 * Callers validate (ownership, lock, freeze) before calling.
 */
async function applyDrop(
  tx: EngineDb,
  settings: LeagueSettings,
  teamId: number,
  playerId: string,
  refTime: Date,
  via: "drop" | "free_agent_add" | "waiver_claim",
): Promise<Date> {
  const week = settings.currentWeek;
  await tx
    .delete(rosterEntries)
    .where(and(eq(rosterEntries.teamId, teamId), eq(rosterEntries.playerId, playerId)));
  await tx
    .delete(lineupEntries)
    .where(
      and(
        eq(lineupEntries.teamId, teamId),
        eq(lineupEntries.playerId, playerId),
        inArray(lineupEntries.week, [week, week + 1]),
      ),
    );
  const waiverUntil = dropWaiverUntil(settings, refTime);
  await tx.update(players).set({ waiverUntil, updatedAt: refTime }).where(eq(players.playerId, playerId));
  await recordTransaction(tx, {
    type: "drop",
    week,
    teamIds: [teamId],
    payload: { playerId, waiverUntil: waiverUntil.toISOString(), via },
  });
  return waiverUntil;
}

/**
 * Simulated active count after adding one player (bench) and optionally
 * dropping `dropPlayerId`, including incoming players of trades in review
 * (§3.5 roster reservation).
 */
async function simulatedActiveAfterAdd(
  tx: EngineDb,
  teamId: number,
  week: number,
  dropPlayerId: string | null,
): Promise<number> {
  const roster = await tx
    .select({ playerId: rosterEntries.playerId })
    .from(rosterEntries)
    .where(eq(rosterEntries.teamId, teamId));
  const ir = await irOccupant(tx, teamId, week);
  const irFilled = ir !== null && ir !== dropPlayerId && roster.some((r) => r.playerId === ir);
  const reserved = await incomingReservedCount(tx, teamId, week);
  return roster.length + 1 - (dropPlayerId ? 1 : 0) - (irFilled ? 1 : 0) + reserved;
}

/**
 * Replace the team's pending waiver-claim list (§7.2). Claims are **rejected
 * per claim**: the valid ones become the team's pending list and the invalid
 * ones come back in `rejected`, so one bad player id does not throw away the
 * rest of an agent's week. Valid claims for players whose `waiver_until` is in
 * the future are accepted — they wait for a later run. No public transaction is
 * recorded; claims become public when processed.
 */
export async function submitWaiverClaims(
  db: EngineDb,
  clock: Clock,
  teamId: number,
  claims: WaiverClaimInput[],
): Promise<EngineResult<{ accepted: StoredWaiverClaim[]; rejected: ClaimFailure[] }>> {
  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    const week = settings.currentWeek;
    const teamRows = await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId));
    if (teamRows.length === 0) return fail("not_found", `team ${teamId} not found`);

    const frozen = await frozenPlayerIds(tx, teamId);
    const rosterRows = await tx
      .select({ playerId: rosterEntries.playerId })
      .from(rosterEntries)
      .where(eq(rosterEntries.teamId, teamId));
    const myRoster = new Set(rosterRows.map((r) => r.playerId));
    const dropIds = claims.flatMap((c) => (c.dropPlayerId ? [c.dropPlayerId] : []));
    const lockedDrops = await lockedPlayerIds(tx, clock, settings.season, week, dropIds);

    const failures: ClaimFailure[] = [];
    for (const [index, claim] of claims.entries()) {
      const playerRows = await tx
        .select({ waiverUntil: players.waiverUntil })
        .from(players)
        .where(eq(players.playerId, claim.addPlayerId));
      const player = playerRows[0];
      if (!player) {
        failures.push({
          index,
          addPlayerId: claim.addPlayerId,
          error: "not_found",
          message: `player ${claim.addPlayerId} not found`,
        });
        continue;
      }
      const owner = await rosteredBy(tx, claim.addPlayerId);
      if (owner !== null) {
        failures.push({
          index,
          addPlayerId: claim.addPlayerId,
          error: "already_rostered",
          message: `player ${claim.addPlayerId} is already on a roster`,
        });
        continue;
      }
      if (player.waiverUntil === null) {
        failures.push({
          index,
          addPlayerId: claim.addPlayerId,
          error: "not_on_waivers",
          message: `player ${claim.addPlayerId} is a free agent, not on waivers`,
          hint: "use add_free_agent",
        });
        continue;
      }
      if (claim.dropPlayerId) {
        if (!myRoster.has(claim.dropPlayerId)) {
          failures.push({
            index,
            addPlayerId: claim.addPlayerId,
            error: "invalid_drop",
            message: `drop player ${claim.dropPlayerId} is not on your roster`,
          });
        } else if (frozen.has(claim.dropPlayerId)) {
          failures.push({
            index,
            addPlayerId: claim.addPlayerId,
            error: "invalid_drop",
            message: `drop player ${claim.dropPlayerId} is frozen in a trade`,
          });
        } else if (lockedDrops.has(claim.dropPlayerId)) {
          failures.push({
            index,
            addPlayerId: claim.addPlayerId,
            error: "invalid_drop",
            message: `drop player ${claim.dropPlayerId} is locked`,
          });
        }
      }
    }
    const rejectedIndexes = new Set(failures.map((f) => f.index));
    const accepted = claims.filter((_, index) => !rejectedIndexes.has(index));

    // Nothing valid and something rejected: keep the list the team already had.
    // "Valid claims replace the pending list" (§7.2) — no valid claims, no
    // replacement. Otherwise a resubmission where every player has since been
    // rostered would silently leave the team with no claims at all on the
    // morning of the run. An explicit empty list still clears it.
    if (accepted.length === 0 && failures.length > 0) {
      return ok({ accepted: [], rejected: failures });
    }

    // Replace the pending list: cancel everything pending, insert the valid set.
    await tx
      .update(waiverClaims)
      .set({ status: "cancelled" })
      .where(and(eq(waiverClaims.teamId, teamId), eq(waiverClaims.status, "pending")));
    if (accepted.length === 0) return ok({ accepted: [], rejected: failures });
    const rows = await tx
      .insert(waiverClaims)
      .values(
        accepted.map((c) => ({
          teamId,
          addPlayerId: c.addPlayerId,
          dropPlayerId: c.dropPlayerId ?? null,
          priority: c.priority,
          createdAt: clock.now(),
        })),
      )
      .returning();
    return ok({ accepted: rows, rejected: failures });
  });
}

/** Cancel all of the team's pending claims. Returns how many were cancelled. */
export async function cancelWaiverClaims(
  db: EngineDb,
  _clock: Clock,
  teamId: number,
): Promise<EngineResult<number>> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(waiverClaims)
      .set({ status: "cancelled" })
      .where(and(eq(waiverClaims.teamId, teamId), eq(waiverClaims.status, "pending")))
      .returning({ id: waiverClaims.id });
    return ok(rows.length);
  });
}

/**
 * Free-agent add (§7.2): immediate, first come first served, optional drop.
 * The added player goes to the bench (no lineup entry, §7.8).
 */
export async function addFreeAgent(
  db: EngineDb,
  clock: Clock,
  teamId: number,
  addPlayerId: string,
  dropPlayerId?: string,
): Promise<EngineResult<{ addPlayerId: string; dropPlayerId: string | null; droppedWaiverUntil: Date | null }>> {
  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    const now = clock.now();
    const week = settings.currentWeek;

    const teamRows = await tx.select().from(teams).where(eq(teams.id, teamId));
    const team = teamRows[0];
    if (!team) return fail("not_found", `team ${teamId} not found`);
    if (team.paused) return fail("team_paused", "your team is paused");

    const playerRows = await tx
      .select({ waiverUntil: players.waiverUntil })
      .from(players)
      .where(eq(players.playerId, addPlayerId));
    const player = playerRows[0];
    if (!player) return fail("not_found", `player ${addPlayerId} not found`);
    const owner = await rosteredBy(tx, addPlayerId);
    if (owner !== null) return fail("already_rostered", `player ${addPlayerId} is already on a roster`);
    if (player.waiverUntil !== null) {
      return fail("invalid_args", `player ${addPlayerId} is on waivers`, { hint: "use submit_waiver_claims" });
    }
    const lockedAdd = await lockedPlayerIds(tx, clock, settings.season, week, [addPlayerId]);
    if (lockedAdd.has(addPlayerId)) return fail("locked", `player ${addPlayerId} is locked (game started)`);
    if (await isIrIllegal(tx, settings, teamId, week)) {
      return fail("ir_illegal", "your IR occupant is no longer IR-eligible", {
        hint: "clear your IR slot before adding players",
      });
    }
    if (dropPlayerId) {
      const dropOwner = await rosteredBy(tx, dropPlayerId);
      if (dropOwner !== teamId) return fail("not_on_roster", `drop player ${dropPlayerId} is not on your roster`);
      const lockedDrop = await lockedPlayerIds(tx, clock, settings.season, week, [dropPlayerId]);
      if (lockedDrop.has(dropPlayerId)) return fail("locked", `drop player ${dropPlayerId} is locked (game started)`);
      const frozen = await frozenPlayerIds(tx, teamId);
      if (frozen.has(dropPlayerId)) return fail("frozen", `drop player ${dropPlayerId} is frozen in a trade`);
    }
    const cap = maxActive(settings);
    const active = await simulatedActiveAfterAdd(tx, teamId, week, dropPlayerId ?? null);
    if (active > cap) {
      return fail("roster_full", `the add would put you at ${active} active players (max ${cap})`, {
        hint: "include a drop",
      });
    }

    let droppedWaiverUntil: Date | null = null;
    if (dropPlayerId) droppedWaiverUntil = await applyDrop(tx, settings, teamId, dropPlayerId, now, "free_agent_add");
    await tx.insert(rosterEntries).values({ teamId, playerId: addPlayerId, acquiredVia: "free_agent", acquiredAt: now });
    await recordTransaction(tx, {
      type: "add",
      week,
      teamIds: [teamId],
      payload: { playerId: addPlayerId, dropPlayerId: dropPlayerId ?? null },
    });
    return ok({ addPlayerId, dropPlayerId: dropPlayerId ?? null, droppedWaiverUntil });
  });
}

/** Drop a player (§7.2 drop path). Returns the player's new `waiver_until`. */
export async function dropPlayer(
  db: EngineDb,
  clock: Clock,
  teamId: number,
  playerId: string,
): Promise<EngineResult<{ playerId: string; waiverUntil: Date }>> {
  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    const week = settings.currentWeek;
    const owner = await rosteredBy(tx, playerId);
    if (owner !== teamId) return fail("not_on_roster", `player ${playerId} is not on your roster`);
    const locked = await lockedPlayerIds(tx, clock, settings.season, week, [playerId]);
    if (locked.has(playerId)) return fail("locked", `player ${playerId} is locked (game started)`);
    const frozen = await frozenPlayerIds(tx, teamId);
    if (frozen.has(playerId)) return fail("frozen", `player ${playerId} is frozen in a trade`);
    const waiverUntil = await applyDrop(tx, settings, teamId, playerId, clock.now(), "drop");
    return ok({ playerId, waiverUntil });
  });
}

/**
 * Waiver processing (§7.2), exactly the spec algorithm: rolling priority,
 * winner to the back of the order, restart the scan after every win. Paused
 * teams are skipped; claims for players not yet clear (or locked) stay
 * pending for a later run.
 */
export async function runWaivers(
  db: EngineDb,
  clock: Clock,
  runAt: Date,
): Promise<EngineResult<{ runId: number; summary: WaiverRunSummary }>> {
  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    const week = settings.currentWeek;
    const cap = maxActive(settings);

    const teamRows = await tx.select().from(teams).orderBy(asc(teams.waiverPriority), asc(teams.id));
    let order = teamRows.map((t) => t.id);
    const orderBefore = [...order];
    const paused = new Set(teamRows.filter((t) => t.paused).map((t) => t.id));

    const pending = await tx.select().from(waiverClaims).where(eq(waiverClaims.status, "pending"));
    const addIds = [...new Set(pending.map((c) => c.addPlayerId))];
    const addRows =
      addIds.length === 0
        ? []
        : await tx
            .select({ playerId: players.playerId, waiverUntil: players.waiverUntil })
            .from(players)
            .where(inArray(players.playerId, addIds));
    const waiverUntilById = new Map(addRows.map((p) => [p.playerId, p.waiverUntil]));
    const lockedAdds = await lockedPlayerIds(tx, clock, settings.season, week, addIds);
    const eligible = pending.filter((c) => {
      const wu = waiverUntilById.get(c.addPlayerId);
      return wu != null && wu.getTime() <= runAt.getTime() && !lockedAdds.has(c.addPlayerId);
    });

    const finalStatus = new Map<number, { status: "success" | "failed"; failureReason?: string }>();
    const writeOrder = async () => {
      for (let i = 0; i < order.length; i++) {
        await tx.update(teams).set({ waiverPriority: i + 1 }).where(eq(teams.id, order[i]!));
      }
    };

    for (;;) {
      let moved = false;
      for (const teamId of order) {
        if (paused.has(teamId)) continue;
        const teamClaims = eligible
          .filter((c) => c.teamId === teamId && !finalStatus.has(c.id))
          .sort((a, b) => a.priority - b.priority || a.id - b.id);
        for (const claim of teamClaims) {
          if ((await rosteredBy(tx, claim.addPlayerId)) !== null) {
            finalStatus.set(claim.id, { status: "failed", failureReason: "already_rostered" });
            continue;
          }
          if (claim.dropPlayerId) {
            const dropOwner = await rosteredBy(tx, claim.dropPlayerId);
            const frozen = await frozenPlayerIds(tx, teamId);
            const lockedDrop = await lockedPlayerIds(tx, clock, settings.season, week, [claim.dropPlayerId]);
            if (dropOwner !== teamId || frozen.has(claim.dropPlayerId) || lockedDrop.has(claim.dropPlayerId)) {
              finalStatus.set(claim.id, { status: "failed", failureReason: "invalid_drop" });
              continue;
            }
          }
          if (await isIrIllegal(tx, settings, teamId, week)) {
            finalStatus.set(claim.id, { status: "failed", failureReason: "ir_illegal" });
            continue;
          }
          const active = await simulatedActiveAfterAdd(tx, teamId, week, claim.dropPlayerId);
          if (active > cap) {
            finalStatus.set(claim.id, { status: "failed", failureReason: "roster_full" });
            continue;
          }
          // Execute the winning claim.
          if (claim.dropPlayerId) await applyDrop(tx, settings, teamId, claim.dropPlayerId, runAt, "waiver_claim");
          await tx
            .insert(rosterEntries)
            .values({ teamId, playerId: claim.addPlayerId, acquiredVia: "waiver", acquiredAt: runAt });
          await recordTransaction(tx, {
            type: "waiver_add",
            week,
            teamIds: [teamId],
            payload: { playerId: claim.addPlayerId, dropPlayerId: claim.dropPlayerId ?? null, claimId: claim.id },
          });
          finalStatus.set(claim.id, { status: "success" });
          order = [...order.filter((t) => t !== teamId), teamId];
          await writeOrder();
          moved = true;
          break; // restart the scan from the top of the new order
        }
        if (moved) break;
      }
      if (!moved) break;
    }

    // Unclaimed players whose waiver period has passed become free agents
    // (§3.4: "who was not claimed" — a player with a still-pending claim keeps
    // his waiver_until so the waiting claim can process at a later run).
    const stillPendingAddIds = [...new Set(pending.filter((c) => !finalStatus.has(c.id)).map((c) => c.addPlayerId))];
    await tx
      .update(players)
      .set({ waiverUntil: null })
      .where(
        and(
          isNotNull(players.waiverUntil),
          lte(players.waiverUntil, runAt),
          notExists(tx.select().from(rosterEntries).where(eq(rosterEntries.playerId, players.playerId))),
          ...(stillPendingAddIds.length > 0 ? [notInArray(players.playerId, stillPendingAddIds)] : []),
        ),
      );

    const results: WaiverRunSummary["results"] = [];
    for (const c of eligible) {
      const st = finalStatus.get(c.id);
      if (!st) continue; // paused team — claim stays pending
      results.push({
        claimId: c.id,
        teamId: c.teamId,
        addPlayerId: c.addPlayerId,
        dropPlayerId: c.dropPlayerId ?? null,
        status: st.status,
        ...(st.failureReason ? { failureReason: st.failureReason } : {}),
      });
    }
    const summary: WaiverRunSummary = { orderBefore, orderAfter: [...order], results };
    const runRows = await tx.insert(waiverRuns).values({ runAt, summary }).returning({ id: waiverRuns.id });
    const runId = runRows[0]!.id;
    for (const r of results) {
      await tx
        .update(waiverClaims)
        .set({
          status: r.status,
          failureReason: r.failureReason ?? null,
          processedAt: runAt,
          runId,
        })
        .where(eq(waiverClaims.id, r.claimId));
    }
    await handleEvent(tx, clock, { type: "waivers.processed", runId });
    return ok({ runId, summary });
  });
}

/**
 * Game-start waivers (§7.3): every unrostered active player on the game's two
 * NFL teams gets `waiver_until = max(current, next Wednesday at the waiver run
 * time ET)`. Rostered players are unaffected. No transaction rows.
 */
export async function gameStartWaivers(
  db: EngineDb,
  clock: Clock,
  gameId: string,
): Promise<EngineResult<{ playerIds: string[]; waiverUntil: Date }>> {
  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    const gameRows = await tx.select().from(nflGames).where(eq(nflGames.gameId, gameId));
    const game = gameRows[0];
    if (!game) return fail("not_found", `game ${gameId} not found`);
    const { hh, mm } = runTimeEt(settings);
    const waiverUntil = nextEtWeekdayTime(clock.now(), 3, hh, mm); // next Wednesday 4:30 AM ET
    const updated = await tx
      .update(players)
      .set({ waiverUntil })
      .where(
        and(
          inArray(players.nflTeam, [game.home, game.away]),
          eq(players.active, true),
          notExists(tx.select().from(rosterEntries).where(eq(rosterEntries.playerId, players.playerId))),
          or(isNull(players.waiverUntil), lt(players.waiverUntil, waiverUntil)),
        ),
      )
      .returning({ playerId: players.playerId });
    return ok({ playerIds: updated.map((u) => u.playerId).sort(), waiverUntil });
  });
}
