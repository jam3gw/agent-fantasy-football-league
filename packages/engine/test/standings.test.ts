/**
 * Standings, seeding, and bracket advancement (SPEC §3.7, §7.6) —
 * acceptance battery 15.1.6.
 *
 * §3.7: "Standings order: win percentage, then head-to-head record among tied
 * teams, then points for, then a stored coin flip." and "Playoffs: 6 teams.
 * Week 15: seeds 3 v 6 and 4 v 5; seeds 1 and 2 have byes. Week 16: seed 1 v
 * lowest remaining seed, seed 2 v the other. Week 17: final."
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { seedLeague, seedTeams } from "./helpers/factories.ts";
import { matchups, teams } from "../src/db/schema.ts";
import type { StandingsRow } from "../src/standings.ts";
import { advancePlayoffs, computeStandings, getPlayoffSeeds, seedPlayoffs } from "../src/standings.ts";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

const clock = new FixedClock("2026-12-22T12:00:00Z");

interface GameSpec {
  week: number;
  home: number;
  away: number;
  homePoints: number;
  awayPoints: number;
  final?: boolean;
  isPlayoff?: boolean;
  playoffRound?: number | null;
}

async function addMatchup(spec: GameSpec): Promise<number> {
  const isFinal = spec.final ?? true;
  const winnerTeamId =
    !isFinal || spec.homePoints === spec.awayPoints
      ? null
      : spec.homePoints > spec.awayPoints
        ? spec.home
        : spec.away;
  const rows = await db
    .insert(matchups)
    .values({
      week: spec.week,
      homeTeamId: spec.home,
      awayTeamId: spec.away,
      homePoints: spec.homePoints,
      awayPoints: spec.awayPoints,
      final: isFinal,
      isPlayoff: spec.isPlayoff ?? false,
      playoffRound: spec.playoffRound ?? null,
      winnerTeamId,
    })
    .returning({ id: matchups.id });
  return rows[0]!.id;
}

async function addMatchups(specs: GameSpec[]): Promise<void> {
  for (const s of specs) await addMatchup(s);
}

/** Finalize an existing (playoff) matchup row directly, as the scorer would. */
async function finalizeMatchup(id: number, homePoints: number, awayPoints: number): Promise<void> {
  const rows = await db.select().from(matchups).where(eq(matchups.id, id));
  const m = rows[0]!;
  const winner = homePoints >= awayPoints ? m.homeTeamId : m.awayTeamId;
  await db
    .update(matchups)
    .set({ homePoints, awayPoints, final: true, winnerTeamId: winner })
    .where(eq(matchups.id, id));
}

async function playoffWeek(week: number) {
  return db
    .select()
    .from(matchups)
    .where(and(eq(matchups.week, week), eq(matchups.isPlayoff, true)))
    .orderBy(asc(matchups.id));
}

function row(standings: StandingsRow[], teamId: number): StandingsRow {
  const r = standings.find((s) => s.teamId === teamId);
  if (!r) throw new Error(`team ${teamId} missing from standings`);
  return r;
}

function rankOf(standings: StandingsRow[], teamId: number): number {
  return row(standings, teamId).rank;
}

async function setup(): Promise<number[]> {
  await seedLeague(db);
  return seedTeams(db);
}

