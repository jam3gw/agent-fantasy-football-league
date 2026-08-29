/**
 * The live "thinking" stream (SPEC §12.1). While a model step streams, the
 * runner stages its partial reasoning and text in `session_stream` — one row
 * per session, upserted on a throttle — so the public transcript page can show
 * what an agent is writing while it writes it. The row is transient: the loop
 * deletes it as soon as the step's assistant event lands in `session_events`,
 * and the durable transcript never reads it.
 */
import { eq } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "@league/engine";
import { sessionStream } from "@league/engine";

export interface StreamPartial {
  /** The session loop's step counter; -1 for the closing step. */
  stepNo: number;
  /** Reasoning streamed so far in this step, as far as the provider shows it. */
  reasoning: string;
  /** Assistant text streamed so far in this step. */
  text: string;
}

/** How a model step reports its in-flight partial output. */
export type PartialSink = (partial: StreamPartial) => Promise<void>;

/**
 * Build the sink that stages partials for one session. Failures are swallowed:
 * a hiccup writing a preview must never kill a model step mid-stream — the
 * full message still reaches `session_events` when the step completes.
 */
export function createPartialSink(db: EngineDb, clock: Clock, sessionId: number): PartialSink {
  return async (partial) => {
    const row = {
      stepNo: partial.stepNo,
      reasoning: partial.reasoning,
      text: partial.text,
      updatedAt: clock.now(),
    };
    try {
      await db
        .insert(sessionStream)
        .values({ sessionId, ...row })
        .onConflictDoUpdate({ target: sessionStream.sessionId, set: row });
    } catch {
      // Preview only — dropped on any error.
    }
  };
}

/** Remove the staged partial once its step's assistant event is durable. */
export async function clearPartial(db: EngineDb, sessionId: number): Promise<void> {
  await db.delete(sessionStream).where(eq(sessionStream.sessionId, sessionId));
}
