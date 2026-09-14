/**
 * Scheduled trade windows are retired (§2, 2026-09-05): the booking loop books
 * none, and a `sessions.book` row for one already on the calendar books nothing
 * when it fires. Agents shop trades in a check-in they book themselves (§8.10).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { health, initLeagueSettings, scheduledJobs, sessions, teams, updateSettings } from "@league/engine";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { makeGame, seedTeams } from "../../../packages/engine/test/helpers/factories";
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
    await runJob(db, clock, "sessions.book", { kind: "trade_window" });
    expect(await db.select().from(sessions)).toEqual([]);

    await runJob(db, clock, "sessions.book", { kind: "post_waivers" });
    const rows = await db.select().from(sessions);
    expect(rows.length).toBe(12);
    expect(rows.every((r) => r.kind === "post_waivers")).toBe(true);
  });
});

describe("sessions.book keys carry the booking day", () => {
  /*
   * Week 1 ran from the draft (Aug 30) to the first kickoff (Sep 10), so it
   * held two Wednesdays. The key used to be the week alone, and the second
   * Wednesday's post_waivers booking matched the first one's key for every
   * team: `createSession` skipped all twelve and the job reported success.
   * The same happened to the second Tuesday's weekly_review.
   */
  it("books post_waivers on both Wednesdays of a week that spans two", async () => {
    await runJob(db, new FixedClock("2026-09-02T13:00:00Z"), "sessions.book", { kind: "post_waivers" });
    await runJob(db, new FixedClock("2026-09-09T13:00:00Z"), "sessions.book", { kind: "post_waivers" });
    const rows = await db.select().from(sessions);
    expect(rows.length).toBe(24);
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(24);
    expect(rows.every((r) => r.kind === "post_waivers" && r.status === "queued")).toBe(true);
  });

  it("stays idempotent within a day, so a re-run tick books nothing twice", async () => {
    const clock = new FixedClock("2026-09-08T13:00:00Z");
    await runJob(db, clock, "sessions.book", { kind: "weekly_review" });
    await runJob(db, clock, "sessions.book", { kind: "weekly_review" });
    expect((await db.select().from(sessions)).length).toBe(12);
  });

  it("books a fresh set when the week advances, so in season every Tuesday books", async () => {
    await runJob(db, new FixedClock("2026-09-15T13:00:00Z"), "sessions.book", { kind: "weekly_review" });
    await updateSettings(db, { currentWeek: 2 });
    await runJob(db, new FixedClock("2026-09-22T13:00:00Z"), "sessions.book", { kind: "weekly_review" });
    const rows = await db.select().from(sessions);
    expect(rows.length).toBe(24);
    expect(rows.filter((r) => r.context.week === 2).length).toBe(12);
  });

  /*
   * §13.4: a finalization that defers (a game moved) or stalls leaves
   * `current_week` in place. That week's review and post-waivers already ran;
   * the next Tuesday must not book twelve more against a week whose result is
   * not final. The signal is the week's first kickoff: once it has passed,
   * the recurring bookings are done for that week.
   */
  it("books nothing for a week already under way (deferred or stalled finalization)", async () => {
    await makeGame(db, { week: 1, kickoffAt: new Date("2026-09-10T00:20:00Z"), home: "NE", away: "SEA" });
    await makeGame(db, { week: 1, kickoffAt: new Date("2026-09-13T17:00:00Z"), home: "TEN", away: "NYJ" });
    // Wednesday 9 AM ET, before the week's first kickoff: books.
    await runJob(db, new FixedClock("2026-09-09T13:00:00Z"), "sessions.book", { kind: "post_waivers" });
    expect((await db.select().from(sessions)).length).toBe(12);
    // The next Tuesday and Wednesday with the week still current: nothing.
    await runJob(db, new FixedClock("2026-09-15T13:00:00Z"), "sessions.book", { kind: "weekly_review" });
    await runJob(db, new FixedClock("2026-09-16T13:00:00Z"), "sessions.book", { kind: "post_waivers" });
    expect((await db.select().from(sessions)).length).toBe(12);
  });
});

describe("the commissioner's one-off trade window for every team (2026-09-08)", () => {
  it("a sessions.book row naming a window label books one trade_window per active team, keyed on the label", async () => {
    await makeGame(db, { week: 1, kickoffAt: new Date("2026-09-01T00:00:00Z"), home: "NE", away: "SEA" }); // under way: no effect here
    const clock = new FixedClock("2026-09-08T16:00:00Z");
    await runJob(db, clock, "sessions.book", { kind: "trade_window", window: "final-2026-09-08" });
    await runJob(db, clock, "sessions.book", { kind: "trade_window", window: "final-2026-09-08" });
    const rows = await db.select().from(sessions);
    expect(rows.length).toBe(12);
    expect(rows.every((r) => r.kind === "trade_window" && r.idempotencyKey.endsWith(":final-2026-09-08"))).toBe(true);
    // Without the label, or with an empty one, the retired path still books nothing.
    await runJob(db, clock, "sessions.book", { kind: "trade_window" });
    await runJob(db, clock, "sessions.book", { kind: "trade_window", window: "  " });
    expect((await db.select().from(sessions)).length).toBe(12);
  });

  it("carries the commissioner's note into every session's context, and skips a paused team", async () => {
    const clock = new FixedClock("2026-09-08T16:00:00Z");
    const [paused] = await db.select({ id: teams.id }).from(teams).limit(1);
    await db.update(teams).set({ paused: true }).where(eq(teams.id, paused!.id));
    await runJob(db, clock, "sessions.book", {
      kind: "trade_window",
      window: "final-2026-09-08",
      note: "This is the last window the league opens for everyone.",
    });
    const rows = await db.select().from(sessions);
    expect(rows.length).toBe(11);
    expect(rows.some((r) => r.teamId === paused!.id)).toBe(false);
    expect(rows.every((r) => r.context.note === "This is the last window the league opens for everyone.")).toBe(true);
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

  it("alerts on the live seat's model id, not the static LEAGUE_MODELS default it was swapped away from", async () => {
    // seedTeams gives team 12 "zai/glm-5.3" — already swapped off the
    // LEAGUE_MODELS default "zai/glm-5.3-promo-50", the same shape as the
    // real 2026-09-09 swap. A catalog missing both must alert on the id the
    // seat actually runs, never the retired default it left behind.
    const clock = new FixedClock("2026-09-14T07:00:00Z");
    const saved = globalThis.fetch;
    const savedKey = process.env.AI_GATEWAY_API_KEY;
    process.env.AI_GATEWAY_API_KEY = "test-key";
    try {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "anthropic/claude-fable-5", context_window: 1000000, pricing: { input: "0.00001", output: "0.00005" } }],
          }),
          { status: 200 },
        )) as unknown as typeof fetch;
      await runJob(db, clock, "prices.sync", {});
      const row = (await db.select().from(health).where(eq(health.key, "prices.sync")))[0]!;
      expect(row.lastError).toContain("zai/glm-5.3");
      expect(row.lastError).not.toContain("zai/glm-5.3-promo-50");
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
