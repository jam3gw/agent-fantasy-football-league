import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "@league/shared";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { makeGame, makePlayer, rosterPlayer, seedFullRoster, seedLeague, seedTeams, SEASON } from "./helpers/factories.ts";
import { getSettings } from "../src/settings.ts";
import { isPlayerLocked, lockedPlayerIds } from "../src/locks.ts";
import { activeCount, frozenPlayerIds, frozenPlayerTrades, frozenPlayerTradesForTeams, frozenReason, isIrIllegal } from "../src/roster.ts";
import { setLineupEntry } from "./helpers/factories.ts";
import { trades } from "../src/db/schema.ts";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

describe("migrations + settings", () => {
  it("applies the full schema and reads back the singleton", async () => {
    await seedLeague(db);
    const s = await getSettings(db);
    expect(s.season).toBe(SEASON);
    expect(s.rosterSlots.BN).toBe(5);
    expect(s.scoringSettings.rec).toBe(1);
    expect(s.irEligibleStatuses).toContain("PUP");
    expect(s.tradeVetoVotes).toBe(7);
  });
});

describe("locks (§3.3)", () => {
  it("locks a player from his game's kickoff; bye/teamless players never lock", async () => {
    await seedLeague(db);
    const kc = await makePlayer(db, { playerId: "kc1", nflTeam: "KC" });
    const buf = await makePlayer(db, { playerId: "buf1", nflTeam: "BUF" });
    const fa = await makePlayer(db, { playerId: "noteam", nflTeam: null });
    await makeGame(db, { week: 1, kickoffAt: new Date("2026-09-13T17:00:00Z"), home: "KC", away: "PHI" });

    const before = new FixedClock("2026-09-13T16:59:00Z");
    const after = new FixedClock("2026-09-13T17:00:00Z");

    expect(await isPlayerLocked(db, before, SEASON, 1, kc)).toBe(false);
    expect(await isPlayerLocked(db, after, SEASON, 1, kc)).toBe(true);
    expect(await isPlayerLocked(db, after, SEASON, 1, buf)).toBe(false); // no game (bye)
    expect(await isPlayerLocked(db, after, SEASON, 1, fa)).toBe(false);
    // wrong week: game is week 1, week 2 unaffected
    expect(await isPlayerLocked(db, after, SEASON, 2, kc)).toBe(false);
    const set = await lockedPlayerIds(db, after, SEASON, 1, [kc, buf, fa]);
    expect([...set]).toEqual([kc]);
  });
});

describe("roster helpers", () => {
  it("activeCount subtracts a filled IR slot", async () => {
    await seedLeague(db);
    const [t1] = await seedTeams(db);
    const r = await seedFullRoster(db, t1!);
    expect(await activeCount(db, t1!, 1)).toBe(14);
    const ir = await makePlayer(db, { playerId: "ir1", injuryStatus: "IR", nflTeam: "SF" });
    await rosterPlayer(db, t1!, ir);
    expect(await activeCount(db, t1!, 1)).toBe(15); // no IR entry yet
    await setLineupEntry(db, t1!, 1, ir, "IR");
    expect(await activeCount(db, t1!, 1)).toBe(14); // IR occupied
    expect(r.all.length + 1).toBe(15);
  });

  it("isIrIllegal flags a healthy IR occupant", async () => {
    const settings = await seedLeague(db);
    const [t1] = await seedTeams(db);
    const ir = await makePlayer(db, { playerId: "irx", injuryStatus: "IR" });
    await rosterPlayer(db, t1!, ir);
    await setLineupEntry(db, t1!, 1, ir, "IR");
    expect(await isIrIllegal(db, settings, t1!, 1)).toBe(false);
    const { players } = await import("../src/db/schema.ts");
    const { eq } = await import("drizzle-orm");
    await db.update(players).set({ injuryStatus: null, status: "Active" }).where(eq(players.playerId, ir));
    expect(await isIrIllegal(db, settings, t1!, 1)).toBe(true);
  });

  it("frozenPlayerIds follows §3.5 (proposed: give side only; accepted: both sides)", async () => {
    await seedLeague(db);
    const [t1, t2] = await seedTeams(db);
    const a = await makePlayer(db, { playerId: "a" });
    const b = await makePlayer(db, { playerId: "b" });
    await rosterPlayer(db, t1!, a);
    await rosterPlayer(db, t2!, b);
    await db.insert(trades).values({
      proposerTeamId: t1!,
      counterpartyTeamId: t2!,
      givePlayerIds: [a],
      getPlayerIds: [b],
      status: "proposed",
      proposedAt: new Date(),
    });
    expect([...(await frozenPlayerIds(db, t1!))]).toEqual([a]);
    expect([...(await frozenPlayerIds(db, t2!))]).toEqual([]); // counterparty free while proposed
    const { eq } = await import("drizzle-orm");
    await db.update(trades).set({ status: "accepted" }).where(eq(trades.proposerTeamId, t1!));
    expect([...(await frozenPlayerIds(db, t1!))]).toEqual([a]);
    expect([...(await frozenPlayerIds(db, t2!))]).toEqual([b]);
  });

  it("frozenPlayerTrades names one stable trade per player: review over open offer, oldest open offer first", async () => {
    await seedLeague(db);
    const [t1, t2, t3] = await seedTeams(db);
    const a = await makePlayer(db, { playerId: "a" });
    await rosterPlayer(db, t1!, a);
    const row = (to: number, status: "proposed" | "accepted") => ({
      proposerTeamId: t1!,
      counterpartyTeamId: to,
      givePlayerIds: [a],
      getPlayerIds: [],
      status,
      proposedAt: new Date(),
    });
    const [first] = await db.insert(trades).values(row(t2!, "proposed")).returning({ id: trades.id });
    await db.insert(trades).values(row(t3!, "proposed"));
    expect((await frozenPlayerTrades(db, t1!)).get(a)).toEqual({ tradeId: first!.id, status: "proposed" });

    // A review (inserted last, so it is not the lowest id) wins over both open offers.
    const [review] = await db.insert(trades).values(row(t3!, "accepted")).returning({ id: trades.id });
    expect((await frozenPlayerTrades(db, t1!)).get(a)).toEqual({ tradeId: review!.id, status: "accepted" });
    expect(frozenReason({ tradeId: review!.id, status: "accepted" })).toBe(`trade ${review!.id} (in review)`);
    expect(frozenReason({ tradeId: first!.id, status: "proposed" })).toBe(`trade ${first!.id} (your open offer)`);

    // Teams outside the asked-for set are not built, and a team with nothing frozen gets an empty map.
    const only = await frozenPlayerTradesForTeams(db, [t2!]);
    expect(only.has(t1!)).toBe(false);
    expect(only.get(t2!)!.size).toBe(0);
  });
});
