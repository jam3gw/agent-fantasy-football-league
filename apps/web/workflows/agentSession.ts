/**
 * agentSessionWorkflow (SPEC §9.2). One durable run per agent session.
 *
 * A workflow step is capped at 800 seconds (§4.1) and a session's deadline can
 * be 90 minutes (§8.3), so a session is not one step: `runAgentSession` runs
 * until its budget is spent, stops cleanly between model calls, and returns
 * `interrupted`. This loop then starts another step, which resumes from the
 * transcript — every model call and tool result is already durable in
 * `session_events`, so nothing is repeated and nothing is lost.
 */
import { runAgentSession, type SessionRunOutcome } from "../lib/runSession";
import { emitRunChunk } from "../lib/runStream";

/** Well inside the 800-second cap, leaving room for one long model call. */
const STEP_BUDGET_MS = 9 * 60_000;

export async function agentSessionWorkflow(sessionId: number) {
  "use workflow";
  for (;;) {
    const result = await runSessionStep(sessionId);
    if (result.status !== "interrupted") return result;
  }
}

async function runSessionStep(sessionId: number): Promise<SessionRunOutcome> {
  "use step";
  // While the step runs, model-output deltas flow to the run stream via the
  // partial sink pairing in runSession.ts; the outcome chunk below closes out
  // each step so the run's Streams tab shows progress even when a provider
  // streams nothing. Stream writes must happen inside a step, hence here and
  // not in the workflow loop.
  const result = await runAgentSession(sessionId, { stepBudgetMs: STEP_BUDGET_MS });
  await emitRunChunk({
    kind: "session_step",
    sessionId,
    status: result.status,
    endedBy: result.endedBy,
    steps: result.steps,
    toolCalls: result.toolCalls,
    invalidToolCalls: result.invalidToolCalls,
  });
  return result;
}
