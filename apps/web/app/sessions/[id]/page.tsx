/**
 * Session transcript (SPEC §12.1): the brief and context snapshot collapsed,
 * every assistant message, every tool call with its arguments and result,
 * usage and cost, and any errors. Public by §2 — it renders only what is
 * stored in `session_events`, never an environment value.
 *
 * A queued or running session renders the live view instead: it polls the
 * public live API with SWR and shows the in-flight partial output while the
 * model streams (the same §12.1 transcript, just ahead of the CDN window).
 */
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { sessionEvents, sessions, teams } from "@league/engine";
import { Card, Empty, PageTitle } from "@/components/ui";
import { Json, SessionSummaryCard, TranscriptEventItem } from "@/components/transcript";
import { db } from "@/lib/db";
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

  const title = `Session ${session.id} — ${session.kind}`;
  const subtitle = team
    ? `${team.name ?? team.slug} — ${team.modelLabel}`
    : `Reporter or league session — ${session.modelId}`;

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

  // Queued or running: hand the page to the live view, which fetches the
  // transcript fresh (this shell may be up to `revalidate` seconds stale) and
  // then streams. A session that has since finished still renders fully there.
  if (session.status === "queued" || session.status === "running") {
    return (
      <div className="space-y-6">
        <PageTitle title={title} subtitle={subtitle} />
        <LiveSession
          sessionId={session.id}
          initialSession={summary}
          initialTeam={team ? { slug: team.slug, name: team.name, modelLabel: team.modelLabel } : null}
        />
      </div>
    );
  }

  const events = await safe(
    () => db().select().from(sessionEvents).where(eq(sessionEvents.sessionId, id)).orderBy(asc(sessionEvents.seq)),
    [],
  );

  const errors = events.filter((e) => e.type === "error");

  return (
    <div className="space-y-6">
      <PageTitle title={title} subtitle={subtitle} />

      <SessionSummaryCard
        session={summary}
        team={team ? { slug: team.slug, name: team.name, modelLabel: team.modelLabel } : null}
      />

      {errors.length > 0 ? (
        <Card title={`Errors (${errors.length})`}>
          {errors.map((e) => (
            <Json key={e.id} value={e.content} />
          ))}
        </Card>
      ) : null}

      <Card title={`Transcript (${events.length} events)`}>
        {events.length === 0 ? (
          <Empty>No transcript events were recorded for this session.</Empty>
        ) : (
          <ol className="space-y-4">
            {events.map((event) => (
              <TranscriptEventItem key={event.id} event={event} />
            ))}
          </ol>
        )}
      </Card>

      <p className="text-xs text-muted">
        Every session is public: the same prompt, the same tools, and the same information go to all twelve models.
      </p>
    </div>
  );
}
