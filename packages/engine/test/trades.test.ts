/**
 * Trades & votes (SPEC §3.5, §7.5, §3.3, §3.1) — acceptance battery 15.1.4:
 * full lifecycle, counter, expiry, freeze rules, the rolling 3-per-day offer
 * limit, votes (7 vetoes / 4 allows / window end / paused team), the trade
 * deadline, and a locked player's ghost lineup entry on execution.
 *
 * Calendar: Tue Sep 15 2026 08:00 ET == 12:00Z; the PHI/DAL game used for
 * locks kicked off Sun Sep 13 17:00Z.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "@league/shared";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import type { PlayerSpec } from "./helpers/factories.ts";
import { makeGame, makePlayer, rosterPlayer, seedLeague, seedTeams, setLineupEntry } from "./helpers/factories.ts";
import { lineupEntries, rosterEntries, sessions, teams, trades, transactions } from "../src/db/schema.ts";
import {
  MOOT_VOTE_REASON,
  cancelTrade,
  expireAllProposedAtDeadline,
  expireOffers,
  proposeTrade,
  resolveEndedReviews,
  respondToTrade,
  voteOnTrade,
} from "../src/trades.ts";
import { updateSettings } from "../src/settings.ts";
import { dropPlayer } from "../src/waivers.ts";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

/** Tuesday Sep 15 2026, 08:00 ET — no game has kicked off unless one is seeded. */
const T0 = "2026-09-15T12:00:00Z";
const HOUR = 3600_000;

async function setup(overrides: Parameters<typeof seedLeague>[1] = {}): Promise<number[]> {
  await seedLeague(db, overrides);
  return seedTeams(db);
}

/** A rostered player on `teamId` (NO has no seeded game → never locked). */
async function owned(teamId: number, playerId: string, spec: PlayerSpec = {}): Promise<string> {
  const pid = await makePlayer(db, { playerId, nflTeam: "NO", ...spec });
  await rosterPlayer(db, teamId, pid);
  return pid;
}

async function tradeRow(tradeId: number) {
  const rows = await db.select().from(trades).where(eq(trades.id, tradeId));
  return rows[0]!;
}

async function ownerOf(playerId: string): Promise<number | null> {
  const rows = await db.select().from(rosterEntries).where(eq(rosterEntries.playerId, playerId));
  return rows[0]?.teamId ?? null;
}

/** Standard two-player offer from ids[0] to ids[1], accepted into review. */
async function proposeAndAccept(
  clock: FixedClock,
  ids: number[],
  givePlayerIds: string[],
  getPlayerIds: string[],
): Promise<number> {
  const p = await proposeTrade(db, clock, ids[0]!, { toTeamId: ids[1]!, givePlayerIds, getPlayerIds });
  if (!p.ok) throw new Error(`propose failed: ${p.error} ${p.message}`);
  const acc = await respondToTrade(db, clock, ids[1]!, p.value.tradeId, "accept");
  if (!acc.ok) throw new Error(`accept failed: ${acc.error} ${acc.message}`);
  return p.value.tradeId;
}

