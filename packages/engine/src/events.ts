/**
 * Engine events (§9.3). Emitted by engine functions inside the same database
 * transaction; handlers create session rows (status queued) plus a
 * `session.run` scheduled job so the per-minute tick starts the workflow.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { Clock } from "@league/shared";
import { etDay, injurySessionKey, zonedTimeToUtc } from "@league/shared";
import type { EngineDb } from "./db/index.ts";
import type { SessionKind } from "./db/schema.ts";
import { draft, nflGames, players, scheduledJobs, sessions, teams } from "./db/schema.ts";
import { sessionGuard } from "./guards.ts";
import { playerKickoff } from "./locks.ts";
import type { LeagueSettings } from "./settings.ts";
import { getSettings, updateSettings } from "./settings.ts";
import { createSeasonSchedule } from "./schedule.ts";

export type EngineEvent =
  | { type: "trade.proposed"; tradeId: number; proposerTeamId: number; counterpartyTeamId: number }
  | { type: "trade.accepted"; tradeId: number; partyTeamIds: [number, number]; reviewEndsAt: Date }
  | { type: "trade.vote_cast"; tradeId: number; vetoes: number; allows: number }
  | { type: "trade.executed"; tradeId: number }
  | { type: "trade.vetoed"; tradeId: number }
  | { type: "trade.failed"; tradeId: number; reason: string }
  | { type: "injury.changed"; teamId: number; playerId: string; status: string; week: number }
  | { type: "board.posted"; postId: number; authorTeamId: number; mentionTeamIds: number[]; depth: number }
  | { type: "draft.completed" }
  | { type: "week.finalized"; week: number }
  | { type: "waivers.processed"; runId: number };

export const DEFAULT_REPORTER_MODEL_ID = "anthropic/claude-sonnet-5";

export function reporterModelId(settings: Pick<LeagueSettings, "extra">): string {
  const extra = settings.extra as { reporterModelId?: string };
  return extra.reporterModelId ?? DEFAULT_REPORTER_MODEL_ID;
}

export interface CreateSessionInput {
  teamId: number | null; // null = reporter
  kind: SessionKind;
  trigger: string;
  idempotencyKey: string;
  modelId: string;
  dueAt: Date;
  /** Creation instant from the engine Clock (keeps simulation time consistent, §4.3). */
  now: Date;
  /** Real-event deadline; when omitted the kind's wall-time window applies from dueAt. */
  deadlineAt?: Date;
  context?: Record<string, unknown>;
}

/**
 * Idempotently create a queued session and the job that starts it.
 * Returns the session id, or null when the idempotency key already exists.
 */
export async function createSession(
  db: EngineDb,
  settings: LeagueSettings,
  input: CreateSessionInput,
): Promise<number | null> {
  const guard = sessionGuard(settings, input.kind);
  const deadlineAt =
    input.deadlineAt ??
    new Date(input.dueAt.getTime() + (guard.deadlineMinutes ?? 120) * 60_000);
  const rows = await db
    .insert(sessions)
    .values({
      teamId: input.teamId,
      kind: input.kind,
      trigger: input.trigger,
      idempotencyKey: input.idempotencyKey,
      modelId: input.modelId,
      status: "queued",
      createdAt: input.now,
      context: {
        ...(input.context ?? {}),
        deadline_at: deadlineAt.toISOString(),
        tool_call_ceiling: guard.toolCallCeiling,
      },
    })
    .onConflictDoNothing({ target: sessions.idempotencyKey })
    .returning({ id: sessions.id });
  const sessionId = rows[0]?.id;
  if (sessionId === undefined) return null;
  await db
    .insert(scheduledJobs)
    .values({
      type: "session.run",
      dueAt: input.dueAt,
      payload: { sessionId },
      idempotencyKey: `job:session.run:${input.idempotencyKey}`,
    })
    .onConflictDoNothing({ target: scheduledJobs.idempotencyKey });
  return sessionId;
}

async function activeTeam(db: EngineDb, teamId: number) {
  const rows = await db.select().from(teams).where(eq(teams.id, teamId));
  const t = rows[0];
  if (!t || t.paused || t.eliminated) return null;
  return t;
}

/**
 * Handle an event inside the emitting transaction (§9.3). Trade resolution
 * effects (vote thresholds, review end) live in trades.ts, not here — this
 * dispatcher only creates the follow-up sessions the table in §9.3 defines.
 */
