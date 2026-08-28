/**
 * Scoring, finalization, and team_week_results (SPEC §7.4, §7.7, §13.3;
 * acceptance 15.1.7 and the ghost half of 15.1.10).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import {
  SEASON,
  makePlayer,
  rosterPlayer,
  seedLeague,
  seedTeams,
  setLineupEntry,
} from "./helpers/factories.ts";
import { computePoints, finalizeWeekCore, scoreWeek, teamWeekPoints } from "../src/scoring.ts";
import { DEFAULT_SCORING_SETTINGS, getSettings, updateSettings } from "../src/settings.ts";
import { matchups, playerWeekStats, rosterEntries, teamWeekResults } from "../src/db/schema.ts";

let db: TestDb;
let close: () => Promise<void>;
const clock = new FixedClock("2026-09-15T08:00:00Z");

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

async function stat(playerId: string, week: number, ptsPpr: number): Promise<void> {
  await db.insert(playerWeekStats).values({
    playerId,
    season: SEASON,
    week,
    stats: { pts_ppr: ptsPpr },
    ptsPpr,
    enginePts: ptsPpr,
    final: true,
  });
}

describe("computePoints (§3.2)", () => {
  it("is the dot product with missing keys as 0", () => {
    expect(computePoints(DEFAULT_SCORING_SETTINGS, { rec: 6, rec_yd: 84, rec_td: 1 })).toBe(6 + 8.4 + 6);
    expect(computePoints(DEFAULT_SCORING_SETTINGS, { pass_yd: 300, pass_td: 2, pass_int: 1 })).toBe(12 + 8 - 1);
    expect(computePoints(DEFAULT_SCORING_SETTINGS, { unknown_stat: 500 })).toBe(0);
    expect(computePoints(DEFAULT_SCORING_SETTINGS, {})).toBe(0);
    // negatives apply
    expect(computePoints(DEFAULT_SCORING_SETTINGS, { fum_lost: 2, rush_yd: 10 })).toBe(-4 + 1);
  });
});

describe("scoreWeek / teamWeekPoints (§7.4)", () => {
  it("sums only the nine starting slots — bench and IR never score", async () => {
    await seedLeague(db);
    const [t1] = await seedTeams(db);
    const qb = await makePlayer(db, { position: "QB" });
    const rb = await makePlayer(db, { position: "RB" });
    const bench = await makePlayer(db, { position: "WR" });
    const ir = await makePlayer(db, { position: "TE", injuryStatus: "IR" });
    for (const p of [qb, rb, bench, ir]) await rosterPlayer(db, t1!, p);
    await setLineupEntry(db, t1!, 1, qb, "QB");
    await setLineupEntry(db, t1!, 1, rb, "RB1");
    await setLineupEntry(db, t1!, 1, ir, "IR");
    await stat(qb, 1, 24.5);
    await stat(rb, 1, 10.2);
    await stat(bench, 1, 99); // benched: no entry
    await stat(ir, 1, 50); // IR slot never scores

    expect(await teamWeekPoints(db, SEASON, t1!, 1)).toBe(34.7);
  });

  it("counts a ghost entry for the old team and treats missing stats as 0", async () => {
    await seedLeague(db);
    const [t1, t2] = await seedTeams(db);
    const traded = await makePlayer(db, { position: "RB" });
    const kept = await makePlayer(db, { position: "QB" });
    await rosterPlayer(db, t2!, traded); // now owned by t2...
    await rosterPlayer(db, t1!, kept);
    await setLineupEntry(db, t1!, 1, traded, "RB1"); // ...but the ghost entry stays with t1
    await setLineupEntry(db, t1!, 1, kept, "QB");
    await stat(traded, 1, 17);
    // `kept` has no stats row → 0

    expect(await teamWeekPoints(db, SEASON, t1!, 1)).toBe(17);
    expect(await teamWeekPoints(db, SEASON, t2!, 1)).toBe(0); // no entry on the new team
  });

  it("updates matchup points without finalizing", async () => {
    await seedLeague(db);
    const [t1, t2] = await seedTeams(db);
    const a = await makePlayer(db, { position: "QB" });
    const b = await makePlayer(db, { position: "QB" });
    await rosterPlayer(db, t1!, a);
    await rosterPlayer(db, t2!, b);
    await setLineupEntry(db, t1!, 1, a, "QB");
    await setLineupEntry(db, t2!, 1, b, "QB");
    await stat(a, 1, 20);
    await stat(b, 1, 14);
    await db.insert(matchups).values({ week: 1, homeTeamId: t1!, awayTeamId: t2! });

    const res = await scoreWeek(db, 1);
    expect(res).toHaveLength(1);
    expect(res[0]!.homePoints).toBe(20);
    const m = (await db.select().from(matchups))[0]!;
    expect(m.homePoints).toBe(20);
    expect(m.awayPoints).toBe(14);
    expect(m.final).toBe(false);
  });
});

describe("finalizeWeekCore (§7.4)", () => {
  it("sets winners, writes results, and advances the week", async () => {
    await seedLeague(db, { currentWeek: 1 });
    const [t1, t2] = await seedTeams(db);
    const a = await makePlayer(db, { position: "QB" });
    const b = await makePlayer(db, { position: "QB" });
    await rosterPlayer(db, t1!, a);
    await rosterPlayer(db, t2!, b);
    await setLineupEntry(db, t1!, 1, a, "QB");
    await setLineupEntry(db, t2!, 1, b, "QB");
    await stat(a, 1, 20);
    await stat(b, 1, 14);
    await db.insert(matchups).values({ week: 1, homeTeamId: t1!, awayTeamId: t2! });

    const res = await finalizeWeekCore(db, clock, 1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.currentWeek).toBe(2);
    const m = (await db.select().from(matchups))[0]!;
    expect(m.final).toBe(true);
    expect(m.winnerTeamId).toBe(t1!);
    expect((await getSettings(db)).currentWeek).toBe(2);
    const results = await db.select().from(teamWeekResults);
    expect(results).toHaveLength(2);
  });

  it("a regular-season tie stores no winner; a playoff tie goes to the higher seed", async () => {
    await seedLeague(db, { currentWeek: 1 });
    const [t1, t2] = await seedTeams(db);
    const a = await makePlayer(db, { position: "QB" });
    const b = await makePlayer(db, { position: "QB" });
    await rosterPlayer(db, t1!, a);
    await rosterPlayer(db, t2!, b);
    await setLineupEntry(db, t1!, 1, a, "QB");
    await setLineupEntry(db, t2!, 1, b, "QB");
    await stat(a, 1, 15);
    await stat(b, 1, 15);
    await db.insert(matchups).values({ week: 1, homeTeamId: t1!, awayTeamId: t2! });
    await finalizeWeekCore(db, clock, 1);
    expect((await db.select().from(matchups))[0]!.winnerTeamId).toBeNull();

    // playoff tie → higher seed (t2 seeded 1, t1 seeded 4) wins
    await updateSettings(db, { extra: { playoffSeeds: { [String(t2!)]: 1, [String(t1!)]: 4 } } });
    await stat(a, 15, 15);
    await stat(b, 15, 15);
    await setLineupEntry(db, t1!, 15, a, "QB");
    await setLineupEntry(db, t2!, 15, b, "QB");
    await db
      .insert(matchups)
      .values({ week: 15, homeTeamId: t1!, awayTeamId: t2!, isPlayoff: true, playoffRound: 1 });
    await updateSettings(db, { currentWeek: 15 });
    await finalizeWeekCore(db, clock, 15);
    const playoff = (await db.select().from(matchups).where(eq(matchups.week, 15)))[0]!;
    expect(playoff.winnerTeamId).toBe(t2!);
  });

  it("a week with no matchups is a no-op that still advances the week (§4.3)", async () => {
    await seedLeague(db, { currentWeek: 1, phase: "pre_draft" });
    await seedTeams(db);
    const res = await finalizeWeekCore(db, clock, 1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.matchupsFinalized).toBe(0);
    expect((await getSettings(db)).currentWeek).toBe(2);
    expect(await db.select().from(teamWeekResults)).toHaveLength(0);
  });

  it("team_week_results: actual, optimal, bench points, fa_points, empty slots", async () => {
    await seedLeague(db, { currentWeek: 1 });
    const [t1, t2] = await seedTeams(db);
    // started: drafted QB (20), waiver RB (12). benched: a better RB (30).
    const qb = await makePlayer(db, { position: "QB" });
    const waiverRb = await makePlayer(db, { position: "RB" });
    const benchRb = await makePlayer(db, { position: "RB" });
    await rosterPlayer(db, t1!, qb, "draft");
    await rosterPlayer(db, t1!, waiverRb, "waiver");
    await rosterPlayer(db, t1!, benchRb, "draft");
    await setLineupEntry(db, t1!, 1, qb, "QB");
    await setLineupEntry(db, t1!, 1, waiverRb, "RB1");
    await stat(qb, 1, 20);
    await stat(waiverRb, 1, 12);
    await stat(benchRb, 1, 30);
    const opp = await makePlayer(db, { position: "QB" });
    await rosterPlayer(db, t2!, opp);
    await db.insert(matchups).values({ week: 1, homeTeamId: t1!, awayTeamId: t2! });

    await finalizeWeekCore(db, clock, 1);
    const r = (await db.select().from(teamWeekResults).where(eq(teamWeekResults.teamId, t1!)))[0]!;
    expect(r.actualPoints).toBe(32);
    // optimal starts benchRb (30) at RB1 and waiverRb (12) at RB2/FLEX too
    expect(r.optimalPoints).toBe(62);
    expect(r.pointsLeftOnBench).toBe(30);
    expect(r.faPoints).toBe(12); // only the waiver RB's starting points
    expect(r.emptyStartingSlots).toBe(7); // 9 slots, 2 filled
  });

  it("fa_points ignores a ghost (the player is off-roster)", async () => {
    await seedLeague(db, { currentWeek: 1 });
    const [t1, t2] = await seedTeams(db);
    const ghost = await makePlayer(db, { position: "RB" });
    await rosterPlayer(db, t2!, ghost, "waiver"); // owned by t2 now
    await setLineupEntry(db, t1!, 1, ghost, "RB1"); // ghost entry on t1
    await stat(ghost, 1, 18);
    await db.insert(matchups).values({ week: 1, homeTeamId: t1!, awayTeamId: t2! });
    await finalizeWeekCore(db, clock, 1);
    const r = (await db.select().from(teamWeekResults).where(eq(teamWeekResults.teamId, t1!)))[0]!;
    expect(r.actualPoints).toBe(18); // ghost scores
    expect(r.faPoints).toBe(0); // but is not an FA acquisition of t1
  });

  it("phase moves to playoffs and then complete", async () => {
    await seedLeague(db, { currentWeek: 14, phase: "regular" });
    await seedTeams(db);
    await finalizeWeekCore(db, clock, 14);
    expect((await getSettings(db)).phase).toBe("playoffs");
    await updateSettings(db, { currentWeek: 17 });
    await finalizeWeekCore(db, clock, 17);
    expect((await getSettings(db)).phase).toBe("complete");
  });

  it("is safe to re-run: results upsert rather than duplicate", async () => {
    await seedLeague(db, { currentWeek: 1 });
    const [t1, t2] = await seedTeams(db);
    const a = await makePlayer(db, { position: "QB" });
    await rosterPlayer(db, t1!, a);
    await setLineupEntry(db, t1!, 1, a, "QB");
    await stat(a, 1, 11);
    await db.insert(matchups).values({ week: 1, homeTeamId: t1!, awayTeamId: t2! });
    await finalizeWeekCore(db, clock, 1);
    await db.update(matchups).set({ final: false }).where(eq(matchups.week, 1));
    await finalizeWeekCore(db, clock, 1);
    const rows = await db
      .select()
      .from(teamWeekResults)
      .where(and(eq(teamWeekResults.teamId, t1!), eq(teamWeekResults.week, 1)));
    expect(rows).toHaveLength(1);
    expect(await db.select().from(rosterEntries)).toHaveLength(1);
  });
});
