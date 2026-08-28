/**
 * jobWorkflow (SPEC §9.1 step 1). The tick claims a due job and *starts* the
 * matching workflow rather than running it: a per-minute cron function must
 * not spend its own 800 seconds on a 5 MB player download or a waiver run, or
 * the live score poll and the trade-review resolution behind it never happen.
 *
 * The workflow owns the job row's outcome, so a failure is still visible on
 * /admin/jobs with its message.
 */
import { eq } from "drizzle-orm";
import { scheduledJobs } from "@league/engine";
import { db, leagueClock } from "../lib/db";
import { runJob } from "../lib/jobs";

export async function jobWorkflow(jobId: number, type: string, payload: Record<string, unknown>) {
  "use workflow";
  return runJobStep(jobId, type, payload);
}

async function runJobStep(jobId: number, type: string, payload: Record<string, unknown>) {
  "use step";
  const database = db();
  const clock = await leagueClock();
  try {
    await runJob(database, clock, type, payload);
    await database
      .update(scheduledJobs)
      .set({ status: "done", doneAt: clock.now() })
      .where(eq(scheduledJobs.id, jobId));
    return { jobId, type, ok: true };
  } catch (err) {
    await database
      .update(scheduledJobs)
      .set({ status: "failed", doneAt: clock.now(), error: String(err) })
      .where(eq(scheduledJobs.id, jobId));
    return { jobId, type, ok: false, error: String(err) };
  }
}
