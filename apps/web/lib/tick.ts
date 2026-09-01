import "server-only";
/**
 * The per-minute scheduler tick (SPEC §9.1). Each tick, in order:
 *  1. claim due scheduled_jobs and start the matching work
 *  2. mark games that kicked off since the last tick live, and apply §7.3
 *  3. poll live scores when any game is live
 *  4. injury changes (handled inside the players ingest)
 *  5. expire stale offers and resolve trades whose review window ended
 */
import { and, asc, desc, eq, inArray, lte, not, or, sql } from "drizzle-orm";
import { formatEt, parseDate } from "@league/shared";
import type { Clock } from "@league/shared";
import type { EngineDb } from "@league/engine";
import {
  draft,
  expireAllProposedAtDeadline,
  expireOffers,
  gameStartWaivers,
  getSettings,
  health,
  nflGames,
  resolveEndedReviews,
  scheduledJobs,
  scoreWeek,
  sessionEvents,
  sessionStream,
  sessions,
  teams,
  tstz,
  weekGamesComplete,
} from "@league/engine";
import { db, leagueClock } from "./db";
import { detectModelOutages, requeueFailedSessions, teamsForModels } from "./retry";
import { notifyOnce } from "./alarms";
import { CAPACITY_CHECK_INTERVAL_MS, checkDbSize, checkGatewayCredits } from "./capacity";
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
  /** Whether this tick had to book the first `book_daily_jobs` (§9.1). */
  queuePrimed: boolean;
  /** Whether the season is stalled on a finalization that never happened. */
  stalled: boolean;
  /** Whether a draft whose clock had died was re-booked. */
  draftRestarted: boolean;
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
/**
 * How long a session that carries *no* deadline may sit queued before it is
 * retired. A week's worth of thinking is worthless a week late, and without
 * this a team paused for the rest of the season would keep a growing pile of
 * queued sessions that all fired the moment it was unpaused. Sessions with a
 * deadline are retired by that deadline instead; this never touches them.
 */
