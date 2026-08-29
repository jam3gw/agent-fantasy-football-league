import "server-only";
/**
 * The per-minute scheduler tick (SPEC §9.1). Each tick, in order:
 *  1. claim due scheduled_jobs and start the matching work
 *  2. mark games that kicked off since the last tick live, and apply §7.3
 *  3. poll live scores when any game is live
 *  4. injury changes (handled inside the players ingest)
 *  5. expire stale offers and resolve trades whose review window ended
 */
import { and, asc, eq, lte, not, or, sql } from "drizzle-orm";
import { parseDate } from "@league/shared";
import type { Clock } from "@league/shared";
import type { EngineDb } from "@league/engine";
import {
  expireOffers,
  gameStartWaivers,
  getSettings,
  health,
  nflGames,
  resolveEndedReviews,
  scheduledJobs,
  scoreWeek,
  sessionEvents,
  sessions,
} from "@league/engine";
import { db, leagueClock } from "./db";
import { detectModelOutages, requeueFailedSessions, teamsForModels } from "./retry";
import { sendEmail } from "./alarms";
import { runJob } from "./jobs";

export interface TickSummary {
  claimed: number;
  jobsRun: number;
  jobsStarted: number;
  jobsFailed: number;
  jobsReleased: number;
  gamesStarted: number;
  livePolled: boolean;
  offersExpired: number;
  tradesResolved: number;
  sessionsRequeued: number;
  sessionsStarted: number;
  sessionsExpired: number;
  sessionsReclaimed: number;
  /** Whether this tick swept the session queue (§9.1: every five minutes). */
  queueSwept: boolean;
  outages: number;
}

/** Jobs claimed per tick. Generous: the queue is small and each job is quick to start. */
const MAX_JOBS_PER_TICK = 20;
/**
 * Jobs cheap enough to finish inside the tick: they only book rows or start
 * another workflow of their own. Everything else is handed to `jobWorkflow`.
 */
const INLINE_JOB_TYPES = new Set([
  "book_daily_jobs",
  "sessions.book",
  "reporter.run",
  "draft.run",
  "stats.finalize",
]);

/**
 * How long a claimed job may sit before the queue takes it back. The workflow
 * refreshes the claim when it actually begins, so this only reclaims jobs whose
 * workflow never started — not one that is simply taking a while.
 */
const CLAIM_STALE_MS = 30 * 60_000;

/**
 * How long a running session that has written *something* may go quiet before
 * it counts as dead. It has to clear the platform's 800-second step cap plus
 * the workflow runtime's retry backoff: the only span of a live session that
 * writes nothing is a single model call, and §8.1 forbids capping one, so a
 * call that starts just inside the 9-minute step budget can legally run to the
 * 800-second kill and be re-dispatched after a backoff. Fifteen minutes left no
 * margin for the backoff and would have failed live sessions.
 */
const STUCK_SESSION_IDLE_MS = 30 * 60_000;

/**
 * How long a claimed session may hold its slot without writing a single
 * transcript row. A workflow that was actually accepted writes its first row
 * within seconds of starting, so anything past this never started at all —
 * `startRun` threw, or the invocation died between the claim and the workflow.
 * Short, because that slot is doing nothing for anyone.
 */
const NEVER_STARTED_MS = 5 * 60_000;

/** Queued sessions examined per tick. More than the cap, so expiries are seen too. */
const MAX_QUEUED_SESSIONS_PER_TICK = 40;
const LIVE_POLL_MIN_INTERVAL_MS = 55_000;
/**
 * How often the session queue is swept. The tick itself stays per-minute —
 * live scoring (§13.2), game-start waivers (§7.3) and trade-review resolution
 * all need that cadence — but the queue does not: a session's own booking is
 * what decides when it runs, and five minutes of latency is nothing against a
 * lineup check booked ninety minutes before kickoff.
 *
 * Sweeping five times less often also means five times fewer scans of
 * `sessions`, which is the one query the tick repeats forever. Check-in times
 * are rounded to the same five-minute grid (§8.10), so an agent asking for
 * 10:05 is started at 10:05, not up to five minutes later.
 */
