/**
 * Pure scheduling logic: snake draft order (§3.8) and kickoff windows (§9.2).
 * Both are pure functions, so they are tested without a database.
 */
import { describe, expect, it } from "vitest";
import { snakeSlot } from "../lib/draft";
import { groupKickoffWindows } from "../lib/weekPlan";
import { refinalizeCutoff } from "../lib/refinalizeWindow";

describe("snakeSlot (§3.8)", () => {
  it("runs forward in odd rounds and backward in even rounds", () => {
    // Round 1: picks 1..12 map to order indices 0..11
    expect(snakeSlot(1, 12)).toEqual({ round: 1, slotInRound: 1, orderIndex: 0 });
    expect(snakeSlot(12, 12)).toEqual({ round: 1, slotInRound: 12, orderIndex: 11 });
    // Round 2 reverses: pick 13 goes to the team that picked last
    expect(snakeSlot(13, 12)).toEqual({ round: 2, slotInRound: 1, orderIndex: 11 });
    expect(snakeSlot(24, 12)).toEqual({ round: 2, slotInRound: 12, orderIndex: 0 });
    // Round 3 forward again
    expect(snakeSlot(25, 12)).toEqual({ round: 3, slotInRound: 1, orderIndex: 0 });
  });

  it("gives every team exactly 14 picks over 168", () => {
    const counts = new Map<number, number>();
    for (let pick = 1; pick <= 168; pick++) {
      const { orderIndex } = snakeSlot(pick, 12);
      counts.set(orderIndex, (counts.get(orderIndex) ?? 0) + 1);
    }
    expect(counts.size).toBe(12);
    for (const [, n] of counts) expect(n).toBe(14);
  });

  it("gives the turn team back-to-back picks at each snake turn", () => {
    // pick 12 (end of round 1) and pick 13 (start of round 2) are the same team
    expect(snakeSlot(12, 12).orderIndex).toBe(snakeSlot(13, 12).orderIndex);
    expect(snakeSlot(24, 12).orderIndex).toBe(snakeSlot(25, 12).orderIndex);
  });
});

describe("groupKickoffWindows (§9.2)", () => {
  const game = (iso: string, home: string, away: string) => ({ kickoffAt: new Date(iso), home, away });

  it("groups kickoffs within 30 minutes of each other", () => {
    const windows = groupKickoffWindows([
      game("2026-09-13T17:00:00Z", "KC", "PHI"),
      game("2026-09-13T17:00:00Z", "BUF", "NYJ"),
      game("2026-09-13T17:15:00Z", "SF", "SEA"), // within 30 min → same window
      game("2026-09-13T20:25:00Z", "DAL", "NYG"), // later → its own window
      game("2026-09-14T00:20:00Z", "GB", "CHI"),
    ]);
    expect(windows).toHaveLength(3);
    expect(windows[0]!.key.toISOString()).toBe("2026-09-13T17:00:00.000Z");
    expect(windows[0]!.nflTeams.sort()).toEqual(["BUF", "KC", "NYJ", "PHI", "SEA", "SF"]);
    expect(windows[1]!.nflTeams.sort()).toEqual(["DAL", "NYG"]);
    expect(windows[2]!.nflTeams.sort()).toEqual(["CHI", "GB"]);
  });

  it("keys each window by its earliest kickoff and handles a single game", () => {
    const windows = groupKickoffWindows([game("2026-09-11T00:20:00Z", "SEA", "NE")]);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.key.toISOString()).toBe("2026-09-11T00:20:00.000Z");
  });

  it("returns nothing for a bye-heavy week with no games", () => {
    expect(groupKickoffWindows([])).toEqual([]);
  });

  it("chains games that drift by less than 30 minutes each", () => {
    // 1:00, 1:25, 1:50 — each within 30 minutes of the window key? No: the
    // window key stays the earliest, so 1:50 opens a new window.
    const windows = groupKickoffWindows([
      game("2026-09-13T17:00:00Z", "A", "B"),
      game("2026-09-13T17:25:00Z", "C", "D"),
      game("2026-09-13T17:50:00Z", "E", "F"),
    ]);
    expect(windows).toHaveLength(2);
    expect(windows[0]!.nflTeams.sort()).toEqual(["A", "B", "C", "D"]);
    expect(windows[1]!.nflTeams.sort()).toEqual(["E", "F"]);
  });
});

describe("re-finalization window (§13.4)", () => {
  const et = (iso: string) => new Date(iso);

  it("is open between Tuesday 4:00 AM and Tuesday 9:00 AM ET", () => {
    // 2026-09-15 is a Tuesday. ET is UTC-4 in September.
    const tue0500Et = et("2026-09-15T09:00:00Z");
    expect(tue0500Et < refinalizeCutoff(tue0500Et)).toBe(true);
    expect(refinalizeCutoff(tue0500Et).toISOString()).toBe("2026-09-15T13:00:00.000Z");
  });

  it("is closed from Tuesday 9:00 AM ET onward", () => {
    const tue0930Et = et("2026-09-15T13:30:00Z");
    expect(tue0930Et >= refinalizeCutoff(tue0930Et)).toBe(true);
  });

  it("is closed every other day of the week", () => {
    for (const iso of [
      "2026-09-16T13:00:00Z", // Wednesday 9:00 ET
      "2026-09-17T20:00:00Z", // Thursday 4:00 PM ET
      "2026-09-20T17:00:00Z", // Sunday 1:00 PM ET
      "2026-09-15T07:00:00Z", // Tuesday 3:00 AM ET — before this week's finalization
    ]) {
      const now = et(iso);
      expect(now >= refinalizeCutoff(now), iso).toBe(true);
    }
  });

  it("holds across the November DST change", () => {
    // 2026-11-01 is the fall-back Sunday; ET is UTC-5 from then on.
    const tue0500Et = et("2026-11-03T10:00:00Z");
    expect(refinalizeCutoff(tue0500Et).toISOString()).toBe("2026-11-03T14:00:00.000Z");
    expect(tue0500Et < refinalizeCutoff(tue0500Et)).toBe(true);
  });
});