const STALE_QUEUED_MS = 7 * 24 * 3600_000;
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
    queuePrimed: false,
    stalled: false,
    draftRestarted: false,
    outages: 0,
  };

  // 0. Prime the queue. Every recurring job is booked by `book_daily_jobs`,
  // and `book_daily_jobs` books the next one — but nothing booked the *first*
  // one, so on a fresh database the queue stayed empty for ever: no ingest, no
  // sessions, no season, and no error anywhere to say why. This is idempotent
  // and self-healing: it does nothing on any tick where the queue is primed,
  // and recovers one that has somehow drained.
  summary.queuePrimed = await primeJobQueue(database, clock);

  // 1. Claim due jobs. SKIP LOCKED means two overlapping ticks never double-run one.
  // `tstz(now)` rather than `now`: a raw sql template has no column type to
  // serialize against, and postgres-js throws on a bare Date (see db/sqlTime).
  const claimed = await database.execute(sql`
    update scheduled_jobs
       set status = 'claimed', claimed_at = ${tstz(now)}
     where id in (
       select id from scheduled_jobs
        where status = 'due' and due_at <= ${tstz(now)}
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
    await stage(database, clock, "sessions.sweep", async () => {
      const swept = await startQueuedSessions(database, clock);
      summary.sessionsStarted = swept.started;
      summary.sessionsExpired = swept.expired;
      summary.sessionsReclaimed = swept.reclaimed;
    });
    summary.queueSwept = true;
  }

  // 2. Games that kicked off since the last tick.
  await stage(database, clock, "tick.games", async () => {
    summary.gamesStarted = await startKickedOffGames(database, clock);
  });

  // 3. Live score poll while any game is live.
  await stage(database, clock, "tick.live_scores", async () => {
    summary.livePolled = await maybePollLiveScores(database, clock);
  });

  // 4b. Re-queue sessions that failed, and notice a provider outage (§8.8).
  await stage(database, clock, "tick.retries", async () => {
    const retries = await requeueFailedSessions(database, clock);
    summary.sessionsRequeued = retries.requeued;
    summary.outages = await notifyOutages(database, clock);
  });

  // 5. Offer expiry and trade review resolution. A trade whose 24-hour window
  // ended has to execute on time; it must not be skipped because Sleeper was
  // down two stages earlier.
  await stage(database, clock, "tick.trades", async () => {
    const expired = await expireOffers(database, clock);
    if (expired.ok) summary.offersExpired = expired.value.length;
    const resolved = await resolveEndedReviews(database, clock);
    if (resolved.ok) summary.tradesResolved = resolved.value.length;
    summary.offersExpired += await sweepDeadlineOffers(database, clock);
  });

  // 6. The season-stall watchdog (§13.4). A finalization that fails every
  // retry stops the season dead and silently, so it gets its own check.
  await stage(database, clock, "tick.stall_watchdog", async () => {
    summary.stalled = await checkFinalizationStall(database, clock);
    summary.draftRestarted = await restartStalledDraft(database, clock);
  });

  // 7. Capacity watchdogs, hourly: database size and gateway credit. Both are
  // silent and league-wide when exhausted — §17 warns that a full database
  // fails writes while the admin pages render calm and empty, and a $0
  // gateway balance fails every session for every team at once. Gated like
  // the queue sweep: the stamp is pre-written, so a check that throws retries
  // on the next hourly turn instead of sixty times an hour.
  if (await dueForCapacityCheck(database, now)) {
    await stage(database, clock, "tick.capacity", async () => {
      await checkDbSize(database, clock);
      await checkGatewayCredits(database, clock);
    });
  }

  // The heartbeat, last and unconditional. /admin/health's red "the scheduler
  // has never run" banner keys on this row and on nothing else, so a tick that
  // did its work and forgot to stamp it would leave the page shouting that the
  // league is dead while it runs perfectly — which is exactly what happened
  // when the stage refactor dropped this write. Every stage above catches its
  // own failure, so reaching here means the tick completed, whatever any one
  // stage made of its own job.
  await database
    .insert(health)
    .values({ key: "cron.tick", lastSuccessAt: clock.now() })
    .onConflictDoUpdate({ target: health.key, set: { lastSuccessAt: clock.now() } });

  return summary;
}

/**
 * Re-book `draft.run` when the draft is `running` but its clock has been dead
 * for a while (§10.2).
 *
 * `draftWorkflow` returns cleanly on a pause or on completion, but a run that
 * dies any other way was never restarted: `draft.run` is booked only by the
 * commissioner pressing a button, and nothing said the draft had stopped. The
 * emergency auto-pick does not help either — the flag is only read inside the
 * live pick loop, so a dead draft ignores it. Restarting is safe: the workflow
 * resumes from `current_pick`, and `claimPickSession` refuses to start a second
 * session for a pick that already has a live one.
 */
const DRAFT_STALL_MS = 3 * 60_000;

async function restartStalledDraft(database: EngineDb, clock: Clock): Promise<boolean> {
  const now = clock.now();
  const rows = await database
    .select({ status: draft.status, clockEndsAt: draft.clockEndsAt })
    .from(draft)
    .where(eq(draft.id, 1));
  const row = rows[0];
  if (!row || row.status !== "running") return false;
  if (!row.clockEndsAt || now.getTime() - row.clockEndsAt.getTime() < DRAFT_STALL_MS) return false;

  // Idempotent per minute, so a draft that is slow to come back is not booked
  // sixty times while it starts.
  const bucket = Math.floor(now.getTime() / 60_000);
  const inserted = await database
    .insert(scheduledJobs)
    .values({
      type: "draft.run",
      dueAt: now,
      payload: { reason: "the draft clock has been dead for minutes" },
      idempotencyKey: `job:draft.run:restart:${bucket}`,
    })
    .onConflictDoNothing({ target: scheduledJobs.idempotencyKey })
    .returning({ id: scheduledJobs.id });
  if (inserted.length === 0) return false;

  const message = `the draft clock ended ${formatEt(row.clockEndsAt)} and nothing has moved since; re-booking draft.run`;
  await database
    .insert(health)
    .values({ key: "draft.run", lastError: message, lastErrorAt: now })
    .onConflictDoUpdate({ target: health.key, set: { lastError: message, lastErrorAt: now } });
  return true;
}

/**
 * §3.5: once the trade deadline has passed, no offer may still be open. The
 * sweep existed and had no caller, so for up to `trade_offer_expiry_hours`
 * after the deadline dead offers stayed `proposed` — visible on /trades, in
 * `get_pending_trades`, and acceptable by an agent, which then got a confusing
 * `deadline_passed` failure instead of finding the offer already gone.
 *
 * Runs once, on the first tick after the deadline week ends.
 */
async function sweepDeadlineOffers(database: EngineDb, clock: Clock): Promise<number> {
  const settings = await getSettings(database);
  if (settings.currentWeek <= settings.tradeDeadlineWeek) return 0;
  const key = `trades.deadline_sweep:${settings.season}`;
  const done = await database.select({ key: health.key }).from(health).where(eq(health.key, key));
  if (done.length > 0) return 0;

  const result = await expireAllProposedAtDeadline(database, clock);
  await database
    .insert(health)
    .values({ key, lastSuccessAt: clock.now() })
    .onConflictDoNothing({ target: health.key });
  return result.ok ? result.value.length : 0;
}

/**
 * Run one stage of the tick. A stage that throws is recorded to `health` under
 * its own key and the tick carries on: before this, a Sleeper outage during
 * the live-score poll threw out of `runTick` and took trade resolution, offer
 * expiry and the outage notifier with it for as long as Sleeper was down.
 */
async function stage(database: EngineDb, clock: Clock, key: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    await database
      .insert(health)
      .values({ key, lastSuccessAt: clock.now() })
      .onConflictDoUpdate({ target: health.key, set: { lastSuccessAt: clock.now() } });
  } catch (err) {
    const at = clock.now();
    await database
      .insert(health)
      .values({ key, lastError: String(err).slice(0, 500), lastErrorAt: at })
      .onConflictDoUpdate({ target: health.key, set: { lastError: String(err).slice(0, 500), lastErrorAt: at } })
      .catch(() => undefined);
  }
}

/**
 * Notice a week that never advanced (§13.4, §9.1). `stats.finalize` starts
 * `finalizeWeekWorkflow` and that workflow owns the job row, so a total
 * failure shows up as a `failed` job — but nothing was *watching* for it, and
 * the consequences are entirely silent: `current_week` stays put, so the next
 * week is never planned, lineups are never carried over, and Tuesday's
 * `sessions.book` computes the same idempotency keys as last week and creates
 * nothing at all. The league keeps looking alive while every team fields the
 * lineup it had and the standings stop moving.
 *
 * The check: a `stats.finalize` booked for the week the league is *still* in,
 * due more than `FINALIZE_GRACE_MS` ago. That can only mean the week did not
 * advance. Records the error under `stats.finalize` (which /admin/health
 * banners), re-books the finalization so it retries within the hour, and
 * emails once a day.
 */
const FINALIZE_GRACE_MS = 3 * 3600_000;
const FINALIZE_RETRY_MS = 30 * 60_000;

export async function checkFinalizationStall(database: EngineDb, clock: Clock): Promise<boolean> {
  const settings = await getSettings(database);
  if (!["regular", "playoffs"].includes(settings.phase)) return false;

  const now = clock.now();
  const cutoff = new Date(now.getTime() - FINALIZE_GRACE_MS);
  const overdue = await database
    .select({ id: scheduledJobs.id, dueAt: scheduledJobs.dueAt, status: scheduledJobs.status, payload: scheduledJobs.payload })
    .from(scheduledJobs)
    .where(and(eq(scheduledJobs.type, "stats.finalize"), lte(scheduledJobs.dueAt, cutoff)))
    .orderBy(desc(scheduledJobs.dueAt))
    .limit(1);

  const job = overdue[0];
  if (!job) return false;
  const bookedWeek = Number((job.payload as { week?: unknown }).week ?? 0);
  // The week advanced past the one this finalization was for: all is well.
  if (!bookedWeek || settings.currentWeek > bookedWeek) return false;

  // A week whose games have not been played yet is deferred, not stalled:
  // finalization is refusing to run early, exactly as it should, and
  // re-booking it here would only produce more deferrals (or, before the
  // guard existed, re-finalize an unplayed week every half hour). The
  // no-games-recorded case stays: that is a missing schedule, which is a
  // genuine stall to raise.
  const completion = await weekGamesComplete(database, clock, bookedWeek);
  if (!completion.complete && completion.reason === "games_pending") return false;
  // A job that came due before the week's games ended was correctly deferred,
  // not stalled — the operative finalization is the one booked for the first
  // Tuesday after the games, and it is not late yet. Without this, the
  // deferred job goes "overdue" the moment the week completes, and the
  // watchdog would re-book — and run — finalization hours before the fixed
  // Tuesday 4:00 AM ET, cutting off the overnight stat corrections.
  if (completion.complete && completion.lastGameEndsAt && job.dueAt.getTime() < completion.lastGameEndsAt.getTime()) {
    return false;
  }

  const hoursLate = Math.floor((now.getTime() - job.dueAt.getTime()) / 3600_000);
  const message =
    `week ${bookedWeek} has not finalized ${hoursLate}h after its scheduled time ` +
    `(job ${job.id} is ${job.status}). The season cannot advance: no week plan, no lineup ` +
    `carry-over, and no weekly reviews until it does.`;

  await database
    .insert(health)
    .values({ key: "stats.finalize", lastError: message, lastErrorAt: now })
    .onConflictDoUpdate({ target: health.key, set: { lastError: message, lastErrorAt: now } });

  // Re-book it rather than waiting a week for the next Tuesday. Idempotent per
  // half-hour bucket, so this retries about twice an hour until it works.
  const bucket = Math.floor(now.getTime() / FINALIZE_RETRY_MS);
  await database
    .insert(scheduledJobs)
    .values({
      type: "stats.finalize",
      dueAt: now,
      payload: { week: bookedWeek, reason: "stall retry" },
      idempotencyKey: `job:stats.finalize:retry:${bookedWeek}:${bucket}`,
    })
    .onConflictDoNothing({ target: scheduledJobs.idempotencyKey });

  await notifyOnce(database, clock, `stall:${bookedWeek}`, `[League] Week ${bookedWeek} has not finalized`, `<p>${message}</p>`);
  return true;
}

/**
 * Make sure the recurring-job chain is running. `book_daily_jobs` re-books
 * every recurring job for the next 48 hours and re-books itself, so the chain
 * sustains itself once started — it just was never started.
 */
async function primeJobQueue(database: EngineDb, clock: Clock): Promise<boolean> {
  const pending = await database
    .select({ id: scheduledJobs.id })
    .from(scheduledJobs)
    .where(and(eq(scheduledJobs.type, "book_daily_jobs"), inArray(scheduledJobs.status, ["due", "claimed"])))
    .limit(1);
  if (pending.length > 0) return false;

  const now = clock.now();
  await database
    .insert(scheduledJobs)
    .values({
      type: "book_daily_jobs",
      dueAt: now,
      payload: { reason: "queue was empty" },
      idempotencyKey: `job:book_daily_jobs:prime:${now.toISOString().slice(0, 13)}`,
    })
    .onConflictDoNothing({ target: scheduledJobs.idempotencyKey });
  return true;
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

/**
 * Is this the tick that runs the capacity watchdogs? Same shape as the queue
 * sweep's gate: the interval lives in `health` under the stage's own key, and
 * the stamp is written *before* the checks run, so a check that throws is
 * retried on the next hourly turn rather than every minute.
 */
export async function dueForCapacityCheck(database: EngineDb, now: Date): Promise<boolean> {
  const last = await database.select().from(health).where(eq(health.key, "tick.capacity"));
  const lastAt = last[0]?.lastSuccessAt?.getTime() ?? 0;
  if (now.getTime() - lastAt < CAPACITY_CHECK_INTERVAL_MS) return false;
  await database
    .insert(health)
    .values({ key: "tick.capacity", lastSuccessAt: now })
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

  // Ordered by when each session's turn comes, not by when it was booked:
  // `week.plan` books the whole week's lineup checks in one instant — more
  // rows than this page — and ordering by `created_at` put that far-future
  // pile ahead of everything booked after it, so a board reply due *now* was
  // never even examined until the pile drained weeks later. Due time also
  // serves the retirement branches below: a session past its deadline is past
  // its due time too, so it sorts to the front rather than falling off the
  // page, and a session with neither field coalesces to `created_at`. (A
  // deadline-less session with a future `due_at` waits for its due time
  // before the stale check sees it, which only ever retires it later, never
  // runs it earlier.)
  //
  // The validity guard mirrors `parseDate`'s leniency: `due_at` is only ever
  // written by `createSession` via `toISOString()`, but a cast that throws on
  // one malformed row would fail this query — and with it every sweep, for
  // every team, forever, with no way for the sweep to retire the poisoned
  // row. A value that fails the guard sorts by `created_at` instead, exactly
  // as `parseDate` returning null treats it on the JS side.
  // `pg_input_is_valid` is PG16+; production is on 18, and PGlite (tests)
  // carries it too.
  const dueAtOrder = sql`coalesce(
    case when pg_input_is_valid(${sessions.context} ->> 'due_at', 'timestamptz')
         then (${sessions.context} ->> 'due_at')::timestamptz end,
    ${sessions.createdAt})`;
  const queued = await database
    .select({
      id: sessions.id,
      teamId: sessions.teamId,
      kind: sessions.kind,
      context: sessions.context,
      createdAt: sessions.createdAt,
    })
    .from(sessions)
    .where(eq(sessions.status, "queued"))
    .orderBy(dueAtOrder, asc(sessions.createdAt))
    .limit(MAX_QUEUED_SESSIONS_PER_TICK);

  // §4.3: a paused team runs nothing. Pausing was enforced only where sessions
  // are *booked*, so a team paused mid-week still ran everything already in the
  // queue — up to four lineup checks booked on Tuesday and three check-ins the
  // agent booked up to a fortnight out. That made the pause button, which is
  // also the commissioner's only spend brake, quietly not do what it says.
  const pausedTeams = new Set(
    (await database.select({ id: teams.id }).from(teams).where(eq(teams.paused, true))).map((t) => t.id),
  );

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
    // A session that carries a deadline is retired by that deadline and by
    // nothing else. `STALE_QUEUED_MS` is only for the kinds that have none —
    // a weekly review or a post-waivers session for a team that has been
    // paused for weeks — which would otherwise sit queued for the season and
    // all fire at once on the unpause.
    const staleAt = deadlineAt ? null : new Date(session.createdAt.getTime() + STALE_QUEUED_MS);
    if ((deadlineAt && now >= deadlineAt) || (staleAt && now >= staleAt)) {
      const rows = await database
        .update(sessions)
        .set({ status: "skipped", endedBy: "deadline", endedAt: now, updatedAt: now })
        .where(and(eq(sessions.id, session.id), eq(sessions.status, "queued")))
        .returning({ id: sessions.id });
      if (rows.length > 0) expired++;
      continue;
    }

    // A pause holds a session; it does not cancel it. Anything time-sensitive
    // expires on its own deadline in the branch above, and everything else
    // runs when the team is unpaused, which is what a commissioner pausing a
    // team for a day actually wants. `STALE_QUEUED_MS` stops a team paused for
    // the season from accumulating sessions for ever.
    if (session.teamId !== null && pausedTeams.has(session.teamId)) continue;

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
  // A reclaimed session's invocation died without cleaning up; whatever it was
  // mid-thinking when it went quiet must not sit in `session_stream` forever.
  if (rows.length > 0) {
    await database.delete(sessionStream).where(inArray(sessionStream.sessionId, rows.map((r) => r.id)));
  }
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
  for (const outage of outages) {
    // One email per model per ET day. `notifyOnce` records whether the send
    // actually left, so a day consumed by a *failed* send is visible on
    // /admin/health rather than looking like a day with no outage.
    await notifyOnce(
      database,
      clock,
      `outage:${outage.modelId}`,
      `[League] ${outage.modelId} looks down`,
      `<p><strong>${outage.consecutiveFailures}</strong> sessions in a row have failed for <code>${outage.modelId}</code>` +
        ` (${(names.get(outage.modelId) ?? []).join(", ") || "no team"}).</p>` +
        `<p>Check the provider, then swap the model on /admin/teams if it stays down. Nothing is paused automatically.</p>`,
      `${outage.consecutiveFailures} sessions in a row failed for ${outage.modelId}`,
    );
  }
  return outages.length;
}
