/**
 * 15.1.7 — optimal lineup. The engine's backtracking search is checked against
 * an independent brute-force permutation solver on hundreds of random rosters,
 * including multi-position players (where greedy per-position selection fails).
 */
import { describe, expect, it } from "vitest";
import { computeOptimalLineup, type OptimalCandidate } from "../src/optimal.ts";
import { SLOT_ELIGIBILITY, STARTING_SLOTS } from "../src/roster.ts";

/**
 * Independent reference: try every assignment of players to the 9 slots.
 *
 * The walk is exhaustive; the memo only stops it re-walking a suffix of slots
 * it has already solved for the same set of used players. The best total from
 * slot `i` on depends on nothing but `i` and that set, so the memo changes
 * nothing about the answer and turns a twenty-second test into a fast one.
 */
function bruteForce(candidates: OptimalCandidate[]): number {
  const slots = [...STARTING_SLOTS];
  const used = new Set<string>();
  const memo = new Map<string, number>();
  const best = (i: number): number => {
    if (i === slots.length) return 0;
    const key = `${i}|${[...used].sort().join(",")}`;
    const seen = memo.get(key);
    if (seen !== undefined) return seen;
    const slot = slots[i]!;
    let top = best(i + 1); // leave empty
    for (const c of candidates) {
      if (used.has(c.playerId)) continue;
      const positions = c.fantasyPositions ?? [];
      if (!SLOT_ELIGIBILITY[slot].some((p) => positions.includes(p))) continue;
      used.add(c.playerId);
      top = Math.max(top, c.pts + best(i + 1));
      used.delete(c.playerId);
    }
    memo.set(key, top);
    return top;
  };
  return Math.round(Math.max(0, best(0)) * 100) / 100;
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POSITION_SETS: string[][] = [
  ["QB"],
  ["RB"],
  ["WR"],
  ["TE"],
  ["K"],
  ["DEF"],
  ["RB", "WR"], // multi-position: the case greedy gets wrong
  ["WR", "TE"],
  ["RB", "TE"],
];

function randomRoster(rand: () => number, size: number): OptimalCandidate[] {
  const out: OptimalCandidate[] = [];
  for (let i = 0; i < size; i++) {
    const positions = POSITION_SETS[Math.floor(rand() * POSITION_SETS.length)]!;
    // occasional negative scores (a DST can go negative)
    const pts = Math.round((rand() * 40 - 4) * 10) / 10;
    out.push({ playerId: `p${i}`, fantasyPositions: positions, pts });
  }
  return out;
}

describe("computeOptimalLineup (15.1.7)", () => {
  it("matches brute force on 250 random rosters, including multi-position players", () => {
    const rand = mulberry32(12345);
    for (let trial = 0; trial < 250; trial++) {
      const size = 3 + Math.floor(rand() * 13); // 3..15 players
      const roster = randomRoster(rand, size);
      const engine = computeOptimalLineup(roster);
      const reference = bruteForce(roster);
      expect(engine.total, `trial ${trial} roster ${JSON.stringify(roster)}`).toBeCloseTo(reference, 2);
    }
  });

  it("beats greedy on the classic multi-position case", () => {
    // Two RB slots + FLEX. The [RB,WR] swing player is worth more at WR2.
    const roster: OptimalCandidate[] = [
      { playerId: "rb-a", fantasyPositions: ["RB"], pts: 20 },
      { playerId: "rb-b", fantasyPositions: ["RB"], pts: 18 },
      { playerId: "swing", fantasyPositions: ["RB", "WR"], pts: 15 },
      { playerId: "rb-c", fantasyPositions: ["RB"], pts: 14 },
      { playerId: "wr-a", fantasyPositions: ["WR"], pts: 12 },
    ];
    const r = computeOptimalLineup(roster);
    // RB1/RB2 = 20+18, WR1 = wr-a 12, WR2 = swing 15, FLEX = rb-c 14
    expect(r.total).toBe(79);
    expect(bruteForce(roster)).toBe(79);
  });

  it("leaves a slot empty rather than starting a negative scorer", () => {
    const roster: OptimalCandidate[] = [
      { playerId: "qb", fantasyPositions: ["QB"], pts: 20 },
      { playerId: "dst", fantasyPositions: ["DEF"], pts: -3 },
    ];
    const r = computeOptimalLineup(roster);
    expect(r.total).toBe(20);
    expect(r.assignment.DST).toBeUndefined();
    expect(r.assignment.QB).toBe("qb");
  });

  it("handles a roster that cannot fill nine slots, and an empty roster", () => {
    const r = computeOptimalLineup([
      { playerId: "a", fantasyPositions: ["QB"], pts: 10 },
      { playerId: "b", fantasyPositions: ["K"], pts: 8 },
    ]);
    expect(r.total).toBe(18);
    expect(Object.keys(r.assignment).sort()).toEqual(["K", "QB"]);
    expect(computeOptimalLineup([]).total).toBe(0);
  });

  it("fills a full 15-man roster legally (no player used twice)", () => {
    const roster: OptimalCandidate[] = [
      { playerId: "qb1", fantasyPositions: ["QB"], pts: 22 },
      { playerId: "qb2", fantasyPositions: ["QB"], pts: 19 },
      { playerId: "rb1", fantasyPositions: ["RB"], pts: 18 },
      { playerId: "rb2", fantasyPositions: ["RB"], pts: 16 },
      { playerId: "rb3", fantasyPositions: ["RB"], pts: 11 },
      { playerId: "wr1", fantasyPositions: ["WR"], pts: 21 },
      { playerId: "wr2", fantasyPositions: ["WR"], pts: 14 },
      { playerId: "wr3", fantasyPositions: ["WR"], pts: 13 },
      { playerId: "te1", fantasyPositions: ["TE"], pts: 12 },
      { playerId: "te2", fantasyPositions: ["TE"], pts: 4 },
      { playerId: "k1", fantasyPositions: ["K"], pts: 9 },
      { playerId: "dst1", fantasyPositions: ["DEF"], pts: 7 },
      { playerId: "swing", fantasyPositions: ["RB", "WR"], pts: 17 },
      { playerId: "bench1", fantasyPositions: ["WR"], pts: 2 },
      { playerId: "bench2", fantasyPositions: ["RB"], pts: 1 },
    ];
    const r = computeOptimalLineup(roster);
    expect(r.total).toBeCloseTo(bruteForce(roster), 2);
    const usedIds = Object.values(r.assignment);
    expect(new Set(usedIds).size).toBe(usedIds.length);
    expect(usedIds).toHaveLength(9);
  });
});
