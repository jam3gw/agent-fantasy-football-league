/**
 * 15.1.9 — FantasyPros → Sleeper mapping: yahoo id, espn id, and the name
 * fallback with real-world variants, D/ST rows, and the unmatched report.
 * Candidates come from the cached live Sleeper player pool.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildMatchIndex,
  fpPositionToSleeper,
  matchFpPlayer,
  normalizeName,
  type SleeperCandidate,
} from "../src/playerMatch.ts";

interface RawSleeperPlayer {
  player_id?: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  position?: string | null;
  team?: string | null;
  yahoo_id?: number | string | null;
  espn_id?: number | string | null;
}

const pool: Record<string, RawSleeperPlayer> = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../fixtures/sleeper/players_active.json", import.meta.url)),
    "utf8",
  ),
);

const candidates: SleeperCandidate[] = Object.entries(pool).map(([id, p]) => ({
  playerId: id,
  fullName: p.full_name ?? [p.first_name, p.last_name].filter(Boolean).join(" "),
  position: p.position ?? null,
  nflTeam: p.team ?? null,
  yahooId: p.yahoo_id != null ? String(p.yahoo_id) : null,
  espnId: p.espn_id != null ? String(p.espn_id) : null,
}));

const index = buildMatchIndex(candidates);

/** A real player from the live pool with both external ids, for id-based tests. */
const withBothIds = candidates.find((c) => c.yahooId && c.espnId && c.position === "WR")!;

describe("normalizeName (Appendix B)", () => {
  it("strips suffixes, punctuation, accents, and collapses spaces", () => {
    expect(normalizeName("Marvin Harrison Jr.")).toBe("marvin harrison");
    expect(normalizeName("Michael Pittman Jr")).toBe("michael pittman");
    expect(normalizeName("Ken Walker III")).toBe("ken walker");
    expect(normalizeName("A.J. Brown")).toBe("aj brown");
    expect(normalizeName("D'Andre Swift")).toBe("dandre swift");
    expect(normalizeName("Amon-Ra St. Brown")).toBe("amon-ra st brown");
    expect(normalizeName("  Josh   Allen  ")).toBe("josh allen");
    // accents normalize to their base letters
    expect(normalizeName("Isaías Peña")).toBe("isaias pena");
  });
});

describe("matchFpPlayer (15.1.9)", () => {
  it("matches by yahoo id first, even when the name would not match", () => {
    const hit = matchFpPlayer(
      {
        fpPlayerId: "fp1",
        name: "Completely Different Name",
        position: "WR",
        team: "XXX",
        yahooId: withBothIds.yahooId,
      },
      index,
    );
    expect(hit).toEqual({ playerId: withBothIds.playerId, matchedBy: "yahoo_id" });
  });

  it("falls back to espn id when yahoo is absent", () => {
    const hit = matchFpPlayer(
      {
        fpPlayerId: "fp2",
        name: "Also Wrong",
        position: "WR",
        team: null,
        espnId: withBothIds.espnId,
      },
      index,
    );
    expect(hit).toEqual({ playerId: withBothIds.playerId, matchedBy: "espn_id" });
  });

  it("falls back to normalized name + position, tolerating suffix and punctuation variants", () => {
    // Find a real player whose name carries a suffix or punctuation.
    const suffixed = candidates.find(
      (c) => /( Jr\.?| III?| IV)$/.test(c.fullName) && c.position && c.position !== "DEF",
    );
    expect(suffixed, "fixture pool should contain a suffixed name").toBeDefined();
    const hit = matchFpPlayer(
      {
        fpPlayerId: "fp3",
        // FantasyPros often drops the period or the suffix entirely
        name: suffixed!.fullName.replace(/\./g, "").replace(/( Jr| III?| IV)$/, ""),
        position: suffixed!.position,
        team: suffixed!.nflTeam,
      },
      index,
    );
    expect(hit?.playerId).toBe(suffixed!.playerId);
    expect(hit?.matchedBy).toBe("name");
  });

  it("maps D/ST rows by team abbreviation, including the LA/LAR difference", () => {
    const rams = matchFpPlayer(
      { fpPlayerId: "fpDST1", name: "Rams", position: "DST", team: "LAR" },
      index,
    );
    expect(rams?.playerId).toBe("LAR");
    // nflverse-style "LA" also resolves through the team map
    const ramsAlt = matchFpPlayer(
      { fpPlayerId: "fpDST2", name: "Rams", position: "DST", team: "LA" },
      index,
    );
    expect(ramsAlt?.playerId).toBe("LAR");
    const chiefs = matchFpPlayer(
      { fpPlayerId: "fpDST3", name: "Chiefs", position: "D/ST", team: "KC" },
      index,
    );
    expect(chiefs?.playerId).toBe("KC");
  });

  it("returns null for an unknown player so it lands in the unmatched report", () => {
    expect(
      matchFpPlayer(
        { fpPlayerId: "fpX", name: "Nonexistent Person", position: "RB", team: "KC" },
        index,
      ),
    ).toBeNull();
  });

  it("refuses to guess when a name and position are ambiguous across teams", () => {
    // Build a tiny index with two same-name, same-position players.
    const ambiguous = buildMatchIndex([
      { playerId: "a1", fullName: "John Smith", position: "RB", nflTeam: "KC", yahooId: null, espnId: null },
      { playerId: "a2", fullName: "John Smith", position: "RB", nflTeam: "SF", yahooId: null, espnId: null },
    ]);
    expect(
      matchFpPlayer({ fpPlayerId: "z", name: "John Smith", position: "RB", team: null }, ambiguous),
    ).toBeNull();
    // ...but resolves when the team disambiguates
    expect(
      matchFpPlayer({ fpPlayerId: "z", name: "John Smith", position: "RB", team: "SF" }, ambiguous),
    ).toEqual({ playerId: "a2", matchedBy: "name" });
  });

  it("matches a large sample of the real pool by name+position round-trip", () => {
    const sample = candidates
      .filter((c) => c.position && c.position !== "DEF" && c.fullName.trim().length > 0)
      .slice(0, 400);
    let matched = 0;
    for (const c of sample) {
      const hit = matchFpPlayer(
        { fpPlayerId: `fp-${c.playerId}`, name: c.fullName, position: c.position, team: c.nflTeam },
        index,
      );
      if (hit) matched++;
    }
    // Only genuine same-name/same-position/same-team collisions should miss.
    expect(matched / sample.length).toBeGreaterThan(0.97);
  });
});

describe("fpPositionToSleeper", () => {
  it("maps FantasyPros DST onto Sleeper DEF and passes others through", () => {
    expect(fpPositionToSleeper("DST")).toBe("DEF");
    expect(fpPositionToSleeper("D/ST")).toBe("DEF");
    expect(fpPositionToSleeper("rb")).toBe("RB");
    expect(fpPositionToSleeper(null)).toBeNull();
  });
});
