import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGames, parseNflverseWeeklyStats } from "../src/nflverse.ts";

const gamesCsv = readFileSync(
  fileURLToPath(new URL("../../../fixtures/nflverse/games.csv", import.meta.url)),
  "utf8",
);

describe("nflverse schedule parse (§5.5)", () => {
  it("parses 2026 with UTC kickoffs, Sleeper team codes, and the verified opener", () => {
    const games = parseGames(gamesCsv, 2026).filter((g) => g.gameType === "REG");
    expect(games).toHaveLength(272);
    const opener = games.reduce((a, b) => (a.kickoffAt <= b.kickoffAt ? a : b));
    // Wed Sep 9, 2026, 8:20 PM ET = Sep 10 00:20 UTC (EDT), Seahawks host Patriots (§3.7 verified)
    expect(opener.home).toBe("SEA");
    expect(opener.away).toBe("NE");
    expect(opener.kickoffAt.toISOString()).toBe("2026-09-10T00:20:00.000Z");
    // no nflverse-only codes leak through
    for (const g of games) {
      expect(g.home).not.toBe("LA");
      expect(g.away).not.toBe("LA");
    }
  });

  it("marks 2025 games final with scores; byes derivable (some team missing in some week)", () => {
    const games = parseGames(gamesCsv, 2025).filter((g) => g.gameType === "REG");
    expect(games.every((g) => g.final && g.homeScore !== null && g.awayScore !== null)).toBe(true);
    const week5Teams = new Set(games.filter((g) => g.week === 5).flatMap((g) => [g.home, g.away]));
    expect(week5Teams.size).toBeLessThan(32); // byes exist
  });
});

describe("kicking on the nflverse rung (§13.4)", () => {
  it("scores field goals and extra points from the bucketed columns", () => {
    const csv = [
      "player_id,season,week,season_type,pat_made,pat_missed,fg_made_0_19,fg_made_20_29,fg_made_30_39,fg_made_40_49,fg_made_50_59,fg_made_60_,fg_missed",
      "00-0033333,2026,3,REG,4,1,0,1,1,2,1,1,1",
    ].join("\n");
    const [row] = parseNflverseWeeklyStats(csv, 2026);
    expect(row!.stats).toEqual({
      xpm: 4,
      xpmiss: 1,
      fgm_20_29: 1,
      fgm_30_39: 1,
      fgm_40_49: 2,
      // 50–59 and 60+ both land in Sleeper's single 50-plus bucket.
      fgm_50p: 2,
      fgmiss: 1,
    });
  });

  it("falls back to the 30-39 rate when a file has no distance buckets", () => {
    const csv = ["player_id,season,week,season_type,fg_made,pat_made", "00-0033333,2026,3,REG,3,2"].join("\n");
    const [row] = parseNflverseWeeklyStats(csv, 2026);
    expect(row!.stats).toEqual({ fgm_30_39: 3, xpm: 2 });
  });

  it("does not use the fallback when the buckets are present but empty", () => {
    const csv = [
      "player_id,season,week,season_type,fg_made,fg_made_0_19,fg_made_20_29,fg_made_30_39,fg_made_40_49,fg_made_50_59,fg_made_60_",
      "00-0033333,2026,3,REG,3,0,0,0,0,0,0",
    ].join("\n");
    const [row] = parseNflverseWeeklyStats(csv, 2026);
    expect(row!.stats).toEqual({});
  });
});
