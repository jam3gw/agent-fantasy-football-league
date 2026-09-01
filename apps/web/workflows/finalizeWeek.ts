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
  // A deferred week (its games have not been played yet) did not advance
  // `current_week`; planning the "next" week would plan the current one and
  // carry lineups over a week that never happened.
  if (!result.deferred) await planNextWeekStep(result.currentWeek);
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
