/** weekPlanWorkflow (SPEC §9.2). */
import { planWeek } from "../lib/jobs";
import { db, leagueClock } from "../lib/db";

export async function weekPlanWorkflow(week: number) {
  "use workflow";
  return planStep(week);
}

async function planStep(week: number) {
  "use step";
  const clock = await leagueClock();
  await planWeek(db(), clock, week);
  return { week };
}
