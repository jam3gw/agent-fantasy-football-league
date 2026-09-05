"use server";
/**
 * Commissioner server actions (SPEC §12.2).
 *
 * Every action re-checks `isCommissioner()` itself. `proxy.ts` already guards
 * `/admin/*` and `/api/admin/*`, but a server action is a POST endpoint of its
 * own and §15.5 asks for defence in depth, so the proxy is never the only gate.
 *
 * Every action writes a `commissioner_actions` row; the ones that change league
 * state also write a public `transactions` row of type `commissioner` so they
 * show up on /transactions (§12.2).
 *
 * Nothing here ever logs, echoes, or stores a secret.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Clock } from "@league/shared";
import { formatEt, sessionKey, zonedTimeToUtc } from "@league/shared";
import type { EngineDb, SessionKind } from "@league/engine";
import {
  commissionerActions,
  costAlarmRules,
  costAlarms,
  createSession,
  draftPicks,
  finalizeWeekCore,
  getSettings,
  lineupEntries,
  maxActiveRoster,
  players,
  playerWeekStats,
  rankings,
  recordTransaction,
  reporterModelId,
  parseTradeWindowDays,
  rosterEntries,
  scheduledJobs,
  scoreWeek,
  sessions,
  teams,
  toolCosts,
  trades,
  updateSettings,
} from "@league/engine";
import { LEAGUE_MODELS, checkGatewayModelId, seedAlarmRules } from "@league/agent";
import { fetchWeekStats, fetchNflverseWeeklyStats, upsertWeekStats } from "@league/data";
import type { SleeperStatsEntry } from "@league/data";
import { db, leagueClock } from "./db";
import { isCommissioner } from "./auth";
import { bookJobNow, runJob } from "./jobs";
import { finalizeWeek } from "./finalize";
import { sendWeeklyDigest } from "./digest";
import { refinalizeCutoff } from "./refinalizeWindow";
import {
  drawDraftOrder,
  forceAutoPick,
  getDraft,
  pauseDraft,
  resumeDraft,
} from "./draft";

/** Job types the commissioner may book by hand from /admin/jobs. */
const BOOKABLE_JOBS = [
  "ingest.players",
  "ingest.trending",
  "ingest.schedule",
  "ingest.stats",
  "ingest.projections",
  "ingest.season_stats",
  "ingest.rankings",
  "waivers.run",
  "stats.finalize",
  "reporter.run",
  "sessions.book",
  "draft.run",
  "week.plan",
  "book_daily_jobs",
  "digest.weekly",
] as const;

const SESSION_KINDS: SessionKind[] = [
  "onboarding",
  "weekly_review",
  "post_waivers",
  "trade_window",
  "lineup_check",
  "injury_response",
  "board_reply",
  "manual",
  "smoke",
];

// ------------------------------------------------------------------ helpers

async function guard(): Promise<void> {
  // Defence in depth (§15.5): never trust the proxy alone.
  if (!(await isCommissioner())) throw new Error("unauthorized");
}

interface Ctx {
  database: EngineDb;
  clock: Clock;
  now: Date;
}