describe("trade lifecycle (§3.5, §7.5)", () => {
  it("propose → accept → review window ends → executes, moving both rosters and recording a transaction", async () => {
    const ids = await setup();
    const clock = new FixedClock(T0);
    const a = await owned(ids[0]!, "a1");
    const b = await owned(ids[1]!, "b1");

    const p = await proposeTrade(db, clock, ids[0]!, {
      toTeamId: ids[1]!,
      givePlayerIds: [a],
      getPlayerIds: [b],
      message: "straight swap",
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const tradeId = p.value.tradeId;
    const proposed = await tradeRow(tradeId);
    expect(proposed).toMatchObject({
      status: "proposed",
      proposerTeamId: ids[0]!,
      counterpartyTeamId: ids[1]!,
      message: "straight swap",
      parentTradeId: null,
    });
    expect(proposed.proposedAt).toEqual(clock.now());

    clock.advance(HOUR);
    const acceptedAt = clock.now();
    const acc = await respondToTrade(db, clock, ids[1]!, tradeId, "accept");
    expect(acc.ok).toBe(true);
    if (!acc.ok) return;
    expect(acc.value.status).toBe("accepted");
    // 24-hour review window (§3.5)
    expect(acc.value.reviewEndsAt!.getTime()).toBe(acceptedAt.getTime() + 24 * HOUR);
    expect((await tradeRow(tradeId)).status).toBe("accepted");

    // nothing resolves before the window ends
    clock.advance(23 * HOUR);
    const early = await resolveEndedReviews(db, clock);
    expect(early.ok && early.value).toEqual([]);
    expect((await tradeRow(tradeId)).status).toBe("accepted");
    expect(await ownerOf(a)).toBe(ids[0]!);

    clock.advance(2 * HOUR); // now past reviewEndsAt
    const resolved = await resolveEndedReviews(db, clock);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toEqual([{ tradeId, status: "executed" }]);

    // rosters actually moved, both ways, acquired via 'trade'
    const aEntry = (await db.select().from(rosterEntries).where(eq(rosterEntries.playerId, a)))[0]!;
    const bEntry = (await db.select().from(rosterEntries).where(eq(rosterEntries.playerId, b)))[0]!;
    expect(aEntry).toMatchObject({ teamId: ids[1]!, acquiredVia: "trade" });
    expect(bEntry).toMatchObject({ teamId: ids[0]!, acquiredVia: "trade" });
    // incoming players arrive on the bench (§7.8)
    expect(await db.select().from(lineupEntries)).toHaveLength(0);

    const final = await tradeRow(tradeId);
    expect(final.status).toBe("executed");
    expect(final.resolvedAt).toEqual(clock.now());
    expect(final.resolutionReason).toBeNull();

    const txns = await db.select().from(transactions).where(eq(transactions.type, "trade"));
    expect(txns).toHaveLength(1);
    expect(txns[0]!.teamIds).toEqual([ids[0]!, ids[1]!]);
    expect(txns[0]!.week).toBe(1);
    expect(txns[0]!.payload).toMatchObject({
      tradeId,
      proposerTeamId: ids[0]!,
      counterpartyTeamId: ids[1]!,
      givePlayerIds: [a],
      getPlayerIds: [b],
    });
  });

  it("counter creates a new offer from the counterparty, sets the original 'countered', and counts toward its daily limit", async () => {
    const ids = await setup();
    const clock = new FixedClock(T0);
    const a = await owned(ids[0]!, "a1");
    const b1 = await owned(ids[1]!, "b1");
    const b2 = await owned(ids[1]!, "b2");
    const b3 = await owned(ids[1]!, "b3");
    const b4 = await owned(ids[1]!, "b4");
    const c = await owned(ids[2]!, "c1");
    const d = await owned(ids[3]!, "d1");

    // ids[1] has already sent 2 offers today
    const o1 = await proposeTrade(db, clock, ids[1]!, { toTeamId: ids[2]!, givePlayerIds: [b2], getPlayerIds: [c] });
    const o2 = await proposeTrade(db, clock, ids[1]!, { toTeamId: ids[3]!, givePlayerIds: [b3], getPlayerIds: [d] });
    expect(o1.ok && o2.ok).toBe(true);

    const p = await proposeTrade(db, clock, ids[0]!, { toTeamId: ids[1]!, givePlayerIds: [a], getPlayerIds: [b1] });
    expect(p.ok).toBe(true);
    if (!p.ok) return;

    clock.advance(HOUR);
    const countered = await respondToTrade(db, clock, ids[1]!, p.value.tradeId, "counter", {
      givePlayerIds: [b1],
      getPlayerIds: [a],
      message: "need more",
    });
    expect(countered.ok).toBe(true);
    if (!countered.ok) return;
    expect(countered.value.status).toBe("countered");
    const counterId = countered.value.counterTradeId!;
    expect(counterId).not.toBe(p.value.tradeId);

    const original = await tradeRow(p.value.tradeId);
    expect(original.status).toBe("countered");
    expect(original.respondedAt).toEqual(clock.now());

    const counter = await tradeRow(counterId);
    expect(counter).toMatchObject({
      status: "proposed",
      proposerTeamId: ids[1]!,
      counterpartyTeamId: ids[0]!,
      givePlayerIds: [b1],
      getPlayerIds: [a],
      parentTradeId: p.value.tradeId,
      message: "need more",
    });

    // the counter was ids[1]'s 3rd offer in the rolling 24 h → a 4th fails
    const fourth = await proposeTrade(db, clock, ids[1]!, {
      toTeamId: ids[2]!,
      givePlayerIds: [b4],
      getPlayerIds: [],
    });
    expect(fourth).toMatchObject({ ok: false, error: "offer_limit" });
  });

  it("expires an offer with no response after 48 hours", async () => {
    const ids = await setup();
    const clock = new FixedClock(T0);
    const a = await owned(ids[0]!, "a1");
    const b = await owned(ids[1]!, "b1");
    const stale = await proposeTrade(db, clock, ids[0]!, { toTeamId: ids[1]!, givePlayerIds: [a], getPlayerIds: [b] });
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;

    clock.advance(47 * HOUR);
    const tooEarly = await expireOffers(db, clock);
    expect(tooEarly.ok && tooEarly.value).toEqual([]);
    expect((await tradeRow(stale.value.tradeId)).status).toBe("proposed");

    // a fresh offer from another team must survive the sweep
    const c = await owned(ids[2]!, "c1");
    const d = await owned(ids[3]!, "d1");
    const fresh = await proposeTrade(db, clock, ids[2]!, { toTeamId: ids[3]!, givePlayerIds: [c], getPlayerIds: [d] });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;

    clock.advance(2 * HOUR); // the first offer is now 49 h old
    const swept = await expireOffers(db, clock);
    expect(swept.ok && swept.value).toEqual([stale.value.tradeId]);
    const expired = await tradeRow(stale.value.tradeId);
    expect(expired.status).toBe("expired");
    expect(expired.resolvedAt).toEqual(clock.now());
    expect((await tradeRow(fresh.value.tradeId)).status).toBe("proposed");
    // nothing moved
    expect(await ownerOf(a)).toBe(ids[0]!);
  });
});

describe("freeze rules (§3.5)", () => {
  it("while 'proposed', the proposer's give-side player cannot be dropped or offered again", async () => {
    const ids = await setup();
    const clock = new FixedClock(T0);
    const a = await owned(ids[0]!, "a1");
    const a2 = await owned(ids[0]!, "a2");
    const b = await owned(ids[1]!, "b1");
    const c = await owned(ids[2]!, "c1");

    const p = await proposeTrade(db, clock, ids[0]!, { toTeamId: ids[1]!, givePlayerIds: [a], getPlayerIds: [b] });
    expect(p.ok).toBe(true);

    expect(await dropPlayer(db, clock, ids[0]!, a)).toMatchObject({ ok: false, error: "frozen" });
    expect(await ownerOf(a)).toBe(ids[0]!);

    const second = await proposeTrade(db, clock, ids[0]!, {
      toTeamId: ids[2]!,
      givePlayerIds: [a],
      getPlayerIds: [c],
    });
    expect(second).toMatchObject({ ok: false, error: "frozen" });

    // an unfrozen player of the same team is still tradeable
    const ok = await proposeTrade(db, clock, ids[0]!, {
      toTeamId: ids[2]!,
      givePlayerIds: [a2],
      getPlayerIds: [c],
    });
    expect(ok.ok).toBe(true);
  });

  it("the counterparty's get-side player is free while 'proposed' but frozen once 'accepted'", async () => {
    const ids = await setup();
    const clock = new FixedClock(T0);
    const a = await owned(ids[0]!, "a1");
    const b = await owned(ids[1]!, "b1");
    const c = await owned(ids[2]!, "c1");

    const p = await proposeTrade(db, clock, ids[0]!, { toTeamId: ids[1]!, givePlayerIds: [a], getPlayerIds: [b] });
    expect(p.ok).toBe(true);
    if (!p.ok) return;

    // only proposed: ids[1] may still shop b elsewhere
    const elsewhere = await proposeTrade(db, clock, ids[1]!, {
      toTeamId: ids[2]!,
      givePlayerIds: [b],
      getPlayerIds: [c],
    });
    expect(elsewhere.ok).toBe(true);
    if (!elsewhere.ok) return;
    // …and that offer freezes b for ids[1], so the accept of the first trade is
    // blocked while it stands (b is now frozen elsewhere).
    const blocked = await respondToTrade(db, clock, ids[1]!, p.value.tradeId, "accept");
    expect(blocked).toMatchObject({ ok: false, error: "player_moved" });
    expect((await tradeRow(p.value.tradeId)).status).toBe("failed");

    // a clean run: cancel the side offer, propose again, accept → both sides frozen
    const cancelled = await cancelTrade(db, clock, ids[1]!, elsewhere.value.tradeId);
    expect(cancelled.ok).toBe(true);
    const tradeId = await proposeAndAccept(clock, ids, [a], [b]);
    expect((await tradeRow(tradeId)).status).toBe("accepted");

    const afterAccept = await proposeTrade(db, clock, ids[1]!, {
      toTeamId: ids[2]!,
      givePlayerIds: [b],
      getPlayerIds: [c],
    });
    expect(afterAccept).toMatchObject({ ok: false, error: "frozen" });
    expect(await dropPlayer(db, clock, ids[1]!, b)).toMatchObject({ ok: false, error: "frozen" });
    // the proposer's side stays frozen too
    expect(await dropPlayer(db, clock, ids[0]!, a)).toMatchObject({ ok: false, error: "frozen" });
  });
});

describe("offer limit (§3.5: 3 per rolling 24 hours)", () => {
  it("rejects the 4th offer inside 24 h and allows one again once the window slides", async () => {
    const ids = await setup();
    const clock = new FixedClock(T0);
    const gives: string[] = [];
    for (let i = 1; i <= 5; i++) gives.push(await owned(ids[0]!, `a${i}`));
    const gets: string[] = [];
    for (let i = 1; i <= 5; i++) gets.push(await owned(ids[1]!, `b${i}`));

    const first = await proposeTrade(db, clock, ids[0]!, {
      toTeamId: ids[1]!,
      givePlayerIds: [gives[0]!],
      getPlayerIds: [gets[0]!],
    });
    expect(first.ok).toBe(true);

    clock.advance(HOUR);
    expect(
      (await proposeTrade(db, clock, ids[0]!, {
        toTeamId: ids[1]!,
        givePlayerIds: [gives[1]!],
        getPlayerIds: [gets[1]!],
      })).ok,
    ).toBe(true);

    clock.advance(HOUR);
    expect(
      (await proposeTrade(db, clock, ids[0]!, {
        toTeamId: ids[1]!,
        givePlayerIds: [gives[2]!],
        getPlayerIds: [gets[2]!],
      })).ok,
    ).toBe(true);

    const fourth = await proposeTrade(db, clock, ids[0]!, {
      toTeamId: ids[1]!,
      givePlayerIds: [gives[3]!],
      getPlayerIds: [gets[3]!],
    });
    expect(fourth).toMatchObject({ ok: false, error: "offer_limit" });
    expect(await db.select().from(trades)).toHaveLength(3);

    // slide the window past the first offer (proposed at T0): 3 → 2 in window
    clock.set(new Date(new Date(T0).getTime() + 24 * HOUR));
    const fifth = await proposeTrade(db, clock, ids[0]!, {
      toTeamId: ids[1]!,
      givePlayerIds: [gives[3]!],
      getPlayerIds: [gets[3]!],
    });
    expect(fifth.ok).toBe(true);
    // …but the limit still binds for the next one
    const sixth = await proposeTrade(db, clock, ids[0]!, {
      toTeamId: ids[1]!,
      givePlayerIds: [gives[4]!],
      getPlayerIds: [gets[4]!],
    });
    expect(sixth).toMatchObject({ ok: false, error: "offer_limit" });
  });
});

describe("votes (§3.5)", () => {
  it("7 vetoes veto the trade and nothing moves", async () => {
    const ids = await setup();
    const clock = new FixedClock(T0);
    const a = await owned(ids[0]!, "a1");
    const b = await owned(ids[1]!, "b1");
    const tradeId = await proposeAndAccept(clock, ids, [a], [b]);

    for (let i = 2; i <= 7; i++) {
      const v = await voteOnTrade(db, clock, ids[i]!, tradeId, "veto", "no");
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.value.status).toBe("accepted");
    }
    const seventh = await voteOnTrade(db, clock, ids[8]!, tradeId, "veto", "still no");
    expect(seventh.ok).toBe(true);
    if (seventh.ok) {
      expect(seventh.value.vetoes).toBe(7);
      expect(seventh.value.status).toBe("vetoed");
    }
    expect((await tradeRow(tradeId)).status).toBe("vetoed");
    expect(await ownerOf(a)).toBe(ids[0]!);
    expect(await ownerOf(b)).toBe(ids[1]!);
    expect(await db.select().from(transactions).where(eq(transactions.type, "trade"))).toHaveLength(0);
  });

  it("4 allows execute the trade immediately", async () => {
    const ids = await setup();
    const clock = new FixedClock(T0);
    const a = await owned(ids[0]!, "a1");
    const b = await owned(ids[1]!, "b1");
    const tradeId = await proposeAndAccept(clock, ids, [a], [b]);

    for (let i = 2; i <= 4; i++) {
      const v = await voteOnTrade(db, clock, ids[i]!, tradeId, "allow", "fine by me");
      expect(v.ok && v.value.status).toBe("accepted");
    }
    const fourth = await voteOnTrade(db, clock, ids[5]!, tradeId, "allow", "fine by me");
    expect(fourth.ok).toBe(true);
    if (fourth.ok) {
      expect(fourth.value.allows).toBe(4);
      expect(fourth.value.status).toBe("executed");
    }
    expect((await tradeRow(tradeId)).status).toBe("executed");
    expect(await ownerOf(a)).toBe(ids[1]!);
    expect(await ownerOf(b)).toBe(ids[0]!);
  });

  it("retires the still-queued vote sessions the moment the trade resolves", async () => {
    // §3.5 executes at the allow threshold, hours before the 24h reviewEndsAt
    // the vote sessions were booked with as their deadline. Nothing lowered
    // that deadline, so every unrun session started later just to discover
    // there was nothing to vote on — six per early-resolved trade in
    // production (2026-09-03).
    const ids = await setup();
    const clock = new FixedClock(T0);
    const a = await owned(ids[0]!, "a1");
    const b = await owned(ids[1]!, "b1");
    const tradeId = await proposeAndAccept(clock, ids, [a], [b]);

    const voteSessions = async () =>
      (await db.select().from(sessions).where(eq(sessions.kind, "trade_vote"))).filter(
        (s) => (s.context as { trade_id?: number }).trade_id === tradeId,
      );
    const booked = await voteSessions();
    expect(booked).toHaveLength(10);
    expect(booked.every((s) => s.status === "queued")).toBe(true);

    // One is mid-run when the threshold lands: it may be mid-vote, leave it.
    await db.update(sessions).set({ status: "running" }).where(eq(sessions.id, booked[0]!.id));

    for (let i = 2; i <= 5; i++) await voteOnTrade(db, clock, ids[i]!, tradeId, "allow", "fine");
    expect((await tradeRow(tradeId)).status).toBe("executed");

    const after = await voteSessions();
    expect(after.filter((s) => s.status === "queued")).toHaveLength(0);
    const retired = after.filter((s) => s.status === "skipped");
    expect(retired).toHaveLength(9);
    // Not a loop guard, not a failure: the reason is what the digest keys on.
    expect(retired.every((s) => s.endedBy === null && s.error === MOOT_VOTE_REASON)).toBe(true);
    expect(after.find((s) => s.id === booked[0]!.id)!.status).toBe("running");
  });

  it("executes at the end of the review window with fewer than 7 vetoes", async () => {
    const ids = await setup();
    const clock = new FixedClock(T0);
    const a = await owned(ids[0]!, "a1");
    const b = await owned(ids[1]!, "b1");
    const tradeId = await proposeAndAccept(clock, ids, [a], [b]);

    for (let i = 2; i <= 7; i++) {
      const v = await voteOnTrade(db, clock, ids[i]!, tradeId, "veto", "6 vetoes is not enough");
      expect(v.ok).toBe(true);
    }
    expect((await tradeRow(tradeId)).status).toBe("accepted");

    clock.advance(25 * HOUR);
    const resolved = await resolveEndedReviews(db, clock);
    expect(resolved.ok && resolved.value).toEqual([{ tradeId, status: "executed" }]);
    expect((await tradeRow(tradeId)).status).toBe("executed");
    expect(await ownerOf(a)).toBe(ids[1]!);
    // a second sweep is a no-op
    expect((await resolveEndedReviews(db, clock)) as { ok: true; value: unknown[] }).toMatchObject({ value: [] });
  });

  it("a paused uninvolved team counts as an allow: 3 cast allows + 1 paused team executes", async () => {
    const ids = await setup();
    const clock = new FixedClock(T0);
    const a = await owned(ids[0]!, "a1");
    const b = await owned(ids[1]!, "b1");
    await db.update(teams).set({ paused: true }).where(eq(teams.id, ids[11]!));
    const tradeId = await proposeAndAccept(clock, ids, [a], [b]);

    // the paused team cannot cast a vote of its own
    expect(await voteOnTrade(db, clock, ids[11]!, tradeId, "veto", "paused")).toMatchObject({
      ok: false,
      error: "not_eligible_to_vote",
    });

    const v1 = await voteOnTrade(db, clock, ids[2]!, tradeId, "allow", "ok");
    expect(v1.ok && v1.value.allows).toBe(2); // 1 cast + 1 paused
    const v2 = await voteOnTrade(db, clock, ids[3]!, tradeId, "allow", "ok");
    expect(v2.ok && v2.value.status).toBe("accepted");
    const v3 = await voteOnTrade(db, clock, ids[4]!, tradeId, "allow", "ok");
    expect(v3.ok).toBe(true);
    if (v3.ok) {
      expect(v3.value.allows).toBe(4); // 3 cast + 1 paused
      expect(v3.value.status).toBe("executed");
    }
    expect((await tradeRow(tradeId)).status).toBe("executed");
    expect(await ownerOf(a)).toBe(ids[1]!);
  });

  it("guards: parties cannot vote, no double votes, and only trades in review accept votes", async () => {
    const ids = await setup();
    const clock = new FixedClock(T0);
    const a = await owned(ids[0]!, "a1");
    const b = await owned(ids[1]!, "b1");
    const c = await owned(ids[2]!, "c1");
    const d = await owned(ids[3]!, "d1");

    // a merely 'proposed' offer cannot be voted on
    const open = await proposeTrade(db, clock, ids[2]!, { toTeamId: ids[3]!, givePlayerIds: [c], getPlayerIds: [d] });
    expect(open.ok).toBe(true);
    if (!open.ok) return;
    expect(await voteOnTrade(db, clock, ids[4]!, open.value.tradeId, "allow", "early")).toMatchObject({
      ok: false,
      error: "bad_status",
    });

    const tradeId = await proposeAndAccept(clock, ids, [a], [b]);
    // neither party votes on its own trade
    expect(await voteOnTrade(db, clock, ids[0]!, tradeId, "allow", "mine")).toMatchObject({
      ok: false,
      error: "not_eligible_to_vote",
    });
    expect(await voteOnTrade(db, clock, ids[1]!, tradeId, "veto", "mine")).toMatchObject({
      ok: false,
      error: "not_eligible_to_vote",
    });

    expect((await voteOnTrade(db, clock, ids[5]!, tradeId, "veto", "nope")).ok).toBe(true);
    expect(await voteOnTrade(db, clock, ids[5]!, tradeId, "allow", "changed my mind")).toMatchObject({
      ok: false,
      error: "already_voted",
    });

    // and once resolved, votes are closed
    clock.advance(25 * HOUR);
    await resolveEndedReviews(db, clock);
    expect((await tradeRow(tradeId)).status).toBe("executed");
    expect(await voteOnTrade(db, clock, ids[6]!, tradeId, "veto", "too late")).toMatchObject({
      ok: false,
      error: "bad_status",
    });
  });
});

describe("trade deadline (§3.5)", () => {
  it("blocks new offers after the deadline, expires open offers, and lets a trade in review resolve", async () => {
    const ids = await setup({ currentWeek: 11 });
    const clock = new FixedClock(T0);
    const a = await owned(ids[0]!, "a1");
    const b = await owned(ids[1]!, "b1");
    const c = await owned(ids[2]!, "c1");
    const d = await owned(ids[3]!, "d1");
    const e = await owned(ids[4]!, "e1");
    const f = await owned(ids[5]!, "f1");

    const inReview = await proposeAndAccept(clock, ids, [a], [b]);
    const open = await proposeTrade(db, clock, ids[2]!, { toTeamId: ids[3]!, givePlayerIds: [c], getPlayerIds: [d] });
    expect(open.ok).toBe(true);
    if (!open.ok) return;

    // week 11 finalizes: current_week becomes 12 (> trade_deadline_week 11)
    await updateSettings(db, { currentWeek: 12 });
    const late = await proposeTrade(db, clock, ids[4]!, { toTeamId: ids[5]!, givePlayerIds: [e], getPlayerIds: [f] });
    expect(late).toMatchObject({ ok: false, error: "deadline_passed" });

    const swept = await expireAllProposedAtDeadline(db, clock);
    expect(swept.ok && swept.value).toEqual([open.value.tradeId]);
    expect((await tradeRow(open.value.tradeId)).status).toBe("expired");
    expect((await tradeRow(inReview)).status).toBe("accepted");

    // the trade already in review finishes its review normally
    clock.advance(25 * HOUR);
    const resolved = await resolveEndedReviews(db, clock);
    expect(resolved.ok && resolved.value).toEqual([{ tradeId: inReview, status: "executed" }]);
    expect(await ownerOf(a)).toBe(ids[1]!);
    expect(await ownerOf(b)).toBe(ids[0]!);
    const txns = await db.select().from(transactions).where(eq(transactions.type, "trade"));
    expect(txns[0]!.week).toBe(12);
  });
});

describe("locked players on execution (§3.3, §7.5)", () => {
  it("a traded-away locked starter keeps a ghost entry on the old team for the current week", async () => {
    const ids = await setup();
    const clock = new FixedClock(T0);
    // PHI kicked off Sunday → every PHI player is locked in week 1
    await makeGame(db, { week: 1, kickoffAt: new Date("2026-09-13T17:00:00Z"), home: "PHI", away: "DAL" });
    const lockedStarter = await owned(ids[0]!, "lockedrb", { nflTeam: "PHI" });
    const unlocked = await owned(ids[1]!, "b1");
    await setLineupEntry(db, ids[0]!, 1, lockedStarter, "RB1");
    await setLineupEntry(db, ids[0]!, 2, lockedStarter, "RB1");
    await setLineupEntry(db, ids[1]!, 1, unlocked, "RB1");

    const tradeId = await proposeAndAccept(clock, ids, [lockedStarter], [unlocked]);
    clock.advance(25 * HOUR); // still week 1; PHI's game has long kicked off
    const resolved = await resolveEndedReviews(db, clock);
    expect(resolved.ok && resolved.value).toEqual([{ tradeId, status: "executed" }]);

    // the player moved …
    expect(await ownerOf(lockedStarter)).toBe(ids[1]!);
    // … but his week-1 entry stays with the old team as a ghost (§7.5)
    const ghosts = await db.select().from(lineupEntries).where(eq(lineupEntries.playerId, lockedStarter));
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]).toMatchObject({ teamId: ids[0]!, week: 1, slot: "RB1" });
    // the receiving team has no week-1 entry for him (bench, §7.8)
    expect(
      await db
        .select()
        .from(lineupEntries)
        .where(and(eq(lineupEntries.teamId, ids[1]!), eq(lineupEntries.playerId, lockedStarter))),
    ).toHaveLength(0);

    // the unlocked player going the other way loses his week-1 entry entirely
    expect(await db.select().from(lineupEntries).where(eq(lineupEntries.playerId, unlocked))).toHaveLength(0);
    expect(await ownerOf(unlocked)).toBe(ids[0]!);
  });
});