export async function handleEvent(db: EngineDb, clock: Clock, event: EngineEvent): Promise<void> {
  const settings = await getSettings(db);
  const now = clock.now();
  const season = settings.season;
  const week = settings.currentWeek;

  switch (event.type) {
    case "trade.proposed": {
      const team = await activeTeam(db, event.counterpartyTeamId);
      if (!team) return;
      await createSession(db, settings, {
        teamId: team.id,
        kind: "trade_response",
        trigger: "trade.proposed",
        idempotencyKey: `session:${team.id}:trade_response:${season}:${week}:trade${event.tradeId}`,
        modelId: team.modelId,
        dueAt: now,
        now,
        context: { trade_id: event.tradeId },
      });
      return;
    }

    case "trade.accepted": {
      const all = await db.select().from(teams);
      const uninvolved = all.filter(
        (t) => !event.partyTeamIds.includes(t.id) && !t.paused && !t.eliminated,
      );
      let i = 0;
      for (const t of uninvolved) {
        await createSession(db, settings, {
          teamId: t.id,
          kind: "trade_vote",
          trigger: "trade.accepted",
          idempotencyKey: `session:${t.id}:trade_vote:${season}:${week}:trade${event.tradeId}`,
          modelId: t.modelId,
          dueAt: new Date(now.getTime() + i * 30_000), // staggered 30 s
          now,
          deadlineAt: event.reviewEndsAt,
          context: { trade_id: event.tradeId },
        });
        i++;
      }
      return;
    }

    case "trade.executed":
    case "trade.vetoed": {
      // reporter_trade_note (default on; settings.extra.reporterTradeNotes === false disables)
      const extra = settings.extra as { reporterTradeNotes?: boolean };
      if (extra.reporterTradeNotes === false) return;
      await createSession(db, settings, {
        teamId: null,
        kind: "reporter_trade_note",
        trigger: event.type,
        idempotencyKey: `session:reporter:reporter_trade_note:${season}:${week}:trade${event.tradeId}`,
        modelId: reporterModelId(settings),
        dueAt: now,
        now,
        context: { trade_id: event.tradeId },
      });
      return;
    }

    case "injury.changed": {
      const team = await activeTeam(db, event.teamId);
      if (!team) return;
      // only when the player's game is within 72 h (§8.6); deadline = max(kickoff, now + 60 min)
      const kickoff = await playerKickoff(db, season, event.week, event.playerId);
      if (!kickoff) return;
      const msToKickoff = kickoff.getTime() - now.getTime();
      if (msToKickoff <= 0 || msToKickoff > 72 * 3600_000) return;
      const deadline = new Date(Math.max(kickoff.getTime(), now.getTime() + 60 * 60_000));
      await createSession(db, settings, {
        teamId: team.id,
        kind: "injury_response",
        trigger: "injury.changed",
        idempotencyKey: injurySessionKey(team.id, event.playerId, event.status, event.week),
        modelId: team.modelId,
        dueAt: now,
        now,
        deadlineAt: deadline,
        context: { player_id: event.playerId, injury_status: event.status },
      });
      return;
    }

    case "board.posted": {
      for (const mentioned of event.mentionTeamIds) {
        if (mentioned === event.authorTeamId) continue;
        if (event.depth > 2) continue; // reply depth ≤ 2
        const team = await activeTeam(db, mentioned);
        if (!team) continue;
        // fewer than 3 board_reply sessions today (ET day)
        const dayStart = etDayStartUtc(now);
        const countRows = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(sessions)
          .where(
            and(
              eq(sessions.teamId, mentioned),
              eq(sessions.kind, "board_reply"),
              gte(sessions.createdAt, dayStart),
            ),
          );
        if ((countRows[0]?.n ?? 0) >= 3) continue;
        await createSession(db, settings, {
          teamId: team.id,
          kind: "board_reply",
          trigger: "board.posted",
          idempotencyKey: `session:${team.id}:board_reply:${season}:${week}:post${event.postId}`,
          modelId: team.modelId,
          dueAt: now,
          now,
          context: { thread_post_id: event.postId },
        });
      }
      return;
    }

    // Handled by the trade engine itself; nothing extra here (§9.3). These
    // must stay separate from draft.completed below: they fire on every vote
    // of every trade, and the season setup is emphatically not idempotent
    // against a mid-season league (it rewinds current_week to start_week and
    // clears every waiver window).
    case "trade.vote_cast":
    case "trade.failed":
      return;

    case "draft.completed": {
      await handleDraftCompleted(db, clock, settings);
      return;
    }

    // Handled by their workflows (M6); nothing extra here (§9.3).
    case "week.finalized":
    case "waivers.processed":
      return;
  }
}

