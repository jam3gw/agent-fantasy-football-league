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
import { health, initLeagueSettings, scheduledJobs, updateSettings } from "@league/engine";
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