describe("computeStandings — what counts", () => {
  it("counts only final, non-playoff matchups", async () => {
    const ids = await setup();
    await addMatchups([
      // Final regular-season game: counts.
      { week: 1, home: ids[0]!, away: ids[1]!, homePoints: 120, awayPoints: 100 },
      // Not final: must not count, even though points are present.
      { week: 2, home: ids[2]!, away: ids[3]!, homePoints: 150, awayPoints: 90, final: false },
      // Playoff game: must not count towards the regular-season record.
      {
        week: 15,
        home: ids[4]!,
        away: ids[5]!,
        homePoints: 130,
        awayPoints: 110,
        isPlayoff: true,
        playoffRound: 1,
      },
    ]);

    const standings = await computeStandings(db);
    expect(standings).toHaveLength(12);

    expect(row(standings, ids[0]!)).toMatchObject({ wins: 1, losses: 0, ties: 0, winPct: 1, pointsFor: 120, pointsAgainst: 100 });
    expect(row(standings, ids[1]!)).toMatchObject({ wins: 0, losses: 1, ties: 0, winPct: 0, pointsFor: 100 });
    expect(rankOf(standings, ids[0]!)).toBe(1);

    // The non-final matchup left no trace.
    for (const id of [ids[2]!, ids[3]!]) {
      expect(row(standings, id)).toMatchObject({ wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 });
    }
    // Neither did the playoff matchup.
    for (const id of [ids[4]!, ids[5]!]) {
      expect(row(standings, id)).toMatchObject({ wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 });
    }
  });

  it("counts a regular-season tie as half a win for both teams", async () => {
    const ids = await setup();
    await addMatchups([
      { week: 1, home: ids[0]!, away: ids[1]!, homePoints: 111.5, awayPoints: 111.5 },
      { week: 2, home: ids[0]!, away: ids[2]!, homePoints: 100, awayPoints: 80 },
      { week: 2, home: ids[1]!, away: ids[3]!, homePoints: 70, awayPoints: 90 },
    ]);

    const standings = await computeStandings(db);
    // 1-0-1 → (1 + 0.5) / 2 = 0.75
    expect(row(standings, ids[0]!)).toMatchObject({ wins: 1, losses: 0, ties: 1, winPct: 0.75 });
    // 0-1-1 → (0 + 0.5) / 2 = 0.25
    expect(row(standings, ids[1]!)).toMatchObject({ wins: 0, losses: 1, ties: 1, winPct: 0.25 });
    expect(row(standings, ids[0]!).pointsFor).toBeCloseTo(211.5, 2);
    expect(rankOf(standings, ids[0]!)).toBeLessThan(rankOf(standings, ids[1]!));
  });
});

