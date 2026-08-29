/**
 * draftWorkflow (SPEC §9.2, §10.2). The draft is the longest-running job in
 * the league — 168 picks at up to 180 seconds each, so 1.5–4 hours — and a
 * single workflow step is capped at 800 seconds (§4.1). Each pick is therefore
 * its own durable step, and the workflow drives the board pick by pick.
 *
 * `runDraftPickStep` resumes from `draft.current_pick` and skips a pick already
 * recorded, so a run that dies mid-draft simply carries on from the board.
 */
import { runDraftPickStep, type DraftRunResult } from "../lib/draft";

export async function draftWorkflow() {
  "use workflow";
  let picksMade = 0;
  let autoPicks = 0;
  for (;;) {
    const result = await runOnePick();
    picksMade += result.picksMade;
    autoPicks += result.autoPicks;
    // A pause returns early; the commissioner's resume starts a new run.
    if (result.completed || result.pausedAt !== null) {
      return { picksMade, autoPicks, completed: result.completed, pausedAt: result.pausedAt };
    }
  }
}

async function runOnePick(): Promise<DraftRunResult> {
  "use step";
  return runDraftPickStep();
}
