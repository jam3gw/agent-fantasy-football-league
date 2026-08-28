/**
 * §15.4 — load and timing: twelve sessions booked for the same window finish
 * inside the deadline with the concurrency cap of 6, and none of them is
 * silently dropped on the way.
 *
 * The model is not involved: what is under test is the scheduler's arithmetic
 * and the slot claim, which is where the twelve-at-once case actually goes
 * wrong.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { initLeagueSettings, sessions, teams } from "@league/engine";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { claimSlot } from "../lib/runSession";

let db: TestDb;
let close: () => Promise<void>;
let clock: FixedClock;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = new FixedClock("2026-11-08T15:00:00Z"); // Sunday, 10:00 ET
  await initLeagueSettings(db, { season: 2026, phase: "regular", currentWeek: 10 });
});
afterEach(async () => {
  await close();
});

const CAP = 6;

async function twelveTeams(): Promise<number[]> {
  const rows = await db
    .insert(teams)
    .values(
      Array.from({ length: 12 }, (_, i) => ({
        slug: `t${i + 1}`,
        name: `Team ${i + 1}`,
        modelId: `m/${i + 1}`,
        modelLabel: `M${i + 1}`,
        provider: "t",
        tiebreakRand: i / 12,
      })),
    )
    .returning({ id: teams.id });
  return rows.map((r) => r.id);
}

/** One queued session per team, all for the same kickoff window. */
async function bookTwelve(teamIds: number[], deadlineAt: Date): Promise<number[]> {
  const rows = await db
    .insert(sessions)
    .values(
      teamIds.map((teamId, i) => ({
        teamId,
        kind: "lineup_check" as const,
        trigger: "week.plan",
        idempotencyKey: `k${i}`,
        modelId: `m/${i + 1}`,
        status: "queued" as const,
        context: { deadline_at: deadlineAt.toISOString(), week: 10 },
      })),
    )
    .returning({ id: sessions.id });
  return rows.map((r) => r.id);
}

async function runningCount(): Promise<number> {
  const rows = await db.select().from(sessions).where(eq(sessions.status, "running"));
  return rows.length;
}

async function finish(sessionId: number) {
  await db
    .update(sessions)
    .set({ status: "succeeded", endedAt: clock.now() })
    .where(eq(sessions.id, sessionId));
}

describe("§9.2 — the slot claim", () => {
  it("lets exactly six through, whatever order they arrive in", async () => {
    const teamIds = await twelveTeams();
    const ids = await bookTwelve(teamIds, new Date("2026-11-08T18:00:00Z"));

    const claimed: number[] = [];
    for (const id of ids) {
      const session = (await db.select().from(sessions).where(eq(sessions.id, id)))[0]!;
      if (await claimSlot(db, id, session.teamId)) claimed.push(id);
    }
    expect(claimed).toHaveLength(CAP);
    expect(await runningCount()).toBe(CAP);

    // The six that did not get in are untouched and still runnable.
    const stillQueued = await db.select().from(sessions).where(eq(sessions.status, "queued"));
    expect(stillQueued).toHaveLength(6);
  });

  it("never runs two sessions for the same team", async () => {
    const [teamId] = await twelveTeams();
    const rows = await db
      .insert(sessions)
      .values(
        ["a", "b"].map((k) => ({
          teamId: teamId!,
          kind: "weekly_review" as const,
          trigger: "t",
          idempotencyKey: k,
          modelId: "m/1",
          status: "queued" as const,
          context: { deadline_at: "2026-11-08T18:00:00Z" },
        })),
      )
      .returning({ id: sessions.id });

    expect(await claimSlot(db, rows[0]!.id, teamId!)).toBe(true);
    expect(await claimSlot(db, rows[1]!.id, teamId!)).toBe(false);
    await finish(rows[0]!.id);
    expect(await claimSlot(db, rows[1]!.id, teamId!)).toBe(true);
  });

  it("claims a session once, so two ticks racing cannot both start it", async () => {
    const [teamId] = await twelveTeams();
    const [row] = await db
      .insert(sessions)
      .values({
        teamId: teamId!,
        kind: "weekly_review",
        trigger: "t",
        idempotencyKey: "once",
        modelId: "m/1",
        status: "queued",
        context: { deadline_at: "2026-11-08T18:00:00Z" },
      })
      .returning({ id: sessions.id });
    expect(await claimSlot(db, row!.id, teamId!)).toBe(true);
    expect(await claimSlot(db, row!.id, teamId!)).toBe(false);
  });

  it("the reporter has no team, so the per-team rule never blocks it", async () => {
    const teamIds = await twelveTeams();
    await bookTwelve(teamIds, new Date("2026-11-08T18:00:00Z"));
    const [reporter] = await db
      .insert(sessions)
      .values({
        teamId: null,
        kind: "reporter_recap",
        trigger: "t",
        idempotencyKey: "rep",
        modelId: "m/r",
        status: "queued",
        context: { deadline_at: "2026-11-08T18:00:00Z" },
      })
      .returning({ id: sessions.id });
    expect(await claimSlot(db, reporter!.id, null)).toBe(true);
  });
});

describe("§15.4 — twelve lineup checks finish inside the window", () => {
  it("drains in two waves, well inside the 45 minutes the criterion allows", async () => {
    // §9.2 books lineup checks 90 minutes before kickoff; the deadline is the
    // kickoff itself (§8.3). A session takes at most the 15 minutes §15.4
    // budgets for one.
    const kickoff = new Date("2026-11-08T18:00:00Z");
    const teamIds = await twelveTeams();
    const ids = await bookTwelve(teamIds, kickoff);
    const startedAt = clock.now();

    const SESSION_MINUTES = 15;
    let elapsed = 0;
    const running = new Map<number, number>(); // session id → minute it finishes
    const done: number[] = [];
    const pending = [...ids];

    // One pass per simulated minute, which is exactly the tick's cadence.
    for (elapsed = 0; elapsed <= 45 && done.length < ids.length; elapsed++) {
      clock.set(new Date(startedAt.getTime() + elapsed * 60_000));

      for (const [id, endsAt] of [...running]) {
        if (endsAt > elapsed) continue;
        await finish(id);
        running.delete(id);
        done.push(id);
      }

      // The tick's sweeper: start what it can, stop at the cap.
      while (pending.length > 0) {
        const id = pending[0]!;
        const session = (await db.select().from(sessions).where(eq(sessions.id, id)))[0]!;
        if (!(await claimSlot(db, id, session.teamId))) break;
        pending.shift();
        running.set(id, elapsed + SESSION_MINUTES);
      }
      expect(await runningCount(), `over the cap at minute ${elapsed}`).toBeLessThanOrEqual(CAP);
    }

    expect(done).toHaveLength(12);
    // Two waves of six at fifteen minutes each: thirty, inside both §15.4's
    // 45 minutes and the 90-minute lead before kickoff.
    expect(elapsed - 1).toBeLessThanOrEqual(45);
    expect(elapsed - 1).toBeLessThan(90);
    const unfinished = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.status, "queued")));
    expect(unfinished, "no session may be left behind").toHaveLength(0);
  });
});