describe("accept re-validation (§3.5)", () => {
  it("fails the trade with 'player_moved' when a give-side player left the roster", async () => {
    const ids = await setup();
    const clock = new FixedClock(T0);
    const a = await owned(ids[0]!, "a1");
    const b = await owned(ids[1]!, "b1");
    const p = await proposeTrade(db, clock, ids[0]!, { toTeamId: ids[1]!, givePlayerIds: [a], getPlayerIds: [b] });
    expect(p.ok).toBe(true);
    if (!p.ok) return;

    // a commissioner move takes the player off the roster behind the offer's back
    await db.delete(rosterEntries).where(eq(rosterEntries.playerId, a));

    clock.advance(HOUR);
    const acc = await respondToTrade(db, clock, ids[1]!, p.value.tradeId, "accept");
    expect(acc).toMatchObject({ ok: false, error: "player_moved" });

    const row = await tradeRow(p.value.tradeId);
    expect(row.status).toBe("failed");
    expect(row.resolutionReason).toBe("player_moved");
    expect(row.resolvedAt).toEqual(clock.now());
    // nothing moved and no transaction was recorded
    expect(await ownerOf(b)).toBe(ids[1]!);
    expect(await db.select().from(transactions).where(eq(transactions.type, "trade"))).toHaveLength(0);
    // the failed trade no longer freezes anyone
    expect((await dropPlayer(db, clock, ids[1]!, b)).ok).toBe(true);
  });
});

