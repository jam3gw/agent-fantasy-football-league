/**
 * Schedule generation (SPEC §3.7) — acceptance battery 15.1.5.
 *
 * §3.7: "each team plays every other team once (11 games) using the circle
 * method, then repeat the pairings of weeks 1–3 for weeks 12–14. Deterministic
 * from a seed stored in settings. If `start_week > 1`, drop the earliest weeks."
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { seedLeague, seedTeams } from "./helpers/factories.ts";
import { leagueSettings, matchups, teams, transactions } from "../src/db/schema.ts";
import type { ScheduledGame } from "../src/schedule.ts";
import { createSeasonSchedule, generateSchedule } from "../src/schedule.ts";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

const clock = new FixedClock("2026-09-01T12:00:00Z");

/** 12 synthetic team ids for the pure-function tests. */
const TEAM_IDS = Array.from({ length: 12 }, (_, i) => i + 1);
const SEED = "seed-alpha";

/** Unordered pair key — home/away independent. */
function pairKey(g: ScheduledGame): string {
  return [g.homeTeamId, g.awayTeamId].sort((a, b) => a - b).join("-");
}

function byWeek(games: ScheduledGame[]): Map<number, ScheduledGame[]> {
  const m = new Map<number, ScheduledGame[]>();
  for (const g of games) {
    const list = m.get(g.week) ?? [];
    list.push(g);
    m.set(g.week, list);
  }
  return m;
}

function weekPairs(games: ScheduledGame[], week: number): string[] {
  return games
    .filter((g) => g.week === week)
    .map(pairKey)
    .sort();
}

/** teamId → number of games played across the whole schedule. */
function gameCounts(games: ScheduledGame[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const g of games) {
    counts.set(g.homeTeamId, (counts.get(g.homeTeamId) ?? 0) + 1);
    counts.set(g.awayTeamId, (counts.get(g.awayTeamId) ?? 0) + 1);
  }
  return counts;
}

