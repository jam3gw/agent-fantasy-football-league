/**
 * The `ingest.rankings` job books the right sets for the phase. The in-season
 * run has to build BOTH the weekly board and the rest-of-season one:
 * `player_research` offered `ros_rankings` from the day it shipped, but the
 * job only ever ingested `weekly`, so every ros call failed "no ros rankings
 * are loaded" (30 in one 48h stretch, found 2026-09-03).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock } from "@league/shared";
import { initLeagueSettings, players, rankings } from "@league/engine";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { runJob } from "../lib/jobs";

let db: TestDb;
let close: () => Promise<void>;
let clock: FixedClock;
const SEASON = 2026;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = new FixedClock("2026-09-16T10:00:00Z");
  for (const [id, position] of [
    ["a", "RB"],
    ["b", "WR"],
    ["c", "RB"],
  ] as const) {
    await db.insert(players).values({ playerId: id, fullName: `Player ${id}`, position, nflTeam: "KC" });
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { player_id: "a", season: SEASON, player: { position: "RB" }, stats: { adp_ppr: 1.9, pts_ppr: 300 } },
            { player_id: "b", season: SEASON, player: { position: "WR" }, stats: { adp_ppr: 3.6, pts_ppr: 280 } },
            { player_id: "c", season: SEASON, player: { position: "RB" }, stats: { adp_ppr: 12.4, pts_ppr: 200 } },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await close();
});

describe("ingest.rankings job (§5.7)", () => {
  it("in season, builds the weekly set and the rest-of-season set", async () => {
    await initLeagueSettings(db, { season: SEASON, phase: "regular", currentWeek: 2 });
    await runJob(db, clock, "ingest.rankings", {});

    const stored = await db.select().from(rankings);
    const sets = new Map<string, number>();
    for (const r of stored) sets.set(`${r.set}:${r.week}`, (sets.get(`${r.set}:${r.week}`) ?? 0) + 1);
    expect(sets.get("weekly:2")).toBe(3);
    expect(sets.get("ros:2")).toBe(3);
    expect(sets.has("draft:0")).toBe(false);
  });

  it("before the draft, builds only the draft board", async () => {
    await initLeagueSettings(db, { season: SEASON, phase: "pre_draft", currentWeek: 1 });
    await runJob(db, clock, "ingest.rankings", {});

    const stored = await db.select().from(rankings);
    expect(stored.every((r) => r.set === "draft" && r.week === 0)).toBe(true);
    expect(stored).toHaveLength(3);
  });
});
