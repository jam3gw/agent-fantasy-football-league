/**
 * Transcript rendering shared by the static session page (server component)
 * and the live session view (client component). Everything here is pure
 * presentation over serialisable props — no hooks, no server-only imports —
 * so both sides render the exact same markup for the same event (SPEC §12.1).
 */
import Link from "next/link";
import { formatEt } from "@league/shared";
import { Badge, Card, money } from "@/components/ui";

export function Json({ value }: { value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre className="mt-2 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-3 font-mono text-xs leading-relaxed">
      {text ?? "null"}
    </pre>
  );
}

export function Collapsible({ summary, value }: { summary: string; value: unknown }) {
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

/**
 * The thinking log of an assistant event. New events carry it first-class as
 * `content.reasoning`; events recorded before it existed may still hold
 * reasoning parts inside the raw assistant message, so those are read as a
 * fallback rather than left invisible.
 */
export function assistantReasoning(content: Record<string, unknown>): string {
  if (typeof content.reasoning === "string" && content.reasoning.trim() !== "") return content.reasoning;
  const raw = content.raw as { content?: unknown } | undefined;
  if (!raw || !Array.isArray(raw.content)) return "";
  return (raw.content as unknown[])
    .filter(
      (p): p is { type: "reasoning"; text: string } =>
        typeof p === "object" && p !== null &&
        (p as Record<string, unknown>).type === "reasoning" &&
        typeof (p as Record<string, unknown>).text === "string",
    )
    .map((p) => p.text)
    .join("\n\n")
    .trim();
}

/** One transcript event, serialisable across the live API. */
export interface TranscriptEvent {
  id: number;
  seq: number;
  type: string;
  content: Record<string, unknown>;
  /** ISO string over the wire, Date when read straight from the database. */
  createdAt: string | Date;
}

export function TranscriptEventItem({ event }: { event: TranscriptEvent }) {
  const content = event.content;
  const reasoning = event.type === "assistant" ? assistantReasoning(content) : "";
  return (
    <li className="rounded border border-border p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-xs text-muted tabular-nums">#{event.seq}</span>
        <Badge tone={TYPE_TONE[event.type] ?? "neutral"}>{event.type.replace("_", " ")}</Badge>
        {typeof content.name === "string" ? <span className="font-mono text-xs">{content.name}</span> : null}
        <span className="text-xs text-muted">{formatEt(new Date(event.createdAt))}</span>
      </div>

      {event.type === "system" ? <Collapsible summary="System prompt" value={content.prompt ?? content} /> : null}

      {event.type === "user" ? (
        <>
          <Collapsible summary="Brief" value={content.brief ?? "(none)"} />
          <Collapsible summary="Context snapshot" value={content.snapshot ?? content} />
        </>
      ) : null}

      {event.type === "assistant" ? (
        <>
          {reasoning !== "" ? (
            <div className="mt-2">
              <span className="text-xs uppercase tracking-wide text-muted">thinking</span>
              <p className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words text-sm italic leading-relaxed text-muted">
                {reasoning}
              </p>
            </div>
          ) : null}
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

      {event.type === "tool_result" ? <Collapsible summary="Result" value={content.result ?? content} /> : null}

      {event.type === "error" || event.type === "info" ? <Json value={content} /> : null}
    </li>
  );
}

/** The session header fields, serialisable across the live API. */
export interface SessionSummaryData {
  id: number;
  kind: string;
  status: string;
  trigger: string;
  modelId: string;
  startedAt: string | Date | null;
  endedAt: string | Date | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  toolCalls: number;
  invalidToolCalls: number;
  endedBy: string | null;
  error: string | null;
  context: unknown;
}

export interface SessionTeamData {
  slug: string;
  name: string | null;
  modelLabel: string;
}

export function statusTone(status: string): "neutral" | "accent" | "danger" {
  if (status === "succeeded") return "accent";
  if (status === "failed" || status === "timed_out") return "danger";
  return "neutral";
}

export function SessionSummaryCard({
  session,
  team,
  action,
}: {
  session: SessionSummaryData;
  team: SessionTeamData | null;
  action?: React.ReactNode;
}) {
  return (
    <Card title="Session" action={action}>
      <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Status</dt>
          <dd className="mt-0.5">
            <Badge tone={statusTone(session.status)}>{session.status}</Badge>
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
            {session.startedAt ? formatEt(new Date(session.startedAt)) : "not started"}
            <br />
            {session.endedAt ? formatEt(new Date(session.endedAt)) : "—"}
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
      {session.error ? <p className="mt-3 text-sm text-danger">Error: {session.error}</p> : null}
      {team ? (
        <p className="mt-3 text-sm">
          <Link href={`/teams/${team.slug}`} className="text-accent hover:underline">
            All of this team&apos;s sessions
          </Link>
        </p>
      ) : null}
      <Collapsible summary="Session context (as stored)" value={session.context} />
    </Card>
  );
}
