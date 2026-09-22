import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { SEASON, makeGame, seedFullRoster, seedLeague, seedTeams, setLineupEntry } from "./helpers/factories.ts";
import { health, matchupOdds, matchups, oddsRuns, playerPlayOdds, playerWeekProj, playerWeekStats, players } from "../src/db/schema.ts";
import type { JevAsk, JevReply, JevRequest } from "../src/odds.ts";
import { jevSpend, latestWeekOdds, loadOddsMatchups, oddsScoreboard, playedFromStats, runMatchupOdds } from "../src/oddsRun.ts";

let db: TestDb;
let close: () => Promise<void>;
let ids: number[];
let rosters: Awaited<ReturnType<typeof seedFullRoster>>[];
const WEEK = 3;
const clock = new FixedClock("2026-09-24T13:30:00Z"); // Thu 9:30 AM ET
const kickoff = new Date("2026-09-27T17:00:00Z");

async function setStarters(teamId: number, r: Awaited<ReturnType<typeof seedFullRoster>>) {
  const slots = [
    [r.qb, "QB"],
    [r.rb1, "RB1"],
    [r.rb2, "RB2"],
    [r.wr1, "WR1"],
    [r.wr2, "WR2"],
    [r.te, "TE"],
    [r.flexRb, "FLEX"],
    [r.dst, "DST"],
    [r.k, "K"],
  ] as const;
  for (const [pid, slot] of slots) await setLineupEntry(db, teamId, WEEK, pid, slot);
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await seedLeague(db, { currentWeek: WEEK });
  ids = await seedTeams(db);
  const nfl = ["KC", "BUF", "DAL", "PHI"];
  rosters = [];
  for (let i = 0; i < 4; i++) {
    const r = await seedFullRoster(db, ids[i]!, { nflTeam: nfl[i] });
    rosters.push(r);
    await setStarters(ids[i]!, r);
    for (const pid of r.all) {
      await db.insert(playerWeekProj).values({ playerId: pid, season: SEASON, week: WEEK, projPtsPpr: 10 });
    }
  }
  await makeGame(db, { week: WEEK, kickoffAt: kickoff, home: "KC", away: "BUF" });
  await makeGame(db, { week: WEEK, kickoffAt: kickoff, home: "DAL", away: "PHI" });
  await db.insert(matchups).values([
    { week: WEEK, homeTeamId: ids[0]!, awayTeamId: ids[1]! },
    { week: WEEK, homeTeamId: ids[2]!, awayTeamId: ids[3]! },
  ]);
  // Team 1's RB1 is questionable and projected high.
  await db.update(players).set({ injuryStatus: "Questionable", injuryBodyPart: "Hamstring" }).where(eq(players.playerId, rosters[0]!.rb1));
  await db.update(playerWeekProj).set({ projPtsPpr: 25 }).where(eq(playerWeekProj.playerId, rosters[0]!.rb1));
});
afterEach(async () => {
  await close();
});

function fakeJev(opts: { play?: number; home?: number; failOn?: "noul" | "choice" } = {}): { ask: JevAsk; calls: JevRequest[] } {
  const calls: JevRequest[] = [];
  const ask: JevAsk = async (req): Promise<JevReply> => {
    calls.push(req);
    const q = Object.values(req.questions)[0]!;
    if (opts.failOn === q.type) throw new Error("HTTP 529 from Jev via AI Gateway");
    if (q.type === "noul") return { model: "typesafe-ai/jev", answers: { plays: { type: "noul", noul: opts.play ?? 0.9 } }, inputTokens: 300, costUsd: null };
    const h = opts.home ?? 0.6;
    return {
      model: "typesafe-ai/jev",
      answers: { winner: { type: "choice", choice: h >= 0.5 ? "home" : "away", probabilities: { home: h, away: 1 - h }, confidence: 0.4 } },
      inputTokens: 2000,
      // The gateway reports its own cost on this call; the noul above falls back to the price table.
      costUsd: 0.0001,
    };
  };
  return { ask, calls };
}

