import "server-only";
/**
 * The per-minute scheduler tick (SPEC §9.1). Each tick, in order:
 *  1. claim due scheduled_jobs and start the matching work
 *  2. mark games that kicked off since the last tick live, and apply §7.3
 *  3. poll live scores when any game is live
 *  4. injury changes (handled inside the players ingest)
 *  5. expire stale offers and resolve trades whose review window ended
 */
import { and, asc, eq, lte, sql } from "drizzle-orm";
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
  "session.run",
  "draft.run",
  "stats.finalize",
]);

/** How long a claimed job may sit before the queue takes it back. */
const CLAIM_STALE_MS = 15 * 60_000;

/** Queued sessions examined per tick. More than the cap, so expiries are seen too. */
const MAX_QUEUED_SESSIONS_PER_TICK = 40;
const LIVE_POLL_MIN_INTERVAL_MS = 55_000;
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

  // 1b. Sessions still waiting for one of the six slots (§9.2's wait-for-slot).
  // A session whose job already ran but that lost the concurrency race is left
  // `queued`; without this it would wait forever, because the job row is
  // already `done`.
  const swept = await startQueuedSessions(database, clock);
  summary.sessionsStarted = swept.started;
  summary.sessionsExpired = swept.expired;

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
 * Start queued sessions whose turn has come, oldest first, and expire the ones
 * whose deadline passed while they waited (§8.3, §9.2).
 *
 * The slot claim itself is atomic, so this can stop as soon as one session
 * fails to get a slot: the league is at its cap and the rest wait a minute.
 * A session that has no team never blocks on the per-team rule, so it is only
 * the cap that can stop us — hence the plain loop rather than a per-team scan.
 */
async function startQueuedSessions(
  database: EngineDb,
  clock: Clock,
): Promise<{ started: number; expired: number }> {
  const now = clock.now();
  const queued = await database
    .select({ id: sessions.id, teamId: sessions.teamId, context: sessions.context })
    .from(sessions)
    .where(eq(sessions.status, "queued"))
    .orderBy(asc(sessions.createdAt))
    .limit(MAX_QUEUED_SESSIONS_PER_TICK);

  let started = 0;
  let expired = 0;
  for (const session of queued) {
    const raw = session.context.deadline_at;
    const deadlineAt = typeof raw === "string" ? new Date(raw) : null;
    if (deadlineAt && !Number.isNaN(deadlineAt.getTime()) && now >= deadlineAt) {
      // §8.3: a session that never got a slot before its deadline is skipped,
      // not run late — a lineup check after kickoff cannot change anything.
      const rows = await database
        .update(sessions)
        .set({ status: "skipped", endedBy: "deadline", endedAt: now, updatedAt: now })
        .where(and(eq(sessions.id, session.id), eq(sessions.status, "queued")))
        .returning({ id: sessions.id });
      if (rows.length > 0) expired++;
      continue;
    }

    const { claimSlot } = await import("./runSession");
    if (!(await claimSlot(database, session.id, session.teamId))) break; // at the cap

    // The slot is taken; hand the session to its durable run. Release the slot
    // again if the workflow cannot even be started, so one bad start does not
    // hold a slot until the deadline.
    try {
      const { start } = await import("workflow/api");
      const { agentSessionWorkflow } = await import("../workflows/agentSession");
      await start(agentSessionWorkflow, [session.id]);
      started++;
    } catch {
      await database
        .update(sessions)
        .set({ status: "queued", startedAt: null, updatedAt: clock.now() })
        .where(and(eq(sessions.id, session.id), eq(sessions.status, "running")));
      break;
    }
  }
  return { started, expired };
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
