import "server-only";
/**
 * The per-minute scheduler tick (SPEC §9.1). Each tick, in order:
 *  1. claim due scheduled_jobs and start the matching work
 *  2. mark games that kicked off since the last tick live, and apply §7.3
 *  3. poll live scores when any game is live
 *  4. injury changes (handled inside the players ingest)
 *  5. expire stale offers and resolve trades whose review window ended
 */
import { and, eq, lte, sql } from "drizzle-orm";
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
} from "@league/engine";
import { db, leagueClock } from "./db";
import { detectModelOutages, requeueFailedSessions, teamsForModels } from "./retry";
import { sendEmail } from "./alarms";
import { runJob } from "./jobs";

export interface TickSummary {
  claimed: number;
  jobsRun: number;
  jobsFailed: number;
  gamesStarted: number;
  livePolled: boolean;
  offersExpired: number;
  tradesResolved: number;
  sessionsRequeued: number;
  outages: number;
}

/** Jobs claimed per tick. Generous: the queue is small and each job is quick to start. */
const MAX_JOBS_PER_TICK = 20;
const LIVE_POLL_MIN_INTERVAL_MS = 55_000;
const GAME_LENGTH_MS = 4.5 * 3600_000;

export async function runTick(): Promise<TickSummary> {
  const database = db();
  const clock = await leagueClock();
  const now = clock.now();

  const summary: TickSummary = {
    claimed: 0,
    jobsRun: 0,
    jobsFailed: 0,
    gamesStarted: 0,
    livePolled: false,
    offersExpired: 0,
    tradesResolved: 0,
    sessionsRequeued: 0,
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

/** Mark newly kicked-off games live and put their unrostered players on waivers (§7.3). */
async function startKickedOffGames(database: EngineDb, clock: Clock): Promise<number> {
  const settings = await getSettings(database);
  const now = clock.now();
  const started = await database
    .select()
    .from(nflGames)
    .where(
      and(
        eq(nflGames.season, settings.season),
        eq(nflGames.status, "scheduled"),
        lte(nflGames.kickoffAt, now),
      ),
    );
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
  await scoreWeek(database, settings.currentWeek);
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