describe("loadOddsMatchups (§11.1 inputs)", () => {
  it("builds starters, bench, and game state from league tables", async () => {
    const ms = await loadOddsMatchups(db, SEASON, WEEK, clock.now());
    expect(ms).toHaveLength(2);
    const home = ms[0]!.home;
    expect(home.starters).toHaveLength(9);
    expect(home.emptySlots).toEqual([]);
    expect(home.bench).toHaveLength(5);
    const rb1 = home.starters.find((s) => s.slot === "RB1")!;
    expect(rb1).toMatchObject({ injuryStatus: "Questionable", proj: 25, gameState: "not_started", opponent: "BUF" });
  });
});

describe("runMatchupOdds (§11.1)", () => {
  it("stores all four methods and the play calls in one run", async () => {
    const jev = fakeJev({ play: 0.9, home: 0.7 });
    const res = await runMatchupOdds(db, clock, { season: SEASON, week: WEEK, snapshot: "thu", jev: jev.ask });
    expect(res).toMatchObject({ existed: false, status: "succeeded", jevError: null, matchups: 2 });
    // One noul for the one questionable starter, one choice per matchup.
    expect(jev.calls.map((c) => Object.values(c.questions)[0]!.type).sort()).toEqual(["choice", "choice", "noul"]);

    const rows = await db.select().from(matchupOdds);
    expect(rows).toHaveLength(8);
    const run = (await db.select().from(oddsRuns))[0]!;
    expect(run).toMatchObject({ status: "succeeded", jevModel: "typesafe-ai/jev", jevInputTokens: 4300 });
    expect(run.jevCostUsd).toBeCloseTo(2 * 0.0001 + (300 * 0.042) / 1e6, 6);

    const calls = await db.select().from(playerPlayOdds);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ playerId: rosters[0]!.rb1, ruleProb: 0.8, jevProb: 0.9, injuryStatus: "Questionable" });

    const week = await latestWeekOdds(db, SEASON, WEEK);
    const m1 = week!.matchups[0]!;
    expect(m1.methods.jev_direct?.homeWinProb).toBeCloseTo(0.7);
    expect(m1.methods.jev_direct?.confidence).toBeCloseTo(0.4);
    // The home team's star is at 25 vs 10; the rule's 0.8 drags it below the baseline, Jev's 0.9 less so.
    expect(m1.methods.baseline!.homeWinProb).toBeGreaterThan(m1.methods.jev_composite!.homeWinProb);
    expect(m1.methods.jev_composite!.homeWinProb).toBeGreaterThan(m1.methods.rule!.homeWinProb);
    expect(week!.players[0]!.name).toContain("rb1");

    const again = await runMatchupOdds(db, clock, { season: SEASON, week: WEEK, snapshot: "thu", jev: jev.ask });
    expect(again).toMatchObject({ existed: true, runId: res.runId });
    expect(await db.select().from(matchupOdds)).toHaveLength(8);

    const h = (await db.select().from(health).where(eq(health.key, "jev")))[0];
    expect(h?.lastSuccessAt).toBeTruthy();
    expect(await jevSpend(db, SEASON)).toMatchObject({ runs: 1, inputTokens: 4300 });
  });

  it("with no key, stores baseline and rule only and marks the run partial", async () => {
    const res = await runMatchupOdds(db, clock, { season: SEASON, week: WEEK, snapshot: "thu", jev: null });
    expect(res.status).toBe("partial");
    expect(res.jevError).toMatch(/no_key/);
    const methods = new Set((await db.select().from(matchupOdds)).map((r) => r.method));
    expect([...methods].sort()).toEqual(["baseline", "rule"]);
    expect((await db.select().from(playerPlayOdds))[0]?.jevProb).toBeNull();
    // A missing key is a setting, not an outage: no health row.
    expect(await db.select().from(health).where(eq(health.key, "jev"))).toHaveLength(0);
  });

  it("drops both Jev methods for the whole run when one Jev call fails", async () => {
    const jev = fakeJev({ failOn: "choice" });
    const res = await runMatchupOdds(db, clock, { season: SEASON, week: WEEK, snapshot: "thu", jev: jev.ask });
    expect(res.status).toBe("partial");
    expect(res.jevError).toMatch(/529/);
    const methods = new Set((await db.select().from(matchupOdds)).map((r) => r.method));
    expect([...methods].sort()).toEqual(["baseline", "rule"]);
    const run = (await db.select().from(oddsRuns))[0]!;
    expect(run.jevModel).toBeNull();
    // The noul call before the failing choice was billed, so it is recorded.
    expect(run.jevInputTokens).toBe(300);
    const h = (await db.select().from(health).where(eq(health.key, "jev")))[0];
    expect(h?.lastError).toMatch(/529/);
  });

  it("rejects an answer out of shape instead of storing it", async () => {
    const ask: JevAsk = async () => ({ model: "typesafe-ai/jev", answers: {}, inputTokens: 1, costUsd: null });
    const res = await runMatchupOdds(db, clock, { season: SEASON, week: WEEK, snapshot: "thu", jev: ask });
    expect(res.status).toBe("partial");
    expect(res.jevError).toMatch(/no noul answer/);
  });

  it("returns no_matchups for a week with none", async () => {
    const res = await runMatchupOdds(db, clock, { season: SEASON, week: 9, snapshot: "thu", jev: null });
    expect(res.status).toBe("no_matchups");
    expect(await db.select().from(oddsRuns)).toHaveLength(0);
  });
});

