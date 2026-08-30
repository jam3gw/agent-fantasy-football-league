/**
 * A simulated fantasy week (SPEC §15.3), driven by real cached 2025 Sleeper
 * stats and a scripted model, so the whole pipeline is exercised without a
 * provider key: lineups → waivers → free agency → locks → live scoring →
 * finalization → results, plus the §13.4 fallback when Sleeper is unavailable.
 *
 * The live-API parts of §15.3 (real model sessions, the reporter recap) need
 * credentials that live only in Vercel and run against a preview deploy.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import {
  addFreeAgent,
  finalizeWeekCore,
  getSettings,
  initLeagueSettings,
  lineupEntries,
  matchups,
  nflGames,
  players,
  playerWeekStats,
  rosterEntries,
  runWaivers,
  scoreWeek,
  setLineup,
  submitWaiverClaims,
  teamWeekResults,
  teams,
  waiverClaims,
} from "@league/engine";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { computeEnginePts } from "@league/data";

let db: TestDb;
let close: () => Promise<void>;
let clock: FixedClock;

const SEASON = 2026;

interface FixtureEntry {
  player_id: string;
  stats: Record<string, number>;
  player?: { position?: string | null; fantasy_positions?: string[] | null } | null;
}

/** Real 2025 Week 1 scoring, replayed as this league's week 1. */
function loadWeekOne(): FixtureEntry[] {
  const path = fileURLToPath(new URL("../../../fixtures/sleeper/stats_2025_w1.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Twelve teams, a real player pool, one NFL game, and a week-1 schedule. */
async function seedSimulation() {
  await initLeagueSettings(db, { season: SEASON, phase: "regular", currentWeek: 1, startWeek: 1 });

  const teamRows = await db
    .insert(teams)
    .values(
      Array.from({ length: 12 }, (_, i) => ({
        slug: `team-${i + 1}`,
        name: `Team ${i + 1}`,
        modelId: `test/model-${i + 1}`,
        modelLabel: `Model ${i + 1}`,
        provider: "test",
        draftSlot: i + 1,
        waiverPriority: i + 1,
        tiebreakRand: (i + 1) / 100,
      })),
    )
    .returning({ id: teams.id });
  const teamIds = teamRows.map((t) => t.id);

  // Take real scorers from the fixture, keeping enough of each position.
  const fixture = loadWeekOne();
  const scored = fixture.filter((e) => typeof e.stats?.pts_ppr === "number");
  const byPos = (pos: string, n: number) =>
    scored.filter((e) => (e.player?.position ?? (/^[A-Z]+$/.test(e.player_id) ? "DEF" : "")) === pos).slice(0, n);

  const pool = [
    ...byPos("QB", 20),
    ...byPos("RB", 40),
    ...byPos("WR", 40),
    ...byPos("TE", 20),
    ...byPos("K", 16),
    ...byPos("DEF", 16),
  ];

  // Everyone plays in one game window so locks are easy to reason about.
  for (const entry of pool) {
    const position = entry.player?.position ?? "DEF";
    await db.insert(players).values({
      playerId: entry.player_id,
      fullName: `Player ${entry.player_id}`,
      position,
      fantasyPositions: entry.player?.fantasy_positions ?? [position],
      nflTeam: "KC",
      active: true,
    });
    await db.insert(playerWeekStats).values({
      playerId: entry.player_id,
      season: SEASON,
      week: 1,
      stats: entry.stats,
      ptsPpr: entry.stats.pts_ppr!,
      enginePts: computeEnginePts((await getSettings(db)).scoringSettings, entry.stats),
      final: false,
    });
  }

  await db.insert(nflGames).values({
    gameId: "sim_w1",
    season: SEASON,
    week: 1,
    kickoffAt: new Date("2026-09-13T17:00:00Z"),
    home: "KC",
    away: "PHI",
  });

  // Six head-to-head matchups.
  for (let i = 0; i < 6; i++) {
    await db.insert(matchups).values({ week: 1, homeTeamId: teamIds[i * 2]!, awayTeamId: teamIds[i * 2 + 1]! });
  }

  return { teamIds, pool };
}

/** Give each team a legal roster from the pool and set a full lineup. */
async function draftAndSetLineups(teamIds: number[], pool: FixtureEntry[]) {
  const posOf = (e: FixtureEntry) => e.player?.position ?? "DEF";
  const take = (pos: string, n: number, used: Set<string>) => {
    const out: string[] = [];
    for (const e of pool) {
      if (out.length === n) break;
      if (posOf(e) !== pos || used.has(e.player_id)) continue;
      used.add(e.player_id);
      out.push(e.player_id);
    }
    return out;
  };

  const used = new Set<string>();
  for (const teamId of teamIds) {
    const qb = take("QB", 1, used);
    const rb = take("RB", 3, used);
    const wr = take("WR", 3, used);
    const te = take("TE", 1, used);
    const k = take("K", 1, used);
    const dst = take("DEF", 1, used);
    const roster = [...qb, ...rb, ...wr, ...te, ...k, ...dst];
    for (const playerId of roster) {
      await db.insert(rosterEntries).values({
        teamId,
        playerId,
        acquiredVia: "draft",
        acquiredAt: clock.now(),
      });
    }
    const result = await setLineup(db, clock, teamId, 1, {
      QB: qb[0]!,
      RB1: rb[0]!,
      RB2: rb[1]!,
      WR1: wr[0]!,
      WR2: wr[1]!,
      TE: te[0]!,
      FLEX: rb[2]!,
      DST: dst[0]!,
      K: k[0]!,
      IR: null,
    });
    expect(result.ok, `lineup for team ${teamId}`).toBe(true);
  }
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = new FixedClock("2026-09-09T12:00:00Z"); // Wednesday, before kickoff
});
afterEach(async () => {
  await close();
});

describe("simulated week (§15.3)", () => {
  it("runs a full week: lineups, waivers, free agency, locks, scoring, finalization", async () => {
    const { teamIds, pool } = await seedSimulation();
    await draftAndSetLineups(teamIds, pool);

    // --- Waivers: two teams want the same unrostered player -----------------
    const unrostered = pool.find(
      async (e) => (await db.select().from(rosterEntries).where(eq(rosterEntries.playerId, e.player_id))).length === 0,
    );
    expect(unrostered).toBeDefined();
    const allRostered = new Set(
      (await db.select({ playerId: rosterEntries.playerId }).from(rosterEntries)).map((r) => r.playerId),
    );
    const target = pool.find((e) => !allRostered.has(e.player_id))!;
    await db
      .update(players)
      .set({ waiverUntil: new Date("2026-09-09T08:30:00Z") })
      .where(eq(players.playerId, target.player_id));

    const contender = teamIds[5]!; // waiver priority 6
    const favourite = teamIds[1]!; // waiver priority 2 — should win
    for (const teamId of [contender, favourite]) {
      const roster = await db.select().from(rosterEntries).where(eq(rosterEntries.teamId, teamId));
      const claim = await submitWaiverClaims(db, clock, teamId, [
        { addPlayerId: target.player_id, dropPlayerId: roster[roster.length - 1]!.playerId, priority: 1 },
      ]);
      expect(claim.ok, `claims for ${teamId}`).toBe(true);
    }

    const run = await runWaivers(db, clock, clock.now());
    expect(run.ok).toBe(true);
    const claims = await db.select().from(waiverClaims);
    const winner = claims.find((c) => c.status === "success");
    expect(winner?.teamId, "the better waiver priority wins").toBe(favourite);
    expect(claims.filter((c) => c.status === "failed")).toHaveLength(1);
    // The winner moves to the back of the rolling list (§3.4).
    const after = await db.select().from(teams).where(eq(teams.id, favourite));
    expect(after[0]!.waiverPriority).toBe(12);

    // --- Free agency: a team adds an unrostered player immediately ----------
    const stillFree = pool.find(
      (e) =>
        e.player_id !== target.player_id &&
        !allRostered.has(e.player_id) &&
        (e.player?.position ?? "DEF") === "WR",
    );
    if (stillFree) {
      const teamId = teamIds[8]!;
      const roster = await db.select().from(rosterEntries).where(eq(rosterEntries.teamId, teamId));
      const add = await addFreeAgent(db, clock, teamId, stillFree.player_id, roster[roster.length - 1]!.playerId);
      expect(add.ok, "free-agent add").toBe(true);
    }

    // --- Kickoff: everyone locks -------------------------------------------
    clock.set("2026-09-13T17:30:00Z");
    const lockedTeam = teamIds[0]!;
    const lineup = await db
      .select()
      .from(lineupEntries)
      .where(and(eq(lineupEntries.teamId, lockedTeam), eq(lineupEntries.week, 1)));
    const bench = (await db.select().from(rosterEntries).where(eq(rosterEntries.teamId, lockedTeam))).find(
      (r) => !lineup.some((l) => l.playerId === r.playerId),
    );
    if (bench) {
      const slots = Object.fromEntries(lineup.map((l) => [l.slot, l.playerId])) as Record<string, string | null>;
      const swapped = await setLineup(db, clock, lockedTeam, 1, {
        ...slots,
        // try to bench a locked starter for a locked bench player
        RB1: bench.playerId,
        IR: null,
      } as never);
      expect(swapped.ok, "a locked player cannot be moved").toBe(false);
    }

    // --- Live scoring -------------------------------------------------------
    const live = await scoreWeek(db, clock, 1);
    expect(live).toHaveLength(6);
    expect(live.every((m) => m.homePoints > 0 && m.awayPoints > 0)).toBe(true);
    expect((await db.select().from(matchups))[0]!.final).toBe(false);

    // --- Finalization -------------------------------------------------------
    clock.set("2026-09-15T08:00:00Z"); // Tuesday 4:00 AM ET
    await db.update(playerWeekStats).set({ final: true });
    const finalized = await finalizeWeekCore(db, clock, 1);
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;
    expect(finalized.value.matchupsFinalized).toBe(6);
    expect(finalized.value.currentWeek).toBe(2);

    const finals = await db.select().from(matchups);
    expect(finals.every((m) => m.final)).toBe(true);
    expect(finals.every((m) => m.winnerTeamId !== null || m.homePoints === m.awayPoints)).toBe(true);

    // --- Results: hand-check two teams against the real fixture -------------
    const results = await db.select().from(teamWeekResults);
    expect(results).toHaveLength(12);
    for (const teamId of [teamIds[0]!, teamIds[7]!]) {
      const entries = await db
        .select()
        .from(lineupEntries)
        .where(and(eq(lineupEntries.teamId, teamId), eq(lineupEntries.week, 1)));
      const starters = entries.filter((e) => e.slot !== "IR");
      let expected = 0;
      for (const s of starters) {
        const row = (
          await db
            .select()
            .from(playerWeekStats)
            .where(and(eq(playerWeekStats.playerId, s.playerId), eq(playerWeekStats.week, 1)))
        )[0];
        expected += row?.ptsPpr ?? 0;
      }
      const result = results.find((r) => r.teamId === teamId)!;
      expect(result.actualPoints).toBeCloseTo(Math.round(expected * 100) / 100, 2);
      // The optimal lineup is never worse than what was actually started.
      expect(result.optimalPoints).toBeGreaterThanOrEqual(result.actualPoints - 0.001);
      expect(result.pointsLeftOnBench).toBeCloseTo(result.optimalPoints - result.actualPoints, 2);
      expect(result.emptyStartingSlots).toBe(0);
    }

    // The free-agent acquisition's starting points are tracked separately.
    expect(results.every((r) => r.faPoints >= 0)).toBe(true);
  });

  it("finalizes from the fallback source when the Sleeper feed is unavailable (§13.4)", async () => {
    const { teamIds, pool } = await seedSimulation();
    await draftAndSetLineups(teamIds, pool);

    // Simulate a Sleeper outage: no Sleeper rows at all for the week.
    await db.delete(playerWeekStats);
    expect(await db.select().from(playerWeekStats)).toHaveLength(0);

    // The fallback supplies computed points, not Sleeper stat lines — exactly
    // the shape the nflverse rung produces.
    const starters = await db.select().from(lineupEntries).where(eq(lineupEntries.week, 1));
    for (const entry of starters) {
      await db
        .insert(playerWeekStats)
        .values({
          playerId: entry.playerId,
          season: SEASON,
          week: 1,
          stats: { pts_ppr: 12.5 },
          ptsPpr: 12.5,
          source: "nflverse",
          final: true,
        })
        .onConflictDoNothing();
    }

    clock.set("2026-09-15T08:00:00Z");
    const finalized = await finalizeWeekCore(db, clock, 1);
    expect(finalized.ok).toBe(true);

    const finals = await db.select().from(matchups);
    expect(finals.every((m) => m.final)).toBe(true);
    // Nine starters at 12.5 each: the week scored without Sleeper.
    expect(finals[0]!.homePoints).toBeCloseTo(9 * 12.5, 2);
    const rows = await db.select().from(playerWeekStats);
    expect(rows.every((r) => r.source === "nflverse")).toBe(true);
  });
});