async function ctx(): Promise<Ctx> {
  await guard();
  const database = db();
  const clock = await leagueClock();
  return { database, clock, now: clock.now() };
}

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function num(form: FormData, key: string): number | null {
  const v = str(form, key);
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** JSON from a textarea, with a message a person can act on. */
function parseJson(raw: string, field: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${field} is not valid JSON — nothing was saved`);
  }
}

function requireReason(form: FormData): string {
  const reason = str(form, "reason");
  if (reason.length < 3) throw new Error("a reason is required");
  return reason;
}

/** The commissioner_actions row every action writes (§12.2). */
async function logAction(
  c: Ctx,
  action: string,
  payload: Record<string, unknown>,
  reason?: string,
): Promise<void> {
  await c.database.insert(commissionerActions).values({
    action,
    payload,
    reason: reason ?? null,
    createdAt: c.now,
  });
}

/** The public transactions row for actions that change league state (§12.2). */
async function publicTransaction(
  c: Ctx,
  action: string,
  teamIds: number[],
  payload: Record<string, unknown>,
  week: number | null = null,
): Promise<void> {
  await recordTransaction(c.database, {
    type: "commissioner",
    week,
    teamIds,
    payload: { action, ...payload },
  });
}

/** Finish an action: revalidate the page and come back with a message. */
function finish(path: string, message: string): never {
  revalidatePath(path);
  redirect(`${path}?msg=${encodeURIComponent(message)}`);
}

/**
 * Re-finalize a week without letting `current_week` or `phase` walk backwards:
 * finalizeWeekCore always sets current_week = week + 1, which is right the
 * first time and wrong when an older week is re-scored.
 */
async function refinalizePreservingClock(c: Ctx, week: number): Promise<void> {
  const before = await getSettings(c.database);
  const result = await finalizeWeekCore(c.database, c.clock, week);
  if (!result.ok) throw new Error(`finalization failed: ${result.message}`);
  const after_ = await getSettings(c.database);
  const patch: { currentWeek?: number; phase?: typeof before.phase } = {};
  if (after_.currentWeek < before.currentWeek) patch.currentWeek = before.currentWeek;
  if (after_.phase !== before.phase && before.phase === "playoffs") patch.phase = before.phase;
  if (Object.keys(patch).length > 0) await updateSettings(c.database, patch);
}

/** Stats for one week from one named source (§13.4 ladder, one rung at a time). */
async function statsFromSource(
  c: Ctx,
  season: number,
  week: number,
  source: "sleeper" | "nflverse",
): Promise<SleeperStatsEntry[]> {
  if (source === "sleeper") {
    return fetchWeekStats(season, week, { db: c.database });
  }
  // nflverse: offense and kickers only; D/ST scores 0 on this rung (§13.4).
  const rows = await fetchNflverseWeeklyStats(season, { db: c.database });
  const settings = await getSettings(c.database);
  const idRows = await c.database
    .select({ playerId: players.playerId, gsisId: players.gsisId })
    .from(players);
  const byGsis = new Map(idRows.filter((p) => p.gsisId).map((p) => [p.gsisId!, p.playerId]));
  const out: SleeperStatsEntry[] = [];
  for (const r of rows) {
    if (r.week !== week) continue;
    const playerId = byGsis.get(r.gsisId);
    if (!playerId) continue;
    let total = 0;
    for (const [k, v] of Object.entries(r.stats)) {
      const coeff = settings.scoringSettings[k];
      if (coeff) total += coeff * v;
    }
    out.push({
      player_id: playerId,
      season,
      week,
      stats: { ...r.stats, pts_ppr: Math.round(total * 100) / 100 },
    });
  }
  return out;
}

// ------------------------------------------------------------------- health

export async function acknowledgeAlarmAction(form: FormData): Promise<void> {
  const c = await ctx();
  const alarmId = num(form, "alarmId");
  if (alarmId === null) throw new Error("alarmId is required");
  await c.database
    .update(costAlarms)
    .set({ acknowledgedAt: c.now })
    .where(eq(costAlarms.id, alarmId));
  await logAction(c, "alarm_acknowledged", { alarmId });
  finish("/admin/health", `Alarm ${alarmId} acknowledged.`);
}

export async function sendDigestNowAction(): Promise<void> {
  const c = await ctx();
  const sent = await sendWeeklyDigest(c.database, c.clock);
  await logAction(c, "digest_sent", { sent });
  finish(
    "/admin/health",
    sent ? "Digest sent." : "Digest built but email is not configured (RESEND_API_KEY / ALERT_EMAIL_TO).",
  );
}

// --------------------------------------------------------------------- jobs

export async function runJobNowAction(form: FormData): Promise<void> {
  const c = await ctx();
  const jobId = num(form, "jobId");
  if (jobId === null) throw new Error("jobId is required");
  const row = (await c.database.select().from(scheduledJobs).where(eq(scheduledJobs.id, jobId)))[0];
  if (!row) throw new Error(`job ${jobId} not found`);

  // Claim it first so the per-minute tick cannot pick up the same row.
  await c.database
    .update(scheduledJobs)
    .set({ status: "claimed", claimedAt: c.now, error: null })
    .where(eq(scheduledJobs.id, jobId));

  let message: string;
  try {
    await runJob(c.database, c.clock, row.type, row.payload);
    await c.database
      .update(scheduledJobs)
      .set({ status: "done", doneAt: c.clock.now() })
      .where(eq(scheduledJobs.id, jobId));
    message = `Ran ${row.type}.`;
  } catch (err) {
    await c.database
      .update(scheduledJobs)
      .set({ status: "failed", doneAt: c.clock.now(), error: String(err) })
      .where(eq(scheduledJobs.id, jobId));
    message = `${row.type} failed: ${String(err).slice(0, 200)}`;
  }
  await logAction(c, "job_run_now", { jobId, type: row.type });
  finish("/admin/jobs", message);
}

export async function cancelJobAction(form: FormData): Promise<void> {
  const c = await ctx();
  const jobId = num(form, "jobId");
  if (jobId === null) throw new Error("jobId is required");
  await c.database
    .update(scheduledJobs)
    .set({ status: "done", doneAt: c.now, error: "cancelled by the commissioner" })
    .where(and(eq(scheduledJobs.id, jobId), inArray(scheduledJobs.status, ["due", "claimed"])));
  await logAction(c, "job_cancelled", { jobId });
  finish("/admin/jobs", `Job ${jobId} cancelled.`);
}

export async function bookJobAction(form: FormData): Promise<void> {
  const c = await ctx();
  const type = str(form, "type");
  if (!(BOOKABLE_JOBS as readonly string[]).includes(type)) throw new Error(`job type not bookable: ${type}`);
  const week = num(form, "week");
  const payload: Record<string, unknown> = week === null ? {} : { week };
  // `reporter.run` and `sessions.book` both dispatch on a `kind`, so booking
  // one without it would throw at run time. This is how a missed recap or
  // preview gets re-run — there was no way to before.
  const kind = str(form, "kind");
  if (type === "reporter.run" || type === "sessions.book") {
    if (!kind) throw new Error(`${type} needs a kind`);
    payload.kind = kind;
  }
  await bookJobNow(c.database, c.clock, type, payload);
  await logAction(c, "job_booked", { type, payload });
  finish("/admin/jobs", `Booked ${type}; the next tick runs it.`);
}

// -------------------------------------------------------------------- teams

export async function setTeamPausedAction(form: FormData): Promise<void> {
  const c = await ctx();
  const teamId = num(form, "teamId");
  const paused = str(form, "paused") === "1";
  if (teamId === null) throw new Error("teamId is required");
  await c.database.update(teams).set({ paused }).where(eq(teams.id, teamId));
  await logAction(c, paused ? "team_paused" : "team_unpaused", { teamId });
  await publicTransaction(c, paused ? "team_paused" : "team_unpaused", [teamId], { teamId });
  finish("/admin/teams", `Team ${teamId} ${paused ? "paused" : "unpaused"}.`);
}

export async function runSessionNowAction(form: FormData): Promise<void> {
  const c = await ctx();
  const teamId = num(form, "teamId");
  const kind = str(form, "kind") as SessionKind;
  const objective = str(form, "objective");
  if (teamId === null) throw new Error("teamId is required");
  if (!SESSION_KINDS.includes(kind)) throw new Error(`unsupported session kind: ${kind}`);

  const settings = await getSettings(c.database);
  const team = (await c.database.select().from(teams).where(eq(teams.id, teamId)))[0];
  if (!team) throw new Error(`team ${teamId} not found`);

  const sessionId = await createSession(c.database, settings, {
    teamId,
    kind,
    trigger: "commissioner",
    idempotencyKey: sessionKey(teamId, kind, settings.season, settings.currentWeek, `manual-${c.now.getTime()}`),
    modelId: team.modelId,
    dueAt: c.now,
    now: c.now,
    context: { week: settings.currentWeek, ...(objective ? { objective } : {}) },
  });
  await logAction(c, "session_run_now", { teamId, kind, objective: objective || null, sessionId });
  await publicTransaction(c, "session_run_now", [teamId], { kind, sessionId }, settings.currentWeek);
  finish("/admin/teams", `Queued a ${kind} session for ${team.name ?? team.slug}.`);
}

/**
 * Stop a session (§12.2). There was no way to: a session stuck `running`
 * held one of six slots and blocked its team entirely for half an hour, and an
 * agent going somewhere bad mid-session could not be stopped at all.
 *
 * Both a queued and a running session end `skipped`, not `failed`: the slot
 * comes back at once, the loop's own writes are all predicated on the row
 * still being `running` so the next step is a no-op, and `skipped` is not a
 * status `requeueFailedSessions` retries — stopping a session must not start
 * it again a minute later.
 */
export async function cancelSessionAction(form: FormData): Promise<void> {
  const c = await ctx();
  const sessionId = num(form, "sessionId");
  if (sessionId === null) throw new Error("sessionId is required");

  const session = (await c.database.select().from(sessions).where(eq(sessions.id, sessionId)))[0];
  if (!session) throw new Error(`session ${sessionId} not found`);
  if (session.status !== "queued" && session.status !== "running") {
    throw new Error(`session ${sessionId} is already ${session.status}`);
  }

  await c.database
    .update(sessions)
    .set({
      status: "skipped",
      error: "stopped by the commissioner",
      endedAt: c.now,
      updatedAt: c.now,
    })
    .where(and(eq(sessions.id, sessionId), inArray(sessions.status, ["queued", "running"])));

  await logAction(c, "session_cancelled", { sessionId, was: session.status, teamId: session.teamId, kind: session.kind });
  finish("/admin/teams", `Stopped session ${sessionId} (${session.kind}).`);
}

export async function swapModelAction(form: FormData): Promise<void> {
  const c = await ctx();
  const teamId = num(form, "teamId");
  const reason = requireReason(form);
  if (teamId === null) throw new Error("teamId is required");

  const picked = str(form, "modelId");
  const custom = str(form, "customModelId");
  const modelId = custom || picked;
  if (!modelId) throw new Error("a model id is required");

  const known = LEAGUE_MODELS.find((m) => m.modelId === modelId);
  const modelLabel = str(form, "modelLabel") || known?.label || modelId;
  const provider = str(form, "provider") || known?.provider || (modelId.split("/")[0] ?? "unknown");

  const team = (await c.database.select().from(teams).where(eq(teams.id, teamId)))[0];
  if (!team) throw new Error(`team ${teamId} not found`);

  // A typo here fails every session this team runs until someone notices, and
  // when the swap is a response to an outage the detector is still watching
  // the old id, so nothing would notice. An unreadable catalog is not a
  // refusal: the swap is the commissioner's answer to a provider having a bad
  // day, and that is exactly when the catalog may be unreachable.
  const onGateway = await checkGatewayModelId(modelId);
  if (onGateway === "not_found") {
    throw new Error(`the AI Gateway has no model called ${modelId}. Check the id and try again.`);
  }

  await c.database.update(teams).set({ modelId, modelLabel, provider }).where(eq(teams.id, teamId));
  // A session carries its own model id from the moment it is queued, and the
  // runner reads that, not the team's. Lineup checks are queued days before
  // kickoff, so without this the swap would not reach them until the next
  // trigger created new sessions. Running sessions keep the id they started on.
  const requeued = await c.database
    .update(sessions)
    .set({ modelId, updatedAt: c.now })
    .where(and(eq(sessions.teamId, teamId), eq(sessions.status, "queued"), eq(sessions.modelId, team.modelId)))
    .returning({ id: sessions.id });
  const payload = { teamId, from: team.modelId, to: modelId, modelLabel, provider, queuedSessions: requeued.length };
  await logAction(c, "model_swapped", payload, reason);
  await publicTransaction(c, "model_swapped", [teamId], { ...payload, reason });
  finish(
    "/admin/teams",
    `${team.name ?? team.slug} now runs ${modelLabel}; ${requeued.length} queued session(s) moved with it.` +
      (onGateway === "unknown" ? " The gateway catalog could not be read, so the id was not verified." : ""),
  );
}

export async function runOnboardingAction(): Promise<void> {
  const c = await ctx();
  // §10.1: the order is drawn first, so each agent prepares for the slot it
  // actually has. Enforced rather than documented — an onboarding session run
  // before the draw produces a generic plan and cannot be re-run, because the
  // idempotency key is the same.
  const draftState = await getDraft(c.database);
  if (!draftState?.order || draftState.order.length === 0) {
    throw new Error("draw the draft order first — onboarding tells each agent the slot it is preparing for");
  }
  const settings = await getSettings(c.database);
  const allTeams = await c.database.select().from(teams);
  let queued = 0;
  let i = 0;
  for (const team of allTeams) {
    const id = await createSession(c.database, settings, {
      teamId: team.id,
      kind: "onboarding",
      trigger: "commissioner",
      idempotencyKey: sessionKey(team.id, "onboarding", settings.season, 0, "setup"),
      modelId: team.modelId,
      // A minute apart so twelve sessions do not all start at once (§9.1).
      dueAt: new Date(c.now.getTime() + i * 60_000),
      now: c.now,
      context: { week: settings.currentWeek },
    });
    if (id !== null) queued++;
    i++;
  }
  await logAction(c, "onboarding_run", { teams: allTeams.length, queued });
  await publicTransaction(c, "onboarding_run", allTeams.map((t) => t.id), { queued });
  finish("/admin/draft", `Queued ${queued} onboarding session(s) of ${allTeams.length} teams.`);
}

// ------------------------------------------------------------------- trades

export async function reverseTradeAction(form: FormData): Promise<void> {
  const c = await ctx();
  const tradeId = num(form, "tradeId");
  const reason = requireReason(form);
  if (tradeId === null) throw new Error("tradeId is required");

  const settings = await getSettings(c.database);
  const week = settings.currentWeek;

  await c.database.transaction(async (tx) => {
    const trade = (await tx.select().from(trades).where(eq(trades.id, tradeId)))[0];
    if (!trade) throw new Error(`trade ${tradeId} not found`);
    if (trade.status !== "executed") throw new Error("only an executed trade can be reversed");

    const a = trade.proposerTeamId;
    const b = trade.counterpartyTeamId;
    // Undo the swap: give-side players go back to the proposer, get-side to
    // the counterparty. Mirrors §7.5 execution, in reverse.
    const moves = [
      ...trade.givePlayerIds.map((playerId) => ({ playerId, to: a, from: b })),
      ...trade.getPlayerIds.map((playerId) => ({ playerId, to: b, from: a })),
    ];

    // The reversal used to delete each roster entry by player id alone, so a
    // traded player who had since been dropped, claimed on waivers or traded
    // on to a third team was silently taken from whoever held him. Refuse
    // unless every player is exactly where the trade left him — a reversal is
    // only meaningful while the trade is the last thing that happened.
    const held = await tx
      .select({ playerId: rosterEntries.playerId, teamId: rosterEntries.teamId })
      .from(rosterEntries)
      .where(inArray(rosterEntries.playerId, moves.map((m) => m.playerId)));
    const moved = moves.filter((m) => held.find((h) => h.playerId === m.playerId)?.teamId !== m.from);
    if (moved.length > 0) {
      throw new Error(
        `cannot reverse: ${moved.map((m) => m.playerId).join(", ")} ` +
          `${moved.length === 1 ? "is" : "are"} no longer on the team the trade put ` +
          `${moved.length === 1 ? "him" : "them"} on. Undo the later moves first.`,
      );
    }

    for (const m of moves) {
      await tx.delete(rosterEntries).where(eq(rosterEntries.playerId, m.playerId));
      await tx
        .insert(rosterEntries)
        .values({ teamId: m.to, playerId: m.playerId, acquiredVia: "commissioner", acquiredAt: c.now });
      // Clear any lineup entry the player now holds for the current or next
      // week; returning players land on the bench (§7.8).
      await tx
        .delete(lineupEntries)
        .where(and(eq(lineupEntries.playerId, m.playerId), inArray(lineupEntries.week, [week, week + 1])));
    }

    // §3.1: a reversal must not leave a team over the roster limit. It cannot
    // here — it restores the exact rosters the trade changed — but a trade
    // with unequal sides plus later adds could, so it is checked rather than
    // assumed. This is the one admin action that writes roster state directly.
    for (const teamId of [a, b]) {
      const n = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(rosterEntries)
        .where(eq(rosterEntries.teamId, teamId));
      const max = maxActiveRoster(settings);
      if ((n[0]?.n ?? 0) > max) {
        throw new Error(`cannot reverse: team ${teamId} would hold ${n[0]?.n} players, over the ${max} limit.`);
      }
    }

    await tx
      .update(trades)
      .set({
        status: "cancelled",
        resolutionReason: `commissioner reversal: ${reason}`,
        resolvedAt: c.now,
        updatedAt: c.now,
      })
      .where(eq(trades.id, tradeId));

    await tx.insert(commissionerActions).values({
      action: "trade_reversed",
      payload: { tradeId, proposerTeamId: a, counterpartyTeamId: b },
      reason,
      createdAt: c.now,
    });
    await recordTransaction(tx, {
      type: "commissioner",
      week,
      teamIds: [a, b],
      payload: {
        action: "trade_reversed",
        tradeId,
        reason,
        returnedToProposer: trade.givePlayerIds,
        returnedToCounterparty: trade.getPlayerIds,
      },
    });
  });

  finish("/admin/trades", `Trade ${tradeId} reversed. Lineups for weeks ${week} and ${week + 1} were cleared for the players involved.`);
}

// ------------------------------------------------------------------- scores

export async function refinalizeWeekAction(form: FormData): Promise<void> {
  const c = await ctx();
  const week = num(form, "week");
  const source = str(form, "source") || "auto";
  if (week === null) throw new Error("week is required");

  const settings = await getSettings(c.database);

  // §13.4: re-finalization is allowed only until Tuesday 9:00 AM ET, when the
  // weekly reviews start. After that the agents have already acted on the
  // scores, so changing them would rewrite the week under them. A week that is
  // not the one just finalized is always past its window.
  const cutoff = refinalizeCutoff(c.now);
  if (week !== settings.currentWeek - 1) {
    throw new Error(
      `week ${week} is closed: only week ${settings.currentWeek - 1}, the one just finalized, can be re-scored. ` +
        `Correct a single player's points on /admin/scores instead.`,
    );
  }
  if (c.now >= cutoff) {
    throw new Error(
      `the window closed at ${formatEt(cutoff)} — the agents' weekly reviews have started and the week stands (§13.4). ` +
        `A single player's points can still be corrected.`,
    );
  }

  let message: string;

  if (source === "auto") {
    const result = await finalizeWeek(c.database, c.clock, week);
    message = `Week ${week} re-finalized from ${result.source} (${result.playersScored} players).`;
  } else if (source === "sleeper" || source === "nflverse") {
    const entries = await statsFromSource(c, settings.season, week, source);
    if (entries.length === 0) throw new Error(`${source} returned no rows for week ${week}`);
    const res = await upsertWeekStats(c.database, c.clock, {
      season: settings.season,
      week,
      entries,
      markFinal: true,
      source,
    });
    await refinalizePreservingClock(c, week);
    const extra = (await getSettings(c.database)).extra as Record<string, unknown>;
    await updateSettings(c.database, {
      extra: {
        ...extra,
        weekScoringSources: {
          ...((extra.weekScoringSources as Record<string, string>) ?? {}),
          [String(week)]: source,
        },
      },
    });
    message = `Week ${week} re-finalized from ${source} (${res.count} players).`;
  } else {
    throw new Error(`unknown scoring source: ${source}`);
  }

  await logAction(c, "week_refinalized", { week, source });
  await publicTransaction(c, "week_refinalized", [], { week, source }, week);
  finish("/admin/scores", message);
}

