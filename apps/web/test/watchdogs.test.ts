/**
 * The two failures nothing was watching for.
 *
 * A finalization that fails every retry stops the season dead and in total
 * silence — `current_week` never advances, so no week is planned, no lineups
 * carry over, and Tuesday's `sessions.book` recomputes last week's idempotency
 * keys and creates nothing at all, while trade windows keep firing so the
 * league looks alive.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { health, initLeagueSettings, matchups, nflGames, scheduledJobs, teams, updateSettings } from "@league/engine";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { checkFinalizationStall } from "../lib/tick";

let db: TestDb;
let close: () => Promise<void>;
let clock: FixedClock;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  // Tuesday, 12:00 ET — eight hours past a 4:00 AM finalization.
  clock = new FixedClock("2026-09-15T16:00:00Z");
  await initLeagueSettings(db, { season: 2026, phase: "regular", currentWeek: 10 });
});
afterEach(async () => {
  await close();
});

/** A `stats.finalize` booked for `week`, due at Tuesday 4:00 AM ET. */
async function bookFinalize(week: number, status: "due" | "failed" | "done" = "failed") {
  await db.insert(scheduledJobs).values({
    type: "stats.finalize",
    dueAt: new Date("2026-09-15T08:00:00Z"),
    payload: { week },
    status,
    idempotencyKey: `job:stats.finalize:${week}`,
  });
}

async function finalizeHealth() {
  return (await db.select().from(health).where(eq(health.key, "stats.finalize")))[0];
}

