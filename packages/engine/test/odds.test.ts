import { describe, expect, it } from "vitest";
import type { OddsMatchup, OddsPlayer, OddsStarter, OddsTeam, TeamExpectation } from "../src/odds.ts";
import {
  brier,
  hitRate,
  homeWinProbability,
  jevMatchupRequest,
  jevPlayRequest,
  modelOdds,
  needsPlayCall,
  normalCdf,
  rulePlayProb,
  teamExpectation,
  timeUntil,
} from "../src/odds.ts";

const kickoff = new Date("2026-09-27T17:00:00Z");
const now = new Date("2026-09-24T13:30:00Z");

function player(id: string, over: Partial<OddsPlayer> = {}): OddsPlayer {
  return {
    playerId: id,
    name: `Player ${id}`,
    position: "RB",
    fantasyPositions: ["RB"],
    nflTeam: "KC",
    opponent: "BUF",
    kickoffAt: kickoff,
    gameState: "not_started",
    proj: 10,
    points: null,
    injuryStatus: null,
    injuryBodyPart: null,
    status: "Active",
    avgLast3: null,
    ...over,
  };
}

const starter = (id: string, slot: OddsStarter["slot"], over: Partial<OddsPlayer> = {}): OddsStarter => ({
  ...player(id, over),
  slot,
});

const form = { wins: 1, losses: 1, ties: 0, avgPoints: 110, avgPointsLast3: 112, avgPointsLeftOnBench: 20, emptyStartingSlotsSeason: 0 };

function team(teamId: number, starters: OddsStarter[], bench: OddsPlayer[] = []): OddsTeam {
  return { teamId, starters, emptySlots: [], bench, form };
}

describe("rulePlayProb (§11.1 fixed rule)", () => {
  it("maps statuses, case-insensitively, falling back to the long-form status", () => {
    expect(rulePlayProb(null, "Active")).toBe(1);
    expect(rulePlayProb("Questionable", null)).toBe(0.8);
    expect(rulePlayProb("doubtful", null)).toBe(0.2);
    expect(rulePlayProb("Out", null)).toBe(0);
    expect(rulePlayProb(null, "Injured Reserve")).toBe(0);
    expect(rulePlayProb("Unknown tag", "Active")).toBe(1);
  });
});

describe("teamExpectation", () => {
  it("sums projections with p = 1 for healthy starters", () => {
    const t = team(1, [starter("a", "RB1", { proj: 12 }), starter("b", "RB2", { proj: 8 })]);
    const e = teamExpectation(t, () => 1, { backups: true });
    expect(e.expected).toBeCloseTo(20);
    expect(e.variance).toBeCloseTo((0.5 * 12) ** 2 + (0.5 * 8) ** 2);
  });

  it("mixes a doubtful starter with the best eligible healthy bench player", () => {
    const t = team(
      1,
      [starter("a", "RB1", { proj: 15, injuryStatus: "Questionable" })],
      [
        player("wr", { position: "WR", fantasyPositions: ["WR"], proj: 14 }), // not RB-eligible
        player("hurt", { proj: 13, injuryStatus: "Out" }), // not healthy
        player("played", { proj: 12, gameState: "final" }), // already played
        player("b1", { proj: 9 }),
      ],
    );
    const e = teamExpectation(t, () => 0.6, { backups: true });
    const s = e.starters[0]!;
    expect(s.backupPlayerId).toBe("b1");
    expect(s.expected).toBeCloseTo(0.6 * 15 + 0.4 * 9);
    const sig = 0.5 * 15;
    const bsig = 0.5 * 9;
    expect(s.variance).toBeCloseTo(0.6 * sig ** 2 + 0.4 * bsig ** 2 + 0.6 * 0.4 * (15 - 9) ** 2);
  });

  it("gives one bench player to one starter only", () => {
    const t = team(
      1,
      [starter("a", "RB1", { injuryStatus: "Out" }), starter("b", "RB2", { injuryStatus: "Out" })],
      [player("b1", { proj: 9 })],
    );
    const e = teamExpectation(t, () => 0, { backups: true });
    expect(e.starters.map((s) => s.backupPlayerId)).toEqual(["b1", null]);
    expect(e.expected).toBeCloseTo(9);
  });

  it("baseline: projections as they stand, no backups, a bye is zero", () => {
    const t = team(
      1,
      [starter("a", "RB1", { proj: 15, injuryStatus: "Out" }), starter("bye", "RB2", { gameState: "none", kickoffAt: null, proj: 0 })],
      [player("b1", { proj: 9 })],
    );
    const e = teamExpectation(t, () => 1, { backups: false });
    expect(e.expected).toBeCloseTo(15);
    expect(e.starters.every((s) => s.backupPlayerId === null)).toBe(true);
  });

  it("the rule and Jev methods cover a bye starter with a backup", () => {
    const t = team(1, [starter("bye", "RB1", { gameState: "none", kickoffAt: null, proj: 0 })], [player("b1", { proj: 7 })]);
    expect(teamExpectation(t, () => 1, { backups: true }).expected).toBeCloseTo(7);
  });

  it("uses final points with no variance, and in-progress players at max(points, proj)", () => {
    const t = team(1, [
      starter("f", "RB1", { gameState: "final", points: 22, proj: 10 }),
      starter("live", "RB2", { gameState: "in_progress", points: 4, proj: 10 }),
    ]);
    const e = teamExpectation(t, () => 0, { backups: true });
    expect(e.expected).toBeCloseTo(32);
    expect(e.variance).toBeCloseTo((0.5 * 10) ** 2);
  });
});