export async function correctPlayerPointsAction(form: FormData): Promise<void> {
  const c = await ctx();
  const week = num(form, "week");
  const playerId = str(form, "playerId");
  const points = num(form, "points");
  const reason = requireReason(form);
  if (week === null) throw new Error("week is required");
  if (!playerId) throw new Error("a player id is required");
  if (points === null) throw new Error("points are required");

  const settings = await getSettings(c.database);
  const existing = (
    await c.database
      .select()
      .from(playerWeekStats)
      .where(
        and(
          eq(playerWeekStats.playerId, playerId),
          eq(playerWeekStats.season, settings.season),
          eq(playerWeekStats.week, week),
        ),
      )
  )[0];

  const before = existing?.ptsPpr ?? null;
  const stats = { ...(existing?.stats ?? {}), pts_ppr: points };
  await c.database
    .insert(playerWeekStats)
    .values({
      playerId,
      season: settings.season,
      week,
      stats,
      ptsPpr: points,
      enginePts: existing?.enginePts ?? points,
      source: existing?.source ?? "sleeper",
      final: true,
      updatedAt: c.now,
    })
    .onConflictDoUpdate({
      target: [playerWeekStats.playerId, playerWeekStats.season, playerWeekStats.week],
      set: { stats, ptsPpr: points, updatedAt: c.now },
    });

  // Re-score the week so matchups, winners and team_week_results follow the
  // correction; the league clock is preserved for an already-past week.
  await scoreWeek(c.database, c.clock, week);
  await refinalizePreservingClock(c, week);

  const payload = { week, playerId, before, after: points };
  await logAction(c, "player_points_corrected", payload, reason);
  await publicTransaction(c, "player_points_corrected", [], { ...payload, reason }, week);
  finish("/admin/scores", `${playerId} week ${week}: ${before ?? "—"} → ${points.toFixed(2)}.`);
}

