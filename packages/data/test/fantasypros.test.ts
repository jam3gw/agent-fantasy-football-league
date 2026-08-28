/** 15.1.11 — FantasyPros allowance, cache-hit counting, midnight-ET reset, global cap. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedClock, zonedTimeToUtc } from "@league/shared";
import { initLeagueSettings } from "@league/engine";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { fpGlobalRemaining, fpRequest, normalizeUrlKey } from "../src/fantasypros.ts";

let db: TestDb;
let close: () => Promise<void>;
let clock: FixedClock;
let upstreamCalls: string[];

const noSleep = () => Promise.resolve();

function cfg(overrides: Partial<Parameters<typeof fpRequest>[2]> = {}) {
  return {
    apiKey: "test-key",
    dailyCap: 100,
    sleep: noSleep,
    fetchImpl: (async (url: string | URL | Request) => {
      upstreamCalls.push(String(url));
      return new Response(JSON.stringify({ players: [], echo: String(url) }), { status: 200 });
    }) as typeof fetch,
    ...overrides,
  };
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await initLeagueSettings(db, { season: 2026, phase: "regular", currentWeek: 1 });
  clock = new FixedClock(zonedTimeToUtc(2026, 9, 10, 12, 0)); // Thu Sep 10 noon ET
  upstreamCalls = [];
});
afterEach(async () => {
  await close();
});

const agent = { kind: "agent", teamId: 1 } as const;

describe("FantasyPros allowance (15.1.11)", () => {
  it("the 4th call in an ET day returns fantasypros_quota; counter resets at midnight ET", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await fpRequest(db, clock, cfg(), agent, "/nfl/2026/consensus-rankings", {
        position: "ALL",
        scoring: "PPR",
        week: i, // distinct URLs → real requests
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.remainingToday).toBe(2 - i);
    }
    const fourth = await fpRequest(db, clock, cfg(), agent, "/nfl/news", { limit: 5 });
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) {
      expect(fourth.error).toBe("fantasypros_quota");
      expect(fourth.message).toContain("3 FantasyPros requests");
    }

    // 11:59 PM ET same day: still blocked
    clock.set(zonedTimeToUtc(2026, 9, 10, 23, 59));
    expect((await fpRequest(db, clock, cfg(), agent, "/nfl/news", { limit: 5 })).ok).toBe(false);
    // 12:01 AM ET next day: allowance is back
    clock.set(zonedTimeToUtc(2026, 9, 11, 0, 1));
    const fresh = await fpRequest(db, clock, cfg(), agent, "/nfl/news", { limit: 5 });
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(fresh.remainingToday).toBe(2);
  });

  it("cache hits count against the allowance but not the global cap", async () => {
    const params = { position: "ALL", scoring: "PPR" };
    const r1 = await fpRequest(db, clock, cfg(), agent, "/nfl/2026/consensus-rankings", params);
    expect(r1.ok && !r1.cacheHit).toBe(true);
    const r2 = await fpRequest(db, clock, cfg(), { kind: "agent", teamId: 2 }, "/nfl/2026/consensus-rankings", params);
    expect(r2.ok && r2.cacheHit).toBe(true); // cached for team 2...
    if (r2.ok) expect(r2.remainingToday).toBe(2); // ...but still counted
    expect(upstreamCalls).toHaveLength(1); // only one real request
    expect(await fpGlobalRemaining(db, clock, 100)).toBe(99);

    // team 2 burns its remaining 2 on cache hits → 4th call quota-blocked with zero upstream traffic
    await fpRequest(db, clock, cfg(), { kind: "agent", teamId: 2 }, "/nfl/2026/consensus-rankings", params);
    await fpRequest(db, clock, cfg(), { kind: "agent", teamId: 2 }, "/nfl/2026/consensus-rankings", params);
    const blocked = await fpRequest(db, clock, cfg(), { kind: "agent", teamId: 2 }, "/nfl/2026/consensus-rankings", params);
    expect(blocked.ok).toBe(false);
    expect(upstreamCalls).toHaveLength(1);
  });

  it("global cap stops real requests; blocked calls do not consume the agent allowance", async () => {
    const tiny = cfg({ dailyCap: 1 });
    const r1 = await fpRequest(db, clock, tiny, { kind: "engine" }, "/nfl/players", { ecr: "included" });
    expect(r1.ok).toBe(true);
    // agent asks for something uncached → global cap reached → unavailable, allowance untouched
    const r2 = await fpRequest(db, clock, tiny, agent, "/nfl/news", { limit: 5 });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe("fantasypros_unavailable");
    // the same agent can still use a cache hit (players is cached)
    const r3 = await fpRequest(db, clock, tiny, agent, "/nfl/players", { ecr: "included" });
    expect(r3.ok && r3.cacheHit).toBe(true);
    if (r3.ok) expect(r3.remainingToday).toBe(2); // only the cache hit counted
  });

  it("upstream failure returns fantasypros_unavailable and does not count", async () => {
    const failing = cfg({
      fetchImpl: (async () => new Response("boom", { status: 500 })) as typeof fetch,
    });
    const r = await fpRequest(db, clock, failing, agent, "/nfl/news", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("fantasypros_unavailable");
    const ok = await fpRequest(db, clock, cfg(), agent, "/nfl/news", {});
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.remainingToday).toBe(2); // the failure consumed nothing
  });

  it("reporter has its own allowance separate from agents and engine", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await fpRequest(db, clock, cfg(), { kind: "reporter" }, "/nfl/news", { limit: i + 1 });
      expect(r.ok).toBe(true);
    }
    expect((await fpRequest(db, clock, cfg(), { kind: "reporter" }, "/nfl/news", { limit: 9 })).ok).toBe(false);
    // engine unaffected
    expect((await fpRequest(db, clock, cfg(), { kind: "engine" }, "/nfl/players", {})).ok).toBe(true);
    // agents unaffected
    expect((await fpRequest(db, clock, cfg(), agent, "/nfl/news", { limit: 1 })).ok).toBe(true);
  });

  it("normalizeUrlKey sorts params and drops empties", () => {
    expect(normalizeUrlKey("/nfl/news", { b: 2, a: "x", c: undefined })).toBe("/nfl/news?a=x&b=2");
    expect(normalizeUrlKey("/nfl/players", {})).toBe("/nfl/players");
  });
});
