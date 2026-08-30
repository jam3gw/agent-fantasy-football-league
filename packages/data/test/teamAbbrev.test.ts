/** 15.1.8 — 32 teams round-trip between nflverse and Sleeper. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv.ts";
import { SLEEPER_TEAMS, nflverseToSleeper, sleeperToNflverse } from "../src/teamAbbrev.ts";

describe("team abbreviation map (15.1.8)", () => {
  it("round-trips all 32 Sleeper teams", () => {
    expect(SLEEPER_TEAMS).toHaveLength(32);
    for (const t of SLEEPER_TEAMS) {
      expect(nflverseToSleeper(sleeperToNflverse(t))).toBe(t);
    }
  });

  it("maps every 2025 nflverse team to a valid Sleeper team", () => {
    const csv = readFileSync(
      fileURLToPath(new URL("../../../fixtures/nflverse/games.csv", import.meta.url)),
      "utf8",
    );
    const teams = new Set<string>();
    for (const r of parseCsv(csv)) {
      if (r.season === "2025" && r.game_type === "REG") {
        teams.add(r.home_team!);
        teams.add(r.away_team!);
      }
    }
    expect(teams.size).toBe(32);
    const sleeperSet = new Set<string>(SLEEPER_TEAMS);
    for (const t of teams) {
      expect(sleeperSet.has(nflverseToSleeper(t)), `${t} → ${nflverseToSleeper(t)}`).toBe(true);
    }
    expect(nflverseToSleeper("LA")).toBe("LAR");
    expect(sleeperToNflverse("LAR")).toBe("LA");
  });
});
