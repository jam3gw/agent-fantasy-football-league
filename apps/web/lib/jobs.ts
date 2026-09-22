import "server-only";
/**
 * Job dispatch and the recurring job table (SPEC §9.1).
 *
 * Booking is idempotent through `scheduled_jobs.idempotency_key`, so a missed
 * tick never loses a schedule and `book_daily_jobs` can re-book freely.
 */
import { and, asc, eq } from "drizzle-orm";
import type { Clock } from "@league/shared";
import { etDay, jobKey, nextEtTime, nextEtWeekdayTime, sessionKey, zonedTimeToUtc } from "@league/shared";
import type { EngineDb } from "@league/engine";
import {
  carryOverLineups,
  createSession,
  getSettings,
  health,
  nflGames,
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
  ingestProjections,
  parseGames,
  upsertGames,
  upsertPlayers,
  upsertTrending,
  upsertWeekStats,
} from "@league/data";
import { reporterModelId } from "@league/engine";

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
  /** The `scheduled_jobs` row being run, when the tick is the caller. */
  job: { id: number } | null = null,
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
      // Keyless and quota-free, so the §5.4 lookahead costs two extra requests.
      await ingestProjections(db, {
        season,
        from: Number(payload.week ?? settings.currentWeek),
        fetchWeek: (s, w) => fetchWeekProjections(s, w, { db }),
      });
      return;
    }
    case "prices.sync": {
      // §8.7: model_prices refreshed weekly from the gateway catalog. A seat
      // whose id has left the catalog (a promo that ended, a retired model)
      // is a `prices.sync` error row on /admin/health, not a log line: the
      // swap on /admin/teams is the fix and someone has to see the need.
      // `LEAGUE_MODELS`/`DEFAULT_REPORTER_MODEL_ID` are static, in-repo
      // defaults; a swap made on /admin/teams or /admin/settings changes
      // `teams.model_id` or `settings.extra.reporterModelId` without
      // touching them, so the live seats have to be passed in explicitly or
      // a seat already swapped off a dead id keeps reporting itself as still
      // needing the swap.
      const { syncModelPrices } = await import("@league/agent");
      const liveSeats = await db.select({ modelId: teams.modelId }).from(teams);
      const result = await syncModelPrices(db, clock, {
        modelIds: [...liveSeats.map((t) => t.modelId), reporterModelId(settings)],
      });
      if (!result.ok) throw new Error(`prices.sync: ${result.error}`);
      const now = clock.now();
      const set =
        result.missingInUse.length > 0
          ? {
              lastError: `not in the gateway catalog any more: ${result.missingInUse.join(", ")} — swap the seat on /admin/teams`,
              lastErrorAt: now,
            }
          : { lastSuccessAt: now, lastError: null, lastErrorAt: null };
      await db.insert(health).values({ key: "prices.sync", ...set }).onConflictDoUpdate({ target: health.key, set });
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
      // §9.2 books a lineup check only for teams that roster a player in the
      // window, decided when the checks are booked — which is Tuesday. Every
      // claim just changed that, so re-run the booking: it is idempotent per
      // session key, so this adds newly-eligible teams and duplicates nobody.
      const { bookLineupChecks } = await import("./weekPlan");
      await bookLineupChecks(db, clock, settings.currentWeek);
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
      // §2 (2026-09-05): scheduled trade windows are retired. Agents look for
      // trades in a check-in they book themselves (§8.10). A `sessions.book`
      // row queued before the change books nothing when it fires, and no admin
      // path books a new one; /admin/teams opens a window by hand. The one
      // exception (2026-09-08) is a row that names its `window`: that is the
      // commissioner opening a window for every team at once from /admin/jobs
      // — used for the last window, with a note that the league opens no more.
      if (String(payload.kind) === "trade_window" && !windowLabel(payload)) {
        console.warn("sessions.book: scheduled trade windows are retired (§2, 2026-09-05); nothing booked");
        return;
      }
      await bookSessionsForKind(db, clock, String(payload.kind), payload);
      return;
    }
    case "reporter.run": {
      if (!inSeason(settings)) return; // §4.3 job gating
      await bookReporterSession(db, clock, String(payload.kind), Number(payload.week ?? settings.currentWeek), job);
      return;
    }
    case "odds.run": {
      if (!inSeason(settings)) return; // §4.3 job gating, like the reporter
      const snapshot = payload.snapshot === "sun" ? "sun" : "thu";
      const { runMatchupOdds } = await import("@league/engine");
      const { jevClient } = await import("@league/data");
      const { env } = await import("./env");
      // Jev runs through the AI Gateway on the key every model call uses.
      const key = env.aiGatewayApiKey;
      const result = await runMatchupOdds(db, clock, {
        season,
        week: Number(payload.week ?? settings.currentWeek),
        snapshot,
        jev: key ? jevClient({ apiKey: key }) : null,
      });
      // A Jev outage is on /admin/health (key `jev`); the job itself succeeds,
      // because the baseline and rule rows are stored either way (§11.1).
      if (result.jevError && key) console.warn(`odds.run: Jev left out of this run: ${result.jevError}`);
      return;
    }
    case "ingest.rankings": {
      const { ingestRankings } = await import("@league/data");
      // Sleeper's projection feed needs no key and no quota, so the only way
      // this fails is the feed itself — which throws and lands in the
      // failed-jobs card. §5.7's gate is checked inside, against the number of
      // players actually stored.
      const set = settings.phase === "pre_draft" || settings.phase === "drafting" ? "draft" : "weekly";
      await ingestRankings(db, clock, { season, set, week: settings.currentWeek });
      // In season, also build the rest-of-season set from the season
      // projections. `player_research` has offered `ros_rankings` to every
      // agent since the FantasyPros replacement, but nothing ever ingested
      // the set — 30 calls in one 48h stretch all failed with "no ros
      // rankings are loaded" (found 2026-09-03, monitoring).
      if (set === "weekly") {
        await ingestRankings(db, clock, { season, set: "ros", week: settings.currentWeek });
      }
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
    // Last season's totals feed get_player_stats.last_season and the §10.4
    // auto-pick fallback. The job type existed but nothing ever booked it, so
    // production drafted with last_season null for every player (found in the
    // mock draft, 2026-08-29). Daily is deliberate: Sleeper republishes stat
    // corrections, and the upsert is idempotent.
    await book("ingest.season_stats", at(5, 10));
    await book("ingest.rankings", at(5, 30));
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

    // Injuries used to be a separate FantasyPros pull. They now arrive on the
    // hourly `ingest.players` feed above, which is what raises `injury.changed`
    // anyway, so there is nothing extra to book.
  }

  // Same reason as after the waiver run: rosters move all week, and a team
  // that picks up a Thursday-night starter on Wednesday would otherwise get no
  // lineup check for that window at all.
  if (inSeason(settings)) {
    const { bookLineupChecks } = await import("./weekPlan");
    await bookLineupChecks(db, clock, settings.currentWeek);
  }

  // Weekly fixtures relative to now.
  // §8.7: the price table follows the gateway catalog, Monday 3:00 AM ET.
  await book("prices.sync", nextEtWeekdayTime(now, 1, 3, 0));
  const nextTue4 = nextEtWeekdayTime(now, 2, 4, 0);
  await book("stats.finalize", nextTue4, { week: settings.currentWeek });
  await book("sessions.book", nextEtWeekdayTime(now, 2, 9, 0), { kind: "weekly_review" });
  // §11: the rankings come first so the recap can point at them.
  await book("reporter.run", nextEtWeekdayTime(now, 2, 10, 30), { kind: "reporter_power_rankings" });
  await book("reporter.run", nextEtWeekdayTime(now, 2, 11, 0), { kind: "reporter_recap" });
  await book("digest.weekly", nextEtWeekdayTime(now, 2, 11, 30));
  await book("sessions.book", nextEtWeekdayTime(now, 3, 9, 0), { kind: "post_waivers" });
  // §11.1: odds before the preview (which cites them), and again before the Sunday slate.
  await book("odds.run", nextEtWeekdayTime(now, 4, 9, 30), { snapshot: "thu" });
  await book("odds.run", nextEtWeekdayTime(now, 0, 11, 30), { snapshot: "sun" });
  await book("reporter.run", nextEtWeekdayTime(now, 4, 10, 0), { kind: "reporter_preview" });
  // No scheduled trade window (§2, 2026-09-05): an agent that wants to shop
  // books a check-in for it (§8.10). Offers still trigger `trade_response`.
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

  const now = clock.now();
  // The recurring bookings (a row with no `window` or `date` of its own) are
  // keyed on the ET booking day rather than the week alone. Before 2026-09-08
  // the key was the week, and a league week that spans two of the same
  // weekday — Week 1 ran from the draft on Aug 30 to the first kickoff on
  // Sep 9 — made the second Tuesday's weekly_review and the second Wednesday's
  // post_waivers silent no-ops: `createSession` saw the first booking's key
  // and skipped every team. The day keeps a same-day re-run idempotent.
  //
  // The day alone would also re-book a week that did not advance: a deferred
  // or stalled finalization leaves `current_week` where it was, and the next
  // Tuesday would book twelve reviews of a week whose result is not final
  // (§13.4 relies on that Tuesday creating nothing). So a recurring booking
  // is skipped once the current week's first kickoff has passed: the week is
  // under way, and its weekly_review and post_waivers have already run.
  const label = kind === "trade_window" ? windowLabel(payload) : null;
  if (label === null && (await weekUnderWay(db, settings.season, settings.currentWeek, now))) {
    console.warn(`sessions.book: week ${settings.currentWeek} is under way (its first kickoff has passed); ${kind} not booked`);
    return;
  }
  const suffix = label ?? etDay(now);
  // The commissioner's note rides the labelled window into the brief, the way
  // an objective rides a manual session (§8.6), so the brief itself stays
  // true for every window and the announcement is made once.
  // Capped like the form field on /admin/jobs, so a hand-written row cannot pad every brief.
  const note = label !== null && typeof payload.note === "string" && payload.note.trim() ? payload.note.trim().slice(0, 500) : null;

  const allTeams = await db.select().from(teams);
  const active = allTeams.filter((t) => !t.paused && !t.eliminated);

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
      context: { week: settings.currentWeek, ...(note ? { note } : {}) },
    });
    i++;
  }
}