describe("generateSchedule — 12 teams, weeks 1–14", () => {
  const games = generateSchedule(TEAM_IDS, SEED, 1);

  it("covers weeks 1–14 with six games a week and 14 games per team", () => {
    const weeks = byWeek(games);
    expect([...weeks.keys()].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    for (const [week, list] of weeks) {
      expect(list, `week ${week}`).toHaveLength(6);
    }
    expect(games).toHaveLength(84);
    for (const id of TEAM_IDS) {
      expect(gameCounts(games).get(id), `team ${id}`).toBe(14);
    }
  });

  it("gives every team exactly one game in every week", () => {
    for (const [week, list] of byWeek(games)) {
      const seen = list.flatMap((g) => [g.homeTeamId, g.awayTeamId]).sort((a, b) => a - b);
      expect(seen, `week ${week}`).toEqual(TEAM_IDS);
    }
  });

  it("never schedules a team against itself", () => {
    for (const g of games) expect(g.homeTeamId).not.toBe(g.awayTeamId);
  });

  it("has every team play every other team exactly once in weeks 1–11", () => {
    const first11 = games.filter((g) => g.week <= 11);
    expect(first11).toHaveLength(66);
    const keys = first11.map(pairKey);
    expect(new Set(keys).size).toBe(66);

    for (const id of TEAM_IDS) {
      const opponents = first11
        .filter((g) => g.homeTeamId === id || g.awayTeamId === id)
        .map((g) => (g.homeTeamId === id ? g.awayTeamId : g.homeTeamId));
      expect(opponents, `team ${id} opponent count`).toHaveLength(11);
      expect(new Set(opponents).size, `team ${id} distinct opponents`).toBe(11);
      expect([...opponents].sort((a, b) => a - b)).toEqual(TEAM_IDS.filter((t) => t !== id));
    }
  });

  it("repeats the pairings of rounds 1–3 in weeks 12–14", () => {
    for (const week of [12, 13, 14]) {
      expect(weekPairs(games, week), `week ${week} vs week ${week - 11}`).toEqual(
        weekPairs(games, week - 11),
      );
    }
  });

  it("swaps home and away in the repeated weeks 12–14", () => {
    for (const week of [12, 13, 14]) {
      const original = games.filter((g) => g.week === week - 11);
      const repeat = games.filter((g) => g.week === week);
      for (const g of original) {
        expect(
          repeat.some((r) => r.homeTeamId === g.awayTeamId && r.awayTeamId === g.homeTeamId),
          `week ${week} mirrors ${g.homeTeamId} v ${g.awayTeamId}`,
        ).toBe(true);
      }
    }
  });

  it("is deterministic: the same seed produces an identical schedule", () => {
    expect(generateSchedule(TEAM_IDS, SEED, 1)).toEqual(generateSchedule(TEAM_IDS, SEED, 1));
  });

  it("produces a different schedule for a different seed", () => {
    const other = generateSchedule(TEAM_IDS, "seed-beta", 1);
    expect(other).not.toEqual(games);
    // Different in the pairings themselves, not merely in home/away.
    const mine = new Set(games.filter((g) => g.week <= 11).map((g) => `${g.week}:${pairKey(g)}`));
    const theirs = other.filter((g) => g.week <= 11).map((g) => `${g.week}:${pairKey(g)}`);
    expect(theirs.some((k) => !mine.has(k))).toBe(true);
    // Still a valid round robin.
    expect(new Set(other.filter((g) => g.week <= 11).map(pairKey)).size).toBe(66);
  });

  it("rejects an odd number of teams", () => {
    expect(() => generateSchedule(TEAM_IDS.slice(0, 11), SEED, 1)).toThrow(/even number/);
    expect(() => generateSchedule([1], SEED, 1)).toThrow(/even number/);
  });
});

describe("generateSchedule — startWeek = 3 (late draft, §3.7)", () => {
  const full = generateSchedule(TEAM_IDS, SEED, 1);
  const late = generateSchedule(TEAM_IDS, SEED, 3);

  it("only contains weeks 3–14 and gives every team 12 games", () => {
    expect([...byWeek(late).keys()].sort((a, b) => a - b)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    expect(late).toHaveLength(72);
    for (const id of TEAM_IDS) {
      expect(gameCounts(late).get(id), `team ${id}`).toBe(12);
      const perWeek = late.filter((g) => g.homeTeamId === id || g.awayTeamId === id);
      expect(new Set(perWeek.map((g) => g.week)).size).toBe(12);
    }
  });

  it("drops only the earliest weeks — weeks 3–14 match the full schedule exactly", () => {
    expect(late).toEqual(full.filter((g) => g.week >= 3));
  });

  it("still repeats the pairings of rounds 1–3 in weeks 12–14", () => {
    for (const week of [12, 13, 14]) {
      expect(weekPairs(late, week), `week ${week}`).toEqual(weekPairs(full, week - 11));
    }
  });
});

describe("createSeasonSchedule", () => {
  it("inserts the regular season, stores a schedule seed, and records a transaction", async () => {
    await seedLeague(db);
    const ids = await seedTeams(db);

    const res = await createSeasonSchedule(db, clock);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.created).toBe(84);
    expect(res.value.startWeek).toBe(1);
    expect(res.value.seed).not.toBe("");

    const stored = await db.select().from(leagueSettings).where(eq(leagueSettings.id, 1));
    expect(stored[0]!.scheduleSeed).toBe(res.value.seed);

    const rows = await db.select().from(matchups).orderBy(asc(matchups.id));
    expect(rows).toHaveLength(84);
    expect(rows.every((r) => r.isPlayoff === false && r.final === false)).toBe(true);
    expect(rows.every((r) => r.week >= 1 && r.week <= 14)).toBe(true);

    // The stored rows are exactly the deterministic schedule for that seed.
    const expected = generateSchedule(ids, res.value.seed, 1, 14);
    expect(rows.map((r) => ({ week: r.week, homeTeamId: r.homeTeamId, awayTeamId: r.awayTeamId }))).toEqual(
      expected,
    );

    // Each team once per week, 11 distinct opponents in weeks 1–11.
    for (const id of ids) {
      const mine = rows.filter((r) => r.homeTeamId === id || r.awayTeamId === id);
      expect(mine).toHaveLength(14);
      const early = mine
        .filter((r) => r.week <= 11)
        .map((r) => (r.homeTeamId === id ? r.awayTeamId : r.homeTeamId));
      expect(new Set(early).size).toBe(11);
    }

    const txs = await db.select().from(transactions);
    const scheduleTx = txs.filter(
      (t) => (t.payload as { action?: string }).action === "schedule_created",
    );
    expect(scheduleTx).toHaveLength(1);
    expect(scheduleTx[0]!.type).toBe("commissioner");
    expect((scheduleTx[0]!.payload as { games?: number }).games).toBe(84);
  });

  it("is idempotent: a second call creates nothing and leaves the rows untouched", async () => {
    await seedLeague(db);
    await seedTeams(db);

    const first = await createSeasonSchedule(db, clock);
    expect(first.ok).toBe(true);
    const before = await db.select().from(matchups).orderBy(asc(matchups.id));

    const second = await createSeasonSchedule(db, clock);
    expect(second.ok).toBe(true);
    if (!second.ok || !first.ok) return;
    expect(second.value.created).toBe(0);
    expect(second.value.seed).toBe(first.value.seed);

    const after = await db.select().from(matchups).orderBy(asc(matchups.id));
    expect(after).toHaveLength(84);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r) => `${r.week}:${r.homeTeamId}-${r.awayTeamId}`)).toEqual(
      before.map((r) => `${r.week}:${r.homeTeamId}-${r.awayTeamId}`),
    );
  });

  it("uses the seed already stored in settings", async () => {
    await seedLeague(db, { scheduleSeed: "stored-seed" });
    const ids = await seedTeams(db);

    const res = await createSeasonSchedule(db, clock);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.seed).toBe("stored-seed");

    const rows = await db.select().from(matchups).orderBy(asc(matchups.id));
    expect(rows.map((r) => ({ week: r.week, homeTeamId: r.homeTeamId, awayTeamId: r.awayTeamId }))).toEqual(
      generateSchedule(ids, "stored-seed", 1, 14),
    );
  });

  it("honours start_week > 1: only weeks 3–14 exist and every team plays 12 games", async () => {
    await seedLeague(db, { startWeek: 3, scheduleSeed: "stored-seed" });
    const ids = await seedTeams(db);

    const res = await createSeasonSchedule(db, clock);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.created).toBe(72);
    expect(res.value.startWeek).toBe(3);

    const rows = await db.select().from(matchups);
    expect(rows).toHaveLength(72);
    expect(Math.min(...rows.map((r) => r.week))).toBe(3);
    expect(Math.max(...rows.map((r) => r.week))).toBe(14);
    for (const id of ids) {
      expect(rows.filter((r) => r.homeTeamId === id || r.awayTeamId === id)).toHaveLength(12);
    }
    // Weeks 12–14 still repeat rounds 1–3 of the same seeded round robin.
    const full = generateSchedule(ids, "stored-seed", 1, 14);
    const stored = rows.map((r) => ({ week: r.week, homeTeamId: r.homeTeamId, awayTeamId: r.awayTeamId }));
    for (const week of [12, 13, 14]) {
      expect(weekPairs(stored, week), `week ${week}`).toEqual(weekPairs(full, week - 11));
    }
  });

  it("fails when the team count is odd", async () => {
    await seedLeague(db);
    const ids = await seedTeams(db);
    // Remove one team so 11 remain.
    await db.delete(teams).where(eq(teams.id, ids[11]!));

    const res = await createSeasonSchedule(db, clock);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("invalid_args");
  });
});