// ----------------------------------------------------------------- settings

export async function saveSettingsAction(form: FormData): Promise<void> {
  const c = await ctx();
  const current = await getSettings(c.database);
  const patch: Record<string, unknown> = {};

  const setNum = (field: string, key: string) => {
    const v = num(form, key);
    if (v !== null) patch[field] = Math.round(v);
  };
  setNum("waiverClearHours", "waiverClearHours");
  setNum("tradeReviewHours", "tradeReviewHours");
  setNum("tradeVetoVotes", "tradeVetoVotes");
  setNum("tradeMaxOffersPerDay", "tradeMaxOffersPerDay");
  setNum("tradeOfferExpiryHours", "tradeOfferExpiryHours");
  setNum("tradeDeadlineWeek", "tradeDeadlineWeek");
  setNum("draftClockSeconds", "draftClockSeconds");
  setNum("draftRounds", "draftRounds");

  const waiverRunTimeEt = str(form, "waiverRunTimeEt");
  if (waiverRunTimeEt) {
    if (!/^\d{2}:\d{2}$/.test(waiverRunTimeEt)) throw new Error("waiver run time must look like 04:30");
    patch.waiverRunTimeEt = waiverRunTimeEt;
  }

  const irStatuses = str(form, "irEligibleStatuses");
  if (irStatuses) {
    patch.irEligibleStatuses = irStatuses
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Roster and scoring are frozen once the draft has started (§12.2).
  const structureLocked = current.phase !== "pre_draft";
  if (!structureLocked) {
    const rosterSlots = str(form, "rosterSlots");
    if (rosterSlots) patch.rosterSlots = parseJson(rosterSlots, "roster_slots");
    const scoringSettings = str(form, "scoringSettings");
    if (scoringSettings) patch.scoringSettings = parseJson(scoringSettings, "scoring_settings");
  }

  // Everything that lives in `extra` is edited through one copy of the object,
  // so saving two of these in one submit cannot lose the other.
  const extra = { ...(current.extra as Record<string, unknown>) };
  let extraTouched = false;

  // Loop guards live in extra.sessionGuards (§8.3); they stay editable.
  const guards = str(form, "sessionGuards");
  if (guards) {
    extra.sessionGuards = parseJson(guards, "sessionGuards");
    extraTouched = true;
  }

  // §11: the reporter's model. It was read from `extra.reporterModelId` and
  // written by nothing, so if Sonnet 5 were retired mid-season every recap,
  // preview, trade note and draft grade would have failed until someone ran
  // SQL — while §17 lists "reporter model set" as a go-live check.
  const reporterModel = str(form, "reporterModelId");
  if (reporterModel && reporterModel !== reporterModelId(current)) {
    if ((await checkGatewayModelId(reporterModel)) === "not_found") {
      throw new Error(`the AI Gateway has no model called ${reporterModel}.`);
    }
    extra.reporterModelId = reporterModel;
    extraTouched = true;
  }

  // §10.1: when the draft is set to start. Informational — shown to every
  // agent before the draft so onboarding and check-ins can plan around it.
  // Entered as ET wall-clock, stored as a UTC ISO string in extra.
  const draftScheduledEt = form.get("draftScheduledEt");
  if (draftScheduledEt !== null) {
    const rawSchedule = String(draftScheduledEt).trim();
    if (rawSchedule === "") {
      delete extra.draftScheduledAt;
    } else {
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(rawSchedule);
      if (!m) throw new Error("draft schedule must be a date and time");
      extra.draftScheduledAt = zonedTimeToUtc(
        Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]),
      ).toISOString();
    }
    extraTouched = true;
  }

  // §2 (2026-09-05): which weekdays get a trade window.
  const windowDays = str(form, "tradeWindowDays");
  if (windowDays) {
    extra.tradeWindowDays = parseTradeWindowDays(windowDays);
    extraTouched = true;
  }

  // §11: reporter trade notes, default on. Also read-only until now.
  extra.reporterTradeNotes = form.get("reporterTradeNotes") !== null;
  extraTouched = true;

  if (extraTouched) patch.extra = extra;

  await updateSettings(c.database, patch);
  await logAction(c, "settings_updated", { fields: Object.keys(patch), structureLocked });
  await publicTransaction(c, "settings_updated", [], { fields: Object.keys(patch) }, current.currentWeek);
  finish(
    "/admin/settings",
    structureLocked
      ? "Settings saved. Roster and scoring stayed locked (the draft has started)."
      : "Settings saved.",
  );
}

