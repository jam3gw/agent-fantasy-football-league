import "server-only";
/**
 * Job dispatch and the recurring job table (SPEC §9.1).
 *
 * Booking is idempotent through `scheduled_jobs.idempotency_key`, so a missed
 * tick never loses a schedule and `book_daily_jobs` can re-book freely.
 */
import { eq } from "drizzle-orm";
import type { Clock } from "@league/shared";
import { etDay, jobKey, nextEtTime, nextEtWeekdayTime, sessionKey, zonedTimeToUtc } from "@league/shared";
import type { EngineDb } from "@league/engine";
import {
  carryOverLineups,
  createSession,
  getSettings,
  runWaivers,
  scheduledJobs,
  teams,
} from "@league/engine";
import {
  fetchAllPlayers,
  fetchSeasonStats,
  fetchSchedule,
  fetchTrendingAdds,
  fetchWeekProjections,
  fetchWeekStats,
  parseGames,
  upsertGames,
  upsertPlayers,
  upsertProjections,
  upsertTrending,
  upsertWeekStats,
} from "@league/data";
import { reporterModelId } from "@league/engine";
import { env } from "./env";

/**
 * §4.3 job gating: `waivers.run`, every `sessions.*` job, the `reporter.*`
 * jobs and lineup-check booking run only once the season is under way. Ingest
 * jobs and `stats.finalize` always run.
 */
function inSeason(settings: { phase: string; currentWeek: number; startWeek: number }): boolean {
  return ["regular", "playoffs"].includes(settings.phase) && settings.currentWeek >= settings.startWeek;
}

/** Book a job unless its idempotency key already exists. */
export async function bookJob(
  db: EngineDb,
  type: string,
  dueAt: Date,
  payload: Record<string, unknown> = {},
  key?: string,
): Promise<void> {
  await db
    .insert(scheduledJobs)
    .values({
      type,
      dueAt,
      payload,
      idempotencyKey: key ?? jobKey(type, dueAt.toISOString()),
    })
    .onConflictDoNothing({ target: scheduledJobs.idempotencyKey });
}

/**
 * Run one job. Errors propagate so the tick marks the row failed with the
 * message — the scheduler retries on the next booking, not silently here.
 */
export async function runJob(
  db: EngineDb,
  clock: Clock,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const settings = await getSettings(db);
  const season = settings.season;

  switch (type) {
    case "ingest.players": {
      const raw = await fetchAllPlayers({ db });
      await upsertPlayers(db, clock, raw);
      return;
    }
    case "ingest.trending": {
      await upsertTrending(db, await fetchTrendingAdds({ db }));
      return;
    }
    case "ingest.schedule": {
      const csv = await fetchSchedule({ db });
      await upsertGames(db, parseGames(csv, season));
      return;
    }
    case "ingest.stats": {
      const week = Number(payload.week ?? settings.currentWeek);
      const entries = await fetchWeekStats(season, week, { db });
      await upsertWeekStats(db, clock, { season, week, entries, markFinal: false });
      return;
    }
    case "ingest.projections": {
      const week = Number(payload.week ?? settings.currentWeek);
      const entries = await fetchWeekProjections(season, week, { db });
      if (entries) await upsertProjections(db, { season, week, entries });
      return;
    }
    case "ingest.season_stats": {
      const entries = await fetchSeasonStats(season - 1, { db });
      await upsertWeekStats(db, clock, { season: season - 1, week: 0, entries, markFinal: true });
      return;
    }
    case "waivers.run": {
      if (!inSeason(settings)) return; // §4.3 job gating
      await runWaivers(db, clock, clock.now());
      return;
    }
    case "stats.finalize": {
      const { start } = await import("workflow/api");
      const { finalizeWeekWorkflow } = await import("../workflows/finalizeWeek");
      await start(finalizeWeekWorkflow, [Number(payload.week ?? settings.currentWeek)]);
      return;
    }
    case "week.plan": {
      await planWeek(db, clock, Number(payload.week ?? settings.currentWeek));
      return;
    }
    case "book_daily_jobs": {
      await bookRecurringJobs(db, clock);
      return;
    }
    case "sessions.book": {
      await bookSessionsForKind(db, clock, String(payload.kind), payload);
      return;
    }
    case "reporter.run": {
      if (!inSeason(settings)) return; // §4.3 job gating
      await bookReporterSession(db, clock, String(payload.kind), Number(payload.week ?? settings.currentWeek));
      return;
    }
    case "ingest.fp_rankings": {
      const { ingestFpRankings } = await import("@league/data");
      const { fantasyprosApiKey, fantasyprosBaseUrl, fantasyprosDailyCap } = env.toolConfig;
      if (!fantasyprosApiKey) return; // no key configured: skip rather than fail the tick
      const set = settings.phase === "pre_draft" || settings.phase === "drafting" ? "draft" : "weekly";
      await ingestFpRankings(
        db,
        clock,
        { apiKey: fantasyprosApiKey, baseUrl: fantasyprosBaseUrl, dailyCap: fantasyprosDailyCap },
        { season, set, week: settings.currentWeek },
      );
      return;
    }
    case "ingest.fp_injuries": {
      const { fpRequest } = await import("@league/data");
      const { fantasyprosApiKey, fantasyprosBaseUrl, fantasyprosDailyCap } = env.toolConfig;
      if (!fantasyprosApiKey) return;
      await fpRequest(
        db,
        clock,
        { apiKey: fantasyprosApiKey, baseUrl: fantasyprosBaseUrl, dailyCap: fantasyprosDailyCap },
        { kind: "engine" },
        "/nfl/injuries",
        { year: season, week: settings.currentWeek, include_probabilities: "true" },
      );
      return;
    }
    case "draft.run": {
      // The draft runs 1.5–4 hours, far past a function's 800 s limit, so it
      // is started as a durable workflow rather than run inline (§4.1, §10.2).
      const { start } = await import("workflow/api");
      const { draftWorkflow } = await import("../workflows/draft");
      await start(draftWorkflow, []);
      return;
    }
    case "digest.weekly": {
      const { sendWeeklyDigest } = await import("./digest");
      // The post-draft digest names its own week and reason (§12.3); the
      // Tuesday one carries no payload and reports the week just finalized.
      await sendWeeklyDigest(db, clock, {
        week: payload.week === undefined ? undefined : Number(payload.week),
        reason: payload.reason === "draft" ? "draft" : "week",
      });
      return;
    }
    default:
      throw new Error(`unknown job type: ${type}`);
  }
}

