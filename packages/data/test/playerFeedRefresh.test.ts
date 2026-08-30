/**
 * The on-demand player-feed refresh (§5.1 on the §5.4 on-demand pattern).
 * What matters here:
 * - freshness is read from the `sleeper.players` health row, so the hourly
 *   job and this refresher share one clock;
 * - only players whose lineup-relevant fields moved are written — a full
 *   ~11k-row upsert from inside a tool call would take minutes;
 * - the write path is `upsertPlayers`, so a starter going Out mid-morning
 *   emits `injury.changed` exactly as the hourly job would, just sooner;
 * - an empty players table is a bootstrap for the job, not for a tool call;
 * - failures never throw, misses are remembered, concurrent callers share
 *   one pull.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock } from "@league/shared";
import { health, initLeagueSettings, lineupEntries, nflGames, players, rosterEntries, sessions, teams } from "@league/engine";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import {
  PLAYER_FEED_MISS_TTL_MS,
  PLAYER_FEED_TTL_MS,
  ensureFreshPlayerFeed,
  resetPlayerFeedRefreshState,
  upsertPlayers,
} from "../src/ingest/players.ts";
import type { SleeperPlayerRaw } from "../src/sleeper.ts";

let db: TestDb;
let close: () => Promise<void>;
let clock: FixedClock;
const NOW = "2026-09-13T15:00:00Z";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = new FixedClock(NOW);
  resetPlayerFeedRefreshState();
  await initLeagueSettings(db, { season: 2026, phase: "regular", currentWeek: 1 });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await close();
});

function rawPlayer(id: string, overrides: Partial<SleeperPlayerRaw> = {}): SleeperPlayerRaw {
  return {
    player_id: id,
    full_name: `Player ${id}`,
    position: "RB",
    fantasy_positions: ["RB"],
    team: "KC",
    status: "Active",
    injury_status: null,
    active: true,
    ...overrides,
  };
}

function stubFeed(feed: Record<string, SleeperPlayerRaw>, status = 200) {
  const spy = vi.fn(
    async (_url: string | URL | Request) =>
      new Response(JSON.stringify(feed), { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

async function playerRow(id: string) {
  return (await db.select().from(players)).find((r) => r.playerId === id);
}

describe("§5.1 on-demand player-feed refresh", () => {
  it("is a no-op while the sleeper.players health row is fresh", async () => {
    await upsertPlayers(db, clock, { p1: rawPlayer("p1") });
    await db.insert(health).values({ key: "sleeper.players", lastSuccessAt: clock.now() });
    const spy = stubFeed({ p1: rawPlayer("p1", { injury_status: "Out" }) });

    const res = await ensureFreshPlayerFeed(db, clock);
    expect(res).toEqual({ outcome: "fresh", changed: 0, injuryChanges: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect((await playerRow("p1"))?.injuryStatus).toBeNull();
  });

  it("writes only players whose lineup-relevant fields moved once the feed is stale", async () => {
    await upsertPlayers(db, clock, { p1: rawPlayer("p1"), p2: rawPlayer("p2") });
    await db.insert(health).values({
      key: "sleeper.players",
      lastSuccessAt: new Date(clock.now().getTime() - PLAYER_FEED_TTL_MS - 1),
    });
    clock.advance(60_000);
    stubFeed({
      p1: rawPlayer("p1", { injury_status: "Questionable", injury_body_part: "Ankle" }),
      p2: rawPlayer("p2"), // unchanged — must not be rewritten
      p3: rawPlayer("p3"), // never seen — must be inserted
    });

    const res = await ensureFreshPlayerFeed(db, clock);
    expect(res.outcome).toBe("refreshed");
    expect(res.changed).toBe(2);
    expect((await playerRow("p1"))?.injuryStatus).toBe("Questionable");
    expect((await playerRow("p3"))?.fullName).toBe("Player p3");
    // p2 kept its original updatedAt: it was not part of the write.
    expect((await playerRow("p2"))?.updatedAt).toEqual(new Date(NOW));
  });

  it("emits injury.changed for a starter exactly like the hourly job", async () => {
    const [team] = await db
      .insert(teams)
      .values({ slug: "t1", name: "T1", modelId: "m", modelLabel: "m", provider: "p", tiebreakRand: 0.1 })
      .returning({ id: teams.id });
    await upsertPlayers(db, clock, { p1: rawPlayer("p1") });
    await db
      .insert(rosterEntries)
      .values({ teamId: team!.id, playerId: "p1", acquiredVia: "draft", acquiredAt: clock.now() });
    await db.insert(lineupEntries).values({ teamId: team!.id, week: 1, playerId: "p1", slot: "RB1" });
    await db.insert(nflGames).values({
      gameId: "g1",
      season: 2026,
      week: 1,
      kickoffAt: new Date("2026-09-13T17:00:00Z"),
      home: "KC",
      away: "PHI",
    });
    stubFeed({ p1: rawPlayer("p1", { injury_status: "Out" }) });

    const res = await ensureFreshPlayerFeed(db, clock);
    expect(res.injuryChanges).toBe(1);
    const s = await db.select().from(sessions);
    expect(s).toHaveLength(1);
    expect(s[0]!.kind).toBe("injury_response");
  });

  it("leaves a never-ingested players table to the ingest job", async () => {
    const spy = stubFeed({ p1: rawPlayer("p1") });
    const res = await ensureFreshPlayerFeed(db, clock);
    expect(res).toEqual({ outcome: "unavailable", changed: 0, injuryChanges: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("never throws on a dead feed, remembers the miss, retries after the miss TTL", async () => {
    await upsertPlayers(db, clock, { p1: rawPlayer("p1") });
    const spy = stubFeed({}, 500);

    expect(await ensureFreshPlayerFeed(db, clock)).toEqual({
      outcome: "unavailable",
      changed: 0,
      injuryChanges: 0,
    });
    const attempts = spy.mock.calls.length;
    await ensureFreshPlayerFeed(db, clock);
    expect(spy.mock.calls.length).toBe(attempts);
    clock.advance(PLAYER_FEED_MISS_TTL_MS + 1);
    await ensureFreshPlayerFeed(db, clock);
    expect(spy.mock.calls.length).toBeGreaterThan(attempts);
  });

  it("shares one pull between concurrent callers", async () => {
    await upsertPlayers(db, clock, { p1: rawPlayer("p1") });
    const spy = stubFeed({ p1: rawPlayer("p1", { injury_status: "Out" }) });
    const [r1, r2] = await Promise.all([ensureFreshPlayerFeed(db, clock), ensureFreshPlayerFeed(db, clock)]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r1.outcome).toBe("refreshed");
    expect(r2.outcome).toBe("refreshed");
  });
});