export async function savePauseAgentAtAction(form: FormData): Promise<void> {
  const c = await ctx();
  const current = await getSettings(c.database);
  const raw = str(form, "pauseAgentAtUsd");
  const extra = { ...(current.extra as Record<string, unknown>) };
  if (raw === "") delete extra.pause_agent_at_usd;
  else {
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) throw new Error("pause_agent_at_usd must be a positive number or blank");
    extra.pause_agent_at_usd = v;
  }
  await updateSettings(c.database, { extra });
  await logAction(c, "pause_agent_at_set", { pause_agent_at_usd: extra.pause_agent_at_usd ?? null });
  finish(
    "/admin/settings",
    raw === "" ? "Hard stop off — no dollar amount ever stops an agent." : `Hard stop set at $${Number(raw).toFixed(2)} per season.`,
  );
}

export async function saveAlarmRulesAction(form: FormData): Promise<void> {
  const c = await ctx();
  const ids = form.getAll("ruleId").map((v) => Number(v)).filter(Number.isFinite);
  for (const id of ids) {
    const threshold = num(form, `threshold_${id}`);
    const stepRaw = str(form, `step_${id}`);
    const channels = ["email", "site", "webhook"].filter((ch) => str(form, `channel_${ch}_${id}`) === "1");
    await c.database
      .update(costAlarmRules)
      .set({
        ...(threshold === null ? {} : { thresholdUsd: threshold }),
        stepUsd: stepRaw === "" ? null : Number(stepRaw),
        enabled: str(form, `enabled_${id}`) === "1",
        channels,
        updatedAt: c.now,
      })
      .where(eq(costAlarmRules.id, id));
  }
  await logAction(c, "alarm_rules_updated", { rules: ids.length });
  finish("/admin/settings", `${ids.length} alarm rule(s) saved.`);
}

