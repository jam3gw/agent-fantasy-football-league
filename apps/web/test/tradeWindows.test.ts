/**
 * Trade windows are a setting (§2, two a week since 2026-09-05): the booking
 * loop reads it, and a `sessions.book` row already on the calendar for a day
 * the commissioner has since removed books nothing when it fires.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { health, initLeagueSettings, scheduledJobs, sessions, updateSettings } from "@league/engine";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { seedTeams } from "../../../packages/engine/test/helpers/factories";
import { bookRecurringJobs, isTradeWindowDay, runJob } from "../lib/jobs";

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

describe("trade windows as a setting", () => {
  it("isTradeWindowDay reads the ET calendar date against the setting", () => {
    // 2026-09-05 is a Saturday, 2026-09-09 a Wednesday, 2026-09-11 a Friday.
    expect(isTradeWindowDay({ extra: {} }, "2026-09-05")).toBe(false);
    expect(isTradeWindowDay({ extra: {} }, "2026-09-09")).toBe(true);
    expect(isTradeWindowDay({ extra: {} }, "2026-09-11")).toBe(true);
    expect(isTradeWindowDay({ extra: { tradeWindowDays: [6] } }, "2026-09-05")).toBe(true);
    expect(isTradeWindowDay({ extra: {} }, "not a date")).toBe(false);
  });

  it("books trade windows only on the configured days, and none past the deadline", async () => {
    // Monday 2026-09-07 00:05 ET.
    const clock = new FixedClock("2026-09-07T04:05:00Z");
    await bookRecurringJobs(db, clock);
    const booked = (await db.select().from(scheduledJobs).where(eq(scheduledJobs.type, "sessions.book")))
      .filter((j) => j.payload.kind === "trade_window")
      .map((j) => j.payload.date)
      .sort();
    expect(booked).toEqual(["2026-09-09", "2026-09-11"]);
    // §8.7: the weekly price sync rides the same booking pass (next Monday 3:00 AM ET; the clock is Monday 00:05 ET, so today).
    const sync = (await db.select().from(scheduledJobs).where(eq(scheduledJobs.type, "prices.sync"))).map((j) =>
      j.dueAt.toISOString(),
    );
    expect(sync).toEqual(["2026-09-07T07:00:00.000Z"]);

    await db.delete(scheduledJobs);
    await updateSettings(db, { tradeDeadlineWeek: 0 });
    await bookRecurringJobs(db, clock);
    const none = (await db.select().from(scheduledJobs).where(eq(scheduledJobs.type, "sessions.book"))).filter(
      (j) => j.payload.kind === "trade_window",
    );
    expect(none).toEqual([]);
  });

  it("a booked row for a removed day books no sessions when it fires", async () => {
    const clock = new FixedClock("2026-09-05T16:00:00Z"); // Sat noon ET
    await runJob(db, clock, "sessions.book", { kind: "trade_window", date: "2026-09-05" });
    expect(await db.select().from(sessions)).toEqual([]);

    await runJob(db, clock, "sessions.book", { kind: "trade_window", date: "2026-09-09" });
    const rows = await db.select().from(sessions);
    expect(rows.length).toBe(12);
    expect(rows.every((r) => r.kind === "trade_window")).toBe(true);
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

describe("reporter bookings (§11)", () => {
  it("books the rankings edition ahead of the recap on Tuesday", async () => {
    const clock = new FixedClock("2026-09-07T04:05:00Z"); // Monday 00:05 ET
    await bookRecurringJobs(db, clock);
    const reporter = (await db.select().from(scheduledJobs).where(eq(scheduledJobs.type, "reporter.run")))
      .map((j) => [j.payload.kind, j.dueAt.toISOString()])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    expect(reporter).toEqual([
      ["reporter_power_rankings", "2026-09-08T14:30:00.000Z"],
      ["reporter_recap", "2026-09-08T15:00:00.000Z"],
      ["reporter_preview", "2026-09-10T14:00:00.000Z"],
    ]);
  });

  it("a second rankings booking in the same week is a new session; a second recap is not", async () => {
    await runJob(db, new FixedClock("2026-09-05T18:00:00Z"), "reporter.run", { kind: "reporter_power_rankings" }, { id: 1 });
    await runJob(db, new FixedClock("2026-09-08T14:30:00Z"), "reporter.run", { kind: "reporter_power_rankings" }, { id: 2 });
    // The same job row run twice (a stale claim released and re-run) is one session.
    await runJob(db, new FixedClock("2026-09-08T15:05:00Z"), "reporter.run", { kind: "reporter_power_rankings" }, { id: 2 });
    await runJob(db, new FixedClock("2026-09-08T15:00:00Z"), "reporter.run", { kind: "reporter_recap" });
    await runJob(db, new FixedClock("2026-09-08T16:00:00Z"), "reporter.run", { kind: "reporter_recap" });
    const booked = await db.select().from(sessions);
    expect(booked.filter((s) => s.kind === "reporter_power_rankings")).toHaveLength(2);
    expect(booked.filter((s) => s.kind === "reporter_recap")).toHaveLength(1);
    expect(booked.every((s) => s.teamId === null)).toBe(true);
  });
});