describe("roster reservation across trades in review (§3.1, §3.5)", () => {
  /** Fill `teamId` to 14 active with unlocked players named `${prefix}0..13`. */
  async function fill(teamId: number, prefix: string): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < 14; i++) ids.push(await owned(teamId, `${prefix}${i}`));
    return ids;
  }

  it("a team at 14 with a 1-for-1 in review can still accept a second 1-for-1", async () => {
    // Production week 1: a 1-for-1 accept failed with 'roster_illegal' at 15
    // because the counterparty's other 1-for-1 in review reserved its incoming
    // player without crediting the outgoing one.
    const ids = await setup();
    const clock = new FixedClock(T0);
    const a = await fill(ids[0]!, "a");
    const b = await fill(ids[1]!, "b");
    const c = await fill(ids[2]!, "c");

    // ids[1] ↔ ids[2] 1-for-1, accepted into review
    const first = await proposeTrade(db, clock, ids[2]!, { toTeamId: ids[1]!, givePlayerIds: [c[0]!], getPlayerIds: [b[0]!] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect((await respondToTrade(db, clock, ids[1]!, first.value.tradeId, "accept")).ok).toBe(true);

    // ids[0] → ids[1] 1-for-1 while the first is in review: both rosters stay at 14
    const second = await proposeTrade(db, clock, ids[0]!, { toTeamId: ids[1]!, givePlayerIds: [a[0]!], getPlayerIds: [b[1]!] });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const acc = await respondToTrade(db, clock, ids[1]!, second.value.tradeId, "accept");
    expect(acc.ok).toBe(true);
    expect((await tradeRow(second.value.tradeId)).status).toBe("accepted");
  });

  it("a 2-for-1 in review still reserves its net gain of one spot", async () => {
    const ids = await setup();
    const clock = new FixedClock(T0);
    const a: string[] = [];
    for (let i = 0; i < 13; i++) a.push(await owned(ids[0]!, `a${i}`)); // 13 active
    const b0 = await owned(ids[1]!, "b0");
    const b1 = await owned(ids[1]!, "b1");
    const c0 = await owned(ids[2]!, "c0");
    const c1 = await owned(ids[2]!, "c1");

    // ids[0] gives 1, gets 2 → net +1 held while in review: 13 + 1 = 14 on paper
    const first = await proposeTrade(db, clock, ids[1]!, {
      toTeamId: ids[0]!,
      givePlayerIds: [b0, b1],
      getPlayerIds: [a[0]!],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect((await respondToTrade(db, clock, ids[0]!, first.value.tradeId, "accept")).ok).toBe(true);

    // a further 1-for-1 is fine: 13 − 1 + 1 + 1 reserved = 14
    const swap = await proposeTrade(db, clock, ids[2]!, { toTeamId: ids[0]!, givePlayerIds: [c0], getPlayerIds: [a[1]!] });
    expect(swap.ok).toBe(true);
    // a 1-for-0 gift is not: 13 + 1 + 1 reserved = 15
    const gift = await proposeTrade(db, clock, ids[2]!, { toTeamId: ids[0]!, givePlayerIds: [c1], getPlayerIds: [] });
    expect(gift).toMatchObject({ ok: false, error: "roster_illegal" });
  });
});
