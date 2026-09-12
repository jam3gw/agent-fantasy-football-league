/**
 * Waivers & free agency (SPEC §3.4, §7.2, §7.3) — acceptance battery 15.1.3.
 *
 * Calendar facts used throughout (September 2026, EDT = UTC-4):
 *   Sun Sep 13 · Mon Sep 14 · Wed Sep 16 · Fri Sep 18 · Mon Sep 21
 *   4:30 AM ET == 08:30Z.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "@league/shared";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import {
  makeGame,
  makePlayer,
  rosterPlayer,
  seedFullRoster,
  seedLeague,
  seedTeams,
  setLineupEntry,
} from "./helpers/factories.ts";
import {
  lineupEntries,
  players,
  rosterEntries,
  teams,
  trades,
  transactions,
  waiverClaims,
  waiverRuns,
} from "../src/db/schema.ts";
import {
  addFreeAgent,
  cancelWaiverClaims,
  dropPlayer,
  gameStartWaivers,
  runWaivers,
  submitWaiverClaims,
} from "../src/waivers.ts";
import { proposeTrade, resolveEndedReviews, respondToTrade } from "../src/trades.ts";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

/** A waiver_until safely in the past relative to RUN_AT. */
const PAST_WU = new Date("2026-09-14T08:30:00Z");
/** The main weekly run: Wednesday Sep 16, 4:30 AM ET. */
const RUN_AT = new Date("2026-09-16T08:30:00Z");
const runClock = () => new FixedClock(RUN_AT);

async function waiverUntilOf(playerId: string): Promise<Date | null> {
  const rows = await db.select({ wu: players.waiverUntil }).from(players).where(eq(players.playerId, playerId));
  return rows[0]!.wu;
}

async function pendingClaims(teamId: number) {
  return db
    .select()
    .from(waiverClaims)
    .where(and(eq(waiverClaims.teamId, teamId), eq(waiverClaims.status, "pending")));
}

async function priorities(): Promise<Map<number, number>> {
  const rows = await db.select({ id: teams.id, p: teams.waiverPriority }).from(teams);
  return new Map(rows.map((r) => [r.id, r.p!]));
}

/** Roster `n` fresh bench players on `teamId` (well under any lock). */
async function rosterN(teamId: number, n: number, prefix: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const pid = await makePlayer(db, { playerId: `${prefix}${i}`, nflTeam: "NO" });
    await rosterPlayer(db, teamId, pid);
    ids.push(pid);
  }
  return ids;
}