describe("win probability", () => {
  it("normalCdf matches known values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1)).toBeCloseTo(0.841345, 5);
    expect(normalCdf(-1.96)).toBeCloseTo(0.024998, 5);
  });

  it("is 0.5 for equal teams and handles zero variance", () => {
    const e: TeamExpectation = { expected: 100, variance: 100, starters: [] };
    expect(homeWinProbability(e, e)).toBeCloseTo(0.5);
    const z = (x: number): TeamExpectation => ({ expected: x, variance: 0, starters: [] });
    expect(homeWinProbability(z(101), z(100))).toBe(1);
    expect(homeWinProbability(z(99), z(100))).toBe(0);
    expect(homeWinProbability(z(100), z(100))).toBe(0.5);
  });

  it("modelOdds: an injured home star lowers the rule and Jev odds but not the baseline", () => {
    const m: OddsMatchup = {
      matchupId: 1,
      week: 3,
      isPlayoff: false,
      home: team(1, [starter("star", "RB1", { proj: 25, injuryStatus: "Doubtful" })], [player("b1", { proj: 5 })]),
      away: team(2, [starter("x", "RB1", { proj: 18 })]),
    };
    const base = modelOdds(m, "baseline");
    const rule = modelOdds(m, "rule");
    const jev = modelOdds(m, "jev_composite", new Map([["star", 0.9]]));
    expect(base.homeWinProb).toBeGreaterThan(0.5);
    expect(rule.homeWinProb).toBeLessThan(0.5);
    expect(jev.homeWinProb).toBeGreaterThan(rule.homeWinProb);
    expect(() => modelOdds(m, "jev_composite", new Map())).toThrow(/no Jev play call/);
  });
});

describe("Jev requests", () => {
  it("needsPlayCall: tagged and not started only", () => {
    expect(needsPlayCall(player("a", { injuryStatus: "Questionable" }))).toBe(true);
    expect(needsPlayCall(player("a"))).toBe(false);
    expect(needsPlayCall(player("a", { injuryStatus: "Questionable", gameState: "in_progress" }))).toBe(false);
  });

  it("the play request carries only the player's facts, with the time as text", () => {
    const req = jevPlayRequest(starter("a", "RB1", { injuryStatus: "Questionable", injuryBodyPart: "Hamstring" }), now);
    expect(req.questions.plays?.type).toBe("noul");
    const p = req.state.player as Record<string, unknown>;
    expect(p.injury_status).toBe("Questionable");
    expect(p.injury_body_part).toBe("Hamstring");
    expect(p.time_until_kickoff).toBe("about 3 days");
    expect(JSON.stringify(req)).not.toMatch(/team_id|model/i);
  });

  it("the matchup request is keyed home/away, never team names or model ids", () => {
    const m: OddsMatchup = {
      matchupId: 7,
      week: 3,
      isPlayoff: false,
      home: team(1, [starter("a", "RB1", { proj: 20 })]),
      away: team(2, [starter("b", "RB1", { proj: 15, injuryStatus: "Out" })]),
    };
    const req = jevMatchupRequest(m, now);
    expect(req.questions.winner).toMatchObject({ type: "choice", criteria: { home: expect.any(String), away: expect.any(String) } });
    expect(req.state.projected_margin_home_minus_away).toBe(5);
    const away = req.state.away as Record<string, unknown>;
    expect(away.projected_points_from_starters_out_doubtful_or_on_bye).toBe(15);
    expect(JSON.stringify(req.state)).not.toMatch(/"team_id"|anthropic|openai/);
  });

  it("timeUntil", () => {
    const at = (h: number) => new Date(now.getTime() + h * 3_600_000);
    expect(timeUntil(now, at(-1))).toBe("already started");
    expect(timeUntil(now, at(0.5))).toBe("less than an hour");
    expect(timeUntil(now, at(5))).toBe("about 5 hours");
    expect(timeUntil(now, at(72))).toBe("about 3 days");
  });
});

describe("scoring", () => {
  it("brier and hitRate", () => {
    expect(brier([])).toBeNull();
    expect(brier([{ p: 1, outcome: 1 }, { p: 0.5, outcome: 0 }])).toBeCloseTo(0.125);
    expect(hitRate([{ p: 0.7, outcome: 1 }, { p: 0.7, outcome: 0 }, { p: 0.5, outcome: 1 }, { p: 0.2, outcome: 0.5 }])).toBeCloseTo(0.5);
  });
});
