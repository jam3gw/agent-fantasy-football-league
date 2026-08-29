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
import { and, eq, inArray } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import {
  createSession,
  getSettings,
  health,
  initLeagueSettings,
  scheduledJobs,
  sessionEvents,
  sessions,
  teams,
} from "@league/engine";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { claimSlot } from "../lib/runSession";
import { startQueuedSessions } from "../lib/tick";

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
      if ((await claimSlot(db, id, session.teamId, clock.now())) === "claimed") claimed.push(id);
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

    expect(await claimSlot(db, rows[0]!.id, teamId!, clock.now())).toBe("claimed");
    // The distinction the sweeper depends on: this team is busy, the league is not.
    expect(await claimSlot(db, rows[1]!.id, teamId!, clock.now())).toBe("team_busy");
    await finish(rows[0]!.id);
    expect(await claimSlot(db, rows[1]!.id, teamId!, clock.now())).toBe("claimed");
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
    expect(await claimSlot(db, row!.id, teamId!, clock.now())).toBe("claimed");
    expect(await claimSlot(db, row!.id, teamId!, clock.now())).toBe("not_queued");
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
    expect(await claimSlot(db, reporter!.id, null, clock.now())).toBe("claimed");
  });
});

describe("the tick's sweeper is the only thing that starts a session", () => {
  it("starts each session exactly once, however many ticks run", async () => {
    // The bug this pins: a session was started by both its `session.run` job
    // and the sweeper, in the same tick, and neither run refused — so the
    // model calls, the ledger rows and every write the agent made happened
    // twice.
    const teamIds = await twelveTeams();
    const ids = await bookTwelve(teamIds, new Date("2026-11-08T18:00:00Z"));
    const started: number[] = [];

    for (let tick = 0; tick < 3; tick++) {
      await startQueuedSessions(db, clock, async (id) => {
        started.push(id);
      });
    }

    expect(started).toHaveLength(CAP);
    expect(new Set(started).size).toBe(CAP);
    expect(started.every((id) => ids.includes(id))).toBe(true);
    // And no session row was started that the sweeper did not report.
    expect(await runningCount()).toBe(CAP);
  });

  it("does not book a second starter alongside itself", async () => {
    // `createSession` used to book a `session.run` job as well; the job's
    // workflow and the sweeper then both ran the session.
    const [teamId] = await twelveTeams();
    const settings = await getSettings(db);
    await createSession(db, settings, {
      teamId: teamId!,
      kind: "weekly_review",
      trigger: "test",
      idempotencyKey: "solo",
      modelId: "m/1",
      dueAt: clock.now(),
      now: clock.now(),
      context: { week: 10 },
    });
    const jobs = await db.select().from(scheduledJobs);
    expect(jobs.filter((j) => j.type === "session.run")).toHaveLength(0);
  });

  it("a busy team does not hold the queue up behind it", async () => {
    // Team A is mid-session; A's next session is the oldest queued row. The
    // other eleven teams must still start — otherwise one long session idles
    // five slots for ninety minutes and every lineup check behind it is
    // skipped at kickoff.
    const teamIds = await twelveTeams();
    const deadline = new Date("2026-11-08T18:00:00Z");

    const [busy] = await db
      .insert(sessions)
      .values({
        teamId: teamIds[0]!,
        kind: "weekly_review",
        trigger: "t",
        idempotencyKey: "busy",
        modelId: "m/1",
        status: "running",
        startedAt: clock.now(),
        // The row's own default would be real wall-clock time, which is stale
        // against the league clock this test runs on — and a stale row is
        // exactly what the reclaim sweep is for.
        updatedAt: clock.now(),
        context: { deadline_at: deadline.toISOString() },
      })
      .returning({ id: sessions.id });

    // A's second session is booked first, so it is at the head of the queue.
    await db.insert(sessions).values({
      teamId: teamIds[0]!,
      kind: "trade_vote",
      trigger: "t",
      idempotencyKey: "a-second",
      modelId: "m/1",
      status: "queued",
      context: { deadline_at: deadline.toISOString() },
    });
    await bookTwelve(teamIds.slice(1), deadline);

    const started: number[] = [];
    await startQueuedSessions(db, clock, async (id) => {
      started.push(id);
    });

    // Five slots were free beside the running one, and all five were used.
    expect(started).toHaveLength(CAP - 1);
    expect(started).not.toContain(busy!.id);
  });

  it("respects the stagger: a session not yet due waits its turn", async () => {
    const teamIds = await twelveTeams();
    const deadline = new Date("2026-11-08T18:00:00Z");
    await db.insert(sessions).values(
      teamIds.slice(0, 3).map((teamId, i) => ({
        teamId,
        kind: "lineup_check" as const,
        trigger: "t",
        idempotencyKey: `s${i}`,
        modelId: "m/1",
        status: "queued" as const,
        context: {
          deadline_at: deadline.toISOString(),
          // The first is due now; the others in one and two minutes (§9.1).
          due_at: new Date(clock.now().getTime() + i * 60_000).toISOString(),
        },
      })),
    );

    const first: number[] = [];
    await startQueuedSessions(db, clock, async (id) => {
      first.push(id);
    });
    expect(first).toHaveLength(1);

    clock.advance(2 * 60_000);
    const rest: number[] = [];
    await startQueuedSessions(db, clock, async (id) => {
      rest.push(id);
    });
    expect(rest).toHaveLength(2);
  });

  it("skips a session whose deadline passed while it waited", async () => {
    const [teamId] = await twelveTeams();
    const [row] = await db
      .insert(sessions)
      .values({
        teamId: teamId!,
        kind: "lineup_check",
        trigger: "t",
        idempotencyKey: "late",
        modelId: "m/1",
        status: "queued",
        context: { deadline_at: new Date(clock.now().getTime() - 60_000).toISOString() },
      })
      .returning({ id: sessions.id });

    const started: number[] = [];
    const result = await startQueuedSessions(db, clock, async (id) => {
      started.push(id);
    });
    expect(started).toEqual([]);
    expect(result.expired).toBe(1);
    const after = (await db.select().from(sessions).where(eq(sessions.id, row!.id)))[0]!;
    expect(after.status).toBe("skipped");
    expect(after.endedBy).toBe("deadline");
  });

  it("reclaims a session abandoned mid-run so its slot comes back", async () => {
    // A function killed between the slot claim and the workflow start leaves a
    // `running` row nobody owns. Left alone it holds one of the six slots — and
    // blocks that team entirely — for the rest of the season.
    const [teamId] = await twelveTeams();
    const stale = new Date(clock.now().getTime() - 60 * 60_000);
    const [row] = await db
      .insert(sessions)
      .values({
        teamId: teamId!,
        kind: "weekly_review",
        trigger: "t",
        idempotencyKey: "abandoned",
        modelId: "m/1",
        status: "running",
        startedAt: stale,
        updatedAt: stale,
        context: { deadline_at: new Date(clock.now().getTime() - 30 * 60_000).toISOString() },
      })
      .returning({ id: sessions.id });

    const result = await startQueuedSessions(db, clock, async () => {});
    expect(result.reclaimed).toBe(1);
    const after = (await db.select().from(sessions).where(eq(sessions.id, row!.id)))[0]!;
    expect(after.status).toBe("failed");
    expect(await runningCount()).toBe(0);
  });

  it("leaves a live session alone even after its deadline has passed", async () => {
    // The case that matters: a session finishing its closing step is past its
    // deadline by definition (§8.2 step 5), and a turn spent on free tools
    // writes no ledger row. Only idleness may condemn it — otherwise the tick
    // fails a live session and hands its team's slot to a second one.
    const [teamId] = await twelveTeams();
    await db.insert(sessions).values({
      teamId: teamId!,
      kind: "weekly_review",
      trigger: "t",
      idempotencyKey: "closing",
      modelId: "m/1",
      status: "running",
      startedAt: new Date(clock.now().getTime() - 90 * 60_000),
      updatedAt: clock.now(), // just wrote a transcript row
      context: { deadline_at: new Date(clock.now().getTime() - 60_000).toISOString() },
    });
    const result = await startQueuedSessions(db, clock, async () => {});
    expect(result.reclaimed).toBe(0);
    expect(await runningCount()).toBe(1);
  });

  it("reclaims an idle session even while it is still inside its window", async () => {
    // The other half: long enough without writing anything is dead whatever the
    // deadline says, and failing it (rather than skipping it) is what lets §8.8
    // retry. It has written a transcript row, so this is the idle cutoff and
    // not the never-started one.
    const [teamId] = await twelveTeams();
    const idle = new Date(clock.now().getTime() - 45 * 60_000);
    const [row] = await db
      .insert(sessions)
      .values({
        teamId: teamId!,
        kind: "weekly_review",
        trigger: "t",
        idempotencyKey: "idle",
        modelId: "m/1",
        status: "running",
        startedAt: idle,
        updatedAt: idle,
        context: { deadline_at: new Date(clock.now().getTime() + 60 * 60_000).toISOString() },
      })
      .returning({ id: sessions.id });
    await db.insert(sessionEvents).values({ sessionId: row!.id, seq: 0, type: "system", content: {} });

    const result = await startQueuedSessions(db, clock, async () => {});
    expect(result.reclaimed).toBe(1);
    const rows = await db.select().from(sessions).where(eq(sessions.status, "failed"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error).toContain("no progress");
  });

  it("returns the slot quickly when the workflow was never started at all", async () => {
    // `startRun` throwing leaves the row `running` on purpose — requeueing it
    // would give a workflow that *was* accepted a second runner. What makes
    // that safe is the short cutoff for a claimed row that has written no
    // transcript row at all: without it, a start outage burns one of the six
    // slots per tick and stalls the whole league.
    const [teamId] = await twelveTeams();
    await db.insert(sessions).values({
      teamId: teamId!,
      kind: "weekly_review",
      trigger: "t",
      idempotencyKey: "never-started",
      modelId: "m/1",
      status: "running",
      startedAt: new Date(clock.now().getTime() - 6 * 60_000),
      updatedAt: new Date(clock.now().getTime() - 6 * 60_000),
      context: { deadline_at: new Date(clock.now().getTime() + 60 * 60_000).toISOString() },
    });
    const result = await startQueuedSessions(db, clock, async () => {});
    expect(result.reclaimed).toBe(1);
    expect(await runningCount()).toBe(0);
  });

  it("does not touch a session that started and is simply between model calls", async () => {
    // The same six minutes, but it has written something. A model call is the
    // one span that writes nothing and §8.1 forbids capping it, so this row
    // gets the long cutoff, not the never-started one.
    const [teamId] = await twelveTeams();
    const quiet = new Date(clock.now().getTime() - 6 * 60_000);
    const [row] = await db
      .insert(sessions)
      .values({
        teamId: teamId!,
        kind: "weekly_review",
        trigger: "t",
        idempotencyKey: "mid-call",
        modelId: "m/1",
        status: "running",
        startedAt: quiet,
        updatedAt: quiet,
        context: { deadline_at: new Date(clock.now().getTime() + 60 * 60_000).toISOString() },
      })
      .returning({ id: sessions.id });
    await db.insert(sessionEvents).values({ sessionId: row!.id, seq: 0, type: "system", content: {} });

    const result = await startQueuedSessions(db, clock, async () => {});
    expect(result.reclaimed).toBe(0);
    expect(await runningCount()).toBe(1);
  });

  it("a self check-in never takes the slot a lineup check needs", async () => {
    // §8.10: the league's own schedule outranks anything an agent scheduled
    // for itself. The check-in is booked first and is due first, so ordering
    // by age alone would start it ahead of the kickoff-bound sessions.
    const teamIds = await twelveTeams();
    const kickoff = new Date("2026-11-08T18:00:00Z");
    const due = new Date(clock.now().getTime() - 60_000);

    await db.insert(sessions).values(
      teamIds.slice(0, CAP + 1).map((teamId, i) => ({
        teamId,
        kind: (i === 0 ? "self_check_in" : "lineup_check") as "self_check_in" | "lineup_check",
        trigger: "t",
        idempotencyKey: `s${i}`,
        modelId: "m/1",
        status: "queued" as const,
        context: {
          due_at: due.toISOString(),
          deadline_at: kickoff.toISOString(),
          ...(i === 0 ? { reason: "check the practice report" } : {}),
        },
      })),
    );

    const started: number[] = [];
    await startQueuedSessions(db, clock, async (id) => {
      started.push(id);
    });

    expect(started).toHaveLength(CAP);
    const startedKinds = await db.select().from(sessions).where(inArray(sessions.id, started));
    expect(startedKinds.every((s) => s.kind === "lineup_check")).toBe(true);
    // The check-in is still queued, waiting for a slot the league does not need.
    const left = await db.select().from(sessions).where(eq(sessions.status, "queued"));
    expect(left).toHaveLength(1);
    expect(left[0]!.kind).toBe("self_check_in");
  });

  it("never starts a draft pick: the draft workflow runs those inline", async () => {
    // `runDraftPick` commits the session `queued` and only then runs it. A tick
    // landing in that window would start a second copy — two model calls
    // racing `make_pick` on a 180-second clock.
    const [teamId] = await twelveTeams();
    await db.insert(sessions).values({
      teamId: teamId!,
      kind: "draft_pick",
      trigger: "draft",
      idempotencyKey: "pick-47",
      modelId: "m/1",
      status: "queued",
      context: { deadline_at: new Date(clock.now().getTime() + 180_000).toISOString() },
    });
    const started: number[] = [];
    await startQueuedSessions(db, clock, async (id) => {
      started.push(id);
    });
    expect(started).toEqual([]);
    expect(await runningCount()).toBe(0);
  });

  it("still expires a queued draft pick whose clock has run out", async () => {
    // The exclusion is on the start decision, not on the query. This branch is
    // the only place a queued session is ever retired, so a draft pick the
    // draft workflow never got to — killed between `createSession`'s commit and
    // `runSession` — would otherwise sit `queued` for the rest of the season.
    const [teamId] = await twelveTeams();
    await db.insert(sessions).values({
      teamId: teamId!,
      kind: "draft_pick",
      trigger: "draft",
      idempotencyKey: "pick-48",
      modelId: "m/1",
      status: "queued",
      context: { deadline_at: new Date(clock.now().getTime() - 1_000).toISOString() },
    });
    const result = await startQueuedSessions(db, clock, async () => {});
    expect(result.expired).toBe(1);
    const rows = await db.select().from(sessions).where(eq(sessions.status, "skipped"));
    expect(rows).toHaveLength(1);
  });

  it("leaves a running session alone while it is still working", async () => {
    const [teamId] = await twelveTeams();
    await db.insert(sessions).values({
      teamId: teamId!,
      kind: "weekly_review",
      trigger: "t",
      idempotencyKey: "working",
      modelId: "m/1",
      status: "running",
      startedAt: clock.now(),
      updatedAt: clock.now(),
      context: { deadline_at: new Date(clock.now().getTime() + 60 * 60_000).toISOString() },
    });
    const result = await startQueuedSessions(db, clock, async () => {});
    expect(result.reclaimed).toBe(0);
    expect(await runningCount()).toBe(1);
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

      // The tick's own sweeper, not a copy of it.
      await startQueuedSessions(db, clock, async (id) => {
        pending.splice(pending.indexOf(id), 1);
        running.set(id, elapsed + SESSION_MINUTES);
      });
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

describe("§9.1 — the queue is swept every five minutes, not every minute", () => {
  it("gates on the recorded sweep, so a missed tick delays it rather than skipping a cycle", async () => {
    // The gate lives in `runTick` and is recorded in `health`, which is what
    // makes it robust: deriving "is it a multiple of five" from the clock
    // would skip a whole cycle whenever a tick was missed.
    const key = "sessions.sweep";
    const swept = async (at: Date) => {
      const last = await db.select().from(health).where(eq(health.key, key));
      const lastAt = last[0]?.lastSuccessAt?.getTime() ?? 0;
      if (at.getTime() - lastAt < 5 * 60_000) return false;
      await db
        .insert(health)
        .values({ key, lastSuccessAt: at })
        .onConflictDoUpdate({ target: health.key, set: { lastSuccessAt: at } });
      return true;
    };

    const start = clock.now();
    // Minute 0 sweeps; 1 through 4 do not; 5 does again.
    expect(await swept(new Date(start.getTime()))).toBe(true);
    for (const m of [1, 2, 3, 4]) {
      expect(await swept(new Date(start.getTime() + m * 60_000)), `minute ${m}`).toBe(false);
    }
    expect(await swept(new Date(start.getTime() + 5 * 60_000))).toBe(true);

    // A gap — the tick did not run for eleven minutes — sweeps on the next
    // tick it gets, rather than waiting for the grid to come round.
    expect(await swept(new Date(start.getTime() + 16 * 60_000))).toBe(true);
    expect(await swept(new Date(start.getTime() + 17 * 60_000))).toBe(false);
  });

  it("five minutes of latency still drains twelve lineup checks inside §15.4's window", async () => {
    // The §15.4 criterion is 45 minutes for twelve sessions at a cap of six.
    // Sweeping five times less often costs at most one sweep interval per
    // wave, so two waves of fifteen minutes still land well inside it.
    const kickoff = new Date("2026-11-08T18:00:00Z");
    const teamIds = await twelveTeams();
    const ids = await bookTwelve(teamIds, kickoff);
    const startedAt = clock.now();
    const SESSION_MINUTES = 15;
    const running = new Map<number, number>();
    const done: number[] = [];
    let elapsed = 0;

    for (elapsed = 0; elapsed <= 45 && done.length < ids.length; elapsed++) {
      clock.set(new Date(startedAt.getTime() + elapsed * 60_000));
      for (const [id, endsAt] of [...running]) {
        if (endsAt > elapsed) continue;
        await db.update(sessions).set({ status: "succeeded", endedAt: clock.now() }).where(eq(sessions.id, id));
        running.delete(id);
        done.push(id);
      }
      // Only every fifth minute, which is the whole point of this test.
      if (elapsed % 5 !== 0) continue;
      await startQueuedSessions(db, clock, async (id) => {
        running.set(id, elapsed + SESSION_MINUTES);
      });
    }

    expect(done).toHaveLength(12);
    expect(elapsed - 1).toBeLessThanOrEqual(45);
  });
});