describe("computeStandings — tiebreaks (§3.7)", () => {
  it("breaks a two-team tie on head-to-head, ahead of points for", async () => {
    const ids = await setup();
    const [a, b, c, d] = [ids[0]!, ids[1]!, ids[2]!, ids[3]!];
    await addMatchups([
      // b beats a head-to-head.
      { week: 1, home: b, away: a, homePoints: 100, awayPoints: 90 },
      // a piles up points against c.
      { week: 2, home: a, away: c, homePoints: 200, awayPoints: 50 },
      // d beats b, so a and b both finish 1-1.
      { week: 3, home: d, away: b, homePoints: 100, awayPoints: 80 },
    ]);

    const standings = await computeStandings(db);
    expect(row(standings, a)).toMatchObject({ wins: 1, losses: 1, winPct: 0.5, pointsFor: 290 });
    expect(row(standings, b)).toMatchObject({ wins: 1, losses: 1, winPct: 0.5, pointsFor: 180 });
    // Head-to-head wins even though a has 110 more points for.
    expect(rankOf(standings, b)).toBeLessThan(rankOf(standings, a));
  });

  it("breaks a three-team tie on head-to-head win pct within the tied group", async () => {
    const ids = await setup();
    const [a, b, c] = [ids[0]!, ids[1]!, ids[2]!];
    const outside = [ids[3]!, ids[4]!, ids[5]!, ids[6]!, ids[7]!, ids[8]!];
    await addMatchups([
      // Inside the group: a 2-0, b 1-1, c 0-2.
      { week: 1, home: a, away: b, homePoints: 100, awayPoints: 90 },
      { week: 2, home: a, away: c, homePoints: 100, awayPoints: 90 },
      { week: 3, home: b, away: c, homePoints: 100, awayPoints: 90 },
      // Outside games equalize everyone at 2-2 while reversing points for.
      { week: 4, home: outside[0]!, away: a, homePoints: 100, awayPoints: 10 },
      { week: 5, home: outside[1]!, away: a, homePoints: 100, awayPoints: 10 },
      { week: 4, home: b, away: outside[2]!, homePoints: 100, awayPoints: 90 },
      { week: 5, home: outside[3]!, away: b, homePoints: 100, awayPoints: 60 },
      { week: 4, home: c, away: outside[4]!, homePoints: 200, awayPoints: 90 },
      { week: 5, home: c, away: outside[5]!, homePoints: 200, awayPoints: 90 },
    ]);

    const standings = await computeStandings(db);
    for (const id of [a, b, c]) {
      expect(row(standings, id), `team ${id}`).toMatchObject({ wins: 2, losses: 2, winPct: 0.5 });
    }
    // Points for run the other way: c (580) > b (350) > a (310).
    expect(row(standings, c).pointsFor).toBeGreaterThan(row(standings, b).pointsFor);
    expect(row(standings, b).pointsFor).toBeGreaterThan(row(standings, a).pointsFor);
    // Head-to-head within the tied group decides first: a (1.000) > b (.500) > c (.000).
    expect(rankOf(standings, a)).toBeLessThan(rankOf(standings, b));
    expect(rankOf(standings, b)).toBeLessThan(rankOf(standings, c));
  });

  it("falls through to points for when head-to-head is a three-way cycle", async () => {
    const ids = await setup();
    const [a, b, c] = [ids[0]!, ids[1]!, ids[2]!];
    await addMatchups([
      { week: 1, home: a, away: b, homePoints: 120, awayPoints: 100 },
      { week: 2, home: b, away: c, homePoints: 130, awayPoints: 110 },
      { week: 3, home: c, away: a, homePoints: 140, awayPoints: 90 },
    ]);

    const standings = await computeStandings(db);
    for (const id of [a, b, c]) {
      expect(row(standings, id), `team ${id}`).toMatchObject({ wins: 1, losses: 1, winPct: 0.5 });
    }
    // Every head-to-head record inside the group is 1-1, so points for decides:
    // c 250 > b 230 > a 210.
    expect(row(standings, a).pointsFor).toBeCloseTo(210, 2);
    expect(row(standings, b).pointsFor).toBeCloseTo(230, 2);
    expect(row(standings, c).pointsFor).toBeCloseTo(250, 2);
    expect(rankOf(standings, c)).toBeLessThan(rankOf(standings, b));
    expect(rankOf(standings, b)).toBeLessThan(rankOf(standings, a));
  });

  it("uses the stored coin flip when record, head-to-head, and points for are all equal", async () => {
    const ids = await setup();
    const [a, b, c, d] = [ids[0]!, ids[1]!, ids[2]!, ids[3]!];
    // a and b never meet and finish identical: 1-0 with 100 points for.
    await addMatchups([
      { week: 1, home: a, away: c, homePoints: 100, awayPoints: 50 },
      { week: 1, home: b, away: d, homePoints: 100, awayPoints: 50 },
    ]);

    const standings = await computeStandings(db);
    expect(row(standings, a)).toMatchObject({ wins: 1, losses: 0, winPct: 1, pointsFor: 100 });
    expect(row(standings, b)).toMatchObject({ wins: 1, losses: 0, winPct: 1, pointsFor: 100 });
    // Factories give team i tiebreak_rand (i + 1) / 100, so b (0.02) > a (0.01).
    expect(rankOf(standings, b)).toBe(1);
    expect(rankOf(standings, a)).toBe(2);

    // Deterministic across repeated calls.
    const again = await computeStandings(db);
    expect(again.map((r) => r.teamId)).toEqual(standings.map((r) => r.teamId));
  });

  it("orders an entirely empty season by the coin flip alone, deterministically", async () => {
    const ids = await setup();
    const first = await computeStandings(db);
    const second = await computeStandings(db);
    expect(first.map((r) => r.teamId)).toEqual([...ids].reverse());
    expect(second.map((r) => r.teamId)).toEqual(first.map((r) => r.teamId));
    expect(first.every((r) => r.winPct === 0 && r.rank > 0)).toBe(true);
  });
});

/**
 * A week-1 slate that produces a fully determined 1–12 order:
 * ids[0..5] win (points for 200, 190, … 150), ids[6..11] lose (50 … 45).
 * Seeds therefore run 1 = ids[0] … 6 = ids[5].
 */
async function seedDeterminedStandings(ids: number[]): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await addMatchup({
      week: 1,
      home: ids[i]!,
      away: ids[i + 6]!,
      homePoints: 200 - i * 10,
      awayPoints: 50 - i,
    });
  }
}

