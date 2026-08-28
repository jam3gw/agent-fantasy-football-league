import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGames } from "../src/nflverse.ts";

const csv = readFileSync(
  fileURLToPath(new URL("../../../fixtures/nflverse/games.csv", import.meta.url)),
  "utf8",
);

describe("nflverse schedule parse (§5.5)", () => {
  it("parses 2026 with UTC kickoffs, Sleeper team codes, and the verified opener", () => {
    const games = parseGames(csv, 2026).filter((g) => g.gameType === "REG");
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
    const games = parseGames(csv, 2025).filter((g) => g.gameType === "REG");
    expect(games.every((g) => g.final && g.homeScore !== null && g.awayScore !== null)).toBe(true);
    const week5Teams = new Set(games.filter((g) => g.week === 5).flatMap((g) => [g.home, g.away]));
    expect(week5Teams.size).toBeLessThan(32); // byes exist
  });
});
