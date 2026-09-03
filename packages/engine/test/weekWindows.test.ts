/**
 * Kickoff windows (SPEC §9.2) and the lineup-check lead. Pure functions,
 * shared by the week plan (books the checks) and the context snapshot (tells
 * the agent when they run), so they are pinned here in the engine.
 */
import { describe, expect, it } from "vitest";
import { groupKickoffWindows, lineupCheckDueAt } from "../src/weekWindows.ts";

const game = (iso: string, home: string, away: string) => ({ kickoffAt: new Date(iso), home, away });

describe("groupKickoffWindows (§9.2)", () => {
  it("puts kickoffs within 30 minutes of each other in one window, keyed by the earliest", () => {
    const windows = groupKickoffWindows([
      game("2026-09-13T20:25:00Z", "LV", "MIA"),
      game("2026-09-13T17:00:00Z", "KC", "BUF"),
      game("2026-09-13T17:00:00Z", "DAL", "NYG"),
      game("2026-09-13T20:05:00Z", "ARI", "LAC"),
    ]);
    expect(windows.map((w) => w.key.toISOString())).toEqual(["2026-09-13T17:00:00.000Z", "2026-09-13T20:05:00.000Z"]);
    expect(windows[0]!.nflTeams).toEqual(["KC", "BUF", "DAL", "NYG"]);
    expect(windows[1]!.nflTeams).toEqual(["ARI", "LAC", "LV", "MIA"]);
  });

  it("gives a lone game its own window", () => {
    const windows = groupKickoffWindows([game("2026-09-11T00:20:00Z", "SEA", "NE")]);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.nflTeams).toEqual(["SEA", "NE"]);
  });

  it("is empty for no games", () => {
    expect(groupKickoffWindows([])).toEqual([]);
  });

  it("does not mutate the input order", () => {
    const games = [game("2026-09-13T20:25:00Z", "LV", "MIA"), game("2026-09-13T17:00:00Z", "KC", "BUF")];
    groupKickoffWindows(games);
    expect(games[0]!.home).toBe("LV");
  });
});

describe("lineupCheckDueAt (§9.2 step 3)", () => {
  it("is 90 minutes before the window's first kickoff", () => {
    const [w] = groupKickoffWindows([game("2026-09-13T17:00:00Z", "KC", "BUF")]);
    expect(lineupCheckDueAt(w!).toISOString()).toBe("2026-09-13T15:30:00.000Z");
  });
});
