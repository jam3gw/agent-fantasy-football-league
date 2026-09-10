import "server-only";
/**
 * Session retry policy and provider-outage detection (SPEC §8.8).
 *
 * A session that fails after its own step retries is re-queued up to twice
 * over thirty minutes, with `:retry{n}` appended to the idempotency key, unless
 * the window it belonged to has already passed. If all retries fail the league
 * simply keeps the previous lineup and the failure is visible on the team page
 * and the health page.
 */
import { and, desc, eq, gte, inArray, isNotNull, ne } from "drizzle-orm";
import type { Clock } from "@league/shared";
import { retryKey } from "@league/shared";
import type { EngineDb } from "@league/engine";
import { createSession, getSettings, scheduledJobs, sessionEvents, sessions, teams } from "@league/engine";

/** §8.8: two more attempts, spread over thirty minutes. */
export const MAX_SESSION_RETRIES = 2;
const RETRY_DELAYS_MS = [10 * 60_000, 30 * 60_000];

/** Sessions whose failure should not be retried because their moment has passed. */
function windowPassed(_kind: string, deadlineAt: Date, now: Date): boolean {
  // A lineup check is pointless once the games have started (§8.8), and the
  // same rule turns out to hold for every kind: the deadline is the moment.
  return now >= deadlineAt;
}

function retryAttemptOf(idempotencyKey: string): number {
  const match = /:retry(\d+)$/.exec(idempotencyKey);
  return match ? Number(match[1]) : 0;
}

function baseKeyOf(idempotencyKey: string): string {
  return idempotencyKey.replace(/:retry\d+$/, "");
}

export interface RetrySweepResult {
  requeued: number;
  abandoned: number;
}

/**
 * Re-queue recently failed sessions. Called from the per-minute tick.
 * Idempotent: the retry's own key means a second sweep cannot double-queue.
 */
export async function requeueFailedSessions(db: EngineDb, clock: Clock): Promise<RetrySweepResult> {
  const now = clock.now();
  const settings = await getSettings(db);
  const since = new Date(now.getTime() - 60 * 60_000); // only recent failures

  const failed = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.status, "failed"), gte(sessions.createdAt, since), isNotNull(sessions.endedAt)));

  let requeued = 0;
  let abandoned = 0;

  for (const session of failed) {
    // The draft owns its own retries: `runDraftPick` takes the next attempt
    // number and re-runs the pick inline, or auto-picks (§10.2, §10.4). A
    // retry booked here would be a queued `draft_pick` the tick refuses to
    // start, so it would sit in the queue for the rest of the season.
    if (session.kind === "draft_pick") {
      abandoned++;
      continue;
    }

    const attempt = retryAttemptOf(session.idempotencyKey);
    if (attempt >= MAX_SESSION_RETRIES) {
      abandoned++;
      continue;
    }

    const deadlineAt = new Date(String(session.context.deadline_at ?? now.toISOString()));
    if (windowPassed(session.kind, deadlineAt, now)) {
      abandoned++;
      continue;
    }

    const nextAttempt = attempt + 1;
    const key = retryKey(baseKeyOf(session.idempotencyKey), nextAttempt);
    const dueAt = new Date((session.endedAt ?? now).getTime() + RETRY_DELAYS_MS[attempt]!);

    const created = await createSession(db, settings, {
      teamId: session.teamId,
      kind: session.kind,
      trigger: `retry:${session.id}`,
      idempotencyKey: key,
      modelId: session.modelId,
      dueAt,
      now,
      deadlineAt,
      context: { ...session.context, retry_of: session.id, retry_attempt: nextAttempt },
    });
    if (created !== null) {
      requeued++;
      await db.insert(sessionEvents).values({
        sessionId: session.id,
        seq: 9_999,
        type: "info",
        content: { requeued_as: created, attempt: nextAttempt },
        createdAt: now,
      });
    }
  }

  return { requeued, abandoned };
}

export interface ModelOutage {
  modelId: string;
  consecutiveFailures: number;
  teamIds: number[];
}

/**
 * Provider outage detection (§8.8): three sessions in a row failing for one
 * model. Returns the models currently in that state so the health page can
 * show a banner and the tick can email the commissioner once.
 *
 * Only a model some seat runs *now* can be in outage. A seat's failures stay
 * on the old id after a swap — the swap is the commissioner's response to
 * them — and for the rest of the 24-hour window nothing succeeds on that id,
 * so the streak never breaks. The daily email key rolled over at midnight and
 * the commissioner got "zai/glm-5.3-promo-50 looks down (no team)" the
 * morning after the seat had already moved off it. Reporter sessions carry no
 * team; their model is kept on the reporter's own id, so they are judged by
 * the streak alone.
 */
export async function detectModelOutages(db: EngineDb, clock: Clock): Promise<ModelOutage[]> {
  const since = new Date(clock.now().getTime() - 24 * 3600_000);
  const recent = await db
    .select()
    .from(sessions)
    .where(and(gte(sessions.createdAt, since), ne(sessions.status, "queued")))
    .orderBy(desc(sessions.createdAt));
  const inUse = new Set((await db.select({ modelId: teams.modelId }).from(teams)).map((t) => t.modelId));

  const byModel = new Map<string, typeof recent>();
  for (const s of recent) {
    const list = byModel.get(s.modelId) ?? [];
    list.push(s);
    byModel.set(s.modelId, list);
  }

  const outages: ModelOutage[] = [];
  for (const [modelId, list] of byModel) {
    if (!inUse.has(modelId) && list.every((s) => s.teamId !== null)) continue;
    let streak = 0;
    for (const s of list) {
      // `skipped` sessions never reached the provider, so they break nothing.
      if (s.status === "skipped") continue;
      if (s.status === "failed" || s.status === "timed_out") streak++;
      else break;
    }
    if (streak >= 3) {
      const teamIds = [
        ...new Set(list.filter((s) => s.teamId !== null).map((s) => s.teamId as number)),
      ];
      outages.push({ modelId, consecutiveFailures: streak, teamIds });
    }
  }
  return outages;
}

/** Team names for an outage banner. */
export async function teamsForModels(db: EngineDb, modelIds: string[]): Promise<Map<string, string[]>> {
  if (modelIds.length === 0) return new Map();
  const rows = await db.select().from(teams).where(inArray(teams.modelId, modelIds));
  const out = new Map<string, string[]>();
  for (const t of rows) {
    const list = out.get(t.modelId) ?? [];
    list.push(t.name ?? t.slug);
    out.set(t.modelId, list);
  }
  return out;
}

/** Jobs that failed and are worth showing as overdue on the health page. */
export async function failedJobs(db: EngineDb, clock: Clock) {
  const since = new Date(clock.now().getTime() - 24 * 3600_000);
  return db
    .select()
    .from(scheduledJobs)
    .where(and(eq(scheduledJobs.status, "failed"), gte(scheduledJobs.createdAt, since)))
    .orderBy(desc(scheduledJobs.dueAt));
}
