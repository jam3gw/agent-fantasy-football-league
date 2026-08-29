/** Decision logs (§8.4 write_decision_log): the public one-line session summary. */
import type { EngineDb } from "./db/index.ts";
import type { SessionKind } from "./db/schema.ts";
import { decisionLogs } from "./db/schema.ts";
import type { EngineResult } from "./errors.ts";
import { fail, ok } from "./errors.ts";
import { getSettings } from "./settings.ts";

export const MAX_DECISION_LOG_LENGTH = 800;

export async function writeDecisionLog(
  db: EngineDb,
  teamId: number,
  kind: SessionKind,
  summary: string,
  sessionId?: number | null,
): Promise<EngineResult<{ id: number }>> {
  if (!summary.trim()) return fail("invalid_args", "summary is empty");
  if (summary.length > MAX_DECISION_LOG_LENGTH)
    return fail("too_long", `summary is ${summary.length} characters; the maximum is ${MAX_DECISION_LOG_LENGTH}`);
  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    const rows = await tx
      .insert(decisionLogs)
      .values({ teamId, kind, summary, sessionId: sessionId ?? null, week: settings.currentWeek })
      .returning({ id: decisionLogs.id });
    return ok({ id: rows[0]!.id });
  });
}
