import "server-only";
/**
 * Workflow run streams (SPEC §9.2 workflows; Workflow DevKit
 * `docs/foundations/streaming`). Every workflow run has a default writable
 * stream that steps can write to with `getWritable()`; chunks land in the
 * Vercel Workflows dashboard's Streams tab and on `run.readable` for any
 * consumer. Nothing league-critical lives here: the durable record is
 * `session_events` and the engine tables, and every write below is
 * observability only — a failed write must never fail a step, and code that
 * runs outside a workflow context (unit tests, local scripts) must not
 * notice the stream exists.
 */
import { getWritable } from "workflow";
import type { PartialSink, StreamPartial } from "@league/agent";

/** One chunk on a run's default stream. Flat and JSON-serializable. */
export type RunStreamChunk =
  /** One agent-session workflow step finished (up to every ~9 minutes). */
  | {
      kind: "session_step";
      sessionId: number;
      status: string;
      endedBy: string | null;
      steps: number;
      toolCalls: number;
      invalidToolCalls: number;
    }
  /**
   * Newly streamed model output — the *suffix* since the previous chunk of
   * the same step, not the accumulated partial the DB sink stages. Readers
   * concatenate; a new `stepNo` starts over.
   */
  | { kind: "model_delta"; sessionId: number; stepNo: number; reasoning: string; text: string }
  /** One draft pick step finished. */
  | { kind: "draft_pick"; picksMade: number; autoPicks: number; completed: boolean; pausedAt: number | null };

/**
 * Write one chunk to the current run's default stream. `getWritable()` throws
 * outside a workflow or step function, and a stream hiccup is not a session
 * failure, so every path is swallowed. The writer lock is scoped to this call
 * — the SDK flushes on release, and locks do not span steps — so
 * acquire-write-release per chunk is the supported pattern.
 */
export async function emitRunChunk(chunk: RunStreamChunk): Promise<void> {
  let writable: WritableStream<RunStreamChunk>;
  try {
    writable = getWritable<RunStreamChunk>();
  } catch {
    return; // No workflow context (tests, scripts): nowhere to stream.
  }
  const writer = writable.getWriter();
  try {
    await writer.write(chunk);
  } catch {
    // Observability only — dropped on any error.
  } finally {
    writer.releaseLock();
  }
}

/**
 * The suffix `next` adds over `prev`, or `null` when there is nothing new.
 * The model-step sink reports the whole accumulated partial each flush, so
 * the delta is a `slice` while the step and prefix match; a new step — or a
 * partial that is not an extension (a retry reset it) — starts over with the
 * full strings.
 */
export function partialDelta(
  prev: StreamPartial,
  next: StreamPartial,
): { reasoning: string; text: string } | null {
  const extendsPrev =
    prev.stepNo === next.stepNo &&
    next.reasoning.startsWith(prev.reasoning) &&
    next.text.startsWith(prev.text);
  const reasoning = extendsPrev ? next.reasoning.slice(prev.reasoning.length) : next.reasoning;
  const text = extendsPrev ? next.text.slice(prev.text.length) : next.text;
  if (reasoning === "" && text === "") return null;
  return { reasoning, text };
}

/**
 * A `PartialSink` that forwards model-output deltas to the run stream, for
 * composing next to `createPartialSink` (which stages the accumulated partial
 * for the public live transcript, §12.1). `emit` is injectable for tests.
 */
export function createRunStreamPartialSink(
  sessionId: number,
  emit: (chunk: RunStreamChunk) => Promise<void> = emitRunChunk,
): PartialSink {
  // stepNo starts at 0 and the closing step uses -1, so -2 never collides.
  let prev: StreamPartial = { stepNo: -2, reasoning: "", text: "" };
  return async (partial) => {
    const delta = partialDelta(prev, partial);
    prev = partial;
    if (delta === null) return;
    await emit({ kind: "model_delta", sessionId, stepNo: partial.stepNo, ...delta });
  };
}
