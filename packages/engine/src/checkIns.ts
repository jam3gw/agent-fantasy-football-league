/**
 * Agent-scheduled check-ins (SPEC §8.10).
 *
 * An agent can leave itself a note to come back at a time it chooses — "see
 * whether Achane practises on Thursday before I commit to the FLEX". The
 * booking is an ordinary queued session with `due_at` in the future, so the
 * tick's sweeper starts it exactly like any other; nothing new runs it.
 *
 * The limits live here rather than in the tool, so they hold however the
 * session is created and so they are testable without the agent package.
 * They exist for three reasons the loop guards (§8.3) already anticipate at a
 * smaller scale: an anxious model will book twenty; a check-in that only books
 * another check-in is a loop; and a check-in scheduled a minute from now is
 * really just a request to keep running past the ceiling.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Clock } from "@league/shared";
import { checkInKey } from "@league/shared";
import type { EngineDb } from "./db/index.ts";
import { sessions, teams } from "./db/schema.ts";
import type { EngineResult } from "./errors.ts";
import { fail, ok } from "./errors.ts";
import { createSession } from "./events.ts";
import { getSettings } from "./settings.ts";

/** Outstanding check-ins one team may hold at once. */
export const MAX_PENDING_CHECK_INS = 3;
/** Check-ins one team may book per fantasy week, booked or already run. */
export const MAX_CHECK_INS_PER_WEEK = 5;
/** No sooner than this: sooner is "keep going", which the ceiling governs. */
export const MIN_LEAD_MINUTES = 30;
/** No further out than this. */
export const MAX_HORIZON_DAYS = 14;
/** Longest a reason may be — it becomes the session's brief and is public. */
export const MAX_REASON_CHARS = 500;

export interface ScheduledCheckIn {
  sessionId: number;
  at: Date;
  reason: string;
}

/**
 * Book a check-in for `teamId` at `at`. Returns the session, or a failure the
 * tool hands back to the model unchanged.
 *
 * `bookedBySessionKind` is the kind of the session doing the booking: a
 * check-in cannot book another check-in, which is the chaining guard.
 */
export async function scheduleCheckIn(
  db: EngineDb,
  clock: Clock,
  teamId: number,
  input: { at: Date; reason: string; bookedBySessionKind?: string },
): Promise<EngineResult<ScheduledCheckIn>> {
  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    const now = clock.now();

    if (input.bookedBySessionKind === "self_check_in") {
      return fail(
        "invalid_args",
        "a check-in cannot schedule another check-in",
        { hint: "do the work now, or leave it for your next scheduled session" },
      );
    }

    const reason = input.reason.trim();
    if (reason.length === 0) return fail("invalid_args", "a check-in needs a reason");
    if (reason.length > MAX_REASON_CHARS) {
      return fail("too_long", `the reason is ${reason.length} characters; the maximum is ${MAX_REASON_CHARS}`);
    }

    if (Number.isNaN(input.at.getTime())) return fail("bad_time", "that is not a time");
    const leadMs = input.at.getTime() - now.getTime();
    if (leadMs < MIN_LEAD_MINUTES * 60_000) {
      return fail(
        "bad_time",
        `a check-in must be at least ${MIN_LEAD_MINUTES} minutes out`,
        { hint: "for something you need now, do it in this session" },
      );
    }
    if (leadMs > MAX_HORIZON_DAYS * 24 * 3600_000) {
      return fail("bad_time", `a check-in must be within ${MAX_HORIZON_DAYS} days`);
    }

    const team = (await tx.select().from(teams).where(eq(teams.id, teamId)))[0];
    if (!team) return fail("not_found", `team ${teamId} not found`);
    if (team.paused) return fail("team_paused", "your team is paused");
    if (team.eliminated) return fail("team_paused", "your season is over");

    const mine = await tx
      .select({ status: sessions.status, week: sql<number>`(${sessions.context} ->> 'week')::int` })
      .from(sessions)
      .where(and(eq(sessions.teamId, teamId), eq(sessions.kind, "self_check_in")));

    const pending = mine.filter((s) => s.status === "queued").length;
    if (pending >= MAX_PENDING_CHECK_INS) {
      return fail(
        "check_in_limit",
        `you already have ${pending} check-ins waiting; the maximum is ${MAX_PENDING_CHECK_INS}`,
        { hint: "cancel one you no longer need with cancel_check_in" },
      );
    }
    const thisWeek = mine.filter((s) => s.week === settings.currentWeek).length;
    if (thisWeek >= MAX_CHECK_INS_PER_WEEK) {
      return fail(
        "check_in_limit",
        `you have booked ${thisWeek} check-ins this week; the maximum is ${MAX_CHECK_INS_PER_WEEK}`,
      );
    }

    const sessionId = await createSession(tx, settings, {
      teamId,
      kind: "self_check_in",
      trigger: "agent:schedule_check_in",
      idempotencyKey: checkInKey(teamId, input.at.toISOString()),
      modelId: team.modelId,
      dueAt: input.at,
      now,
      context: { week: settings.currentWeek, reason },
    });
    if (sessionId === null) {
      return fail("invalid_args", "you already have a check-in booked for that minute");
    }
    return ok({ sessionId, at: input.at, reason });
  });
}

/** A team's own check-ins that have not run yet, soonest first. */
export async function pendingCheckIns(db: EngineDb, teamId: number): Promise<ScheduledCheckIn[]> {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.teamId, teamId), eq(sessions.kind, "self_check_in"), eq(sessions.status, "queued")));
  return rows
    .map((r) => ({
      sessionId: r.id,
      at: new Date(String(r.context.due_at)),
      reason: String(r.context.reason ?? ""),
    }))
    .filter((r) => !Number.isNaN(r.at.getTime()))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * Cancel one of the team's own pending check-ins. Scoped to the team, so an
 * agent cannot cancel another team's — the ids are sequential (§15.5).
 */
export async function cancelCheckIn(
  db: EngineDb,
  clock: Clock,
  teamId: number,
  sessionId: number,
): Promise<EngineResult<{ sessionId: number }>> {
  const rows = await db
    .update(sessions)
    .set({ status: "skipped", endedAt: clock.now(), updatedAt: clock.now() })
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.teamId, teamId),
        eq(sessions.kind, "self_check_in"),
        inArray(sessions.status, ["queued"]),
      ),
    )
    .returning({ id: sessions.id });
  if (rows.length === 0) {
    return fail("not_found", `you have no check-in ${sessionId} waiting to run`);
  }
  return ok({ sessionId });
}

/** Check-ins booked for this team since `since` (rate-limit reporting). */
export async function checkInsBookedSince(db: EngineDb, teamId: number, since: Date): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sessions)
    .where(
      and(
        eq(sessions.teamId, teamId),
        eq(sessions.kind, "self_check_in"),
        gte(sessions.createdAt, since),
      ),
    );
  return rows[0]?.n ?? 0;
}