export async function seedAlarmRulesAction(): Promise<void> {
  const c = await ctx();
  await seedAlarmRules(c.database);
  await logAction(c, "alarm_rules_seeded", {});
  finish("/admin/settings", "Default alarm rules created.");
}

export async function saveToolCostsAction(form: FormData): Promise<void> {
  const c = await ctx();
  const names = form.getAll("toolName").map(String);
  for (const name of names) {
    const price = num(form, `cost_${name}`);
    if (price === null) continue;
    await c.database
      .update(toolCosts)
      .set({ usdPerCall: price, updatedAt: c.now })
      .where(eq(toolCosts.toolName, name));
  }
  const newName = str(form, "newToolName");
  const newPrice = num(form, "newToolCost");
  if (newName && newPrice !== null) {
    await c.database
      .insert(toolCosts)
      .values({ toolName: newName, usdPerCall: newPrice, updatedAt: c.now })
      .onConflictDoUpdate({
        target: toolCosts.toolName,
        set: { usdPerCall: newPrice, updatedAt: c.now },
      });
  }
  await logAction(c, "tool_costs_updated", { tools: names, added: newName || null });
  finish("/admin/settings", "Tool costs saved.");
}

// ---------------------------------------------------------------- rankings

export async function refreshRankingsAction(): Promise<void> {
  const c = await ctx();
  await bookJobNow(c.database, c.clock, "ingest.rankings");
  await logAction(c, "rankings_refresh_booked", {});
  finish("/admin/rankings", "Rankings refresh booked; the next tick runs it.");
}