describe("submitWaiverClaims (§7.2)", () => {
  it("stores the claim list and replaces any pending list (idempotent)", async () => {
    await seedLeague(db);
    const [t1] = await seedTeams(db);
    const clock = new FixedClock("2026-09-15T12:00:00Z");
    const w1 = await makePlayer(db, { playerId: "w1", waiverUntil: PAST_WU });
    const w2 = await makePlayer(db, { playerId: "w2", waiverUntil: PAST_WU });

    const r1 = await submitWaiverClaims(db, clock, t1!, [{ addPlayerId: w1, priority: 1 }]);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.accepted.map((c) => c.addPlayerId)).toEqual([w1]);

    const r2 = await submitWaiverClaims(db, clock, t1!, [
      { addPlayerId: w2, priority: 1 },
      { addPlayerId: w1, priority: 2 },
    ]);
    expect(r2.ok).toBe(true);
    const pending = await pendingClaims(t1!);
    expect(pending.map((c) => c.addPlayerId).sort()).toEqual([w1, w2]);
    // the first list was cancelled, not deleted
    const all = await db.select().from(waiverClaims).where(eq(waiverClaims.teamId, t1!));
    expect(all.filter((c) => c.status === "cancelled")).toHaveLength(1);

    // no public transaction is recorded for claims
    expect(await db.select().from(transactions)).toHaveLength(0);

    // an empty list clears everything
    const r3 = await submitWaiverClaims(db, clock, t1!, []);
    expect(r3.ok && r3.value.accepted).toEqual([]);
    expect(await pendingClaims(t1!)).toHaveLength(0);
  });

  it("rejects a free-agent claim per claim and keeps the valid one (§7.2)", async () => {
    await seedLeague(db);
    const [t1] = await seedTeams(db);
    const clock = new FixedClock("2026-09-15T12:00:00Z");
    const w1 = await makePlayer(db, { playerId: "w1", waiverUntil: PAST_WU });
    const fa = await makePlayer(db, { playerId: "fa1", waiverUntil: null });
    await submitWaiverClaims(db, clock, t1!, [{ addPlayerId: w1, priority: 1 }]);

    const r = await submitWaiverClaims(db, clock, t1!, [
      { addPlayerId: fa, priority: 1 },
      { addPlayerId: w1, priority: 2 },
    ]);
    // §7.2 rejects per claim: the free agent is refused with a reason, the
    // valid claim is still saved rather than thrown away with it.
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.accepted.map((c) => c.addPlayerId)).toEqual([w1]);
      expect(r.value.rejected).toHaveLength(1);
      expect(r.value.rejected[0]!.error).toBe("not_on_waivers");
      expect(r.value.rejected[0]!.addPlayerId).toBe(fa);
      expect(r.value.rejected[0]!.hint).toBe("use add_free_agent");
    }
    const pending = await pendingClaims(t1!);
    expect(pending.map((c) => c.addPlayerId)).toEqual([w1]);
  });

  it("reports every per-claim failure when nothing in the list is valid", async () => {
    await seedLeague(db);
    const [t1, t2] = await seedTeams(db);
    const clock = new FixedClock("2026-09-15T12:00:00Z");
    const owned = await makePlayer(db, { playerId: "owned", waiverUntil: PAST_WU });
    await rosterPlayer(db, t2!, owned);
    const fa = await makePlayer(db, { playerId: "fa1", waiverUntil: null });

    const r = await submitWaiverClaims(db, clock, t1!, [
      { addPlayerId: owned, priority: 1 },
      { addPlayerId: fa, priority: 2 },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.accepted).toEqual([]);
      expect(r.value.rejected.map((d) => d.error).sort()).toEqual(["already_rostered", "not_on_waivers"]);
    }
    expect(await pendingClaims(t1!)).toHaveLength(0);
  });

  it("keeps the previous list when a resubmission has nothing valid in it", async () => {
    await seedLeague(db);
    const [t1, t2] = await seedTeams(db);
    const clock = new FixedClock("2026-09-15T12:00:00Z");
    const good = await makePlayer(db, { playerId: "good", waiverUntil: PAST_WU });
    await submitWaiverClaims(db, clock, t1!, [{ addPlayerId: good, priority: 1 }]);

    // Both players have since been rostered by someone else.
    const gone = await makePlayer(db, { playerId: "gone", waiverUntil: PAST_WU });
    await rosterPlayer(db, t2!, gone);
    const r = await submitWaiverClaims(db, clock, t1!, [{ addPlayerId: gone, priority: 1 }]);

    expect(r.ok && r.value.accepted).toEqual([]);
    expect(r.ok && r.value.rejected[0]!.error).toBe("already_rostered");
    // The good claim from before survives: nothing valid means no replacement.
    expect((await pendingClaims(t1!)).map((c) => c.addPlayerId)).toEqual([good]);
  });

  it("an explicit empty list still clears the pending claims", async () => {
    await seedLeague(db);
    const [t1] = await seedTeams(db);
    const clock = new FixedClock("2026-09-15T12:00:00Z");
    const w1 = await makePlayer(db, { playerId: "w1", waiverUntil: PAST_WU });
    await submitWaiverClaims(db, clock, t1!, [{ addPlayerId: w1, priority: 1 }]);
    const r = await submitWaiverClaims(db, clock, t1!, []);
    expect(r.ok && r.value.rejected).toEqual([]);
    expect(await pendingClaims(t1!)).toHaveLength(0);
  });

  it("rejects invalid_drop when the drop player is not owned, frozen, or locked", async () => {
    await seedLeague(db);
    const [t1, t2] = await seedTeams(db);
    const clock = new FixedClock("2026-09-13T18:00:00Z");
    const w1 = await makePlayer(db, { playerId: "w1", waiverUntil: PAST_WU });

    // not owned
    const someoneElses = await makePlayer(db, { playerId: "other" });
    await rosterPlayer(db, t2!, someoneElses);
    const rNotOwned = await submitWaiverClaims(db, clock, t1!, [
      { addPlayerId: w1, dropPlayerId: someoneElses, priority: 1 },
    ]);
    expect(rNotOwned.ok && rNotOwned.value.rejected[0]!.error).toBe("invalid_drop");

    // frozen (give side of the team's own proposed trade)
    const frozenP = await makePlayer(db, { playerId: "frozen1" });
    await rosterPlayer(db, t1!, frozenP);
    await db.insert(trades).values({
      proposerTeamId: t1!,
      counterpartyTeamId: t2!,
      givePlayerIds: [frozenP],
      getPlayerIds: [someoneElses],
      status: "proposed",
      proposedAt: clock.now(),
    });
    const rFrozen = await submitWaiverClaims(db, clock, t1!, [
      { addPlayerId: w1, dropPlayerId: frozenP, priority: 1 },
    ]);
    expect(rFrozen.ok && rFrozen.value.rejected[0]!.error).toBe("invalid_drop");

    // locked (game kicked off)
    const lockedP = await makePlayer(db, { playerId: "locked1", nflTeam: "PHI" });
    await rosterPlayer(db, t1!, lockedP);
    await makeGame(db, { week: 1, kickoffAt: new Date("2026-09-13T17:00:00Z"), home: "PHI", away: "DAL" });
    const rLocked = await submitWaiverClaims(db, clock, t1!, [
      { addPlayerId: w1, dropPlayerId: lockedP, priority: 1 },
    ]);
    expect(rLocked.ok && rLocked.value.rejected[0]!.error).toBe("invalid_drop");
  });

  it("accepts claims for players whose waiver_until is in the future (they wait)", async () => {
    await seedLeague(db);
    const [t1] = await seedTeams(db);
    const clock = new FixedClock("2026-09-15T12:00:00Z");
    const future = await makePlayer(db, { playerId: "future", waiverUntil: new Date("2026-09-20T08:30:00Z") });
    const r = await submitWaiverClaims(db, clock, t1!, [{ addPlayerId: future, priority: 1 }]);
    expect(r.ok).toBe(true);
    expect(await pendingClaims(t1!)).toHaveLength(1);
  });

  it("cancelWaiverClaims cancels all pending claims and reports the count", async () => {
    await seedLeague(db);
    const [t1] = await seedTeams(db);
    const clock = new FixedClock("2026-09-15T12:00:00Z");
    const w1 = await makePlayer(db, { playerId: "w1", waiverUntil: PAST_WU });
    const w2 = await makePlayer(db, { playerId: "w2", waiverUntil: PAST_WU });
    await submitWaiverClaims(db, clock, t1!, [
      { addPlayerId: w1, priority: 1 },
      { addPlayerId: w2, priority: 2 },
    ]);
    const r = await cancelWaiverClaims(db, clock, t1!);
    expect(r.ok && r.value).toBe(2);
    expect(await pendingClaims(t1!)).toHaveLength(0);
  });
});

