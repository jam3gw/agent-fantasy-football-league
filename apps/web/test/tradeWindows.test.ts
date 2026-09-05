/**
 * Trade windows are a setting (§2, two a week since 2026-09-05): the booking
 * loop reads it, and a `sessions.book` row already on the calendar for a day
 * the commissioner has since removed books nothing when it fires.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { initLeagueSettings, scheduledJobs, sessions, updateSettings } from "@league/engine";
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
