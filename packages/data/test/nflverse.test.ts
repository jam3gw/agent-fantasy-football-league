import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEDULE_URLS, fetchSchedule, NFLVERSE_STATS_URLS, fetchNflverseWeeklyStats, parseGames, parseNflverseWeeklyStats } from "../src/nflverse.ts";

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

describe("nflverse weekly stats URLs (§5.6)", () => {
  it("tries the stats_player release tag first (the old player_stats tag 404s for 2026)", () => {
    const urls = NFLVERSE_STATS_URLS(2026);
    expect(urls[0]).toBe(
      "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2026.csv",
    );
    expect(urls.length).toBeGreaterThan(1);
  });
});

describe("fetchNflverseWeeklyStats fallthrough (§5.6)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const csv = "player_id,season,week,passing_yards\n00-0000001,2026,3,250\n";
  const respond = (byUrl: (u: string) => string | null) =>
    vi.stubGlobal("fetch", async (u: string | URL | Request) => {
      const body = byUrl(String(u));
      return body === null
        ? new Response("not found", { status: 404 })
        : new Response(body, { status: 200 });
    });

  it("falls through a 404 to the next URL", async () => {
    respond((u) => (u.includes("/stats_player/") ? null : csv));
    expect((await fetchNflverseWeeklyStats(2026)).length).toBe(1);
  });

  it("falls through a 200 that parses to zero rows", async () => {
    respond((u) => (u.includes("/stats_player/") ? "<html></html>" : csv));
    expect((await fetchNflverseWeeklyStats(2026)).length).toBe(1);
  });

  it("throws when every URL fails", async () => {
    respond(() => null);
    await expect(fetchNflverseWeeklyStats(2026)).rejects.toThrow();
  });
});

describe("fetchSchedule fallthrough (§5.5)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const csv =
    "game_id,season,game_type,week,gameday,gametime,away_team,home_team,away_score,home_score,result\n" +
    "2026_01_NE_SEA,2026,REG,1,2026-09-09,20:20,NE,SEA,,,\n";

  it("falls through a 404 on the release asset to nfldata", async () => {
    vi.stubGlobal("fetch", async (u: string | URL | Request) =>
      String(u) === SCHEDULE_URLS[0] ? new Response("nf", { status: 404 }) : new Response(csv, { status: 200 }),
    );
    expect(await fetchSchedule({ season: 2026 })).toBe(csv);
  });

  it("falls through a 200 with no rows for the season", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (u: string | URL | Request) => {
      calls.push(String(u));
      return String(u) === SCHEDULE_URLS[0]
        ? new Response("game_id,season,week,gameday\n", { status: 200 })
        : new Response(csv, { status: 200 });
    });
    expect(await fetchSchedule({ season: 2026 })).toBe(csv);
    expect(calls).toEqual([...SCHEDULE_URLS]);
  });

  it("throws with every URL's error when all fail", async () => {
    vi.stubGlobal("fetch", async () => new Response("nf", { status: 404 }));
    await expect(fetchSchedule({ season: 2026, backoffMs: 0 })).rejects.toThrow(/games\.csv.*games\.csv/s);
  });
});
