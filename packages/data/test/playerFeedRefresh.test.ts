/**
 * The on-demand player-feed refresh (§5.1 on the §5.4 on-demand pattern).
 * What matters here:
 * - freshness is the PLAYER_FEED_APPLIED_KEY health row, stamped by
 *   `upsertPlayers` inside its transaction — "a pull landed", never "a fetch
 *   succeeded" — so the hourly job and this refresher share one clock and a
 *   failed write can never masquerade as freshness;
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
import { initLeagueSettings, lineupEntries, nflGames, players, rosterEntries, sessions, teams } from "@league/engine";
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

/** Seed via the real ingest path (which stamps the applied marker), then age past the TTL. */
async function seedStale(feed: Record<string, SleeperPlayerRaw>): Promise<void> {
  await upsertPlayers(db, clock, feed);
  clock.advance(PLAYER_FEED_TTL_MS + 1);
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
  it("is a no-op while the last applied pull is within the TTL", async () => {
    await upsertPlayers(db, clock, { p1: rawPlayer("p1") }); // stamps applied = now
    const spy = stubFeed({ p1: rawPlayer("p1", { injury_status: "Out" }) });

    const res = await ensureFreshPlayerFeed(db, clock);
    expect(res).toEqual({ outcome: "fresh", changed: 0, injuryChanges: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect((await playerRow("p1"))?.injuryStatus).toBeNull();
  });

  it("writes only players whose lineup-relevant fields moved once the feed is stale", async () => {
    await seedStale({ p1: rawPlayer("p1"), p2: rawPlayer("p2") });
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
    // The write re-stamped the applied marker: the next read is one SELECT.
    const spy = stubFeed({});
    expect((await ensureFreshPlayerFeed(db, clock)).outcome).toBe("fresh");
    expect(spy).not.toHaveBeenCalled();
  });

  it("detects a change in fantasy position eligibility, not just injuries", async () => {
    await seedStale({ p1: rawPlayer("p1") });
    stubFeed({ p1: rawPlayer("p1", { fantasy_positions: ["RB", "TE"] }) });
    const res = await ensureFreshPlayerFeed(db, clock);
    expect(res.changed).toBe(1);
    expect((await playerRow("p1"))?.fantasyPositions).toEqual(["RB", "TE"]);
  });

  it("stamps the applied marker on a zero-change pass so it does not re-download every read", async () => {
    await seedStale({ p1: rawPlayer("p1") });
    const spy = stubFeed({ p1: rawPlayer("p1") });
    expect((await ensureFreshPlayerFeed(db, clock)).outcome).toBe("refreshed");
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await ensureFreshPlayerFeed(db, clock)).outcome).toBe("fresh");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("emits injury.changed for a starter exactly like the hourly job", async () => {
    const [team] = await db
      .insert(teams)
      .values({ slug: "t1", name: "T1", modelId: "m", modelLabel: "m", provider: "p", tiebreakRand: 0.1 })
      .returning({ id: teams.id });
    await seedStale({ p1: rawPlayer("p1") });
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
    await seedStale({ p1: rawPlayer("p1") });
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

  it("defers a delta too large for a tool call to the scheduled job", async () => {
    await seedStale({ p1: rawPlayer("p1"), p2: rawPlayer("p2"), p3: rawPlayer("p3") });
    stubFeed({
      p1: rawPlayer("p1", { injury_status: "Out" }),
      p2: rawPlayer("p2", { injury_status: "Out" }),
      p3: rawPlayer("p3", { injury_status: "Out" }),
    });
    const res = await ensureFreshPlayerFeed(db, clock, { maxWrites: 2 });
    expect(res).toEqual({ outcome: "deferred", changed: 0, injuryChanges: 0 });
    expect((await playerRow("p1"))?.injuryStatus).toBeNull();
    // Deferring is not freshness, but it is suppressed like a miss so
    // back-to-back reads do not re-download the 5MB feed.
    const spy = stubFeed({});
    expect((await ensureFreshPlayerFeed(db, clock)).outcome).toBe("unavailable");
    expect(spy).not.toHaveBeenCalled();
  });

  it("never throws when the write path fails, and does not claim freshness for it", async () => {
    await seedStale({ p1: rawPlayer("p1") });
    stubFeed({ p1: rawPlayer("p1", { injury_status: "Out" }) });
    const broken = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return () => {
            throw new Error("connection reset");
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const result = await ensureFreshPlayerFeed(broken as typeof db, clock);
    expect(result).toEqual({ outcome: "unavailable", changed: 0, injuryChanges: 0 });
    expect((await playerRow("p1"))?.injuryStatus).toBeNull();
    // The applied marker was not advanced: once the miss window passes, a
    // healthy call retries and lands the write.
    resetPlayerFeedRefreshState();
    stubFeed({ p1: rawPlayer("p1", { injury_status: "Out" }) });
    expect((await ensureFreshPlayerFeed(db, clock)).outcome).toBe("refreshed");
    expect((await playerRow("p1"))?.injuryStatus).toBe("Out");
  });

  it("shares one pull between concurrent callers", async () => {
    await seedStale({ p1: rawPlayer("p1") });
    const spy = stubFeed({ p1: rawPlayer("p1", { injury_status: "Out" }) });
    const [r1, r2] = await Promise.all([ensureFreshPlayerFeed(db, clock), ensureFreshPlayerFeed(db, clock)]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r1.outcome).toBe("refreshed");
    expect(r2.outcome).toBe("refreshed");
  });
});