describe("the season-stall watchdog (§13.4)", () => {
  it("says nothing when the week advanced past the finalization", async () => {
    await bookFinalize(9, "done");
    expect(await checkFinalizationStall(db, clock)).toBe(false);
    expect(await finalizeHealth()).toBeUndefined();
  });

  it("catches a week that never advanced, and names the consequence", async () => {
    await bookFinalize(10);
    expect(await checkFinalizationStall(db, clock)).toBe(true);

    const row = await finalizeHealth();
    expect(row?.lastError).toContain("week 10 has not finalized");
    expect(row?.lastError).toContain("8h");
    expect(row?.lastError).toContain("The season cannot advance");
  });

  it("re-books the finalization rather than waiting a week for the next Tuesday", async () => {
    await bookFinalize(10);
    await checkFinalizationStall(db, clock);

    const retries = (await db.select().from(scheduledJobs).where(eq(scheduledJobs.type, "stats.finalize"))).filter((j) =>
      j.idempotencyKey.includes(":retry:"),
    );
    expect(retries).toHaveLength(1);
    expect(retries[0]!.payload).toMatchObject({ week: 10 });
    expect(retries[0]!.status).toBe("due");
  });

  it("books at most one retry per half hour, however often the tick runs", async () => {
    await bookFinalize(10);
    for (let i = 0; i < 5; i++) {
      clock.set(new Date(clock.now().getTime() + 60_000));
      await checkFinalizationStall(db, clock);
    }
    const retries = (await db.select().from(scheduledJobs)).filter((j) => j.idempotencyKey.includes(":retry:"));
    expect(retries).toHaveLength(1);

    // Half an hour later it tries again, because the week still has not moved.
    clock.set(new Date(clock.now().getTime() + 31 * 60_000));
    await checkFinalizationStall(db, clock);
    expect((await db.select().from(scheduledJobs)).filter((j) => j.idempotencyKey.includes(":retry:"))).toHaveLength(2);
  });

  it("treats an unplayed week as deferred, not stalled", async () => {
    // The 2026-09-01 incident's second act: after the premature finalization
    // was reverted, the watchdog saw an overdue `stats.finalize` for the
    // still-current week and would have re-booked it every half hour —
    // re-finalizing an unplayed week each time, before the guard existed.
    await bookFinalize(10, "done");
    await db.insert(teams).values([
      { slug: "wa", name: "WA", modelId: "m/a", modelLabel: "A", provider: "t", tiebreakRand: 0.1 },
      { slug: "wb", name: "WB", modelId: "m/b", modelLabel: "B", provider: "t", tiebreakRand: 0.2 },
    ]);
    const ids = (await db.select({ id: teams.id }).from(teams)).map((t) => t.id);
    await db.insert(matchups).values({ week: 10, homeTeamId: ids[0]!, awayTeamId: ids[1]! });
    await db.insert(nflGames).values({
      gameId: "w10-future",
      season: 2026,
      week: 10,
      kickoffAt: new Date("2026-09-20T17:00:00Z"), // after the test clock
      home: "SEA",
      away: "SF",
    });

    expect(await checkFinalizationStall(db, clock)).toBe(false);
    expect(await finalizeHealth()).toBeUndefined();
    const retries = (await db.select().from(scheduledJobs)).filter((j) => j.idempotencyKey.includes(":retry:"));
    expect(retries).toHaveLength(0);
  });

  it("still stalls on a week with matchups but no schedule — that fault must not hide", async () => {
    // games_pending is a healthy deferral; a missing schedule is not. The
    // finalize deferral raises the health error, and the watchdog keeps
    // escalating so the season cannot quietly sit behind a dead feed.
    await bookFinalize(10);
    await db.insert(teams).values([
      { slug: "na", name: "NA", modelId: "m/a", modelLabel: "A", provider: "t", tiebreakRand: 0.5 },
      { slug: "nb", name: "NB", modelId: "m/b", modelLabel: "B", provider: "t", tiebreakRand: 0.6 },
    ]);
    const nids = (await db.select({ id: teams.id }).from(teams)).map((t) => t.id);
    await db.insert(matchups).values({ week: 10, homeTeamId: nids[0]!, awayTeamId: nids[1]! });
    // No nfl_games rows for week 10 at all.
    expect(await checkFinalizationStall(db, clock)).toBe(true);
  });

  it("ignores a deferred job once the week completes — the next Tuesday's run owns it", async () => {
    // The deferred job goes "overdue" the instant the week's games end; the
    // watchdog must not re-book finalization then, hours before the fixed
    // Tuesday 4:00 AM ET run that is already scheduled.
    await bookFinalize(10, "done"); // due 08:00Z, deferred at the time
    await db.insert(teams).values([
      { slug: "da", name: "DA", modelId: "m/a", modelLabel: "A", provider: "t", tiebreakRand: 0.3 },
      { slug: "db", name: "DB", modelId: "m/b", modelLabel: "B", provider: "t", tiebreakRand: 0.4 },
    ]);
    const ids = (await db.select({ id: teams.id }).from(teams)).map((t) => t.id);
    await db.insert(matchups).values({ week: 10, homeTeamId: ids[0]!, awayTeamId: ids[1]! });
    await db.insert(nflGames).values({
      gameId: "w10-done-after-due",
      season: 2026,
      week: 10,
      kickoffAt: new Date("2026-09-15T09:00:00Z"), // ends 13:30Z — after the job's 08:00Z due, before the 16:00Z clock
      home: "SEA",
      away: "SF",
      status: "final",
    });
    // The operative finalization: booked for the next Tuesday, not yet due.
    await db.insert(scheduledJobs).values({
      type: "stats.finalize",
      dueAt: new Date("2026-09-22T08:00:00Z"),
      payload: { week: 10 },
      status: "due",
      idempotencyKey: "job:stats.finalize:10:next-tuesday",
    });

    expect(await checkFinalizationStall(db, clock)).toBe(false);

    // With the booking chain dead — no due or claimed finalization after the
    // games — standing down would silence the season's one emailed alarm for
    // good, so the deferred job stalls after all and the re-book recovers.
    await db.delete(scheduledJobs).where(eq(scheduledJobs.idempotencyKey, "job:stats.finalize:10:next-tuesday"));
    expect(await checkFinalizationStall(db, clock)).toBe(true);
    await db.delete(scheduledJobs).where(eq(scheduledJobs.status, "due")); // drop the re-book before the next scene
    await db.update(health).set({ lastError: null, lastErrorAt: null }).where(eq(health.key, "stats.finalize"));

    // But a job due AFTER the games ended that still has not advanced the
    // week is the real stall, and it still fires.
    await db.insert(scheduledJobs).values({
      type: "stats.finalize",
      dueAt: new Date("2026-09-15T13:45:00Z"), // past the 13:30Z game end, 2h15 before the clock… not yet 3h overdue
      payload: { week: 10 },
      status: "done",
      idempotencyKey: "job:stats.finalize:10:after-games",
    });
    clock.set(new Date("2026-09-15T17:00:00Z")); // now 3h15 overdue
    expect(await checkFinalizationStall(db, clock)).toBe(true);
  });

  it("holds its fire inside the three-hour grace period", async () => {
    await bookFinalize(10);
    clock.set(new Date("2026-09-15T10:00:00Z")); // two hours after the 4:00 AM run
    expect(await checkFinalizationStall(db, clock)).toBe(false);
  });

  it("says nothing outside the regular season and the playoffs", async () => {
    await bookFinalize(10);
    await updateSettings(db, { phase: "pre_draft" });
    expect(await checkFinalizationStall(db, clock)).toBe(false);
  });
});

/**
 * The heartbeat `/admin/health` keys its red banner on. A stage refactor
 * dropped this write once: every stage recorded itself, the tick did all its
 * work, and the page still said "the scheduler has never run" — the exact
 * false alarm the banner exists to avoid.
 */
describe("the tick's heartbeat", () => {
  it("is written by runTick and by nothing else", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const tickSrc = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "tick.ts"),
      "utf8",
    );
    expect(tickSrc).toContain('key: "cron.tick"');

    // It must be the last thing runTick does, after every stage — not inside
    // one, where a single failing stage would suppress the heartbeat.
    const heartbeat = tickSrc.indexOf('key: "cron.tick"');
    const lastStage = tickSrc.lastIndexOf('await stage(database, clock, "tick.');
    expect(heartbeat).toBeGreaterThan(lastStage);
  });
});