/** The label on a commissioner-booked `trade_window` row, or null when the row has none (or an empty one). */
function windowLabel(payload: Record<string, unknown>): string | null {
  return typeof payload.window === "string" && payload.window.trim() ? payload.window.trim() : null;
}

/** True once the week's first NFL game has kicked off. A week with no games recorded is not under way. */
async function weekUnderWay(db: EngineDb, season: number, week: number, now: Date): Promise<boolean> {
  const first = await db
    .select({ kickoffAt: nflGames.kickoffAt })
    .from(nflGames)
    .where(and(eq(nflGames.season, season), eq(nflGames.week, week)))
    .orderBy(asc(nflGames.kickoffAt))
    .limit(1);
  return first[0] !== undefined && first[0].kickoffAt.getTime() <= now.getTime();
}

async function bookReporterSession(
  db: EngineDb,
  clock: Clock,
  kind: string,
  week: number,
  job: { id: number } | null,
): Promise<void> {
  const settings = await getSettings(db);
  const now = clock.now();
  // A post kind runs once per week: the recap and the preview key on the week
  // alone, so a second booking is a no-op. A rankings edition is append-only
  // and the site shows the newest, so a re-run (the runbook's "fresh edition
  // on demand", or the Tuesday run in a week that already has the preseason
  // edition) must create a new session. Key it to the job row, so a row the
  // tick re-runs after a stale-claim release books the same session again
  // rather than a second one; without a row (a direct call), the minute.
  const suffix =
    kind === "reporter_power_rankings" ? `${week}:${job ? `job${job.id}` : now.toISOString().slice(0, 16)}` : week;
  await createSession(db, settings, {
    teamId: null,
    kind: kind as never,
    trigger: `job:${kind}`,
    idempotencyKey: sessionKey("reporter", kind, settings.season, week, suffix),
    modelId: reporterModelId(settings),
    dueAt: now,
    now,
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