describe("dropPlayer (§7.2 drop path)", () => {
  it("rejects not_on_roster, locked, and frozen drops", async () => {
    await seedLeague(db);
    const [t1, t2] = await seedTeams(db);
    const clock = new FixedClock("2026-09-13T18:00:00Z");

    const stranger = await makePlayer(db, { playerId: "stranger" });
    expect(await dropPlayer(db, clock, t1!, stranger)).toMatchObject({ ok: false, error: "not_on_roster" });

    const lockedP = await makePlayer(db, { playerId: "lockedp", nflTeam: "PHI" });
    await rosterPlayer(db, t1!, lockedP);
    await makeGame(db, { week: 1, kickoffAt: new Date("2026-09-13T17:00:00Z"), home: "PHI", away: "DAL" });
    expect(await dropPlayer(db, clock, t1!, lockedP)).toMatchObject({ ok: false, error: "locked" });

    const frozenP = await makePlayer(db, { playerId: "frozenp" });
    await rosterPlayer(db, t1!, frozenP);
    await db.insert(trades).values({
      proposerTeamId: t1!,
      counterpartyTeamId: t2!,
      givePlayerIds: [frozenP],
      getPlayerIds: [],
      status: "proposed",
      proposedAt: clock.now(),
    });
    expect(await dropPlayer(db, clock, t1!, frozenP)).toMatchObject({ ok: false, error: "frozen" });
  });

  it("removes roster + lineup entries for weeks W and W+1 and sets the exact 48h waiver window", async () => {
    await seedLeague(db); // currentWeek 1
    const [t1] = await seedTeams(db);
    const p = await makePlayer(db, { playerId: "dropme", nflTeam: "NO" });
    await rosterPlayer(db, t1!, p);
    await setLineupEntry(db, t1!, 1, p, "RB1");
    await setLineupEntry(db, t1!, 2, p, "RB1");

    // Mon Sep 14, 2:00 AM ET (06:00Z) + 48h = Wed 2:00 AM ET → first 4:30 AM ET run = Wed Sep 16 08:30Z
    const clock = new FixedClock("2026-09-14T06:00:00Z");
    const r = await dropPlayer(db, clock, t1!, p);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.waiverUntil.toISOString()).toBe("2026-09-16T08:30:00.000Z");
    expect(await waiverUntilOf(p)).toEqual(new Date("2026-09-16T08:30:00Z"));

    expect(await db.select().from(rosterEntries).where(eq(rosterEntries.playerId, p))).toHaveLength(0);
    expect(await db.select().from(lineupEntries).where(eq(lineupEntries.playerId, p))).toHaveLength(0);

    const txns = await db.select().from(transactions).where(eq(transactions.type, "drop"));
    expect(txns).toHaveLength(1);
    expect(txns[0]!.teamIds).toEqual([t1!]);
    expect(txns[0]!.payload).toMatchObject({ playerId: p });
  });

  it("lands exactly on the run time when now + 48h is 4:30 AM ET (at-or-after boundary)", async () => {
    await seedLeague(db);
    const [t1] = await seedTeams(db);
    const p = await makePlayer(db, { playerId: "boundary", nflTeam: "NO" });
    await rosterPlayer(db, t1!, p);
    // Mon Sep 14 4:30 AM ET + 48h = Wed Sep 16 4:30 AM ET exactly
    const clock = new FixedClock("2026-09-14T08:30:00Z");
    const r = await dropPlayer(db, clock, t1!, p);
    expect(r.ok && r.value.waiverUntil.toISOString()).toBe("2026-09-16T08:30:00.000Z");
  });

  it("crosses a weekend: Friday-morning drop clears Monday 4:30 AM ET", async () => {
    await seedLeague(db);
    const [t1] = await seedTeams(db);
    const p = await makePlayer(db, { playerId: "weekend", nflTeam: "NO" });
    await rosterPlayer(db, t1!, p);
    // Fri Sep 18, 10:00 AM ET (14:00Z) + 48h = Sun 10:00 AM ET → first 4:30 run at/after = Mon Sep 21 08:30Z
    const clock = new FixedClock("2026-09-18T14:00:00Z");
    const r = await dropPlayer(db, clock, t1!, p);
    expect(r.ok && r.value.waiverUntil.toISOString()).toBe("2026-09-21T08:30:00.000Z");
  });
});

