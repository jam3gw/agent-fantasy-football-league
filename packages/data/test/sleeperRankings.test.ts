/**
 * The rankings ingest (§5.7) on Sleeper's projection feed.
 *
 * The two things that matter here are the two that FantasyPros got wrong: the
 * board must reach §5.7's 200-player gate, and every row must land on a player
 * we actually have — Sleeper's `player_id` is our own id, so a "mapping" step
 * cannot silently drop 72% of the top 200 the way an external id would.
 *
 * Tiers are the other claim worth testing. They mark a cliff in projected
 * points within a position, so an invented tier for a player with no
 * projection would be worse than none at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { health, players, rankings } from "@league/engine";
import { createTestDb, type TestDb } from "../../engine/test/helpers/db";
import { assignTiers, ingestRankings } from "../src/ingest/rankings.ts";

let db: TestDb;
let close: () => Promise<void>;
let clock: FixedClock;
const SEASON = 2026;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = new FixedClock("2026-08-29T12:00:00Z");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await close();
});

/** One projection row in Sleeper's shape. */
function row(id: string, position: string, adp: number | null, pts: number | null) {
  const stats: Record<string, number> = {};
  // Sleeper writes 999 into an ADP it has no value for, rather than omitting it.
  stats.adp_ppr = adp ?? 999;
  if (pts !== null) stats.pts_ppr = pts;
  return { player_id: id, season: SEASON, player: { position }, stats };
}

async function seedPlayers(ids: Array<[string, string]>) {
  for (const [id, position] of ids) {
    await db.insert(players).values({ playerId: id, fullName: `Player ${id}`, position, nflTeam: "KC" });
  }
}

function stubFeed(rows: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } })),
  );
}

describe("§5.7 rankings ingest", () => {
  it("ranks by ADP, numbers each position, and stores ADP verbatim", async () => {
    await seedPlayers([
      ["a", "RB"],
      ["b", "WR"],
      ["c", "RB"],
    ]);
    stubFeed([row("c", "RB", 12.4, 200), row("a", "RB", 1.9, 300), row("b", "WR", 3.6, 280)]);

    const result = await ingestRankings(db, clock, { season: SEASON, set: "draft", week: 0 });
    expect(result.ranked).toBe(3);

    const stored = await db.select().from(rankings).orderBy(rankings.rank);
    expect(stored.map((r) => r.playerId)).toEqual(["a", "b", "c"]);
    expect(stored.map((r) => r.rank)).toEqual([1, 2, 3]);
    // Position rank counts within the position, in the same ADP order.
    expect(stored.map((r) => r.posRank)).toEqual(["RB1", "WR1", "RB2"]);
    expect(stored[0]!.adp).toBe(1.9);
  });

  it("builds the rest-of-season set from season projections, ordered by points", async () => {
    // `player_research`'s ros_rankings kind read this set from the day the
    // tool shipped, but nothing ingested it — every call failed with "no ros
    // rankings are loaded" until the in-season job started building it
    // (2026-09-03).
    await seedPlayers([
      ["a", "RB"],
      ["b", "WR"],
      ["c", "RB"],
    ]);
    stubFeed([row("c", "RB", 12.4, 200), row("a", "RB", 1.9, 300), row("b", "WR", 3.6, 280)]);

    const result = await ingestRankings(db, clock, { season: SEASON, set: "ros", week: 3 });
    expect(result.ranked).toBe(3);

    const stored = await db.select().from(rankings).orderBy(rankings.rank);
    // Points order (300, 280, 200), not ADP order; stored at the passed week.
    expect(stored.map((r) => r.playerId)).toEqual(["a", "b", "c"]);
    expect(stored.every((r) => r.set === "ros" && r.week === 3)).toBe(true);
    // ADP belongs to the draft board alone.
    expect(stored.every((r) => r.adp === null)).toBe(true);
  });

  it("drops a player Sleeper has no ADP for rather than ranking him 999th", async () => {
    await seedPlayers([
      ["a", "RB"],
      ["z", "WR"],
    ]);
    stubFeed([row("a", "RB", 1.9, 300), row("z", "WR", null, 10)]);

    const result = await ingestRankings(db, clock, { season: SEASON, set: "draft", week: 0 });
    expect(result.ranked).toBe(1);
    const stored = await db.select().from(rankings);
    expect(stored.map((r) => r.playerId)).toEqual(["a"]);
  });

  it("meets the 200-player gate and records no error", async () => {
    const ids: Array<[string, string]> = [];
    const rows = [];
    for (let i = 0; i < 250; i++) {
      const position = ["RB", "WR", "TE", "QB"][i % 4]!;
      ids.push([`p${i}`, position]);
      rows.push(row(`p${i}`, position, i + 1, 300 - i));
    }
    await seedPlayers(ids);
    stubFeed(rows);

    const result = await ingestRankings(db, clock, { season: SEASON, set: "draft", week: 0 });
    expect(result.distinctRanked).toBe(250);
    expect(result.distinctRanked).toBeGreaterThanOrEqual(200);

    const rowsHealth = await db.select().from(health).where(eq(health.key, "rankings"));
    expect(rowsHealth[0]!.lastError).toBeNull();
  });

  it("records an error when the feed comes back too short to draft from", async () => {
    await seedPlayers([["a", "RB"]]);
    stubFeed([row("a", "RB", 1.9, 300)]);

    await ingestRankings(db, clock, { season: SEASON, set: "draft", week: 0 });
    const rowsHealth = await db.select().from(health).where(eq(health.key, "rankings"));
    expect(rowsHealth[0]!.lastError).toContain("only 1 ranked players");
  });

  it("re-running replaces the board rather than duplicating it", async () => {
    await seedPlayers([
      ["a", "RB"],
      ["b", "WR"],
    ]);
    stubFeed([row("a", "RB", 1.9, 300), row("b", "WR", 3.6, 280)]);
    await ingestRankings(db, clock, { season: SEASON, set: "draft", week: 0 });

    // b moves ahead of a on the next pull.
    stubFeed([row("b", "WR", 1.4, 290), row("a", "RB", 2.2, 285)]);
    await ingestRankings(db, clock, { season: SEASON, set: "draft", week: 0 });

    const stored = await db.select().from(rankings).orderBy(rankings.rank);
    expect(stored).toHaveLength(2);
    expect(stored.map((r) => r.playerId)).toEqual(["b", "a"]);
  });
});

