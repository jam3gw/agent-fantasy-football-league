/**
 * §13.4 / §15.3 — the scoring degradation ladder, exercised for real.
 *
 * The point of §13.4 is that a dead Sleeper feed costs nobody a week and needs
 * nobody's attention, so this drives `finalizeWeek` itself with the network
 * stubbed rather than pre-inserting the rows a fallback would have written.
 * Sleeper is made to fail; nflverse answers; the week finalizes, records which
 * source scored it, and the audit runs. No manual step anywhere.
 *
 * The ladder was three rungs deep until 2026-08-29, with FantasyPros between
 * the two. It went with the rest of that integration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import {
  getSettings,
  health,
  initLeagueSettings,
  lineupEntries,
  matchups,
  nflGames,
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
});
afterEach(async () => {
  vi.unstubAllGlobals();
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
      await db.insert(lineupEntries).values({ teamId, week: 1, slot, playerId });
    }
  }
  await db.insert(matchups).values({
    week: 1,
    homeTeamId: teamIds[0]!,
    awayTeamId: teamIds[1]!,
  });
  // Week 1's games are over: the clock is Tuesday Sept 15, the last kickoff
  // was Sunday. Finalization only runs for a played week.
  await db.insert(nflGames).values({
    gameId: "w1-sea-sf",
    season: SEASON,
    week: 1,
    kickoffAt: new Date("2026-09-13T20:25:00Z"),
    home: "SEA",
    away: "SF",
    status: "final",
  });
  return { teamIds, playerIds };
}

/**
 * Stub the network. `sleeperPoints` makes Sleeper answer with a real stat line
 * — 6 catches for 65 yards is exactly 12.5 at the league's PPR settings, so
 * §3.2's fit check has nothing to report and the audit below is measuring only
 * what it claims to. Omit it and Sleeper fails, which drops to nflverse.
 */
