/** ingestWorkflow (SPEC §9.2): one durable run per data source. */
import { runJob } from "../lib/jobs";
import { db, leagueClock } from "../lib/db";

export async function ingestWorkflow(kind: string, payload: Record<string, unknown> = {}) {
  "use workflow";
  return ingestStep(kind, payload);
}

async function ingestStep(kind: string, payload: Record<string, unknown>) {
  "use step";
  const clock = await leagueClock();
  await runJob(db(), clock, kind, payload);
  return { kind, ok: true };
}
