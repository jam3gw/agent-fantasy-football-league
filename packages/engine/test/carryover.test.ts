/**
 * 15.1.10 — carry-over and ghosts. Week W+1 entries copy W for rostered
 * players only; a traded-away locked starter still scores for the old team in
 * W (ghost) and never appears in W+1.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import {
  SEASON,
  makeGame,
  makePlayer,
  rosterPlayer,
  seedLeague,
  seedTeams,
  setLineupEntry,
} from "./helpers/factories.ts";
import { carryOverLineups } from "../src/carryover.ts";
import { lineupEntries, rosterEntries, transactions } from "../src/db/schema.ts";
import { teamWeekPoints } from "../src/scoring.ts";
import { playerWeekStats } from "../src/db/schema.ts";

let db: TestDb;
let close: () => Promise<void>;
const clock = new FixedClock("2026-09-15T08:00:00Z");

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

describe("carryOverLineups (§7.8)", () => {
  it("copies every slot including IR for players still on the roster", async () => {
    await seedLeague(db, { currentWeek: 1 });
    const [t1] = await seedTeams(db);
    const qb = await makePlayer(db, { position: "QB" });
    const rb = await makePlayer(db, { position: "RB" });
    const ir = await makePlayer(db, { position: "TE", injuryStatus: "IR" });
    for (const p of [qb, rb, ir]) await rosterPlayer(db, t1!, p);
    await setLineupEntry(db, t1!, 1, qb, "QB");
    await setLineupEntry(db, t1!, 1, rb, "RB1");
    await setLineupEntry(db, t1!, 1, ir, "IR");

    const res = await carryOverLineups(db, clock, 1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.teamsCarried).toBe(1);
    expect(res.value.entriesCreated).toBe(3);

    const next = await db
      .select()
      .from(lineupEntries)
      .where(and(eq(lineupEntries.teamId, t1!), eq(lineupEntries.week, 2)));
    expect(next).toHaveLength(3);
    expect(next.find((e) => e.slot === "IR")!.playerId).toBe(ir);
    expect(next.find((e) => e.slot === "QB")!.playerId).toBe(qb);

    const txs = await db.select().from(transactions).where(eq(transactions.type, "lineup"));
    expect(txs).toHaveLength(1);
    expect((txs[0]!.payload as { carried_over?: boolean }).carried_over).toBe(true);
    expect(txs[0]!.week).toBe(2);
  });

  it("skips a team that already set week W+1 and leaves its entries untouched", async () => {
    await seedLeague(db, { currentWeek: 1 });
    const [t1] = await seedTeams(db);
    const qb = await makePlayer(db, { position: "QB" });
    const qb2 = await makePlayer(db, { position: "QB" });
    await rosterPlayer(db, t1!, qb);
    await rosterPlayer(db, t1!, qb2);
    await setLineupEntry(db, t1!, 1, qb, "QB");
    await setLineupEntry(db, t1!, 2, qb2, "QB"); // already planned ahead

    const res = await carryOverLineups(db, clock, 1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.teamsSkipped).toBeGreaterThanOrEqual(1);
    const next = await db
      .select()
      .from(lineupEntries)
      .where(and(eq(lineupEntries.teamId, t1!), eq(lineupEntries.week, 2)));
    expect(next).toHaveLength(1);
    expect(next[0]!.playerId).toBe(qb2); // untouched
  });

  it("never copies a ghost: a traded-away locked starter scores in W but is absent in W+1", async () => {
    await seedLeague(db, { currentWeek: 1 });
    const [t1, t2] = await seedTeams(db);
    const traded = await makePlayer(db, { position: "RB", nflTeam: "KC" });
    const kept = await makePlayer(db, { position: "QB", nflTeam: "KC" });
    await rosterPlayer(db, t1!, kept);
    await rosterPlayer(db, t2!, traded); // already moved to t2 mid-week
    await makeGame(db, { week: 1, kickoffAt: new Date("2026-09-13T17:00:00Z"), home: "KC", away: "PHI" });
    await setLineupEntry(db, t1!, 1, traded, "RB1"); // ghost stays on t1
    await setLineupEntry(db, t1!, 1, kept, "QB");
    await db.insert(playerWeekStats).values({
      playerId: traded,
      season: SEASON,
      week: 1,
      stats: { pts_ppr: 21 },
      ptsPpr: 21,
      final: true,
    });

    // the ghost still scores for the old team in week 1 (§7.5)
    expect(await teamWeekPoints(db, SEASON, t1!, 1)).toBe(21);

    await carryOverLineups(db, clock, 1);
    const t1Week2 = await db
      .select()
      .from(lineupEntries)
      .where(and(eq(lineupEntries.teamId, t1!), eq(lineupEntries.week, 2)));
    expect(t1Week2.map((e) => e.playerId)).toEqual([kept]); // ghost not carried
    const t2Week2 = await db
      .select()
      .from(lineupEntries)
      .where(and(eq(lineupEntries.teamId, t2!), eq(lineupEntries.week, 2)));
    expect(t2Week2).toHaveLength(0); // new owner starts him on the bench
  });

  it("drops entries for players who left the roster and keeps the rest", async () => {
    await seedLeague(db, { currentWeek: 1 });
    const [t1] = await seedTeams(db);
    const stays = await makePlayer(db, { position: "QB" });
    const dropped = await makePlayer(db, { position: "RB" });
    await rosterPlayer(db, t1!, stays);
    await rosterPlayer(db, t1!, dropped);
    await setLineupEntry(db, t1!, 1, stays, "QB");
    await setLineupEntry(db, t1!, 1, dropped, "RB1");
    await db.delete(rosterEntries).where(eq(rosterEntries.playerId, dropped));

    const res = await carryOverLineups(db, clock, 1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.entriesCreated).toBe(1);
    const next = await db
      .select()
      .from(lineupEntries)
      .where(and(eq(lineupEntries.teamId, t1!), eq(lineupEntries.week, 2)));
    expect(next.map((e) => e.playerId)).toEqual([stays]);
  });

  it("teams with no week-W entries are skipped (post-draft: everyone starts empty)", async () => {
    await seedLeague(db, { currentWeek: 1 });
    await seedTeams(db);
    const res = await carryOverLineups(db, clock, 1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.teamsCarried).toBe(0);
    expect(res.value.teamsSkipped).toBe(12);
    expect(await db.select().from(lineupEntries)).toHaveLength(0);
  });
});