/**
 * Recurring jobs (§9.1 table), booked for the next 48 hours. Idempotent, so
 * `book_daily_jobs` at 12:05 AM ET simply tops the queue back up.
 */
export async function bookRecurringJobs(db: EngineDb, clock: Clock): Promise<number> {
  const now = clock.now();
  const settings = await getSettings(db);
  let booked = 0;
  const book = async (type: string, at: Date, payload: Record<string, unknown> = {}) => {
    if (at.getTime() < now.getTime() - 60_000) return;
    await bookJob(db, type, at, payload);
    booked++;
  };

  // Two calendar days ahead.
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    const base = new Date(now.getTime() + dayOffset * 24 * 3600_000);
    const [y, m, d] = etDay(base).split("-").map(Number);
    const at = (hh: number, mm: number) => zonedTimeToUtc(y!, m!, d!, hh, mm);

    await book("ingest.schedule", at(5, 0));
    await book("ingest.fp_rankings", at(5, 30));
    await book("ingest.fp_injuries", at(5, 35));
    // §7.2: the daily waiver run time is a setting, not a constant. Booking it
    // at a hardcoded 4:30 meant changing it on /admin/settings moved the clear
    // window and what all twelve agents were told, but not when waivers ran.
    const [waiverHh, waiverMm] = settings.waiverRunTimeEt.split(":").map(Number);
    await book("waivers.run", at(waiverHh ?? 4, waiverMm ?? 30));
    await book("book_daily_jobs", at(0, 5));
    await book("ingest.projections", at(6, 0));

    // Day of the week in ET for this calendar day: 0 = Sunday.
    const dow = new Date(zonedTimeToUtc(y!, m!, d!, 12, 0)).getUTCDay();
    const gameDay = dow === 0 || dow >= 4; // Thursday–Monday (§9.1)

    // §9.1: players every 6 hours, and hourly across the game-day stretch
    // (Friday noon → Monday midnight) because that is when the status changes
    // that drive `injury.changed` land (§5.1).
    for (const hour of [0, 6, 12, 18]) await book("ingest.players", at(hour, 0));
    const hourlyFrom = dow === 5 ? 12 : dow === 6 || dow === 0 || dow === 1 ? 0 : null;
    if (hourlyFrom !== null) {
      for (let hour = hourlyFrom; hour < 24; hour++) await book("ingest.players", at(hour, 0));
    }

    for (let hour = 0; hour < 24; hour++) await book("ingest.trending", at(hour, 5));

    // §9.1: stats every 30 minutes on game days. The tick polls per minute
    // while a game is live, so these fill the gaps between games — a game that
    // finished at 4 PM is final long before the next kickoff.
    // The week is deliberately NOT baked into the payload: these are booked two
    // days ahead, and Tuesday's finalization advances `current_week` in
    // between. A stale week here would re-upsert the finalized week's rows with
    // `final = false` and overwrite the source that scored it. `runJob`
    // resolves `payload.week ?? settings.currentWeek` when it runs.
    if (gameDay) {
      for (let hour = 0; hour < 24; hour++) {
        await book("ingest.stats", at(hour, 15));
        await book("ingest.stats", at(hour, 45));
      }
    }

    // §9.1: the optional Sunday injuries pull for the site.
    if (dow === 0) await book("ingest.fp_injuries", at(11, 0));
  }

  // Weekly fixtures relative to now.
  const nextTue4 = nextEtWeekdayTime(now, 2, 4, 0);
  await book("stats.finalize", nextTue4, { week: settings.currentWeek });
  await book("sessions.book", nextEtWeekdayTime(now, 2, 9, 0), { kind: "weekly_review" });
  await book("reporter.run", nextEtWeekdayTime(now, 2, 11, 0), { kind: "reporter_recap" });
  await book("digest.weekly", nextEtWeekdayTime(now, 2, 11, 30));
  await book("sessions.book", nextEtWeekdayTime(now, 3, 9, 0), { kind: "post_waivers" });
  await book("reporter.run", nextEtWeekdayTime(now, 4, 10, 0), { kind: "reporter_preview" });
  // Trade windows: Wednesday–Saturday at noon ET (§2: four per week).
  for (const dow of [3, 4, 5, 6]) {
    const at = nextEtWeekdayTime(now, dow, 12, 0);
    if (settings.currentWeek <= settings.tradeDeadlineWeek) {
      await book("sessions.book", at, { kind: "trade_window", date: etDay(at) });
    }
  }
  return booked;
}

