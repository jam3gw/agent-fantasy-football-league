/**
 * draftWorkflow (SPEC §9.2, §10.2). The draft is the longest-running job in
 * the league — 168 picks at up to 180 seconds each — so it must be durable.
 *
 * Each pick is its own step. `runDraft` is itself resumable (it continues from
 * `draft.current_pick` and skips picks already recorded), so a workflow that
 * resumes mid-draft simply carries on from the board.
 */
import { runDraft, type DraftRunResult } from "../lib/draft";

export async function draftWorkflow() {
  "use workflow";
  let result = await runDraftStep();
  // A pause returns early; the commissioner's resume starts a new run.
  while (!result.completed && result.pausedAt === null) {
    result = await runDraftStep();
  }
  return result;
}

async function runDraftStep(): Promise<DraftRunResult> {
  "use step";
  return runDraft();
}
