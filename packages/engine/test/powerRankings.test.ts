import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "@league/shared";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { seedLeague, seedTeams } from "./helpers/factories.ts";
import {
  MAX_RANKING_REASON_LENGTH,
  latestPowerRankings,
  publishPowerRankings,
  rankingMovement,
} from "../src/powerRankings.ts";

let db: TestDb;
let close: () => Promise<void>;
let ids: number[];
const clock = new FixedClock("2026-09-08T15:00:00Z");

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await seedLeague(db);
  ids = await seedTeams(db);
});
afterEach(async () => {
  await close();
});

const full = (order: number[]) => order.map((teamId, i) => ({ teamId, rank: i + 1, reason: `Reason ${i + 1}.` }));

describe("power rankings (§11)", () => {
  it("writes one edition of twelve rows in rank order", async () => {
    const res = await publishPowerRankings(db, clock, { sessionId: 1, week: 1, entries: full(ids) });
    expect(res.ok).toBe(true);
    const [edition] = await latestPowerRankings(db);
    expect(edition?.sessionId).toBe(1);
    expect(edition?.week).toBe(1);
    expect(edition?.entries.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(edition?.entries.map((e) => e.teamId)).toEqual(ids);
  });

  it("refuses a missing team, a repeated team, a repeated rank, a gap, and an empty reason", async () => {
    const short = full(ids).slice(0, 11);
    expect((await publishPowerRankings(db, clock, { sessionId: 1, week: 1, entries: short })).ok).toBe(false);

    const dupTeam = full(ids);
    dupTeam[1] = { ...dupTeam[1]!, teamId: ids[0]! };
    const r1 = await publishPowerRankings(db, clock, { sessionId: 1, week: 1, entries: dupTeam });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toBe("invalid_args");

    const dupRank = full(ids);
    dupRank[1] = { ...dupRank[1]!, rank: 1 };
    expect((await publishPowerRankings(db, clock, { sessionId: 1, week: 1, entries: dupRank })).ok).toBe(false);

    const gap = full(ids);
    gap[11] = { ...gap[11]!, rank: 13 };
    expect((await publishPowerRankings(db, clock, { sessionId: 1, week: 1, entries: gap })).ok).toBe(false);

    const blank = full(ids);
    blank[0] = { ...blank[0]!, reason: "   " };
    expect((await publishPowerRankings(db, clock, { sessionId: 1, week: 1, entries: blank })).ok).toBe(false);

    const long = full(ids);
    long[0] = { ...long[0]!, reason: "x".repeat(MAX_RANKING_REASON_LENGTH + 1) };
    const r2 = await publishPowerRankings(db, clock, { sessionId: 1, week: 1, entries: long });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe("too_long");

    const unknown = full(ids);
    unknown[0] = { ...unknown[0]!, teamId: 999 };
    const r3 = await publishPowerRankings(db, clock, { sessionId: 1, week: 1, entries: unknown });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error).toBe("not_found");

    // Nothing was written by any of the refusals.
    expect(await latestPowerRankings(db)).toEqual([]);
  });

  it("a session publishes once", async () => {
    expect((await publishPowerRankings(db, clock, { sessionId: 1, week: 1, entries: full(ids) })).ok).toBe(true);
    const again = await publishPowerRankings(db, clock, { sessionId: 1, week: 1, entries: full(ids) });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toBe("bad_status");
  });

  it("the newest edition comes first and movement is measured against the one before", async () => {
    await publishPowerRankings(db, clock, { sessionId: 1, week: 1, entries: full(ids) });
    const later = new FixedClock("2026-09-15T15:00:00Z");
    const swapped = [...ids];
    // Team at rank 3 climbs to 1; the old 1 and 2 each drop one place.
    swapped.splice(0, 0, swapped.splice(2, 1)[0]!);
    await publishPowerRankings(db, later, { sessionId: 2, week: 2, entries: full(swapped) });

    const editions = await latestPowerRankings(db);
    expect(editions.map((e) => e.sessionId)).toEqual([2, 1]);
    const move = rankingMovement(editions[0]!, editions[1]);
    expect(move.get(ids[2]!)).toBe(2);
    expect(move.get(ids[0]!)).toBe(-1);
    expect(move.get(ids[1]!)).toBe(-1);
    expect(move.get(ids[3]!)).toBe(0);
    // The first edition has nothing to move against.
    expect([...rankingMovement(editions[1]!, undefined).values()].every((m) => m === 0)).toBe(true);
    // Only the two newest when asked for two, even with three on file.
    await publishPowerRankings(db, new FixedClock("2026-09-22T15:00:00Z"), { sessionId: 3, week: 3, entries: full(ids) });
    expect((await latestPowerRankings(db, 2)).map((e) => e.sessionId)).toEqual([3, 2]);
    expect((await latestPowerRankings(db, 1)).map((e) => e.sessionId)).toEqual([3]);
  });
});