const QUEUE_SWEEP_INTERVAL_MS = 5 * 60_000;
const GAME_LENGTH_MS = 4.5 * 3600_000;

export async function runTick(): Promise<TickSummary> {
  const database = db();
  const clock = await leagueClock();
  const now = clock.now();

  const summary: TickSummary = {
    claimed: 0,
    jobsRun: 0,
    jobsStarted: 0,
    jobsFailed: 0,
    jobsReleased: 0,
    gamesStarted: 0,
    livePolled: false,
    offersExpired: 0,
    tradesResolved: 0,
    sessionsRequeued: 0,
    sessionsStarted: 0,
    sessionsExpired: 0,
    sessionsReclaimed: 0,
    queueSwept: false,
    outages: 0,
  };

  // 1. Claim due jobs. SKIP LOCKED means two overlapping ticks never double-run one.
  const claimed = await database.execute(sql`
    update scheduled_jobs
       set status = 'claimed', claimed_at = ${now}
     where id in (
       select id from scheduled_jobs
        where status = 'due' and due_at <= ${now}
        order by due_at
        for update skip locked
        limit ${MAX_JOBS_PER_TICK}
     )
    returning id, type, payload, idempotency_key
  `);
  const rows = (claimed as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? (claimed as unknown as Array<Record<string, unknown>>);
  summary.claimed = rows.length;

  for (const row of rows) {
    const id = Number(row.id);
    const type = String(row.type);
    const payload = (row.payload ?? {}) as Record<string, unknown>;

    // §9.1: heavy jobs are *started*, not run here. The tick has one minute
    // and 800 seconds for everything below as well — a player ingest or a
    // waiver run inside it would starve the live score poll.
    if (!INLINE_JOB_TYPES.has(type)) {
      try {
        const { start } = await import("workflow/api");
        const { jobWorkflow } = await import("../workflows/job");
        await start(jobWorkflow, [id, type, payload]);
        // The row stays `claimed` until the workflow reports its outcome.
        summary.jobsStarted++;
      } catch (err) {
        await database
          .update(scheduledJobs)
          .set({ status: "failed", doneAt: clock.now(), error: `could not start: ${String(err)}` })
          .where(eq(scheduledJobs.id, id));
        summary.jobsFailed++;
      }
      continue;
    }

    try {
      await runJob(database, clock, type, payload);
      await database
        .update(scheduledJobs)
        .set({ status: "done", doneAt: clock.now() })
        .where(eq(scheduledJobs.id, id));
      summary.jobsRun++;
    } catch (err) {
      await database
        .update(scheduledJobs)
        .set({ status: "failed", doneAt: clock.now(), error: String(err) })
        .where(eq(scheduledJobs.id, id));
      summary.jobsFailed++;
    }
  }

  // A job claimed by a tick whose workflow never started would sit `claimed`
  // for good. Put anything stale back in the queue.
  summary.jobsReleased = await releaseStaleClaims(database, clock);

  // 1b. Start the sessions whose turn has come (§9.2's wait-for-slot). This is
  // the only place a session is started. Gated to every five minutes: the
  // interval is kept in `health` rather than derived from the clock, so a
  // missed tick delays the sweep by a minute instead of skipping a whole cycle.
  if (await dueForQueueSweep(database, now)) {
    const swept = await startQueuedSessions(database, clock);
    summary.sessionsStarted = swept.started;
    summary.sessionsExpired = swept.expired;
    summary.sessionsReclaimed = swept.reclaimed;
    summary.queueSwept = true;
  }

  // 2. Games that kicked off since the last tick.
  summary.gamesStarted = await startKickedOffGames(database, clock);

  // 3. Live score poll while any game is live.
  summary.livePolled = await maybePollLiveScores(database, clock);

  // 4b. Re-queue sessions that failed, and notice a provider outage (§8.8).
  const retries = await requeueFailedSessions(database, clock);
  summary.sessionsRequeued = retries.requeued;
  summary.outages = await notifyOutages(database, clock);

  // 5. Offer expiry and trade review resolution.
  const expired = await expireOffers(database, clock);
  if (expired.ok) summary.offersExpired = expired.value.length;
  const resolved = await resolveEndedReviews(database, clock);
  if (resolved.ok) summary.tradesResolved = resolved.value.length;

  await database
    .insert(health)
    .values({ key: "cron.tick", lastSuccessAt: clock.now() })
    .onConflictDoUpdate({ target: health.key, set: { lastSuccessAt: clock.now() } });

  return summary;
}

/**
 * Is this the tick that sweeps the queue? Records the sweep in `health` under
 * `sessions.sweep`, which also puts the last sweep on /admin/health next to
 * every other feed.
 */
async function dueForQueueSweep(database: EngineDb, now: Date): Promise<boolean> {
  const last = await database.select().from(health).where(eq(health.key, "sessions.sweep"));
  const lastAt = last[0]?.lastSuccessAt?.getTime() ?? 0;
  if (now.getTime() - lastAt < QUEUE_SWEEP_INTERVAL_MS) return false;
  await database
    .insert(health)
    .values({ key: "sessions.sweep", lastSuccessAt: now })
    .onConflictDoUpdate({ target: health.key, set: { lastSuccessAt: now } });
  return true;
}

/** Return jobs whose claiming tick died before their workflow started. */
async function releaseStaleClaims(database: EngineDb, clock: Clock): Promise<number> {
  const cutoff = new Date(clock.now().getTime() - CLAIM_STALE_MS);
  const rows = await database
    .update(scheduledJobs)
    .set({ status: "due", claimedAt: null })
    .where(and(eq(scheduledJobs.status, "claimed"), lte(scheduledJobs.claimedAt, cutoff)))
    .returning({ id: scheduledJobs.id });
  return rows.length;
}

/**
 * Start queued sessions whose turn has come, and clean up the ones that cannot
 * run any more (§8.3, §9.2). This is the *only* thing that starts a session:
 * a second starter meant the same session ran twice, in parallel.
 *
 * Three things happen here, in order of urgency:
 *  - a session past its deadline is skipped rather than run late (a lineup
 *    check after kickoff cannot change anything);
 *  - a session whose turn has come takes a slot and is handed to its workflow;
 *  - a session left `running` by an invocation that died is failed, so its slot
 *    comes back and `requeueFailedSessions` can retry it. Without this one leak
 *    holds a slot — and blocks that team entirely — for the rest of the season.
 */
export async function startQueuedSessions(
  database: EngineDb,
  clock: Clock,
  /** Hand a claimed session to its durable run. Overridden in tests. */
  startRun: (sessionId: number) => Promise<void> = startAgentSessionWorkflow,
): Promise<{ started: number; expired: number; reclaimed: number }> {
  const now = clock.now();
  const reclaimed = await reclaimStuckSessions(database, clock);

  const queued = await database
    .select({ id: sessions.id, teamId: sessions.teamId, kind: sessions.kind, context: sessions.context })
    .from(sessions)
    .where(eq(sessions.status, "queued"))
    .orderBy(asc(sessions.createdAt))
    .limit(MAX_QUEUED_SESSIONS_PER_TICK);

  // §8.10: a check-in the agent booked itself goes last, always. It must never
  // take the slot a lineup check needs before kickoff — the league's own
  // schedule outranks anything an agent scheduled for itself.
  queued.sort((a, b) => Number(a.kind === "self_check_in") - Number(b.kind === "self_check_in"));

  const { claimSlot } = await import("./runSession");
  let started = 0;
  let expired = 0;
  for (const session of queued) {
    // Expiry applies to every kind, including the ones this tick never starts:
    // this is the only place a queued session is ever retired, so excluding a
    // kind from the *query* would leave its orphans queued for the season.
    const deadlineAt = parseDate(session.context.deadline_at);
    if (deadlineAt && now >= deadlineAt) {
      const rows = await database
        .update(sessions)
        .set({ status: "skipped", endedBy: "deadline", endedAt: now, updatedAt: now })
        .where(and(eq(sessions.id, session.id), eq(sessions.status, "queued")))
        .returning({ id: sessions.id });
      if (rows.length > 0) expired++;
      continue;
    }

    // Draft picks are never started here: the draft workflow creates each one
    // and runs it inline against the 180-second clock (§10.2). It commits the
    // row `queued` and only then starts it, so a tick landing in that window
    // would otherwise claim it and run a second copy — two model calls racing
    // `make_pick`, and whichever loses ends without a pick and gets
    // auto-picked. They still reach the expiry branch above, which is what
    // retires the ones the draft never got to.
    if (session.kind === "draft_pick") continue;

    // Bookings are staggered a minute apart (§9.1); a session is not due yet.
    const dueAt = parseDate(session.context.due_at);
    if (dueAt && now < dueAt) continue;

    const outcome = await claimSlot(database, session.id, session.teamId, now);
    // The league is full: everything else waits too, so stop here.
    if (outcome === "at_capacity") break;
    // This team is already running something, or another tick took the row.
    // Neither says anything about the next session in the list.
    if (outcome !== "claimed") continue;

    // The slot is taken; hand the session to its durable run.
    try {
      await startRun(session.id);
      started++;
    } catch {
      // The row stays `running`. `start` can throw *after* the workflow was
      // accepted — a timeout reading the response — and putting the row back
      // in the queue would then give it a second runner alongside the live
      // one. `reclaimStuckSessions`' never-started cutoff returns the slot in
      // `NEVER_STARTED_MS` if nothing ever ran, which also stops a systematic
      // start outage from burning one slot per tick until the long cutoff.
      break;
    }
  }
  return { started, expired, reclaimed };
}

async function startAgentSessionWorkflow(sessionId: number): Promise<void> {
  const { start } = await import("workflow/api");
  const { agentSessionWorkflow } = await import("../workflows/agentSession");
  await start(agentSessionWorkflow, [sessionId]);
}

/**
 * Fail sessions left `running` by an invocation that died — a function kill
 * between the slot claim and the workflow start, a `start` that threw, or a
 * crash while building the context snapshot.
 *
 * Idleness is the test, not the deadline: a session running its closing step is
 * past its deadline by definition (§8.2 step 5), and a turn spent on free tool
 * calls writes no ledger row, so the deadline says nothing about liveness.
 * Keeping it out also means `requeueFailedSessions` can still retry the session
 * inside its window (§8.8), which is the point of failing it rather than
 * skipping it.
 *
 * Two cutoffs, because "never started" and "stopped writing" are different
 * failures with very different costs:
 *
 *  - A row claimed by `claimSlot` that has no transcript row at all after a few
 *    minutes was never picked up by a workflow. Its slot is doing nothing for
 *    anyone, and a short cutoff is safe: a workflow that *was* accepted writes
 *    its first row (the system prompt, or `resumed`) within seconds of starting.
 *    This is what returns the slot when `startRun` throws.
 *  - A row that has written something and then gone quiet gets the long cutoff.
 *    It has to clear the platform's 800-second step cap plus the runtime's
 *    retry backoff, because the one span that writes nothing is a model call,
 *    and §8.1 forbids capping one.
 */
async function reclaimStuckSessions(database: EngineDb, clock: Clock): Promise<number> {
  const now = clock.now();
  const idleCutoff = new Date(now.getTime() - STUCK_SESSION_IDLE_MS);
  const silentCutoff = new Date(now.getTime() - NEVER_STARTED_MS);
  const hasTranscript = sql`exists (select 1 from ${sessionEvents} where ${sessionEvents.sessionId} = ${sessions.id})`;

  const rows = await database
    .update(sessions)
    .set({ status: "failed", error: "abandoned: no progress", endedAt: now, updatedAt: now })
    .where(
      and(
        eq(sessions.status, "running"),
        or(
          lte(sessions.updatedAt, idleCutoff),
          and(lte(sessions.updatedAt, silentCutoff), not(hasTranscript)),
        ),
      ),
    )
    .returning({ id: sessions.id });
  return rows.length;
}

/** Mark newly kicked-off games live and put their unrostered players on waivers (§7.3). */
async function startKickedOffGames(database: EngineDb, clock: Clock): Promise<number> {
  const settings = await getSettings(database);
  const now = clock.now();
  // Only the current week and the one before it. §7.3's waiver window runs to
  // the next Wednesday, so replaying a game from four weeks ago would push
  // every unrostered player on those rosters onto waivers now — which is what
  // an outage long enough to leave whole weeks unmarked would otherwise do.
  const started = (
    await database
      .select()
      .from(nflGames)
      .where(
        and(
          eq(nflGames.season, settings.season),
          eq(nflGames.status, "scheduled"),
          lte(nflGames.kickoffAt, now),
        ),
      )
  ).filter((g) => g.week >= settings.currentWeek - 1);
  for (const game of started) {
    await database.update(nflGames).set({ status: "live", updatedAt: now }).where(eq(nflGames.gameId, game.gameId));
    await gameStartWaivers(database, clock, game.gameId);
  }
  return started.length;
}

/**
 * Poll live scores at most once a minute while a game is live (§13.2). The
 * fetch itself lives in the ingest job so the degradation ladder stays in one
 * place; here we only decide whether to run it and recompute matchup points.
 */
async function maybePollLiveScores(database: EngineDb, clock: Clock): Promise<boolean> {
  const settings = await getSettings(database);
  const now = clock.now();
  const live = await database
    .select()
    .from(nflGames)
    .where(and(eq(nflGames.season, settings.season), eq(nflGames.status, "live")));
  if (live.length === 0) return false;

  // Any game past its window is final by elapsed time (§13.2).
  for (const game of live) {
    if (now.getTime() - game.kickoffAt.getTime() > GAME_LENGTH_MS) {
      await database
        .update(nflGames)
        .set({ status: "final", updatedAt: now })
        .where(eq(nflGames.gameId, game.gameId));
    }
  }

  const last = await database.select().from(health).where(eq(health.key, "live.poll"));
  const lastAt = last[0]?.lastSuccessAt?.getTime() ?? 0;
  if (now.getTime() - lastAt < LIVE_POLL_MIN_INTERVAL_MS) return false;

  await runJob(database, clock, "ingest.stats", { live: true });
  await scoreWeek(database, clock, settings.currentWeek);
  await database
    .insert(health)
    .values({ key: "live.poll", lastSuccessAt: now })
    .onConflictDoUpdate({ target: health.key, set: { lastSuccessAt: now } });
  return true;
}

/**
 * §8.8: three failures in a row for one model means the provider is likely
 * down. Show it on the health page (the sessions themselves are the record)
 * and email the commissioner once per model per day.
 */
async function notifyOutages(database: EngineDb, clock: Clock): Promise<number> {
  const outages = await detectModelOutages(database, clock);
  if (outages.length === 0) return 0;
  const names = await teamsForModels(
    database,
    outages.map((o) => o.modelId),
  );
  const today = clock.now().toISOString().slice(0, 10);
  for (const outage of outages) {
    const key = `outage:${outage.modelId}:${today}`;
    const already = await database.select().from(health).where(eq(health.key, key));
    if (already.length > 0) continue; // one email per model per day
    await database.insert(health).values({
      key,
      lastError: `${outage.consecutiveFailures} sessions in a row failed for ${outage.modelId}`,
      lastErrorAt: clock.now(),
    });
    await sendEmail(
      `[League] ${outage.modelId} looks down`,
      `<p><strong>${outage.consecutiveFailures}</strong> sessions in a row have failed for <code>${outage.modelId}</code>` +
        ` (${(names.get(outage.modelId) ?? []).join(", ") || "no team"}).</p>` +
        `<p>Check the provider, then swap the model on /admin/teams if it stays down. Nothing is paused automatically.</p>`,
    );
  }
  return outages.length;
}
