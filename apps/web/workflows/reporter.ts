/** reporterWorkflow (SPEC §9.2, §11). */
import { runJob } from "../lib/jobs";
import { db, leagueClock } from "../lib/db";

export async function reporterWorkflow(kind: string, week: number) {
  "use workflow";
  return reporterStep(kind, week);
}

async function reporterStep(kind: string, week: number) {
  "use step";
  const clock = await leagueClock();
  await runJob(db(), clock, "reporter.run", { kind, week });
  return { kind, week };
}
