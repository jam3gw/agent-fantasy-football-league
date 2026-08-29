/** waiverRunWorkflow (SPEC §9.2, §7.2). */
import { runWaivers } from "@league/engine";
import { db, leagueClock } from "../lib/db";

export async function waiverRunWorkflow(runAtIso: string) {
  "use workflow";
  return runWaiversStep(runAtIso);
}

async function runWaiversStep(runAtIso: string) {
  "use step";
  const clock = await leagueClock();
  const result = await runWaivers(db(), clock, new Date(runAtIso));
  return result.ok ? { ok: true, runId: result.value } : { ok: false, error: result.error };
}
