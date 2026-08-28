import "server-only";
/**
 * Wire one queued session to the agent runner (SPEC §8.2, §9.2).
 *
 * The concurrency rule (§9.2: at most 6 running sessions, one per team) is
 * enforced here before the loop starts; a session that cannot get a slot before
 * its deadline is marked `skipped`, exactly as the wait-for-slot step requires.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import type { EngineDb } from "@league/engine";
import {
  buildContextSnapshot,
  byokCredentialsFromEnv,
  createModelStep,
  runSession,
  toolsForKind,
  DEFAULT_BYOK_ROUTES,
  buildReporterSystemPrompt,
  buildSystemPrompt,
  type RunSessionResult,
} from "@league/agent";
import { getSettings, sessions, teams } from "@league/engine";
import { formatEt } from "@league/shared";
import { db, leagueClock } from "./db";
import { env } from "./env";
import { notifyAlarms } from "./alarms";
import { readBrief } from "./briefs";

const MAX_CONCURRENT_SESSIONS = 6;

/**
 * Advisory lock key for the slot check. Counting running sessions and then
 * marking one running is only safe if nobody else does the same in between:
 * twelve lineup checks booked for the same minute all read "0 running" and all
 * proceed, breaking both the cap of 6 and the one-per-team rule (§9.2). The
 * lock is transaction-scoped, so it is released whatever happens.
 */
const SLOT_LOCK_KEY = 728_314_501;

/**
 * Take one of the six slots for this session, atomically. Returns false when
 * the league is at its cap or this team is already running something — the
 * session stays `queued` and the tick's sweeper tries again next minute, which
 * is §9.2's wait-for-slot step.
 */
export async function claimSlot(database: EngineDb, sessionId: number, teamId: number | null): Promise<boolean> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SLOT_LOCK_KEY})`);

    const running = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(sessions)
      .where(and(eq(sessions.status, "running"), ne(sessions.id, sessionId)));
    if ((running[0]?.n ?? 0) >= MAX_CONCURRENT_SESSIONS) return false;

    if (teamId !== null) {
      const mine = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(sessions)
        .where(and(eq(sessions.status, "running"), eq(sessions.teamId, teamId), ne(sessions.id, sessionId)));
      if ((mine[0]?.n ?? 0) > 0) return false;
    }

    // Only a still-queued session may be claimed, so two ticks racing on the
    // same session cannot both start it.
    const claimed = await tx
      .update(sessions)
      .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), eq(sessions.status, "queued")))
      .returning({ id: sessions.id });
    return claimed.length > 0;
  });
}

/** What one step of the session workflow reports back. */
export type SessionRunOutcome = RunSessionResult;

export async function runAgentSession(
  sessionId: number,
  options: { stepBudgetMs?: number } = {},
): Promise<RunSessionResult> {
  const database = db();
  const clock = await leagueClock();
  const session = (await database.select().from(sessions).where(eq(sessions.id, sessionId)))[0];
  if (!session) throw new Error(`session ${sessionId} not found`);
  // A session already `running` is one the step cap interrupted: resume it
  // rather than reporting it done. Anything terminal is left alone.
  if (session.status !== "queued" && session.status !== "running") {
    return { status: session.status as RunSessionResult["status"], endedBy: null, toolCalls: 0, invalidToolCalls: 0, steps: 0 };
  }
  const resuming = session.status === "running";

  const deadlineAt = new Date(String(session.context.deadline_at));
  if (!resuming && !(await claimSlot(database, sessionId, session.teamId))) {
    if (clock.now() >= deadlineAt) {
      await database
        .update(sessions)
        .set({ status: "skipped", endedAt: clock.now(), updatedAt: clock.now() })
        .where(and(eq(sessions.id, sessionId), eq(sessions.status, "queued")));
      return { status: "skipped", endedBy: "deadline", toolCalls: 0, invalidToolCalls: 0, steps: 0 };
    }
    // Still queued. `startQueuedSessions` in the tick retries every minute
    // until a slot frees up or the deadline passes (§9.2).
    return { status: "queued", endedBy: null, toolCalls: 0, invalidToolCalls: 0, steps: 0 };
  }

  const settings = await getSettings(database);
  const team = session.teamId === null ? null : (await database.select().from(teams).where(eq(teams.id, session.teamId)))[0];

  const modelStep = createModelStep(database, {
    byokRoutes: (settings.extra as { byokRoutes?: typeof DEFAULT_BYOK_ROUTES }).byokRoutes ?? DEFAULT_BYOK_ROUTES,
    byokCredentials: byokCredentialsFromEnv(),
  });

  return runSession(sessionId, {
    db: database,
    clock,
    ...(options.stepBudgetMs === undefined ? {} : { stepBudgetMs: options.stepBudgetMs }),
    tools: toolsForKind(session.kind),
    toolConfig: env.toolConfig,
    modelStep,
    buildSystemPrompt: async () => {
      const vars = {
        modelLabel: team?.modelLabel ?? session.modelId,
        datetimeEt: formatEt(clock.now()),
        phase: settings.phase,
        week: settings.currentWeek,
        startWeek: settings.startWeek,
      };
      return team === null
        ? buildReporterSystemPrompt(vars)
        : buildSystemPrompt({ ...vars, teamName: team.name ?? "(unnamed)", teamId: team.id });
    },
    buildContext: async (ctx) => ({
      brief: await readBrief(session.kind, session.context),
      snapshot: await buildContextSnapshot(ctx),
    }),
    onAlarms: async (alarms) => notifyAlarms(database, clock, alarms),
  });
}
