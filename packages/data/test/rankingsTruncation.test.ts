/**
 * §5.7's draft gate needs 200 ranked players. On the FantasyPros free tier
 * that is unreachable: the API caps every response at 10 rows and says so in
 * the payload (`tier`, `limit`, `count`). Measured on production 2026-08-29 —
 * limit 10 against count 518 — which left the commissioner looking at "68
 * ranked, need 200" with a working key and no error anywhere.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { health, initLeagueSettings } from "@league/engine";
import { createTestDb, type TestDb } from "../../engine/test/helpers/db";
import { ingestFpRankings } from "../src/ingest/rankings.ts";

let db: TestDb;
let close: () => Promise<void>;
const clock = new FixedClock("2026-08-29T15:00:00Z");

/** A fake upstream returning the same body for every call. */
function fetcher(body: unknown) {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

/** A free-tier response: ten rows, and the API's own account of the cap. */
function freeTierBody(n = 10) {
  return {
    tier: "free",
    limit: 10,
    count: 518,
    players: Array.from({ length: n }, (_, i) => ({
      player_id: String(1000 + i),
      player_name: `Player ${i}`,
      player_position_id: "WR",
      rank_ecr: i + 1,
    })),
  };
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await initLeagueSettings(db, { season: 2026, phase: "pre_draft", currentWeek: 1 });
});
afterEach(async () => {
  await close();
});

describe("free-tier truncation (§5.7)", () => {
  it("records the plan, the cap, and that the draft cannot start", async () => {
    await ingestFpRankings(
      db,
      clock,
      { apiKey: "k", baseUrl: "https://example.invalid", dailyCap: 100, fetchImpl: fetcher(freeTierBody()) },
      { season: 2026, set: "draft", week: 0 },
    );

    const [row] = await db.select().from(health).where(eq(health.key, "fp.rankings"));
    expect(row?.lastError).toContain("'free' plan");
    expect(row?.lastError).toContain("at most 10 players per request");
    expect(row?.lastError).toContain("518 available");
    expect(row?.lastError).toContain("The draft cannot start");
  });

  it("records a plain success when the plan is not truncating", async () => {
    await ingestFpRankings(
      db,
      clock,
      {
        apiKey: "k",
        baseUrl: "https://example.invalid",
        dailyCap: 100,
        fetchImpl: fetcher({ ...freeTierBody(), tier: "paid", limit: 600 }),
      },
      { season: 2026, set: "draft", week: 0 },
    );

    const [row] = await db.select().from(health).where(eq(health.key, "fp.rankings"));
    expect(row?.lastSuccessAt).not.toBeNull();
    expect(row?.lastError).toBeNull();
  });
});