describe("seedPlayoffs (§3.7)", () => {
  it("seeds the top 6, builds 3v6 and 4v5 with the higher seed home, byes for 1–2, eliminates the rest", async () => {
    const ids = await setup();
    await seedDeterminedStandings(ids);

    const standings = await computeStandings(db);
    expect(standings.slice(0, 6).map((r) => r.teamId)).toEqual(ids.slice(0, 6));

    const res = await seedPlayoffs(db, clock);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.seeds).toEqual({
      [String(ids[0]!)]: 1,
      [String(ids[1]!)]: 2,
      [String(ids[2]!)]: 3,
      [String(ids[3]!)]: 4,
      [String(ids[4]!)]: 5,
      [String(ids[5]!)]: 6,
    });
    expect(await getPlayoffSeeds(db)).toEqual(res.value.seeds);

    const week15 = await playoffWeek(15);
    expect(week15).toHaveLength(2);
    expect(week15.map((m) => [m.homeTeamId, m.awayTeamId])).toEqual([
      [ids[2]!, ids[5]!], // 3 v 6, higher seed home
      [ids[3]!, ids[4]!], // 4 v 5, higher seed home
    ]);
    expect(week15.every((m) => m.playoffRound === 1 && m.isPlayoff && !m.final)).toBe(true);

    // Seeds 1 and 2 have no week-15 game.
    const playing = new Set(week15.flatMap((m) => [m.homeTeamId, m.awayTeamId]));
    expect(playing.has(ids[0]!)).toBe(false);
    expect(playing.has(ids[1]!)).toBe(false);

    // The six non-qualifiers are eliminated; the six qualifiers are not.
    const teamRows = await db.select().from(teams).orderBy(asc(teams.id));
    for (const t of teamRows) {
      const expected = !ids.slice(0, 6).includes(t.id);
      expect(t.eliminated, `team ${t.id}`).toBe(expected);
    }
  });

  it("is idempotent", async () => {
    const ids = await setup();
    await seedDeterminedStandings(ids);

    const first = await seedPlayoffs(db, clock);
    expect(first.ok).toBe(true);
    const before = await playoffWeek(15);

    const second = await seedPlayoffs(db, clock);
    expect(second.ok).toBe(true);
    if (!second.ok || !first.ok) return;
    expect(second.value.seeds).toEqual(first.value.seeds);

    const after = await playoffWeek(15);
    expect(after).toHaveLength(2);
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
  });

  it("fails when there are not enough teams for the bracket", async () => {
    await seedLeague(db);
    const ids = await seedTeams(db);
    for (const id of ids.slice(6)) await db.delete(teams).where(eq(teams.id, id));
    await db.delete(teams).where(eq(teams.id, ids[5]!));

    const res = await seedPlayoffs(db, clock);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("invalid_args");
  });
});

