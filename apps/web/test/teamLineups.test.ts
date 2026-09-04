/**
 * `teamLineups` reads every team's lineup for a week in three queries; the
 * matchups page, `teamLineup`, and the public team and matchup APIs all
 * depend on its grouping and its fallbacks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playerWeekStats } from "@league/engine";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { SEASON, makePlayer, seedLeague, seedTeams, setLineupEntry } from "../../../packages/engine/test/helpers/factories";

let db: TestDb;
let close: () => Promise<void>;

vi.mock("../lib/db", () => ({
  db: () => db,
  leagueClock: async () => ({ now: () => new Date() }),
}));

import { teamLineup, teamLineups } from "../lib/queries";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await seedLeague(db);
});
afterEach(() => close());

describe("teamLineups", () => {
  it("groups every team's entries, with names and points where they exist", async () => {
    const [a, b, c] = await seedTeams(db);
    const qb = await makePlayer(db, { position: "QB", fullName: "Quarterback A", nflTeam: "KC" });
    const rb = await makePlayer(db, { position: "RB", fullName: "Runner B", nflTeam: "SF" });
    const shared = await makePlayer(db, { position: "WR", fullName: "Shared WR", nflTeam: "DAL" });
    await setLineupEntry(db, a, 1, qb, "QB");
    await setLineupEntry(db, a, 1, shared, "WR1");
    await setLineupEntry(db, b, 1, rb, "RB1");
    await setLineupEntry(db, b, 1, shared, "WR1");
    // Week 2 entries and another team's week-1 entries must not leak in.
    await setLineupEntry(db, a, 2, rb, "RB1");
    await db.insert(playerWeekStats).values([
      { playerId: qb, season: SEASON, week: 1, stats: {}, ptsPpr: 21.4 },
      { playerId: shared, season: SEASON, week: 1, stats: {}, ptsPpr: 9.5 },
      { playerId: rb, season: SEASON, week: 2, stats: {}, ptsPpr: 30 },
    ]);

    const byTeam = await teamLineups([a, b, c], 1, SEASON);

    expect([...byTeam.keys()].sort()).toEqual([a, b].sort());
    expect(byTeam.has(c), "a team with no entries that week is left out").toBe(false);
    expect(byTeam.get(a)).toEqual(
      expect.arrayContaining([
        { slot: "QB", playerId: qb, name: "Quarterback A", position: "QB", nflTeam: "KC", points: 21.4 },
        { slot: "WR1", playerId: shared, name: "Shared WR", position: "WR", nflTeam: "DAL", points: 9.5 },
      ]),
    );
    expect(byTeam.get(b)).toEqual(
      expect.arrayContaining([
        // No week-1 stats row yet: zero points, not a missing player.
        { slot: "RB1", playerId: rb, name: "Runner B", position: "RB", nflTeam: "SF", points: 0 },
        { slot: "WR1", playerId: shared, name: "Shared WR", position: "WR", nflTeam: "DAL", points: 9.5 },
      ]),
    );
    expect(byTeam.get(a)).toHaveLength(2);
    expect(byTeam.get(b)).toHaveLength(2);
  });

  it("returns an empty map for no teams, and an empty list from teamLineup for an empty team", async () => {
    const [a] = await seedTeams(db);
    expect((await teamLineups([], 1, SEASON)).size).toBe(0);
    expect(await teamLineup(a, 1, SEASON)).toEqual([]);
  });

  it("teamLineup is the one-team view of the same read", async () => {
    const [a] = await seedTeams(db);
    const qb = await makePlayer(db, { position: "QB" });
    await setLineupEntry(db, a, 3, qb, "QB");
    const one = await teamLineup(a, 3, SEASON);
    expect(one).toEqual((await teamLineups([a], 3, SEASON)).get(a));
    expect(one.map((p) => p.playerId)).toEqual([qb]);
  });
});