// ------------------------------------------------------------------- draft

/**
 * §5.7 gate: at least 200 ranked players on the draft board.
 *
 * It used to also require nothing unmatched inside the top 200. That clause
 * went with FantasyPros on 2026-08-29: the board is now keyed by Sleeper's own
 * player ids, which are already ours, so an unmatched player is not a state
 * that can occur.
 */
async function draftGate(database: EngineDb): Promise<{ ranked: number; ok: boolean }> {
  const rankedRows = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(rankings)
    .where(and(eq(rankings.set, "draft"), sql`${rankings.rank} is not null`));
  const ranked = rankedRows[0]?.n ?? 0;
  return { ranked, ok: ranked >= 200 };
}

export async function drawDraftOrderAction(): Promise<void> {
  const c = await ctx();
  const state = await getDraft(c.database);
  if (state && state.status !== "not_started") throw new Error("the order cannot be redrawn once the draft has started");
  const order = await drawDraftOrder(c.database, c.clock);
  await logAction(c, "draft_order_drawn", { order });
  finish("/admin/draft", `Order drawn: ${order.join(", ")}.`);
}

export async function startDraftAction(): Promise<void> {
  const c = await ctx();
  const state = await getDraft(c.database);
  if (!state?.order || state.order.length === 0) throw new Error("draw the order first");
  if (state.status === "complete") throw new Error("the draft is already complete");

  const gate = await draftGate(c.database);
  if (!gate.ok) {
    throw new Error(`the §5.7 gate is not met: ${gate.ranked} ranked players, 200 needed`);
  }

  // §5.7: the draft rankings are pulled again when the draft starts, so the
  // board the agents see is today's, not whatever the 5:30 AM job fetched. A
  // failure here must not block the draft — the gate above already proved the
  // rankings on hand are usable — so it is booked, not awaited.
  if (state.currentPick === null || state.currentPick <= 1) {
    await bookJobNow(c.database, c.clock, "ingest.rankings");
  }

  await logAction(c, "draft_started", { from: state.currentPick ?? 1 });
  await publicTransaction(c, "draft_started", state.order, { from: state.currentPick ?? 1 });
  // 168 picks at up to three minutes each is far past a function's limit, so
  // the draft is a durable workflow. Booking `draft.run` lets the next tick
  // start it (§4.1, §9.2, §10.2).
  await bookJobNow(c.database, c.clock, "draft.run");
  finish("/admin/draft", "Draft booked. The next tick starts the durable draft workflow, which resumes from the current pick.");
}

