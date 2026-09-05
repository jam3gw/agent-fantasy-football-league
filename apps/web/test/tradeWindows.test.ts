/**
 * Scheduled trade windows are retired (§2, 2026-09-05): the booking loop books
 * none, and a `sessions.book` row for one already on the calendar books nothing
 * when it fires. Agents shop trades in a check-in they book themselves (§8.10).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { health, initLeagueSettings, scheduledJobs, sessions } from "@league/engine";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { seedTeams } from "../../../packages/engine/test/helpers/factories";
import { bookRecurringJobs, runJob } from "../lib/jobs";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await initLeagueSettings(db, { season: 2026, phase: "regular", currentWeek: 1 });
  await seedTeams(db);
});
afterEach(async () => {
  await close();
});

describe("no scheduled trade window (§2, 2026-09-05)", () => {
  it("the booking pass books no trade_window sessions, and still books the rest of the week", async () => {
    // Monday 2026-09-07 00:05 ET.
    const clock = new FixedClock("2026-09-07T04:05:00Z");
    await bookRecurringJobs(db, clock);
    const booked = (await db.select().from(scheduledJobs).where(eq(scheduledJobs.type, "sessions.book"))).map(
      (j) => j.payload.kind,
    );
    expect(booked).not.toContain("trade_window");
    expect(booked).toContain("weekly_review");
    expect(booked).toContain("post_waivers");
    // §8.7: the weekly price sync rides the same booking pass (next Monday 3:00 AM ET; the clock is Monday 00:05 ET, so today).
    const sync = (await db.select().from(scheduledJobs).where(eq(scheduledJobs.type, "prices.sync"))).map((j) =>
      j.dueAt.toISOString(),
    );
    expect(sync).toEqual(["2026-09-07T07:00:00.000Z"]);
  });

  it("a trade_window booking row already on the calendar books no sessions when it fires", async () => {
    const clock = new FixedClock("2026-09-09T16:00:00Z"); // Wed noon ET
    await runJob(db, clock, "sessions.book", { kind: "trade_window", date: "2026-09-09" });
    expect(await db.select().from(sessions)).toEqual([]);

    await runJob(db, clock, "sessions.book", { kind: "post_waivers" });
    const rows = await db.select().from(sessions);
    expect(rows.length).toBe(12);
    expect(rows.every((r) => r.kind === "post_waivers")).toBe(true);
  });
});

describe("prices.sync job (§8.7)", () => {
  it("fails loudly when the catalog cannot be read, and writes a health row when it can", async () => {
    const clock = new FixedClock("2026-09-07T07:00:00Z");
    const saved = globalThis.fetch;
    const savedKey = process.env.AI_GATEWAY_API_KEY;
    process.env.AI_GATEWAY_API_KEY = "test-key";
    try {
      globalThis.fetch = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
      await expect(runJob(db, clock, "prices.sync", {})).rejects.toThrow(/prices\.sync/);
      expect(await db.select().from(health).where(eq(health.key, "prices.sync"))).toEqual([]);

      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "mistral/mistral-large-3", context_window: 256000, pricing: { input: "0.0000005", output: "0.0000015" } }],
          }),
          { status: 200 },
        )) as unknown as typeof fetch;
      await runJob(db, clock, "prices.sync", {});
      const row = (await db.select().from(health).where(eq(health.key, "prices.sync")))[0]!;
      // Eleven league seats are absent from this one-entry catalog: an error row names them.
      expect(row.lastError).toContain("anthropic/claude-fable-5");
      expect(row.lastError).toContain("/admin/teams");
    } finally {
      globalThis.fetch = saved;
      if (savedKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = savedKey;
    }
  });
});
