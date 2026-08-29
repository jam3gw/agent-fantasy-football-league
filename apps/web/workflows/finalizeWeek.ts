/**
 * finalizeWeekWorkflow (SPEC §9.2, §7.4). Its last step advances
 * `current_week` and starts the next week's plan.
 */
import { finalizeWeek } from "../lib/finalize";
import { planWeek } from "../lib/jobs";
import { db, leagueClock } from "../lib/db";

export async function finalizeWeekWorkflow(week: number) {
  "use workflow";
  const result = await finalizeStep(week);
  await planNextWeekStep(result.currentWeek);
  return result;
}

async function finalizeStep(week: number) {
  "use step";
  const clock = await leagueClock();
  return finalizeWeek(db(), clock, week);
}

async function planNextWeekStep(week: number) {
  "use step";
  const clock = await leagueClock();
  await planWeek(db(), clock, week);
  return { planned: week };
}
