/**
 * §7.4 — when may a week finalize? `weekGamesComplete` is the guard that
 * keeps the calendar-booked Tuesday finalization from scoring a week nobody
 * has played (the 2026-09-01 incident: week 1 finalized 0–0 nine days
 * before its first kickoff).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "@league/shared";
import { initLeagueSettings, matchups, nflGames, teams, weekGamesComplete } from "../src/index.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";

let db: TestDb;
let close: () => Promise<void>;
let clock: FixedClock;

const NOW = "2026-09-15T08:00:00Z";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = new FixedClock(NOW);
  await initLeagueSettings(db, { season: 2026, phase: "regular", currentWeek: 1 });
});
afterEach(async () => {
  await close();
});

async function seedMatchup(week: number) {
  const rows = await db
    .insert(teams)
    .values([
      { slug: `a${week}`, name: "A", modelId: "m/a", modelLabel: "A", provider: "t", tiebreakRand: 0.1 },
      { slug: `b${week}`, name: "B", modelId: "m/b", modelLabel: "B", provider: "t", tiebreakRand: 0.2 },
    ])
    .returning({ id: teams.id });
  await db.insert(matchups).values({ week, homeTeamId: rows[0]!.id, awayTeamId: rows[1]!.id });
}

function game(gameId: string, week: number, kickoffAt: string, season = 2026) {
  return { gameId, season, week, kickoffAt: new Date(kickoffAt), home: "SEA", away: "SF" };
}

describe("weekGamesComplete", () => {
  it("a week with no matchups is complete — §7.4's no-op advance", async () => {
    expect(await weekGamesComplete(db, clock, 1)).toEqual({ complete: true });
  });

  it("matchups with no games recorded is a fault, not a green light", async () => {
    await seedMatchup(1);
    expect(await weekGamesComplete(db, clock, 1)).toEqual({ complete: false, reason: "no_games_recorded" });
  });

  it("pending until every kickoff is 4.5 hours past; complete at exactly that instant", async () => {
    await seedMatchup(1);
    // Kickoff exactly 4.5h before the clock: the boundary is complete.
    await db.insert(nflGames).values(game("g1", 1, "2026-09-15T03:30:00Z"));
    expect(await weekGamesComplete(db, clock, 1)).toMatchObject({ complete: true });

    // One second later a kickoff and the week is pending again, naming when it ends.
    await db.insert(nflGames).values(game("g2", 1, "2026-09-15T03:30:01Z"));
    const pending = await weekGamesComplete(db, clock, 1);
    expect(pending).toMatchObject({ complete: false, reason: "games_pending" });
    if (!pending.complete && pending.reason === "games_pending") {
      expect(pending.lastGameEndsAt.toISOString()).toBe("2026-09-15T08:00:01.000Z");
    }
  });

  it("one future kickoff holds the whole week, however many games are done", async () => {
    await seedMatchup(1);
    await db.insert(nflGames).values([
      game("thu", 1, "2026-09-10T00:15:00Z"),
      game("sun", 1, "2026-09-13T17:00:00Z"),
      game("mon", 1, "2026-09-15T23:15:00Z"), // Monday night, after the clock
    ]);
    expect(await weekGamesComplete(db, clock, 1)).toMatchObject({ complete: false, reason: "games_pending" });
  });

  it("ignores another season's games entirely", async () => {
    await seedMatchup(1);
    await db.insert(nflGames).values(game("old", 1, "2025-09-14T17:00:00Z", 2025));
    expect(await weekGamesComplete(db, clock, 1)).toEqual({ complete: false, reason: "no_games_recorded" });
  });

  it("complete weeks report when their last game ended, for the watchdog", async () => {
    await seedMatchup(1);
    await db.insert(nflGames).values(game("done", 1, "2026-09-13T17:00:00Z"));
    const done = await weekGamesComplete(db, clock, 1);
    expect(done.complete).toBe(true);
    if (done.complete) expect(done.lastGameEndsAt?.toISOString()).toBe("2026-09-13T21:30:00.000Z");
  });
});