/** UTC instant of midnight ET on the ET day containing `now`. */
function etDayStartUtc(now: Date): Date {
  const day = etDay(now); // YYYY-MM-DD
  const [y, m, d] = day.split("-").map(Number);
  return zonedTimeToUtc(y!, m!, d!, 0, 0);
}

/**
 * `draft.completed` (§9.3). The busiest handler in the league: it turns a
 * finished draft into a running season.
 */
async function handleDraftCompleted(db: EngineDb, clock: Clock, settings: LeagueSettings): Promise<void> {
  const now = clock.now();

  // start_week (§3.7): week 1 if the draft ended before week 1's first
  // kickoff, otherwise the first week whose earliest kickoff is after it.
  const games = await db
    .select({ week: nflGames.week, kickoffAt: nflGames.kickoffAt })
    .from(nflGames)
    .where(eq(nflGames.season, settings.season));
  const earliestByWeek = new Map<number, Date>();
  for (const g of games) {
    const current = earliestByWeek.get(g.week);
    if (!current || g.kickoffAt < current) earliestByWeek.set(g.week, g.kickoffAt);
  }
  let startWeek = 1;
  for (const week of [...earliestByWeek.keys()].sort((a, b) => a - b)) {
    if (earliestByWeek.get(week)! > now) {
      startWeek = week;
      break;
    }
  }

  await updateSettings(db, { phase: "regular", startWeek, currentWeek: startWeek });

  // Rule 3 of §3.4: after the draft every unrostered player is a free agent.
  await db.update(players).set({ waiverUntil: null });

  // Initial waiver order = reverse of the draft order (§3.4): the team with
  // the last first-round pick is first.
  const draftRow = (await db.select().from(draft).where(eq(draft.id, 1)))[0];
  const order = draftRow?.order ?? [];
  const reversed = [...order].reverse();
  for (const [index, teamId] of reversed.entries()) {
    await db.update(teams).set({ waiverPriority: index + 1 }).where(eq(teams.id, teamId));
  }

  // The season schedule.
  await createSeasonSchedule(db, clock);

  // Every team needs a lineup: a weekly_review 15 minutes after the draft,
  // staggered so the concurrency cap is respected (§9.3).
  const allTeams = (await db.select().from(teams)).filter((t) => !t.paused);
  const fresh = await getSettings(db);
  let i = 0;
  for (const team of allTeams) {
    await createSession(db, fresh, {
      teamId: team.id,
      kind: "weekly_review",
      trigger: "draft.completed",
      idempotencyKey: `session:${team.id}:weekly_review:${fresh.season}:${startWeek}:post_draft`,
      modelId: team.modelId,
      dueAt: new Date(now.getTime() + 15 * 60_000 + i * 60_000),
      now,
      context: { week: startWeek, post_draft: true },
    });
    i++;
  }

  // And the reporter grades the draft.
  await createSession(db, fresh, {
    teamId: null,
    kind: "reporter_draft_grades",
    trigger: "draft.completed",
    idempotencyKey: `session:reporter:reporter_draft_grades:${fresh.season}:${startWeek}:draft`,
    modelId: reporterModelId(fresh),
    dueAt: new Date(now.getTime() + 5 * 60_000),
    now,
    context: { week: startWeek },
  });

  // §12.3: the commissioner digest also goes out once after the draft, not
  // only on Tuesdays — the draft is the biggest thing that happens all season.
  await db
    .insert(scheduledJobs)
    .values({
      type: "digest.weekly",
      dueAt: new Date(now.getTime() + 30 * 60_000),
      payload: { week: startWeek, reason: "draft" },
      idempotencyKey: `job:digest.weekly:${fresh.season}:draft`,
    })
    .onConflictDoNothing({ target: scheduledJobs.idempotencyKey });

  // Finally, plan the first week (the job runner starts weekPlanWorkflow).
  await db
    .insert(scheduledJobs)
    .values({
      type: "week.plan",
      dueAt: new Date(now.getTime() + 60_000),
      payload: { week: startWeek },
      idempotencyKey: `job:week.plan:${fresh.season}:${startWeek}`,
    })
    .onConflictDoNothing({ target: scheduledJobs.idempotencyKey });
}