function stubNetwork(options: { sleeperPoints?: number; nflverseCsv?: string } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("sleeper")) {
        if (options.sleeperPoints === undefined) throw new Error("sleeper is down");
        const rows = await db.select().from(players);
        return new Response(
          JSON.stringify(
            rows.map((r) => ({
              player_id: r.playerId,
              season: SEASON,
              week: 1,
              stats: { rec: 6, rec_yd: 65, pts_ppr: options.sleeperPoints },
            })),
          ),
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
  it("falls through to nflverse, finalizes, and records the source", async () => {
    const { teamIds } = await seedWeek();
    // 6 catches for 65 yards = 12.5 for each of the eighteen starters.
    const csv = [
      "player_id,season,week,receiving_yards,receptions",
      ...(await db.select().from(players)).map((p) => `${p.gsisId},2026,1,65,6`),
    ].join("\n");
    stubNetwork({ nflverseCsv: csv });

    const result = await finalizeWeek(db, clock, 1);

    expect(result.source).toBe("nflverse");
    expect(result.degraded).toBe(true);
    expect(result.playersScored).toBeGreaterThan(0);
    expect(result.matchupsFinalized).toBe(1);

    // The stats that scored the week came from the fallback, not from a person.
    const stats = await db.select().from(playerWeekStats);
    expect(stats.length).toBe(18);
    expect(stats.every((r) => r.source === "nflverse")).toBe(true);
    expect(stats.every((r) => r.final)).toBe(true);

    // Nine starters at 12.5 apiece, on both sides.
    const [matchup] = await db.select().from(matchups);
    expect(matchup!.final).toBe(true);
    expect(matchup!.homePoints).toBeCloseTo(9 * 12.5, 2);
    expect(matchup!.awayPoints).toBeCloseTo(9 * 12.5, 2);
    expect(matchup!.winnerTeamId).toBeNull(); // a tie, and that is fine

    // The site can say which source scored it, and the week advanced.
    expect(await weekScoringSource(db, 1)).toBe("nflverse");
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

describe("§7.4 — finalization waits for games, only for games", () => {
  it("defers a week whose games have not been played, touching nothing", async () => {
    // The 2026-09-01 incident: the first Tuesday of the regular phase fell
    // nine days before kickoff, and the calendar-booked finalization scored
    // week 1 as six 0.00–0.00 matchups and advanced `current_week`.
    await seedWeek();
    await db
      .update(nflGames)
      .set({ kickoffAt: new Date("2026-09-20T17:00:00Z"), status: "scheduled" })
      .where(eq(nflGames.gameId, "w1-sea-sf"));
    stubNetwork({ sleeperPoints: 12.5 }); // even a live stats feed must not tempt it

    const result = await finalizeWeek(db, clock, 1);

    expect(result.deferred).toBe(true);
    expect(result.matchupsFinalized).toBe(0);
    const [matchup] = await db.select().from(matchups);
    expect(matchup!.final).toBe(false);
    expect(matchup!.homePoints).toBeNull();
    expect((await getSettings(db)).currentWeek).toBe(1);
    expect(await weekScoringSource(db, 1)).toBeNull();
    // The deferral is healthy, not an error.
    const rows = await db.select().from(health).where(eq(health.key, "stats.finalize"));
    expect(rows[0]!.lastError).toBeNull();
  });

  it("defers and raises the fault when the week has matchups but no schedule", async () => {
    // No nfl_games rows for a week that has matchups means the schedule feed
    // is missing — finalizing blind is how an unplayed week gets scored 0–0.
    await seedWeek();
    await db.delete(nflGames).where(eq(nflGames.gameId, "w1-sea-sf"));
    stubNetwork({ sleeperPoints: 12.5 });

    const result = await finalizeWeek(db, clock, 1);

    expect(result.deferred).toBe(true);
    expect((await getSettings(db)).currentWeek).toBe(1);
    const rows = await db.select().from(health).where(eq(health.key, "stats.finalize"));
    expect(rows[0]!.lastError).toContain("no NFL games recorded");
  });

  it("still no-op advances a week with no matchups at all", async () => {
    // §7.4: before start_week there is nothing to score, and finalization is
    // a no-op that still advances the week.
    stubNetwork({});
    const result = await finalizeWeek(db, clock, 1);
    expect(result.deferred).toBeUndefined();
    expect(result.matchupsFinalized).toBe(0);
    expect((await getSettings(db)).currentWeek).toBe(2);
  });
});

describe("§5.6 — the nflverse audit", () => {
  it("logs only the players who differ by more than 0.5 points", async () => {
    await seedWeek();
    // Sleeper scores everyone 12.5. At the league's PPR settings (0.1 per
    // receiving yard, 1 per catch) one player is 8 points out and the other
    // lands on 12.5 exactly, so only the first should be logged.
    const csv = [
      "player_id,season,week,receiving_yards,receptions",
      "gsis-p0-0,2026,1,125,8", // 12.5 + 8.0 = 20.5 → 8.0 out, logged
      "gsis-p0-1,2026,1,65,6", //  6.5 + 6.0 = 12.5 → exact, not logged
    ].join("\n");
    stubNetwork({ sleeperPoints: 12.5, nflverseCsv: csv });

    const result = await finalizeWeek(db, clock, 1);
    expect(result.source).toBe("sleeper");
    expect(result.audited, "both players should have been compared").toBe(2);
    expect(result.auditDiscrepancies).toBe(1);

    const logged = await db.select().from(scoringDiscrepancies);
    expect(logged).toHaveLength(1);
    expect(logged[0]!.playerId).toBe("p0-0");
    expect(logged[0]!.diff).toBeCloseTo(8, 2);
    // §5.6 audits; it never rescores. The week still reads 9 × 12.5.
    const [matchup] = await db.select().from(matchups);
    expect(matchup!.homePoints).toBeCloseTo(9 * 12.5, 2);

    // And the summary reaches /admin/health.
    const rows = await db.select().from(health).where(eq(health.key, "stats.audit"));
    expect(rows[0]!.lastError).toContain("1 of 2");
  });

  it("logs nothing when nflverse agrees with the week", async () => {
    await seedWeek();
    const csv = [
      "player_id,season,week,receiving_yards,receptions",
      "gsis-p0-0,2026,1,65,6", // exactly 12.5
    ].join("\n");
    stubNetwork({ sleeperPoints: 12.5, nflverseCsv: csv });

    const result = await finalizeWeek(db, clock, 1);
    expect(result.audited).toBe(1);
    expect(result.auditDiscrepancies).toBe(0);
    expect(await db.select().from(scoringDiscrepancies)).toHaveLength(0);
  });

  it("does not audit a week nflverse itself scored", async () => {
    await seedWeek();
    // Sleeper fails and nflverse scores the week. Auditing it against itself
    // would be meaningless, so the audit is skipped.
    const csv = ["player_id,season,week,receiving_yards,receptions", "gsis-p0-0,2026,1,100,5"].join("\n");
    stubNetwork({ nflverseCsv: csv });

    const result = await finalizeWeek(db, clock, 1);
    expect(result.source).toBe("nflverse");
    expect(result.audited).toBe(0);
    expect(await db.select().from(scoringDiscrepancies)).toHaveLength(0);
  });
});

describe("§3.2 — the Sleeper fit check does not fire on a fallback week", () => {
  it("records no discrepancy for nflverse-scored rows", async () => {
    // A fallback supplies computed points and no comparable Sleeper stat line,
    // so `engine_pts` is what our settings make of it. Comparing that with
    // `pts_ppr` as though it were Sleeper's own logged all eighteen.
    await seedWeek();
    const csv = [
      "player_id,season,week,receiving_yards,receptions",
      ...(await db.select().from(players)).map((p) => `${p.gsisId},2026,1,65,6`),
    ].join("\n");
    stubNetwork({ nflverseCsv: csv });
    await finalizeWeek(db, clock, 1);
    const logged = await db.select().from(scoringDiscrepancies);
    expect(logged).toHaveLength(0);
  });
});
