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

/** Running sessions right now, and whether this team already has one. */
async function slotAvailable(database: EngineDb, sessionId: number, teamId: number | null): Promise<boolean> {
  const running = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(sessions)
    .where(and(eq(sessions.status, "running"), ne(sessions.id, sessionId)));
  if ((running[0]?.n ?? 0) >= MAX_CONCURRENT_SESSIONS) return false;
  if (teamId === null) return true;
  const mine = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(sessions)
    .where(and(eq(sessions.status, "running"), eq(sessions.teamId, teamId), ne(sessions.id, sessionId)));
  return (mine[0]?.n ?? 0) === 0;
}

export async function runAgentSession(sessionId: number): Promise<RunSessionResult> {
  const database = db();
  const clock = await leagueClock();
  const session = (await database.select().from(sessions).where(eq(sessions.id, sessionId)))[0];
  if (!session) throw new Error(`session ${sessionId} not found`);
  if (session.status !== "queued") {
    return { status: session.status as RunSessionResult["status"], endedBy: null, toolCalls: 0, invalidToolCalls: 0, steps: 0 };
  }

  const deadlineAt = new Date(String(session.context.deadline_at));
  if (!(await slotAvailable(database, sessionId, session.teamId))) {
    if (clock.now() >= deadlineAt) {
      await database
        .update(sessions)
        .set({ status: "skipped", endedAt: clock.now(), updatedAt: clock.now() })
        .where(eq(sessions.id, sessionId));
      return { status: "skipped", endedBy: "deadline", toolCalls: 0, invalidToolCalls: 0, steps: 0 };
    }
    // Leave it queued: the next tick tries again (the tick runs every minute,
    // which is the same cadence as the spec's 30-second poll for our purposes).
    return { status: "skipped", endedBy: null, toolCalls: 0, invalidToolCalls: 0, steps: 0 };
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
