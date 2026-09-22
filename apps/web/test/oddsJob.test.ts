/**
 * `odds.run` (§11.1, §9.1): booked Thursday 9:30 AM and Sunday 11:30 AM ET,
 * gated like the reporter jobs, and without `AI_GATEWAY_API_KEY` it stores the two
 * non-Jev methods and never calls TypeSafe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { matchupOdds, matchups, oddsRuns, playerWeekProj, scheduledJobs } from "@league/engine";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { makePlayer, seedLeague, seedTeams } from "../../../packages/engine/test/helpers/factories";
import { bookRecurringJobs, runJob } from "../lib/jobs";

let db: TestDb;
let close: () => Promise<void>;
let ids: number[];
// Tuesday 2026-09-22, 2:00 PM ET.
const clock = new FixedClock("2026-09-22T18:00:00Z");

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  ids = await seedTeams(db);
  vi.stubEnv("AI_GATEWAY_API_KEY", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await close();
});

describe("odds.run booking (§9.1)", () => {
  it("books Thursday 9:30 AM ET and Sunday 11:30 AM ET, with no week baked in", async () => {
    await seedLeague(db, { currentWeek: 3 });
    await bookRecurringJobs(db, clock);
    const rows = await db.select().from(scheduledJobs).where(eq(scheduledJobs.type, "odds.run"));
    const byDue = rows.map((r) => [r.dueAt.toISOString(), r.payload]).sort();
    expect(byDue).toEqual([
      ["2026-09-24T13:30:00.000Z", { snapshot: "thu" }],
      ["2026-09-27T15:30:00.000Z", { snapshot: "sun" }],
    ]);
  });
});

describe("odds.run job (§11.1)", () => {
  it("fails the job for a week with no projections, storing nothing", async () => {
    await seedLeague(db, { currentWeek: 3 });
    await db.insert(matchups).values({ week: 3, homeTeamId: ids[0]!, awayTeamId: ids[1]! });
    await expect(runJob(db, clock, "odds.run", { snapshot: "thu" })).rejects.toThrow(/no projections/);
    expect(await db.select().from(oddsRuns)).toHaveLength(0);
  });

  it("is gated before the season starts", async () => {
    await seedLeague(db, { phase: "regular", currentWeek: 1, startWeek: 2 });
    await db.insert(matchups).values({ week: 1, homeTeamId: ids[0]!, awayTeamId: ids[1]! });
    await runJob(db, clock, "odds.run", { snapshot: "thu" });
    expect(await db.select().from(oddsRuns)).toHaveLength(0);
  });

  it("without a key, stores baseline and rule and never calls TypeSafe", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await seedLeague(db, { currentWeek: 3 });
    await db.insert(matchups).values({ week: 3, homeTeamId: ids[0]!, awayTeamId: ids[1]! });
    // A week needs projections before it gets odds (§11.1).
    await makePlayer(db, { playerId: "p-proj" });
    await db.insert(playerWeekProj).values({ playerId: "p-proj", season: 2026, week: 3, projPtsPpr: 10 });
    await runJob(db, clock, "odds.run", { snapshot: "sun" });
    const [run] = await db.select().from(oddsRuns);
    expect(run).toMatchObject({ week: 3, snapshot: "sun", status: "partial" });
    expect(run!.jevError).toMatch(/no_key/);
    expect(new Set((await db.select().from(matchupOdds)).map((r) => r.method))).toEqual(new Set(["baseline", "rule"]));
    expect(fetch).not.toHaveBeenCalled();
  });
});
