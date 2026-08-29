/**
 * The transcript's shared vocabulary: the event and session shapes that cross
 * the live API, the raw JSON view every step falls back to, and the reader for
 * an assistant event's thinking log.
 *
 * The rendering itself lives in `components/session-steps.tsx` and
 * `components/session-view.tsx`. This file stays free of layout so the types
 * can be imported from anywhere — a server component, the client live view,
 * or the pure derivation layer in `lib/sessionTranscript.ts` — without
 * dragging a component tree along with them.
 */

/** Arguments, a result, an unknown event body: shown verbatim (SPEC §12.1). */
export function Json({ value }: { value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre className="mt-2 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-3 font-mono text-xs leading-relaxed">
      {text ?? "null"}
    </pre>
  );
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