describe("oddsScoreboard (§11.1 scoring on read)", () => {
  it("scores finalized matchups and the play calls per method and snapshot", async () => {
    const jev = fakeJev({ play: 0.9, home: 0.7 });
    await runMatchupOdds(db, clock, { season: SEASON, week: WEEK, snapshot: "thu", jev: jev.ask });

    let board = await oddsScoreboard(db, SEASON);
    expect(board.matchups).toEqual([]); // nothing final yet
    expect(board.players).toEqual([]);

    // Home wins the first, away wins the second; the questionable back played.
    const [m1, m2] = await db.select().from(matchups).orderBy(matchups.id);
    await db.update(matchups).set({ final: true, homePoints: 120, awayPoints: 100, winnerTeamId: m1!.homeTeamId }).where(eq(matchups.id, m1!.id));
    await db.update(matchups).set({ final: true, homePoints: 90, awayPoints: 95, winnerTeamId: m2!.awayTeamId }).where(eq(matchups.id, m2!.id));
    await db.insert(playerWeekStats).values({ playerId: rosters[0]!.rb1, season: SEASON, week: WEEK, stats: { gp: 1 }, ptsPpr: 20, final: true });

    board = await oddsScoreboard(db, SEASON);
    const direct = board.matchups.find((s) => s.method === "jev_direct")!;
    expect(direct.n).toBe(2);
    expect(direct.brier).toBeCloseTo(((0.7 - 1) ** 2 + (0.7 - 0) ** 2) / 2);
    expect(direct.hitRate).toBeCloseTo(0.5);
    expect(board.matchups.map((s) => s.method)).toEqual(["baseline", "rule", "jev_composite", "jev_direct"]);
    expect(board.players).toEqual([{ snapshot: "thu", n: 1, ruleBrier: expect.closeTo(0.04, 6), jevBrier: expect.closeTo(0.01, 6) }]);
    expect(board.weeks).toEqual([WEEK]);
  });

  it("playedFromStats reads gp, then gms_active", () => {
    expect(playedFromStats({ gp: 1 })).toBe(true);
    expect(playedFromStats({ gp: 0, gms_active: 1 })).toBe(false);
    expect(playedFromStats({ gms_active: 1 })).toBe(true);
    expect(playedFromStats({})).toBe(false);
    expect(playedFromStats(undefined)).toBe(false);
  });
});