describe("advancePlayoffs (§3.7)", () => {
  async function bracket(): Promise<number[]> {
    const ids = await setup();
    await seedDeterminedStandings(ids);
    const res = await seedPlayoffs(db, clock);
    expect(res.ok).toBe(true);
    return ids;
  }

  it("refuses to advance while the previous round is unfinished", async () => {
    await bracket();
    const res = await advancePlayoffs(db, clock, 15);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("bad_status");
    expect(await playoffWeek(16)).toHaveLength(0);
  });

  it("after week 15 pairs seed 1 with the lowest remaining seed and seed 2 with the other", async () => {
    const ids = await bracket();
    const week15 = await playoffWeek(15);
    // Seed 6 upsets seed 3; seed 4 beats seed 5.
    await finalizeMatchup(week15[0]!.id, 90, 120); // ids[5] (seed 6) wins
    await finalizeMatchup(week15[1]!.id, 130, 100); // ids[3] (seed 4) wins

    const res = await advancePlayoffs(db, clock, 15);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.created).toBe(2);

    const week16 = await playoffWeek(16);
    expect(week16).toHaveLength(2);
    expect(week16.every((m) => m.playoffRound === 2 && m.isPlayoff && !m.final)).toBe(true);
    const pairs = week16.map((m) => [m.homeTeamId, m.awayTeamId]);
    // 1 v lowest remaining seed (6), 2 v the other (4); higher seed at home.
    expect(pairs).toContainEqual([ids[0]!, ids[5]!]);
    expect(pairs).toContainEqual([ids[1]!, ids[3]!]);

    // Week-15 losers are eliminated; winners and byes are not.
    const teamRows = await db.select().from(teams);
    const eliminated = new Set(teamRows.filter((t) => t.eliminated).map((t) => t.id));
    expect(eliminated.has(ids[2]!)).toBe(true); // seed 3
    expect(eliminated.has(ids[4]!)).toBe(true); // seed 5
    for (const id of [ids[0]!, ids[1]!, ids[3]!, ids[5]!]) expect(eliminated.has(id)).toBe(false);
  });

  it("is idempotent for the same completed week", async () => {
    await bracket();
    const week15 = await playoffWeek(15);
    await finalizeMatchup(week15[0]!.id, 90, 120);
    await finalizeMatchup(week15[1]!.id, 130, 100);

    const first = await advancePlayoffs(db, clock, 15);
    expect(first.ok).toBe(true);
    const before = await playoffWeek(16);

    const second = await advancePlayoffs(db, clock, 15);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.created).toBe(0);

    const after = await playoffWeek(16);
    expect(after).toHaveLength(2);
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
  });

  it("after week 16 creates the week-17 final with the higher seed at home, then stops", async () => {
    const ids = await bracket();
    const week15 = await playoffWeek(15);
    await finalizeMatchup(week15[0]!.id, 90, 120); // seed 6 advances
    await finalizeMatchup(week15[1]!.id, 130, 100); // seed 4 advances
    expect((await advancePlayoffs(db, clock, 15)).ok).toBe(true);

    const week16 = await playoffWeek(16);
    for (const m of week16) {
      // Seed 6 (ids[5]) upsets seed 1; seed 2 (ids[1]) wins its game.
      if (m.awayTeamId === ids[5]!) await finalizeMatchup(m.id, 100, 140);
      else await finalizeMatchup(m.id, 150, 90);
    }

    const res = await advancePlayoffs(db, clock, 16);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.created).toBe(1);

    const week17 = await playoffWeek(17);
    expect(week17).toHaveLength(1);
    expect(week17[0]!.playoffRound).toBe(3);
    // Seed 2 (higher) hosts seed 6.
    expect([week17[0]!.homeTeamId, week17[0]!.awayTeamId]).toEqual([ids[1]!, ids[5]!]);

    // Week-16 losers eliminated.
    const teamRows = await db.select().from(teams);
    const eliminated = new Set(teamRows.filter((t) => t.eliminated).map((t) => t.id));
    expect(eliminated.has(ids[0]!)).toBe(true); // seed 1
    expect(eliminated.has(ids[3]!)).toBe(true); // seed 4
    expect(eliminated.has(ids[1]!)).toBe(false);
    expect(eliminated.has(ids[5]!)).toBe(false);

    // The final is the last round: nothing is created after week 17.
    await finalizeMatchup(week17[0]!.id, 160, 120);
    const after = await advancePlayoffs(db, clock, 17);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.created).toBe(0);
    expect(await playoffWeek(18)).toHaveLength(0);
  });

  it("keeps playoff results out of the regular-season standings", async () => {
    const ids = await bracket();
    const before = await computeStandings(db);
    const week15 = await playoffWeek(15);
    await finalizeMatchup(week15[0]!.id, 90, 120);
    await finalizeMatchup(week15[1]!.id, 130, 100);
    const after = await computeStandings(db);
    expect(after.map((r) => [r.teamId, r.wins, r.losses, r.pointsFor])).toEqual(
      before.map((r) => [r.teamId, r.wins, r.losses, r.pointsFor]),
    );
    expect(row(after, ids[2]!).losses).toBe(0);
  });
});

describe("standings tiebreak determinism (review finding)", () => {
  it("orders a partially connected tied group by points for, not by sort implementation", async () => {
    await seedLeague(db);
    const ids = await seedTeams(db);
    const [a, b, c] = ids;
    // A beat B; C played neither of them (it played D). All three finish 1-1.
    const d = ids[3]!;
    const games: Array<[number, number, number, number, number]> = [
      // week, home, away, homePts, awayPts
      [1, a!, b!, 100, 90], // A beats B
      [2, a!, d, 80, 95], // A loses
      [3, b!, d, 105, 80], // B beats D
      [4, c!, d, 70, 99], // C loses to D
      [5, c!, ids[4]!, 120, 60], // C beats another team
    ];
    for (const [week, home, away, hp, ap] of games) {
      await db.insert(matchups).values({
        week,
        homeTeamId: home,
        awayTeamId: away,
        homePoints: hp,
        awayPoints: ap,
        final: true,
        winnerTeamId: hp > ap ? home : away,
      });
    }
    const first = await computeStandings(db);
    const second = await computeStandings(db);
    expect(first.map((r) => r.teamId)).toEqual(second.map((r) => r.teamId));
    // A, B and C are all 1-1: with the group not fully connected the order is
    // points for, descending — a well-defined result rather than sort-dependent.
    const tied = first.filter((r) => [a!, b!, c!].includes(r.teamId));
    const byPoints = [...tied].sort((x, y) => y.pointsFor - x.pointsFor);
    expect(tied.map((r) => r.teamId)).toEqual(byPoints.map((r) => r.teamId));
  });
});
