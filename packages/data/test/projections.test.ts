/**
 * The on-demand projection refresh (§5.4). What matters here:
 * - a stale or missing week pulls the feed and stores it; a fresh week never
 *   touches the network (agents call this inside tool reads);
 * - week 0 pulls the *season* projection endpoint (the draft board's
 *   `proj_points`), weeks 1–18 the per-week one;
 * - a dead or empty feed never throws and never hammers: misses are remembered
 *   for PROJECTIONS_MISS_TTL_MS and stored rows keep being served;
 * - concurrent callers share one pull.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock } from "@league/shared";
import { playerWeekProj } from "@league/engine";
import { createTestDb, type TestDb } from "../../engine/test/helpers/db";
import {
  PROJECTIONS_MISS_TTL_MS,
  PROJECTIONS_TTL_MS,
  ensureFreshProjections,
  resetProjectionsRefreshState,
} from "../src/ingest/projections.ts";

let db: TestDb;
let close: () => Promise<void>;
let clock: FixedClock;
const SEASON = 2026;
const NOW = "2026-09-13T15:00:00Z";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = new FixedClock(NOW);
  resetProjectionsRefreshState();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await close();
});

function feedRow(id: string, pts: number) {
  return { player_id: id, season: SEASON, stats: { pts_ppr: pts } };
}

/** Stub fetch with a JSON body; returns the spy so URLs and call counts can be asserted. */
function stubFeed(rows: unknown[], status = 200) {
  const spy = vi.fn(
    async (_url: string | URL | Request) =>
      new Response(JSON.stringify(rows), { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

async function storedRow(playerId: string, week: number) {
  const rows = await db.select().from(playerWeekProj);
  return rows.find((r) => r.playerId === playerId && r.week === week);
}

describe("§5.4 on-demand projection refresh", () => {
  it("pulls the per-week feed and stores it when the week has no rows", async () => {
    const spy = stubFeed([feedRow("a", 18.4), feedRow("b", 9.1)]);
    const result = await ensureFreshProjections(db, clock, { season: SEASON, week: 3 });
    expect(result).toEqual({ outcome: "refreshed", rows: 2 });
    expect(String(spy.mock.calls[0]?.[0])).toContain(`/projections/nfl/${SEASON}/3`);
    expect((await storedRow("a", 3))?.projPtsPpr).toBe(18.4);
  });

  it("serves stored rows without touching the network while they are fresh", async () => {
    await db
      .insert(playerWeekProj)
      .values({ playerId: "a", season: SEASON, week: 3, projPtsPpr: 12, updatedAt: clock.now() });
    const spy = stubFeed([feedRow("a", 99)]);
    const result = await ensureFreshProjections(db, clock, { season: SEASON, week: 3 });
    expect(result).toEqual({ outcome: "fresh", rows: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect((await storedRow("a", 3))?.projPtsPpr).toBe(12);
  });

  it("re-pulls once the stored week is older than the TTL", async () => {
    await db.insert(playerWeekProj).values({
      playerId: "a",
      season: SEASON,
      week: 3,
      projPtsPpr: 12,
      updatedAt: new Date(clock.now().getTime() - PROJECTIONS_TTL_MS - 1),
    });
    stubFeed([feedRow("a", 14.5)]);
    const result = await ensureFreshProjections(db, clock, { season: SEASON, week: 3 });
    expect(result.outcome).toBe("refreshed");
    expect((await storedRow("a", 3))?.projPtsPpr).toBe(14.5);
  });

  it("uses the season endpoint for week 0 (the draft board)", async () => {
    const spy = stubFeed([feedRow("a", 310.2)]);
    const result = await ensureFreshProjections(db, clock, { season: SEASON, week: 0 });
    expect(result.outcome).toBe("refreshed");
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain(`/projections/nfl/${SEASON}?`);
    expect((await storedRow("a", 0))?.projPtsPpr).toBe(310.2);
  });

  it("keeps stale rows and does not throw when the feed fails, and remembers the miss", async () => {
    await db.insert(playerWeekProj).values({
      playerId: "a",
      season: SEASON,
      week: 3,
      projPtsPpr: 12,
      updatedAt: new Date(clock.now().getTime() - 2 * PROJECTIONS_TTL_MS),
    });
    const spy = stubFeed([], 500);
    expect(await ensureFreshProjections(db, clock, { season: SEASON, week: 3 })).toEqual({
      outcome: "unavailable",
      rows: 0,
    });
    expect((await storedRow("a", 3))?.projPtsPpr).toBe(12);

    // Within the miss TTL the feed is not retried; after it, it is.
    const attempts = spy.mock.calls.length;
    await ensureFreshProjections(db, clock, { season: SEASON, week: 3 });
    expect(spy.mock.calls.length).toBe(attempts);
    clock.advance(PROJECTIONS_MISS_TTL_MS + 1);
    await ensureFreshProjections(db, clock, { season: SEASON, week: 3 });
    expect(spy.mock.calls.length).toBeGreaterThan(attempts);
  });

  it("treats an empty feed as a miss rather than an update", async () => {
    stubFeed([]);
    const result = await ensureFreshProjections(db, clock, { season: SEASON, week: 3 });
    expect(result).toEqual({ outcome: "unavailable", rows: 0 });
    expect(await db.select().from(playerWeekProj)).toHaveLength(0);
  });

  it("shares one pull between concurrent callers for the same week", async () => {
    const spy = stubFeed([feedRow("a", 18.4)]);
    const [r1, r2] = await Promise.all([
      ensureFreshProjections(db, clock, { season: SEASON, week: 3 }),
      ensureFreshProjections(db, clock, { season: SEASON, week: 3 }),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r1.outcome).toBe("refreshed");
    expect(r2.outcome).toBe("refreshed");
  });
});
