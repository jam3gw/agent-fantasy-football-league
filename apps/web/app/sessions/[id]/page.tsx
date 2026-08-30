/**
 * Session transcript (SPEC §12.1): the brief and context snapshot collapsed,
 * every assistant message, every tool call with its arguments and result,
 * usage and cost, and any errors. Public by §2 — it renders only what is
 * stored in `session_events`, never an environment value.
 *
 * The page leads with what the agent decided and then shows how it got there:
 * one card per assistant turn with that turn's tool calls nested inside,
 * beside a rail that says where in the session you are. Every requirement
 * above is still on the page — the raw arguments and result of every call are
 * one disclosure away inside the step that made it.
 *
 * A queued or running session renders the live view instead: it polls the
 * public live API with SWR and shows the in-flight partial output while the
 * model streams (the same §12.1 transcript, just ahead of the CDN window).
 */
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { sessionEvents, sessions, teams } from "@league/engine";
import { Empty } from "@/components/ui";
import { SessionFacts, SessionHeader, SessionTranscript } from "@/components/session-view";
import { db } from "@/lib/db";
import { groupSteps } from "@/lib/sessionTranscript";
import { safeRead as safe } from "@/lib/queries";
import LiveSession from "./live";

// §12.1: 300s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 300s stale.
export const revalidate = 300;

/**
 * Transcripts are unbounded and only exist once the database has them, so none is
 * prerendered. Declaring the list anyway is what makes Next treat the route as
 * static-with-revalidation: without it the segment is server-rendered per
 * request and answers `no-store`, so §12.1's window never reaches the CDN.
 */
export function generateStaticParams() {
  return [];
}

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const rows = await safe(() => db().select().from(sessions).where(eq(sessions.id, id)), []);
  const session = rows[0];
  if (!session) notFound();

  const team = session.teamId
    ? (await safe(() => db().select().from(teams).where(eq(teams.id, session.teamId!)), []))[0]
    : undefined;

  const summary = {
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
  };
  const teamData = team ? { slug: team.slug, name: team.name, modelLabel: team.modelLabel } : null;

  // Queued or running: hand the page to the live view, which fetches the
  // transcript fresh (this shell may be up to `revalidate` seconds stale) and
  // then streams. A session that has since finished still renders fully there.
  if (session.status === "queued" || session.status === "running") {
    return <LiveSession sessionId={session.id} initialSession={summary} initialTeam={teamData} />;
  }

  const events = await safe(
    () => db().select().from(sessionEvents).where(eq(sessionEvents.sessionId, id)).orderBy(asc(sessionEvents.seq)),
    [],
  );

  return (
    <div className="flex flex-col gap-5">
      <SessionHeader session={summary} team={teamData} />
      <SessionFacts session={summary} steps={groupSteps(events).length} />

      {events.length === 0 ? (
        <Empty>No transcript events were recorded for this session.</Empty>
      ) : (
        <SessionTranscript events={events} session={summary} team={teamData} />
      )}
    </div>
  );
}