describe("tiers", () => {
  it("breaks a position where the points cliff is, not at a fixed interval", () => {
    // Three clear groups at RB: ~300, ~200, ~100.
    const tiers = assignTiers([
      { playerId: "a", position: "RB", points: 300 },
      { playerId: "b", position: "RB", points: 298 },
      { playerId: "c", position: "RB", points: 296 },
      { playerId: "d", position: "RB", points: 200 },
      { playerId: "e", position: "RB", points: 198 },
      { playerId: "f", position: "RB", points: 100 },
    ]);
    expect(tiers.get("a")).toBe(1);
    expect(tiers.get("b")).toBe(1);
    expect(tiers.get("c")).toBe(1);
    expect(tiers.get("d")).toBe(2);
    expect(tiers.get("e")).toBe(2);
    expect(tiers.get("f")).toBe(3);
  });

  it("tiers each position separately", () => {
    const tiers = assignTiers([
      { playerId: "rb1", position: "RB", points: 300 },
      { playerId: "wr1", position: "WR", points: 280 },
      { playerId: "wr2", position: "WR", points: 279 },
    ]);
    // The WRs are not tier 2 just because an RB outscores them.
    expect(tiers.get("rb1")).toBe(1);
    expect(tiers.get("wr1")).toBe(1);
    expect(tiers.get("wr2")).toBe(1);
  });

  it("gives no tier to a player with no projection", () => {
    const tiers = assignTiers([
      { playerId: "a", position: "RB", points: 300 },
      { playerId: "b", position: "RB", points: null },
      { playerId: "c", position: null, points: 250 },
    ]);
    expect(tiers.get("a")).toBe(1);
    expect(tiers.has("b")).toBe(false);
    expect(tiers.has("c")).toBe(false);
  });

  it("does not make every gap a cliff when the projections are identical", () => {
    const tiers = assignTiers([
      { playerId: "a", position: "RB", points: 100 },
      { playerId: "b", position: "RB", points: 100 },
      { playerId: "c", position: "RB", points: 100 },
    ]);
    expect([...new Set(tiers.values())]).toEqual([1]);
  });
});
