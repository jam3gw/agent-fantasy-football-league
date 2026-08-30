import "server-only";
/**
 * The live-transcript read behind `/api/public/sessions/[id]/live` (SPEC
 * §12.1). Kept out of the route file so the field allowlist and the cursor
 * logic are unit-testable against PGlite — the session row holds fields that
 * are NOT public (`idempotency_key`, `workflow_run_id`), so what leaves this
 * function is enumerated, never spread.
 */
import { and, asc, eq, gt } from "drizzle-orm";
import type { EngineDb } from "@league/engine";
import { sessionEvents, sessionStream, sessions, teams } from "@league/engine";

/** Events per response; the client keeps polling until it has caught up. */
export const LIVE_EVENT_PAGE_SIZE = 500;

export interface SessionLivePayload {
  session: {
    id: number;
    kind: string;
    status: string;
    trigger: string;
    modelId: string;
    startedAt: Date | null;
    endedAt: Date | null;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    costUsd: number;
    toolCalls: number;
    invalidToolCalls: number;
    endedBy: string | null;
    error: string | null;
    context: Record<string, unknown>;
  };
  team: { slug: string; name: string | null; modelLabel: string } | null;
  events: Array<{ id: number; seq: number; type: string; content: Record<string, unknown>; createdAt: Date }>;
  hasMore: boolean;
  stream: { stepNo: number; reasoning: string; text: string; updatedAt: Date } | null;
}

/** `null` when the session does not exist (the route answers 404). */
export async function readSessionLive(
  database: EngineDb,
  id: number,
  after: number,
  pageSize: number = LIVE_EVENT_PAGE_SIZE,
): Promise<SessionLivePayload | null> {
  const session = (await database.select().from(sessions).where(eq(sessions.id, id)))[0];
  if (!session) return null;

  const events = await database
    .select()
    .from(sessionEvents)
    .where(and(eq(sessionEvents.sessionId, id), gt(sessionEvents.seq, after)))
    .orderBy(asc(sessionEvents.seq))
    .limit(pageSize);

  // The staged partial only means something while the session is running; a
  // terminal session's row (if a crash ever left one) is noise, not thinking.
  const stream =
    session.status === "running"
      ? ((await database.select().from(sessionStream).where(eq(sessionStream.sessionId, id)))[0] ?? null)
      : null;

  const team = session.teamId
    ? ((await database.select().from(teams).where(eq(teams.id, session.teamId)))[0] ?? null)
    : null;

  return {
    session: {
      id: session.id,
      kind: session.kind,
      status: session.status,
      trigger: session.trigger,
      modelId: session.modelId,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      reasoningTokens: session.reasoningTokens,
      costUsd: session.costUsd,
      toolCalls: session.toolCalls,
      invalidToolCalls: session.invalidToolCalls,
      endedBy: session.endedBy,
      error: session.error,
      context: session.context,
    },
    team: team ? { slug: team.slug, name: team.name, modelLabel: team.modelLabel } : null,
    events: events.map((e) => ({ id: e.id, seq: e.seq, type: e.type, content: e.content, createdAt: e.createdAt })),
    hasMore: events.length === pageSize,
    stream: stream
      ? { stepNo: stream.stepNo, reasoning: stream.reasoning, text: stream.text, updatedAt: stream.updatedAt }
      : null,
  };
}
