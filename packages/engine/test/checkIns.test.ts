/**
 * §8.10 — check-ins an agent schedules for itself.
 *
 * The limits are the whole design: without them an anxious model books twenty,
 * a check-in books a check-in forever, and "come back in one minute" becomes a
 * way around the tool-call ceiling. Each one is tested here rather than in the
 * tool, because the tool is not the only thing that may ever create one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { seedLeague, seedTeams } from "./helpers/factories.ts";
import {
  MAX_CHECK_INS_PER_WEEK,
  MAX_PENDING_CHECK_INS,
  cancelCheckIn,
  pendingCheckIns,
  scheduleCheckIn,
} from "../src/checkIns.ts";
import { sessions, teams } from "../src/db/schema.ts";
import { updateSettings } from "../src/settings.ts";

let db: TestDb;
let close: () => Promise<void>;
let clock: FixedClock;
let teamIds: number[];

const NOW = "2026-10-20T15:00:00Z";
const in2h = (h = 2) => new Date(new Date(NOW).getTime() + h * 3600_000);

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = new FixedClock(NOW);
  await seedLeague(db, { phase: "regular", currentWeek: 7 });
  teamIds = await seedTeams(db);
});
afterEach(async () => {
  await close();
});

describe("scheduling", () => {
  it("books a queued session the tick will start, with the reason as its brief", async () => {
    const r = await scheduleCheckIn(db, clock, teamIds[0]!, {
      at: in2h(),
      reason: "check whether Achane practised before I commit to the FLEX",
      bookedBySessionKind: "weekly_review",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const row = (await db.select().from(sessions).where(eq(sessions.id, r.value.sessionId)))[0]!;
    expect(row.kind).toBe("self_check_in");
    expect(row.status).toBe("queued");
    expect(row.teamId).toBe(teamIds[0]!);
    expect(row.context.reason).toContain("Achane");
    // The sweeper starts it from `due_at`, and the week is stamped so its cost
    // lands in this week's rollup (§8.7).
    expect(row.context.due_at).toBe(in2h().toISOString());
    expect(row.context.week).toBe(7);
    // It runs on the team's own model, like every other session for that team.
    const team = (await db.select().from(teams).where(eq(teams.id, teamIds[0]!)))[0]!;
    expect(row.modelId).toBe(team.modelId);
  });

  it("is idempotent to the minute, so asking twice does not book twice", async () => {
    const at = in2h();
    const first = await scheduleCheckIn(db, clock, teamIds[0]!, { at, reason: "one" });
    const second = await scheduleCheckIn(db, clock, teamIds[0]!, { at, reason: "one again" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(await pendingCheckIns(db, teamIds[0]!)).toHaveLength(1);
  });
});

describe("the limits", () => {
  it("refuses a check-in sooner than the lead time", async () => {
    const r = await scheduleCheckIn(db, clock, teamIds[0]!, {
      at: new Date(new Date(NOW).getTime() + 60_000),
      reason: "right now",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("bad_time");
      // "Do it now" is the ceiling's job, not the scheduler's.
      expect(r.hint).toContain("do it in this session");
    }
  });

  it("refuses a check-in past the horizon, and a time that is not one", async () => {
    const far = await scheduleCheckIn(db, clock, teamIds[0]!, {
      at: new Date(new Date(NOW).getTime() + 30 * 24 * 3600_000),
      reason: "next month",
    });
    expect(!far.ok && far.error).toBe("bad_time");
    const nonsense = await scheduleCheckIn(db, clock, teamIds[0]!, {
      at: new Date("not a date"),
      reason: "when?",
    });
    expect(!nonsense.ok && nonsense.error).toBe("bad_time");
  });

  it(`holds at ${MAX_PENDING_CHECK_INS} pending, and frees a slot when one is cancelled`, async () => {
    for (let i = 1; i <= MAX_PENDING_CHECK_INS; i++) {
      const r = await scheduleCheckIn(db, clock, teamIds[0]!, { at: in2h(i), reason: `look ${i}` });
      expect(r.ok, `booking ${i}`).toBe(true);
    }
    const over = await scheduleCheckIn(db, clock, teamIds[0]!, { at: in2h(9), reason: "one more" });
    expect(!over.ok && over.error).toBe("check_in_limit");
    expect(!over.ok && over.hint).toContain("cancel_check_in");

    const mine = await pendingCheckIns(db, teamIds[0]!);
    expect(await cancelCheckIn(db, clock, teamIds[0]!, mine[0]!.sessionId)).toMatchObject({ ok: true });
    expect(await scheduleCheckIn(db, clock, teamIds[0]!, { at: in2h(9), reason: "now there is room" })).toMatchObject(
      { ok: true },
    );
  });

  it(`holds at ${MAX_CHECK_INS_PER_WEEK} a week even as earlier ones finish`, async () => {
    for (let i = 1; i <= MAX_CHECK_INS_PER_WEEK; i++) {
      const r = await scheduleCheckIn(db, clock, teamIds[0]!, { at: in2h(i), reason: `look ${i}` });
      expect(r.ok, `booking ${i}`).toBe(true);
      // Retire it so the pending cap is never what stops us.
      if (r.ok) {
        await db.update(sessions).set({ status: "succeeded" }).where(eq(sessions.id, r.value.sessionId));
      }
    }
    const over = await scheduleCheckIn(db, clock, teamIds[0]!, { at: in2h(9), reason: "one more" });
    expect(!over.ok && over.error).toBe("check_in_limit");

    // The allowance is per fantasy week, so next week starts clean.
    await updateSettings(db, { currentWeek: 8 });
    expect(await scheduleCheckIn(db, clock, teamIds[0]!, { at: in2h(9), reason: "new week" })).toMatchObject({
      ok: true,
    });
  });

  it("refuses to let a check-in book another check-in", async () => {
    const r = await scheduleCheckIn(db, clock, teamIds[0]!, {
      at: in2h(),
      reason: "and again",
      bookedBySessionKind: "self_check_in",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("cannot schedule another check-in");
  });

  it("refuses a paused or eliminated team", async () => {
    await db.update(teams).set({ paused: true }).where(eq(teams.id, teamIds[0]!));
    expect(await scheduleCheckIn(db, clock, teamIds[0]!, { at: in2h(), reason: "x" })).toMatchObject({ ok: false });

    await db.update(teams).set({ paused: false, eliminated: true }).where(eq(teams.id, teamIds[1]!));
    expect(await scheduleCheckIn(db, clock, teamIds[1]!, { at: in2h(), reason: "x" })).toMatchObject({ ok: false });
  });

  it("refuses an empty or oversized reason", async () => {
    expect(await scheduleCheckIn(db, clock, teamIds[0]!, { at: in2h(), reason: "   " })).toMatchObject({ ok: false });
    const long = await scheduleCheckIn(db, clock, teamIds[0]!, { at: in2h(), reason: "x".repeat(501) });
    expect(!long.ok && long.error).toBe("too_long");
  });
});

describe("cancelling", () => {
  it("cannot cancel another team's check-in", async () => {
    const r = await scheduleCheckIn(db, clock, teamIds[0]!, { at: in2h(), reason: "mine" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Ids are sequential, so this is the §15.5 case: guessing one must not work.
    const stolen = await cancelCheckIn(db, clock, teamIds[1]!, r.value.sessionId);
    expect(stolen.ok).toBe(false);
    expect(await pendingCheckIns(db, teamIds[0]!)).toHaveLength(1);
  });

  it("cannot cancel one that already ran", async () => {
    const r = await scheduleCheckIn(db, clock, teamIds[0]!, { at: in2h(), reason: "mine" });
    if (!r.ok) throw new Error("setup");
    await db.update(sessions).set({ status: "succeeded" }).where(eq(sessions.id, r.value.sessionId));
    expect(await cancelCheckIn(db, clock, teamIds[0]!, r.value.sessionId)).toMatchObject({ ok: false });
  });
});
