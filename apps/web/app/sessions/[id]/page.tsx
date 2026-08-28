/**
 * Session transcript (SPEC §12.1): the brief and context snapshot collapsed,
 * every assistant message, every tool call with its arguments and result,
 * usage and cost, and any errors. Public by §2 — it renders only what is
 * stored in `session_events`, never an environment value.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { sessionEvents, sessions, teams } from "@league/engine";
import { formatEt } from "@league/shared";
import { Badge, Card, Empty, PageTitle, money } from "@/components/ui";
import { db } from "@/lib/db";
import { safeRead as safe } from "@/lib/queries";

// §12.1: 300s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 300s stale.
export const revalidate = 300;

function Json({ value }: { value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre className="mt-2 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-3 font-mono text-xs leading-relaxed">
      {text ?? "null"}
    </pre>
  );
}

function Collapsible({ summary, value }: { summary: string; value: unknown }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-accent">{summary}</summary>
      <Json value={value} />
    </details>
  );
}

const TYPE_TONE: Record<string, "neutral" | "accent" | "warn" | "danger"> = {
  system: "neutral",
  user: "neutral",
  assistant: "accent",
  tool_call: "neutral",
  tool_result: "neutral",
  error: "danger",
  info: "warn",
};

interface Usage {
  [k: string]: unknown;
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

  const events = await safe(
    () => db().select().from(sessionEvents).where(eq(sessionEvents.sessionId, id)).orderBy(asc(sessionEvents.seq)),
    [],
  );

  const errors = events.filter((e) => e.type === "error");

  return (
    <div className="space-y-6">
      <PageTitle
        title={`Session ${session.id} — ${session.kind}`}
        subtitle={
          team ? `${team.name ?? team.slug} — ${team.modelLabel}` : `Reporter or league session — ${session.modelId}`
        }
      />

      <Card title="Session">
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Status</dt>
            <dd className="mt-0.5">
              <Badge
                tone={
                  session.status === "succeeded"
                    ? "accent"
                    : session.status === "failed" || session.status === "timed_out"
                      ? "danger"
                      : "neutral"
                }
              >
                {session.status}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Trigger</dt>
            <dd className="mt-0.5">{session.trigger}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Model</dt>
            <dd className="mt-0.5 break-words">{session.modelId}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Started / ended</dt>
            <dd className="mt-0.5 text-xs">
              {session.startedAt ? formatEt(session.startedAt) : "not started"}
              <br />
              {session.endedAt ? formatEt(session.endedAt) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Tokens</dt>
            <dd className="mt-0.5 text-xs tabular-nums">
              in {session.inputTokens.toLocaleString()}
              <br />
              out {session.outputTokens.toLocaleString()}
              <br />
              reasoning {session.reasoningTokens.toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Cost</dt>
            <dd className="mt-0.5 tabular-nums">{money(session.costUsd)}</dd>
            <dd className="text-xs text-muted">
              {session.toolCalls} tool calls, {session.invalidToolCalls} invalid
            </dd>
          </div>
        </dl>
        {session.endedBy ? (
          <p className="mt-3 text-sm text-muted">Ended by: {session.endedBy.replace("_", " ")}.</p>
        ) : null}
        {session.error ? (
          <p className="mt-3 text-sm text-danger">Error: {session.error}</p>
        ) : null}
        {team ? (
          <p className="mt-3 text-sm">
            <Link href={`/teams/${team.slug}`} className="text-accent hover:underline">
              All of this team&apos;s sessions
            </Link>
          </p>
        ) : null}
        <Collapsible summary="Session context (as stored)" value={session.context} />
      </Card>

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
            {events.map((event) => {
              const content = event.content as Record<string, unknown>;
              return (
                <li key={event.id} className="rounded border border-border p-3">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-xs text-muted tabular-nums">#{event.seq}</span>
                    <Badge tone={TYPE_TONE[event.type] ?? "neutral"}>{event.type.replace("_", " ")}</Badge>
                    {typeof content.name === "string" ? (
                      <span className="font-mono text-xs">{content.name}</span>
                    ) : null}
                    <span className="text-xs text-muted">{formatEt(event.createdAt)}</span>
                  </div>

                  {event.type === "system" ? (
                    <Collapsible summary="System prompt" value={content.prompt ?? content} />
                  ) : null}

                  {event.type === "user" ? (
                    <>
                      <Collapsible summary="Brief" value={content.brief ?? "(none)"} />
                      <Collapsible summary="Context snapshot" value={content.snapshot ?? content} />
                    </>
                  ) : null}

                  {event.type === "assistant" ? (
                    <>
                      {typeof content.text === "string" && content.text.trim() !== "" ? (
                        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{content.text}</p>
                      ) : (
                        <p className="mt-2 text-sm text-muted">(no text — tool calls only)</p>
                      )}
                      {Array.isArray(content.tool_calls) && content.tool_calls.length > 0 ? (
                        <Collapsible
                          summary={`Tool calls in this step (${content.tool_calls.length})`}
                          value={content.tool_calls}
                        />
                      ) : null}
                      <p className="mt-2 text-xs text-muted">
                        {typeof content.cost_usd === "number" ? `step cost ${money(content.cost_usd)}` : null}
                        {typeof content.billed_to === "string" ? ` — billed to ${content.billed_to}` : null}
                      </p>
                      {content.usage ? <Collapsible summary="Usage" value={content.usage as Usage} /> : null}
                    </>
                  ) : null}

                  {event.type === "tool_call" ? <Collapsible summary="Arguments" value={content.args ?? content} /> : null}

                  {event.type === "tool_result" ? (
                    <Collapsible summary="Result" value={content.result ?? content} />
                  ) : null}

                  {event.type === "error" || event.type === "info" ? <Json value={content} /> : null}
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      <p className="text-xs text-muted">
        Every session is public: the same prompt, the same tools, and the same information go to all twelve models.
      </p>
    </div>
  );
}
