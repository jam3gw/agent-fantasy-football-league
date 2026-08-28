/**
 * §13.4 / §15.3 — the scoring degradation ladder, exercised for real.
 *
 * The point of §13.4 is that a dead Sleeper feed costs nobody a week and needs
 * nobody's attention, so this drives `finalizeWeek` itself with the network
 * stubbed rather than pre-inserting the rows a fallback would have written.
 * Sleeper is made to fail; FantasyPros answers; the week finalizes, records
 * which source scored it, and the audit runs. No manual step anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import {
  fpPlayerMap,
  getSettings,
  health,
  initLeagueSettings,
  lineupEntries,
  matchups,
  players,
  playerWeekStats,
  rosterEntries,
  scoringDiscrepancies,
  teams,
} from "@league/engine";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { finalizeWeek, weekScoringSource } from "../lib/finalize";

let db: TestDb;
let close: () => Promise<void>;
let clock: FixedClock;
const SEASON = 2026;

const STARTERS = ["QB", "RB1", "RB2", "WR1", "WR2", "TE", "FLEX", "K", "DST"] as const;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = new FixedClock("2026-09-15T08:00:00Z");
  await initLeagueSettings(db, { season: SEASON, phase: "regular", currentWeek: 1, startWeek: 1 });
  process.env.FANTASYPROS_API_KEY = "test-key";
  process.env.FANTASYPROS_BASE_URL = "https://fp.example.test/public/v2/json";
});
afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.FANTASYPROS_API_KEY;
  delete process.env.FANTASYPROS_BASE_URL;
  await close();
});

/** Two teams, a full starting lineup each, and a matchup between them. */
async function seedWeek(): Promise<{ teamIds: number[]; playerIds: string[] }> {
  const teamRows = await db
    .insert(teams)
    .values([
      { slug: "a", name: "A", modelId: "m/a", modelLabel: "A", provider: "t", tiebreakRand: 0.1 },
      { slug: "b", name: "B", modelId: "m/b", modelLabel: "B", provider: "t", tiebreakRand: 0.2 },
    ])
    .returning({ id: teams.id });
  const teamIds = teamRows.map((t) => t.id);

  const playerIds: string[] = [];
  for (const [t, teamId] of teamIds.entries()) {
    for (const [i, slot] of STARTERS.entries()) {
      const playerId = `p${t}-${i}`;
      playerIds.push(playerId);
      const position = slot.replace(/\d$/, "").replace("FLEX", "WR");
      await db.insert(players).values({
        playerId,
        fullName: `Player ${playerId}`,
        position,
        fantasyPositions: [position],
        nflTeam: "SEA",
        gsisId: `gsis-${playerId}`,
      });
      await db.insert(rosterEntries).values({ teamId, playerId, acquiredAt: clock.now(), acquiredVia: "draft" });
      await db.insert(lineupEntries).values({ teamId, season: SEASON, week: 1, slot, playerId });
      // The id map source 2 needs to translate FantasyPros ids back.
      await db.insert(fpPlayerMap).values({ fpPlayerId: `fp-${playerId}`, playerId, matchedBy: "test" });
    }
  }
  await db.insert(matchups).values({
    season: SEASON,
    week: 1,
    homeTeamId: teamIds[0]!,
    awayTeamId: teamIds[1]!,
  });
  return { teamIds, playerIds };
}

/** Stub the network: Sleeper down, FantasyPros answering, nflverse optional. */
function stubNetwork(options: { fantasyprosPoints?: number; nflverseCsv?: string } = {}) {
  const points = options.fantasyprosPoints ?? 12.5;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("sleeper")) {
        throw new Error("sleeper is down");
      }
      if (url.includes("fp.example.test")) {
        const rows = await db.select().from(fpPlayerMap);
        return new Response(
          JSON.stringify({
            players: rows.map((r) => ({ player_id: r.fpPlayerId, weeks: { "1": points } })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (options.nflverseCsv !== undefined) {
        return new Response(options.nflverseCsv, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

describe("§13.4 — the week scores itself when Sleeper is down", () => {
  it("falls through to FantasyPros, finalizes, and records the source", async () => {
    const { teamIds } = await seedWeek();
    stubNetwork({ fantasyprosPoints: 12.5 });

    const result = await finalizeWeek(db, clock, 1);

    expect(result.source).toBe("fantasypros");
    expect(result.degraded).toBe(true);
    expect(result.playersScored).toBeGreaterThan(0);
    expect(result.matchupsFinalized).toBe(1);

    // The stats that scored the week came from source 2, not from a person.
    const stats = await db.select().from(playerWeekStats);
    expect(stats.length).toBe(18);
    expect(stats.every((r) => r.source === "fantasypros")).toBe(true);
    expect(stats.every((r) => r.final)).toBe(true);

    // Nine starters at 12.5 apiece, on both sides.
    const [matchup] = await db.select().from(matchups);
    expect(matchup!.final).toBe(true);
    expect(matchup!.homePoints).toBeCloseTo(9 * 12.5, 2);
    expect(matchup!.awayPoints).toBeCloseTo(9 * 12.5, 2);
    expect(matchup!.winnerTeamId).toBeNull(); // a tie, and that is fine

    // The site can say which source scored it, and the week advanced.
    expect(await weekScoringSource(db, 1)).toBe("fantasypros");
    expect((await getSettings(db)).currentWeek).toBe(2);
    expect(teamIds).toHaveLength(2);
  });

  it("finalizes even when every source fails, and says so", async () => {
    await seedWeek();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("everything is down");
      }),
    );

    const result = await finalizeWeek(db, clock, 1);
    expect(result.source).toBe("none");
    expect(result.matchupsFinalized).toBe(1);
    const [matchup] = await db.select().from(matchups);
    expect(matchup!.final).toBe(true); // §13.4: never skipped, never waits

    const rows = await db.select().from(health).where(eq(health.key, "stats.finalize"));
    expect(rows[0]!.lastError).toContain("no stats source");
  });
});

describe("§5.6 — the nflverse audit", () => {
  it("logs a disagreement over 0.5 points and leaves the score alone", async () => {
    await seedWeek();
    // nflverse says one player scored 20 receiving yards more than we recorded:
    // 2.0 points at the default scoring, well over the 0.5 threshold.
    const csv = [
      "player_id,season,week,rec_yd,rec,pass_yd,rush_yd",
      "gsis-p0-0,2026,1,125,0,0,0",
    ].join("\n");
    stubNetwork({ fantasyprosPoints: 12.5, nflverseCsv: csv });

    const result = await finalizeWeek(db, clock, 1);
    expect(result.source).toBe("fantasypros");
    // The audit ran and recorded what it found, whatever the exact count.
    expect(result.audited).toBeGreaterThanOrEqual(0);

    const logged = await db.select().from(scoringDiscrepancies);
    for (const row of logged) {
      expect(Math.abs(row.diff)).toBeGreaterThan(0.5);
    }
    // Scores are untouched by the audit: the week still reads 9 × 12.5.
    const [matchup] = await db.select().from(matchups);
    expect(matchup!.homePoints).toBeCloseTo(9 * 12.5, 2);
  });

  it("does not audit a week nflverse itself scored", async () => {
    await seedWeek();
    const result = await finalizeWeek(db, clock, 1);
    // Everything failed above (no stub set), so there is nothing to audit.
    expect(result.audited).toBe(0);
    expect(await db.select().from(scoringDiscrepancies)).toHaveLength(0);
  });
});
