/**
 * agentSessionWorkflow (SPEC §9.2). One durable run per agent session; the
 * model and tool calls inside `runSession` are the steps that matter, and the
 * runner already persists every one of them to `session_events`, so a resumed
 * run never repeats work that was already recorded.
 */
import { runAgentSession } from "../lib/runSession";

export async function agentSessionWorkflow(sessionId: number) {
  "use workflow";
  return runSessionStep(sessionId);
}

async function runSessionStep(sessionId: number) {
  "use step";
  return runAgentSession(sessionId);
}
