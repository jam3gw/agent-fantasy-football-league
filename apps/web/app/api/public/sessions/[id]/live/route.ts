/**
 * Public read-only JSON: one session's live state (SPEC §12.1) — the session
 * header, the transcript events after a cursor, and the in-flight partial
 * model output staged in `session_stream` while a step streams.
 *
 * The live transcript view polls this with `after` set to the last sequence
 * number it has, so steady-state responses carry only what is new. Rate
 * limited to 60 requests per minute per IP like the rest of the public API.
 */
import { and, asc, eq, gt } from "drizzle-orm";
import { sessionEvents, sessionStream, sessions, teams } from "@league/engine";
import { db } from "../../../../../../lib/db";
import { publicJson, rateLimitResponse } from "../../../../../../lib/rateLimit";

/** Events per response; the client keeps polling until it has caught up. */
const EVENT_PAGE_SIZE = 500;

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const limited = rateLimitResponse(request);
  if (limited) return limited;

  const { id: idParam } = await ctx.params;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return publicJson({ error: "not_found", detail: `no session ${idParam}` }, 404);
  }

  const session = (await db().select().from(sessions).where(eq(sessions.id, id)))[0];
  if (!session) return publicJson({ error: "not_found", detail: `no session ${idParam}` }, 404);

  const url = new URL(request.url);
  const afterRaw = Number(url.searchParams.get("after") ?? -1);
  const after = Number.isFinite(afterRaw) ? afterRaw : -1;

  const events = await db()
    .select()
    .from(sessionEvents)
    .where(and(eq(sessionEvents.sessionId, id), gt(sessionEvents.seq, after)))
    .orderBy(asc(sessionEvents.seq))
    .limit(EVENT_PAGE_SIZE);

  // The staged partial only means something while the session is running; a
  // terminal session's row (if a crash ever left one) is noise, not thinking.
  const stream =
    session.status === "running"
      ? ((await db().select().from(sessionStream).where(eq(sessionStream.sessionId, id)))[0] ?? null)
      : null;

  const team = session.teamId
    ? ((await db().select().from(teams).where(eq(teams.id, session.teamId)))[0] ?? null)
    : null;

  return publicJson({
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
    hasMore: events.length === EVENT_PAGE_SIZE,
    stream: stream
      ? { stepNo: stream.stepNo, reasoning: stream.reasoning, text: stream.text, updatedAt: stream.updatedAt }
      : null,
  });
}