describe("addFreeAgent (§7.2)", () => {
  it("adds a free agent to the bench immediately and records an 'add' transaction", async () => {
    await seedLeague(db);
    const [t1] = await seedTeams(db);
    const clock = new FixedClock("2026-09-15T12:00:00Z");
    const fa = await makePlayer(db, { playerId: "fa1", nflTeam: "NO" });
    const r = await addFreeAgent(db, clock, t1!, fa);
    expect(r.ok).toBe(true);

    const entry = (await db.select().from(rosterEntries).where(eq(rosterEntries.playerId, fa)))[0]!;
    expect(entry.teamId).toBe(t1!);
    expect(entry.acquiredVia).toBe("free_agent");
    expect(entry.acquiredAt).toEqual(clock.now());
    // bench: no lineup entry (§7.8)
    expect(await db.select().from(lineupEntries).where(eq(lineupEntries.playerId, fa))).toHaveLength(0);
    const txns = await db.select().from(transactions).where(eq(transactions.type, "add"));
    expect(txns).toHaveLength(1);
    expect(txns[0]!.payload).toMatchObject({ playerId: fa, dropPlayerId: null });
  });

  it("rejects a player who is on waivers with a hint to claim instead", async () => {
    await seedLeague(db);
    const [t1] = await seedTeams(db);
    const clock = new FixedClock("2026-09-15T12:00:00Z");
    const onWaivers = await makePlayer(db, { playerId: "onw", waiverUntil: new Date("2026-09-18T08:30:00Z") });
    const r = await addFreeAgent(db, clock, t1!, onWaivers);
    expect(r).toMatchObject({ ok: false, error: "invalid_args", hint: "use submit_waiver_claims" });
    expect(await db.select().from(rosterEntries)).toHaveLength(0);
  });

  it("rejects already_rostered, locked, team_paused and ir_illegal", async () => {
    const settings = await seedLeague(db);
    const [t1, t2, t3] = await seedTeams(db);
    const clock = new FixedClock("2026-09-13T18:00:00Z");

    const owned = await makePlayer(db, { playerId: "owned", nflTeam: "NO" });
    await rosterPlayer(db, t2!, owned);
    expect(await addFreeAgent(db, clock, t1!, owned)).toMatchObject({ ok: false, error: "already_rostered" });

    const lockedFa = await makePlayer(db, { playerId: "lockedfa", nflTeam: "PHI" });
    await makeGame(db, { week: 1, kickoffAt: new Date("2026-09-13T17:00:00Z"), home: "PHI", away: "DAL" });
    expect(await addFreeAgent(db, clock, t1!, lockedFa)).toMatchObject({ ok: false, error: "locked" });

    const fa = await makePlayer(db, { playerId: "fa2", nflTeam: "NO" });
    await db.update(teams).set({ paused: true }).where(eq(teams.id, t3!));
    expect(await addFreeAgent(db, clock, t3!, fa)).toMatchObject({ ok: false, error: "team_paused" });

    // IR-illegal team: healthy player in the IR slot
    const irP = await makePlayer(db, { playerId: "irp", nflTeam: "NO", injuryStatus: "IR" });
    await rosterPlayer(db, t1!, irP);
    await setLineupEntry(db, t1!, 1, irP, "IR");
    await db.update(players).set({ injuryStatus: null, status: "Active" }).where(eq(players.playerId, irP));
    expect(settings.irEligibleStatuses).not.toContain("Active");
    expect(await addFreeAgent(db, clock, t1!, fa)).toMatchObject({ ok: false, error: "ir_illegal" });
  });

  it("enforces the 14-active limit: roster_full without a drop, success with one", async () => {
    await seedLeague(db);
    const [t1] = await seedTeams(db);
    const clock = new FixedClock("2026-09-15T12:00:00Z");
    const roster = await seedFullRoster(db, t1!, { nflTeam: "NO" }); // 14 active
    const fa = await makePlayer(db, { playerId: "fa1", nflTeam: "GB" });

    expect(await addFreeAgent(db, clock, t1!, fa)).toMatchObject({ ok: false, error: "roster_full" });

    const r = await addFreeAgent(db, clock, t1!, fa, roster.bench[0]!);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // dropped player: first 4:30 ET run at/after Tue Sep 15 08:00 ET + 48h → Fri Sep 18 08:30Z
      expect(r.value.droppedWaiverUntil!.toISOString()).toBe("2026-09-18T08:30:00.000Z");
    }
    expect(await db.select().from(rosterEntries).where(eq(rosterEntries.teamId, t1!))).toHaveLength(14);
  });

  it("reserves the net gain of a trade in review toward the 14-active limit", async () => {
    await seedLeague(db);
    const [t1, t2] = await seedTeams(db);
    const clock = new FixedClock("2026-09-15T12:00:00Z");
    const mine = await rosterN(t1!, 13, "mine"); // 13 active
    const give1 = await makePlayer(db, { playerId: "give1", nflTeam: "GB" });
    const give2 = await makePlayer(db, { playerId: "give2", nflTeam: "GB" });
    await rosterPlayer(db, t2!, give1);
    await rosterPlayer(db, t2!, give2);
    // t2 → t1 2-for-1 in review: t1 (counterparty) is due 2 and sends 1 → net +1
    await db.insert(trades).values({
      proposerTeamId: t2!,
      counterpartyTeamId: t1!,
      givePlayerIds: [give1, give2],
      getPlayerIds: [mine[0]!],
      status: "accepted",
      proposedAt: clock.now(),
    });
    const fa = await makePlayer(db, { playerId: "fa1", nflTeam: "GB" });
    // 13 + 1 add + 1 reserved = 15 > 14
    expect(await addFreeAgent(db, clock, t1!, fa)).toMatchObject({ ok: false, error: "roster_full" });
    // with a drop of an unfrozen player: 13 + 1 − 1 + 1 = 14 → ok
    // (mine[0] is frozen as the accepted trade's get side, so drop another)
    const r = await addFreeAgent(db, clock, t1!, fa, mine[1]!);
    expect(r.ok).toBe(true);
  });

  it("a 1-for-1 trade in review reserves nothing: its outgoing player leaves when its incoming one arrives", async () => {
    await seedLeague(db);
    const [t1, t2] = await seedTeams(db);
    const clock = new FixedClock("2026-09-15T12:00:00Z");
    const mine = await rosterN(t1!, 13, "mine"); // 13 active
    const give = await makePlayer(db, { playerId: "give1", nflTeam: "GB" });
    await rosterPlayer(db, t2!, give);
    await db.insert(trades).values({
      proposerTeamId: t2!,
      counterpartyTeamId: t1!,
      givePlayerIds: [give],
      getPlayerIds: [mine[0]!],
      status: "accepted",
      proposedAt: clock.now(),
    });
    const fa = await makePlayer(db, { playerId: "fa1", nflTeam: "GB" });
    // 13 + 1 add + 0 reserved = 14 → ok, whether or not the trade later executes
    expect((await addFreeAgent(db, clock, t1!, fa)).ok).toBe(true);
    expect(await db.select().from(rosterEntries).where(eq(rosterEntries.teamId, t1!))).toHaveLength(14);
  });

  it("an outgoing IR occupant frees the IR slot, not an active spot, so the incoming player is still reserved", async () => {
    await seedLeague(db);
    const [t1, t2] = await seedTeams(db);
    const clock = new FixedClock("2026-09-15T12:00:00Z");
    await rosterN(t1!, 13, "mine"); // 13 active
    const irP = await makePlayer(db, { playerId: "irp", nflTeam: "NO", injuryStatus: "IR" });
    await rosterPlayer(db, t1!, irP);
    await setLineupEntry(db, t1!, 1, irP, "IR"); // 13 active + 1 IR
    const give = await makePlayer(db, { playerId: "give1", nflTeam: "GB" });
    await rosterPlayer(db, t2!, give);
    // t1 sends its IR player and receives an active one → 14 active once it executes
    await db.insert(trades).values({
      proposerTeamId: t2!,
      counterpartyTeamId: t1!,
      givePlayerIds: [give],
      getPlayerIds: [irP],
      status: "accepted",
      proposedAt: clock.now(),
    });
    const fa = await makePlayer(db, { playerId: "fa1", nflTeam: "GB" });
    // 13 + 1 add + 1 reserved = 15 > 14: the add would make the trade fail at execution
    expect(await addFreeAgent(db, clock, t1!, fa)).toMatchObject({ ok: false, error: "roster_full" });
  });

  it("a free-agent add beside a 1-for-1 in review never blocks that trade from executing", async () => {
    await seedLeague(db);
    const ids = await seedTeams(db);
    const [t1, t2] = ids;
    const clock = new FixedClock("2026-09-15T12:00:00Z");
    const mine = await rosterN(t1!, 13, "mine");
    const give = await makePlayer(db, { playerId: "give1", nflTeam: "GB" });
    await rosterPlayer(db, t2!, give);
    const p = await proposeTrade(db, clock, t2!, { toTeamId: t1!, givePlayerIds: [give], getPlayerIds: [mine[0]!] });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect((await respondToTrade(db, clock, t1!, p.value.tradeId, "accept")).ok).toBe(true);
    const fa = await makePlayer(db, { playerId: "fa1", nflTeam: "GB" });
    expect((await addFreeAgent(db, clock, t1!, fa)).ok).toBe(true); // 14 active
    clock.advance(25 * 3600_000); // past the 24 h review
    const resolved = await resolveEndedReviews(db, clock);
    expect(resolved.ok).toBe(true);
    const row = (await db.select().from(trades).where(eq(trades.id, p.value.tradeId)))[0]!;
    expect(row.status).toBe("executed");
    expect(await db.select().from(rosterEntries).where(eq(rosterEntries.teamId, t1!))).toHaveLength(14);
  });
});