export async function pauseDraftAction(): Promise<void> {
  const c = await ctx();
  await pauseDraft(c.database, c.clock);
  await logAction(c, "draft_paused", {});
  await publicTransaction(c, "draft_paused", [], {});
  finish("/admin/draft", "Draft paused. The clock for the current pick is stored.");
}

export async function resumeDraftAction(): Promise<void> {
  const c = await ctx();
  await resumeDraft(c.database, c.clock);
  await logAction(c, "draft_resumed", {});
  await publicTransaction(c, "draft_resumed", [], {});
  // A paused run returns early, so a resume needs a fresh durable run.
  await bookJobNow(c.database, c.clock, "draft.run");
  finish("/admin/draft", "Draft resumed; the next tick starts a fresh run from the stored clock.");
}

export async function emergencyAutoPickAction(): Promise<void> {
  const c = await ctx();
  const state = await getDraft(c.database);
  await forceAutoPick(c.database, c.clock);
  await logAction(c, "draft_emergency_autopick", { pickNo: state?.currentPick ?? null });
  await publicTransaction(c, "draft_emergency_autopick", [], { pickNo: state?.currentPick ?? null });
  finish("/admin/draft", `Emergency auto-pick armed for pick ${state?.currentPick ?? "—"}.`);
}

// --------------------------------------------------------------- read-side

/** Used by /admin/draft to show the §5.7 gate. Read-only. */
export async function draftGateStatus(): Promise<{ ranked: number; ok: boolean }> {
  await guard();
  return draftGate(db());
}

/** Auto-picks so far, for the draft page. Read-only. */
export async function autoPickCount(): Promise<number> {
  await guard();
  const rows = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(draftPicks)
    .where(eq(draftPicks.madeBy, "autopick"));
  return rows[0]?.n ?? 0;
}