/** One session per active team, staggered a minute apart (§9.1). */
async function bookSessionsForKind(
  db: EngineDb,
  clock: Clock,
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const settings = await getSettings(db);
  if (!inSeason(settings)) return; // §4.3 job gating

  const allTeams = await db.select().from(teams);
  const active = allTeams.filter((t) => !t.paused && !t.eliminated);
  const now = clock.now();
  const suffix = String(payload.date ?? payload.window ?? settings.currentWeek);

  let i = 0;
  for (const team of active) {
    await createSession(db, settings, {
      teamId: team.id,
      kind: kind as never,
      trigger: `job:${kind}`,
      idempotencyKey: sessionKey(team.id, kind, settings.season, settings.currentWeek, suffix),
      modelId: team.modelId,
      dueAt: new Date(now.getTime() + i * 60_000),
      now,
      context: { week: settings.currentWeek },
    });
    i++;
  }
}

async function bookReporterSession(
  db: EngineDb,
  clock: Clock,
  kind: string,
  week: number,
): Promise<void> {
  const settings = await getSettings(db);
  await createSession(db, settings, {
    teamId: null,
    kind: kind as never,
    trigger: `job:${kind}`,
    idempotencyKey: sessionKey("reporter", kind, settings.season, week, week),
    modelId: reporterModelId(settings),
    dueAt: clock.now(),
    now: clock.now(),
    context: { week },
  });
}

/**
 * weekPlanWorkflow (§9.2): refresh the schedule, carry lineups over, group
 * kickoffs into windows and book a lineup check 90 minutes before each, book
 * the week's session jobs, and seed or advance the playoffs.
 */
export async function planWeek(db: EngineDb, clock: Clock, week: number): Promise<void> {
  const settings = await getSettings(db);

  // (1) schedule refresh
  try {
    const csv = await fetchSchedule({ db });
    await upsertGames(db, parseGames(csv, settings.season));
  } catch {
    // A stale schedule must not stop the week from being planned; the health
    // page shows the failed fetch.
  }

  // (2) carry lineups over from the previous week
  if (week > 1) await carryOverLineups(db, clock, week - 1);

  // (3) lineup-check windows + (4) session jobs + (5) playoffs
  const { bookLineupChecks, seedOrAdvancePlayoffs } = await import("./weekPlan");
  await bookLineupChecks(db, clock, week);
  await bookRecurringJobs(db, clock);
  await seedOrAdvancePlayoffs(db, clock, week);
}

/** Convenience for the admin "run now" button. */
export async function bookJobNow(db: EngineDb, clock: Clock, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const at = clock.now();
  await bookJob(db, type, at, payload, `${jobKey(type, at.toISOString())}:manual`);
}

/** Next daily waiver run instant, for display. */
export function nextWaiverRun(settings: { waiverRunTimeEt: string }, now: Date): Date {
  const [hh, mm] = settings.waiverRunTimeEt.split(":").map(Number);
  return nextEtTime(now, hh ?? 4, mm ?? 30, { strict: true });
}

/** Look up a job by key (admin page). */
export async function findJob(db: EngineDb, key: string) {
  return (await db.select().from(scheduledJobs).where(eq(scheduledJobs.idempotencyKey, key)))[0];
}