describe("runWaivers (§7.2)", () => {
  it("contested claim: higher priority wins, winner moves to the back of the 12-team order", async () => {
    await seedLeague(db);
    const ids = await seedTeams(db); // priorities 1..12
    const clock = runClock();
    const x = await makePlayer(db, { playerId: "x", waiverUntil: PAST_WU, nflTeam: "NO" });
    await submitWaiverClaims(db, clock, ids[4]!, [{ addPlayerId: x, priority: 1 }]); // priority 5
    await submitWaiverClaims(db, clock, ids[1]!, [{ addPlayerId: x, priority: 1 }]); // priority 2 → wins

    const r = await runWaivers(db, clock, RUN_AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { summary, runId } = r.value;
    expect(summary.orderBefore).toEqual(ids);
    expect(summary.orderAfter).toEqual([ids[0], ...ids.slice(2), ids[1]]);
    expect(summary.results).toHaveLength(2);
    const byTeam = new Map(summary.results.map((res) => [res.teamId, res]));
    expect(byTeam.get(ids[1]!)).toMatchObject({ status: "success", addPlayerId: x });
    expect(byTeam.get(ids[4]!)).toMatchObject({ status: "failed", failureReason: "already_rostered" });

    // rolling priority rewritten 1..12 for all teams
    const prio = await priorities();
    expect(prio.get(ids[1]!)).toBe(12);
    expect(prio.get(ids[0]!)).toBe(1);
    expect(prio.get(ids[2]!)).toBe(2);
    expect(prio.get(ids[11]!)).toBe(11);

    // winner rostered on the bench via 'waiver' with a transaction
    const entry = (await db.select().from(rosterEntries).where(eq(rosterEntries.playerId, x)))[0]!;
    expect(entry).toMatchObject({ teamId: ids[1]!, acquiredVia: "waiver" });
    expect(await waiverUntilOf(x)).toBeNull(); // rostered, so no longer on waivers
    expect(await db.select().from(lineupEntries).where(eq(lineupEntries.playerId, x))).toHaveLength(0);
    expect(await db.select().from(transactions).where(eq(transactions.type, "waiver_add"))).toHaveLength(1);

    // claim bookkeeping + waiver_runs row
    const processed = await db.select().from(waiverClaims);
    for (const c of processed) {
      expect(c.processedAt).toEqual(RUN_AT);
      expect(c.runId).toBe(runId);
    }
    const runRow = (await db.select().from(waiverRuns).where(eq(waiverRuns.id, runId)))[0]!;
    expect(runRow.runAt).toEqual(RUN_AT);
    expect(runRow.summary.orderAfter).toEqual(summary.orderAfter);
  });

  it("a team can win twice in one run; its second claim processes from the back of the list", async () => {
    await seedLeague(db);
    const ids = await seedTeams(db);
    const clock = runClock();
    const a = await makePlayer(db, { playerId: "a", waiverUntil: PAST_WU, nflTeam: "NO" });
    const b = await makePlayer(db, { playerId: "b", waiverUntil: PAST_WU, nflTeam: "NO" });
    const c = await makePlayer(db, { playerId: "c", waiverUntil: PAST_WU, nflTeam: "NO" });
    // t1: claims a (prio 1) then c (prio 2); t2: claims b
    await submitWaiverClaims(db, clock, ids[0]!, [
      { addPlayerId: a, priority: 1 },
      { addPlayerId: c, priority: 2 },
    ]);
    await submitWaiverClaims(db, clock, ids[1]!, [{ addPlayerId: b, priority: 1 }]);

    const r = await runWaivers(db, clock, RUN_AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // sequence: t1 wins a → back; t2 wins b → back; t1 wins c from the back
    expect(r.value.summary.results.every((res) => res.status === "success")).toBe(true);
    expect(r.value.summary.orderAfter).toEqual([...ids.slice(2), ids[1], ids[0]]);
    const prio = await priorities();
    expect(prio.get(ids[0]!)).toBe(12); // won last
    expect(prio.get(ids[1]!)).toBe(11);
    expect(prio.get(ids[2]!)).toBe(1);
  });

  it("after winning, a team's remaining claim is processed at its new back-of-list position", async () => {
    await seedLeague(db);
    const ids = await seedTeams(db);
    const clock = runClock();
    const a = await makePlayer(db, { playerId: "a", waiverUntil: PAST_WU, nflTeam: "NO" });
    const b = await makePlayer(db, { playerId: "b", waiverUntil: PAST_WU, nflTeam: "NO" });
    // t1 (priority 1) claims a then b; t3 (priority 3) claims b only.
    await submitWaiverClaims(db, clock, ids[0]!, [
      { addPlayerId: a, priority: 1 },
      { addPlayerId: b, priority: 2 },
    ]);
    await submitWaiverClaims(db, clock, ids[2]!, [{ addPlayerId: b, priority: 1 }]);

    const r = await runWaivers(db, clock, RUN_AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // t1 wins a and moves behind t3, so t3 beats t1 to b despite t1's original priority
    expect(await db.select().from(rosterEntries).where(eq(rosterEntries.playerId, b))).toMatchObject([
      { teamId: ids[2]! },
    ]);
    const t1Claims = await db.select().from(waiverClaims).where(eq(waiverClaims.teamId, ids[0]!));
    const bClaim = t1Claims.find((cl) => cl.addPlayerId === b)!;
    expect(bClaim.status).toBe("failed");
    expect(bClaim.failureReason).toBe("already_rostered");
  });

  it("processes a team's own claims in priority order", async () => {
    await seedLeague(db);
    const ids = await seedTeams(db);
    const clock = runClock();
    await rosterN(ids[0]!, 13, "r"); // one open active slot
    const x = await makePlayer(db, { playerId: "x", waiverUntil: PAST_WU, nflTeam: "NO" });
    const y = await makePlayer(db, { playerId: "y", waiverUntil: PAST_WU, nflTeam: "NO" });
    // submitted with x first, but y carries the better (lower) priority number
    await submitWaiverClaims(db, clock, ids[0]!, [
      { addPlayerId: x, priority: 2 },
      { addPlayerId: y, priority: 1 },
    ]);
    const r = await runWaivers(db, clock, RUN_AT);
    expect(r.ok).toBe(true);
    expect(await db.select().from(rosterEntries).where(eq(rosterEntries.playerId, y))).toHaveLength(1);
    const xClaim = (await db.select().from(waiverClaims).where(eq(waiverClaims.addPlayerId, x)))[0]!;
    expect(xClaim).toMatchObject({ status: "failed", failureReason: "roster_full" });
  });

  it("fails claims with invalid drops (traded away / frozen / locked) and clears their players to FA", async () => {
    await seedLeague(db);
    const ids = await seedTeams(db);
    const clock = runClock();
    const w1 = await makePlayer(db, { playerId: "w1", waiverUntil: PAST_WU, nflTeam: "NO" });
    const w2 = await makePlayer(db, { playerId: "w2", waiverUntil: PAST_WU, nflTeam: "NO" });
    const w3 = await makePlayer(db, { playerId: "w3", waiverUntil: PAST_WU, nflTeam: "NO" });

    // t1: drop player no longer on the roster (e.g. traded away after submitting)
    const gone = await makePlayer(db, { playerId: "gone", nflTeam: "NO" });
    await rosterPlayer(db, ids[0]!, gone);
    await submitWaiverClaims(db, clock, ids[0]!, [{ addPlayerId: w1, dropPlayerId: gone, priority: 1 }]);
    await db.delete(rosterEntries).where(eq(rosterEntries.playerId, gone)); // traded away

    // t2: drop player frozen in a trade proposed after submitting
    const froz = await makePlayer(db, { playerId: "froz", nflTeam: "NO" });
    await rosterPlayer(db, ids[1]!, froz);
    await submitWaiverClaims(db, clock, ids[1]!, [{ addPlayerId: w2, dropPlayerId: froz, priority: 1 }]);
    await db.insert(trades).values({
      proposerTeamId: ids[1]!,
      counterpartyTeamId: ids[2]!,
      givePlayerIds: [froz],
      getPlayerIds: [],
      status: "proposed",
      proposedAt: clock.now(),
    });

    // t3: drop player locked by kickoff before the run
    const lockedDrop = await makePlayer(db, { playerId: "lockeddrop", nflTeam: "PHI" });
    await rosterPlayer(db, ids[2]!, lockedDrop);
    await submitWaiverClaims(db, clock, ids[2]!, [{ addPlayerId: w3, dropPlayerId: lockedDrop, priority: 1 }]);
    await makeGame(db, { week: 1, kickoffAt: new Date("2026-09-16T00:15:00Z"), home: "PHI", away: "DAL" });

    const r = await runWaivers(db, clock, RUN_AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.summary.results).toHaveLength(3);
    for (const res of r.value.summary.results) {
      expect(res).toMatchObject({ status: "failed", failureReason: "invalid_drop" });
    }
    // nobody won → order unchanged; unclaimed cleared players become free agents
    expect(r.value.summary.orderAfter).toEqual(ids);
    expect(await waiverUntilOf(w1)).toBeNull();
    expect(await waiverUntilOf(w2)).toBeNull();
    expect(await waiverUntilOf(w3)).toBeNull();
  });

  it("fails claims of an IR-illegal team with ir_illegal", async () => {
    await seedLeague(db);
    const ids = await seedTeams(db);
    const clock = runClock();
    const irP = await makePlayer(db, { playerId: "irp", nflTeam: "NO", injuryStatus: "IR" });
    await rosterPlayer(db, ids[0]!, irP);
    await setLineupEntry(db, ids[0]!, 1, irP, "IR");
    await db.update(players).set({ injuryStatus: null, status: "Active" }).where(eq(players.playerId, irP));
    const x = await makePlayer(db, { playerId: "x", waiverUntil: PAST_WU, nflTeam: "NO" });
    await submitWaiverClaims(db, clock, ids[0]!, [{ addPlayerId: x, priority: 1 }]);

    const r = await runWaivers(db, clock, RUN_AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.summary.results[0]).toMatchObject({ status: "failed", failureReason: "ir_illegal" });
  });

  it("roster_full without a drop, success with a valid drop; dropped player re-waived 48h out", async () => {
    await seedLeague(db);
    const ids = await seedTeams(db);
    const clock = runClock();
    await seedFullRoster(db, ids[0]!, { nflTeam: "NO", prefix: "f1" });
    await seedFullRoster(db, ids[1]!, { nflTeam: "GB", prefix: "f2" });
    const x = await makePlayer(db, { playerId: "x", waiverUntil: PAST_WU, nflTeam: "LAR" });
    const y = await makePlayer(db, { playerId: "y", waiverUntil: PAST_WU, nflTeam: "LAR" });
    await submitWaiverClaims(db, clock, ids[0]!, [{ addPlayerId: x, priority: 1 }]); // no drop → full
    const full2 = await db
      .select({ playerId: rosterEntries.playerId })
      .from(rosterEntries)
      .where(eq(rosterEntries.teamId, ids[1]!));
    const dropId = full2[0]!.playerId;
    await submitWaiverClaims(db, clock, ids[1]!, [{ addPlayerId: y, dropPlayerId: dropId, priority: 1 }]);

    const r = await runWaivers(db, clock, RUN_AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byTeam = new Map(r.value.summary.results.map((res) => [res.teamId, res]));
    expect(byTeam.get(ids[0]!)).toMatchObject({ status: "failed", failureReason: "roster_full" });
    expect(byTeam.get(ids[1]!)).toMatchObject({ status: "success" });
    // dropped player's waiver window: first 4:30 AM ET run at/after RUN_AT + 48h = Fri Sep 18 08:30Z
    expect((await waiverUntilOf(dropId))!.toISOString()).toBe("2026-09-18T08:30:00.000Z");
    // x was not claimed successfully → free agent now
    expect(await waiverUntilOf(x)).toBeNull();
    // drop transaction recorded alongside the waiver_add
    expect(await db.select().from(transactions).where(eq(transactions.type, "drop"))).toHaveLength(1);
    expect(await db.select().from(transactions).where(eq(transactions.type, "waiver_add"))).toHaveLength(1);
  });

  it("claims for players not yet clear or locked stay pending; paused teams are skipped", async () => {
    await seedLeague(db);
    const ids = await seedTeams(db);
    const clock = runClock();
    // not yet clear
    const future = await makePlayer(db, { playerId: "future", waiverUntil: new Date("2026-09-18T08:30:00Z"), nflTeam: "NO" });
    await submitWaiverClaims(db, clock, ids[0]!, [{ addPlayerId: future, priority: 1 }]);
    // clear but locked (Thursday-night-style game already kicked off is impossible at 4:30 AM Wed,
    // but the rule is general: any kicked-off game locks the add)
    const lockedAdd = await makePlayer(db, { playerId: "lockedadd", waiverUntil: PAST_WU, nflTeam: "PHI" });
    await makeGame(db, { week: 1, kickoffAt: new Date("2026-09-16T00:15:00Z"), home: "PHI", away: "DAL" });
    await submitWaiverClaims(db, clock, ids[1]!, [{ addPlayerId: lockedAdd, priority: 1 }]);
    // paused team with an otherwise-winnable claim
    const clearP = await makePlayer(db, { playerId: "clearp", waiverUntil: PAST_WU, nflTeam: "NO" });
    await submitWaiverClaims(db, clock, ids[2]!, [{ addPlayerId: clearP, priority: 1 }]);
    await db.update(teams).set({ paused: true }).where(eq(teams.id, ids[2]!));

    const r = await runWaivers(db, clock, RUN_AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.summary.results).toEqual([]);
    const all = await db.select().from(waiverClaims);
    for (const cl of all) {
      expect(cl.status).toBe("pending");
      expect(cl.processedAt).toBeNull();
      expect(cl.runId).toBeNull();
    }
    // players with still-pending claims keep their waiver_until; nobody was added
    expect(await waiverUntilOf(lockedAdd)).toEqual(PAST_WU);
    expect(await waiverUntilOf(clearP)).toEqual(PAST_WU);
    expect(await waiverUntilOf(future)).toEqual(new Date("2026-09-18T08:30:00Z"));
    expect(await db.select().from(rosterEntries)).toHaveLength(0);
  });

  it("clears unclaimed players whose waiver_until has passed, leaving future windows alone", async () => {
    await seedLeague(db);
    await seedTeams(db);
    const clock = runClock();
    const cleared = await makePlayer(db, { playerId: "cleared", waiverUntil: PAST_WU, nflTeam: "NO" });
    const boundary = await makePlayer(db, { playerId: "atrun", waiverUntil: RUN_AT, nflTeam: "NO" });
    const notYet = await makePlayer(db, { playerId: "notyet", waiverUntil: new Date("2026-09-18T08:30:00Z"), nflTeam: "NO" });

    const r = await runWaivers(db, clock, RUN_AT);
    expect(r.ok).toBe(true);
    expect(await waiverUntilOf(cleared)).toBeNull();
    expect(await waiverUntilOf(boundary)).toBeNull(); // <= runAt clears
    expect(await waiverUntilOf(notYet)).toEqual(new Date("2026-09-18T08:30:00Z"));
  });
});

describe("gameStartWaivers (§7.3)", () => {
  it("puts unrostered active players of both NFL teams on waivers until next Wednesday 4:30 AM ET", async () => {
    await seedLeague(db);
    const ids = await seedTeams(db);
    // Sunday Sep 13 kickoff → next Wednesday 4:30 AM ET = Sep 16 08:30Z
    const clock = new FixedClock("2026-09-13T17:00:00Z");
    const gameId = await makeGame(db, { week: 1, kickoffAt: clock.now(), home: "KC", away: "PHI" });

    const kcFa = await makePlayer(db, { playerId: "kcfa", nflTeam: "KC" });
    const phiFa = await makePlayer(db, { playerId: "phifa", nflTeam: "PHI" });
    const kcRostered = await makePlayer(db, { playerId: "kcrostered", nflTeam: "KC" });
    await rosterPlayer(db, ids[0]!, kcRostered);
    const otherTeamFa = await makePlayer(db, { playerId: "gbfa", nflTeam: "GB" });
    const inactive = await makePlayer(db, { playerId: "kcretired", nflTeam: "KC", active: false });
    // an existing LATER waiver_until must not be lowered
    const laterWu = new Date("2026-09-23T08:30:00Z");
    const kcLater = await makePlayer(db, { playerId: "kclater", nflTeam: "KC", waiverUntil: laterWu });
    // an existing EARLIER waiver_until is raised to the max
    const kcEarlier = await makePlayer(db, { playerId: "kcearlier", nflTeam: "PHI", waiverUntil: PAST_WU });

    const r = await gameStartWaivers(db, clock, gameId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const wed = new Date("2026-09-16T08:30:00Z");
    expect(r.value.waiverUntil).toEqual(wed);
    expect(r.value.playerIds.sort()).toEqual([kcEarlier, kcFa, phiFa].sort());

    expect(await waiverUntilOf(kcFa)).toEqual(wed);
    expect(await waiverUntilOf(phiFa)).toEqual(wed);
    expect(await waiverUntilOf(kcEarlier)).toEqual(wed);
    expect(await waiverUntilOf(kcLater)).toEqual(laterWu); // never lowered
    expect(await waiverUntilOf(kcRostered)).toBeNull(); // rostered untouched
    expect(await waiverUntilOf(otherTeamFa)).toBeNull();
    expect(await waiverUntilOf(inactive)).toBeNull();
    // no public transaction rows for game-start waivers
    expect(await db.select().from(transactions)).toHaveLength(0);
  });

  it("returns not_found for an unknown game", async () => {
    await seedLeague(db);
    const clock = new FixedClock("2026-09-13T17:00:00Z");
    expect(await gameStartWaivers(db, clock, "nope")).toMatchObject({ ok: false, error: "not_found" });
  });
});
