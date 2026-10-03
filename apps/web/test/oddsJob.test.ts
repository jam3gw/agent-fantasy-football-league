/**
 * `odds.run` (§11.1, §9.1): booked Thursday 9:30 AM and Sunday 11:30 AM ET,
 * gated like the reporter jobs, and without `AI_GATEWAY_API_KEY` it stores the two
 * non-Jev methods and never calls TypeSafe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { health, matchupOdds, matchups, oddsRuns, playerWeekProj, scheduledJobs } from "@league/engine";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { makeGame, makePlayer, seedLeague, seedTeams } from "../../../packages/engine/test/helpers/factories";
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
  it("with no projections, stores nothing and books the same snapshot 30 minutes later", async () => {
    await seedLeague(db, { currentWeek: 3 });
    await db.insert(matchups).values({ week: 3, homeTeamId: ids[0]!, awayTeamId: ids[1]! });
    await runJob(db, clock, "odds.run", { snapshot: "sun" });
    expect(await db.select().from(oddsRuns)).toHaveLength(0);
    const retry = await db.select().from(scheduledJobs).where(eq(scheduledJobs.type, "odds.run"));
    expect(retry).toHaveLength(1);
    expect(retry[0]!.dueAt.toISOString()).toBe("2026-09-22T18:30:00.000Z");
    expect(retry[0]!.payload).toEqual({ snapshot: "sun", week: 3, attempt: 1, chain: "2026-09-22T18:00:00.000Z" });
    const h = (await db.select().from(health).where(eq(health.key, "odds")))[0];
    expect(h?.lastError).toMatch(/no projections/);
    // After the last retry the job fails, so /admin/jobs shows it.
    await expect(runJob(db, clock, "odds.run", { snapshot: "sun", week: 3, attempt: 6 })).rejects.toThrow(/no projections/);
  });

  it("a second chain for the same snapshot books its own retries", async () => {
    await seedLeague(db, { currentWeek: 3 });
    await db.insert(matchups).values({ week: 3, homeTeamId: ids[0]!, awayTeamId: ids[1]! });
    await runJob(db, clock, "odds.run", { snapshot: "thu" });
    await runJob(db, new FixedClock("2026-09-22T19:00:00Z"), "odds.run", { snapshot: "thu" });
    expect(await db.select().from(scheduledJobs).where(eq(scheduledJobs.type, "odds.run"))).toHaveLength(2);
  });

  it("stops retrying when the next try would land after the snapshot's first kickoff", async () => {
    await seedLeague(db, { currentWeek: 3 });
    await db.insert(matchups).values({ week: 3, homeTeamId: ids[0]!, awayTeamId: ids[1]! });
    // Sunday 12:45 PM ET; the 1:00 PM slate is 15 minutes away.
    const sunday = new FixedClock("2026-09-27T16:45:00Z");
    await makeGame(db, { week: 3, kickoffAt: new Date("2026-09-27T17:00:00Z"), home: "KC", away: "BUF" });
    await expect(runJob(db, sunday, "odds.run", { snapshot: "sun" })).rejects.toThrow(/no projections/);
    expect(await db.select().from(scheduledJobs).where(eq(scheduledJobs.type, "odds.run"))).toHaveLength(0);
  });

  it("a Sunday chain measures from its own start: Thursday's game does not stop it, the 1 PM slate does", async () => {
    await seedLeague(db, { currentWeek: 3 });
    await db.insert(matchups).values({ week: 3, homeTeamId: ids[0]!, awayTeamId: ids[1]! });
    await makeGame(db, { week: 3, kickoffAt: new Date("2026-09-25T00:15:00Z"), home: "DAL", away: "NYG" }); // Thu 8:15 PM ET
    await makeGame(db, { week: 3, kickoffAt: new Date("2026-09-27T17:00:00Z"), home: "KC", away: "BUF" }); // Sun 1:00 PM ET
    const chain = "2026-09-27T15:30:00.000Z"; // Sun 11:30 AM ET
    await runJob(db, new FixedClock(chain), "odds.run", { snapshot: "sun" });
    expect(await db.select().from(scheduledJobs).where(eq(scheduledJobs.type, "odds.run"))).toHaveLength(1);
    // The 12:30 retry: its next try would be 1:00 PM, the kickoff, so it stops.
    await expect(
      runJob(db, new FixedClock("2026-09-27T16:30:00Z"), "odds.run", { snapshot: "sun", week: 3, attempt: 2, chain }),
    ).rejects.toThrow(/no projections/);
    expect(await db.select().from(scheduledJobs).where(eq(scheduledJobs.type, "odds.run"))).toHaveLength(1);
  });

  it("does not retry into a week whose games have all kicked off", async () => {
    await seedLeague(db, { currentWeek: 3 });
    await db.insert(matchups).values({ week: 3, homeTeamId: ids[0]!, awayTeamId: ids[1]! });
    await makeGame(db, { week: 3, kickoffAt: new Date("2026-09-21T00:20:00Z"), home: "KC", away: "BUF" });
    await expect(runJob(db, clock, "odds.run", { snapshot: "thu" })).rejects.toThrow(/no projections/);
    expect(await db.select().from(scheduledJobs).where(eq(scheduledJobs.type, "odds.run"))).toHaveLength(0);
  });

  it("a retry that finds projections stores the run and clears the health error", async () => {
    await seedLeague(db, { currentWeek: 3 });
    await db.insert(matchups).values({ week: 3, homeTeamId: ids[0]!, awayTeamId: ids[1]! });
    await runJob(db, clock, "odds.run", { snapshot: "thu" });
    await makePlayer(db, { playerId: "p-late" });
    await db.insert(playerWeekProj).values({ playerId: "p-late", season: 2026, week: 3, projPtsPpr: 10 });
    const later = new FixedClock("2026-09-22T18:30:00Z");
    await runJob(db, later, "odds.run", { snapshot: "thu", week: 3, attempt: 1, chain: "2026-09-22T18:00:00.000Z" });
    expect(await db.select().from(oddsRuns)).toHaveLength(1);
    const h = (await db.select().from(health).where(eq(health.key, "odds")))[0]!;
    expect(h.lastSuccessAt!.getTime()).toBeGreaterThanOrEqual(h.lastErrorAt!.getTime());
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
