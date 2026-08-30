import "server-only";
/**
 * The draft (SPEC §10). Snake, 14 rounds, 168 picks, full speed, a 180-second
 * clock per pick, auto-pick on a missed clock.
 *
 * The draft session runs INLINE here (§8.2: "Draft sessions run inline inside
 * the draft workflow… there is no wait-for-slot step"), because the clock is
 * the only concurrency control that matters.
 */
import { eq, inArray, like, sql } from "drizzle-orm";
import type { Clock } from "@league/shared";
import { draftSessionKey } from "@league/shared";
import type { EngineDb, LeagueSettings } from "@league/engine";
import {
  autofillDraftLineupSlot,
  createSession,
  draft as draftTable,
  draftPicks,
  getSettings,
  handleEvent,
  players,
  recordTransaction,
  rosterEntries,
  sessions,
  teams,
  updateSettings,
} from "@league/engine";
import {
  autoPickCandidate,
  buildContextSnapshot,
  buildSystemPrompt,
  promptRulesFromSettings,
  createModelStep,
  createPartialSink,
  runSession,
  toolsForKind,
} from "@league/agent";
import { formatEt } from "@league/shared";
import { ensureFreshPlayerFeed, ensureFreshProjections } from "@league/data";
import { db, leagueClock } from "./db";
import { env } from "./env";
import { readBrief } from "./briefs";
import { createRunStreamPartialSink } from "./runStream";
import { notifyAlarms } from "./alarms";

/** Snake order: odd rounds go forward, even rounds backward (§3.8). */
export function snakeSlot(pickNo: number, teamCount: number): { round: number; slotInRound: number; orderIndex: number } {
  const round = Math.floor((pickNo - 1) / teamCount) + 1;
  const slotInRound = ((pickNo - 1) % teamCount) + 1;
  const orderIndex = round % 2 === 1 ? slotInRound - 1 : teamCount - slotInRound;
  return { round, slotInRound, orderIndex };
}

export async function getDraft(database: EngineDb) {
  return (await database.select().from(draftTable).where(eq(draftTable.id, 1)))[0];
}

/** Draw the order: a random permutation, stored and shown before the draft (§3.8). */
export async function drawDraftOrder(database: EngineDb, clock: Clock): Promise<number[]> {
  const allTeams = await database.select().from(teams);
  const ids = allTeams.map((t) => t.id);
  // Fisher–Yates with crypto randomness; the draw happens once and is public.
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  }
  await database
    .insert(draftTable)
    .values({ id: 1, order: ids, status: "not_started", updatedAt: clock.now() })
    .onConflictDoUpdate({ target: draftTable.id, set: { order: ids, updatedAt: clock.now() } });
  for (const [index, teamId] of ids.entries()) {
    await database.update(teams).set({ draftSlot: index + 1 }).where(eq(teams.id, teamId));
  }
  await recordTransaction(database, {
    type: "commissioner",
    week: null,
    teamIds: ids,
    payload: { action: "draft_order_drawn", order: ids, at: clock.now().toISOString() },
  });
  return ids;
}

export interface DraftRunResult {
  picksMade: number;
  autoPicks: number;
  completed: boolean;
  pausedAt: number | null;
}

/**
 * Make **one** pick and return (§10.2). The draft runs 1.5–4 hours across 168
 * picks, far past the 800-second cap on a single workflow step (§4.1), so the
 * workflow calls this once per pick and each pick is its own durable step.
 *
 * Safe to call again after a pause or a crash: it resumes at
 * `draft.current_pick` and skips a pick already recorded.
 */
export async function runDraftPickStep(): Promise<DraftRunResult> {
  const database = db();
  const clock = await leagueClock();
  const settings = await getSettings(database);
  const state = await getDraft(database);
  if (!state?.order || state.order.length === 0) throw new Error("draft order has not been drawn");
  if (state.status === "complete") return { picksMade: 0, autoPicks: 0, completed: true, pausedAt: null };
  if (state.status === "paused") {
    return { picksMade: 0, autoPicks: 0, completed: false, pausedAt: state.currentPick ?? null };
  }

  const order = state.order;
  const teamCount = order.length;
  const totalPicks = settings.draftRounds * teamCount;
  const clockSeconds = settings.draftClockSeconds;

  if (state.status === "not_started") {
    await database
      .update(draftTable)
      .set({ status: "running", startedAt: clock.now(), currentPick: 1, updatedAt: clock.now() })
      .where(eq(draftTable.id, 1));
    await updateSettings(database, { phase: "drafting" });
  }

  // Walk past anything already recorded, so a resumed run picks up cleanly.
  let pickNo = (await getDraft(database))?.currentPick ?? 1;
  while (pickNo <= totalPicks) {
    const existing = await database.select().from(draftPicks).where(eq(draftPicks.pickNo, pickNo));
    if (existing.length === 0) break;
    pickNo++;
  }
  if (pickNo > totalPicks) return finishDraft(database, clock);

  const current = await getDraft(database);
  if (!current || current.status === "paused") {
    return { picksMade: 0, autoPicks: 0, completed: false, pausedAt: pickNo };
  }

  const { round, slotInRound, orderIndex } = snakeSlot(pickNo, teamCount);
  const teamId = order[orderIndex]!;
  const clockEndsAt = new Date(
    clock.now().getTime() + (current.clockRemainingSeconds ?? clockSeconds) * 1000,
  );
  await database
    .update(draftTable)
    .set({
      currentPick: pickNo,
      clockEndsAt,
      clockRemainingSeconds: null,
      autopickFlag: false,
      updatedAt: clock.now(),
    })
    .where(eq(draftTable.id, 1));

  const made = await runDraftPick(database, clock, { pickNo, round, slotInRound, teamId, clockEndsAt });
  if (made === "paused") return { picksMade: 0, autoPicks: 0, completed: false, pausedAt: pickNo };

  const result: DraftRunResult = {
    picksMade: 1,
    autoPicks: made === "autopick" ? 1 : 0,
    completed: false,
    pausedAt: null,
  };
  if (pickNo >= totalPicks) {
    const done = await finishDraft(database, clock);
    return { ...result, completed: done.completed };
  }
  // Point the board at the next pick so the draft room and a resumed run agree.
  await database.update(draftTable).set({ currentPick: pickNo + 1, updatedAt: clock.now() }).where(eq(draftTable.id, 1));
  return result;
}

/** Close the draft and fire `draft.completed`, which starts the season (§9.3). */
async function finishDraft(database: EngineDb, clock: Clock): Promise<DraftRunResult> {
  await database
    .update(draftTable)
    .set({ status: "complete", endedAt: clock.now(), updatedAt: clock.now() })
    .where(eq(draftTable.id, 1));
  await handleEvent(database, clock, { type: "draft.completed" });
  return { picksMade: 0, autoPicks: 0, completed: true, pausedAt: null };
}

type PickOutcome = "agent" | "autopick" | "paused";

/** One pick: create the session, run it inline, auto-pick if the clock wins. */
async function runDraftPick(
  database: EngineDb,
  clock: Clock,
  pick: { pickNo: number; round: number; slotInRound: number; teamId: number; clockEndsAt: Date },
): Promise<PickOutcome> {
  const settings = await getSettings(database);
  const team = (await database.select().from(teams).where(eq(teams.id, pick.teamId)))[0];
  if (!team) throw new Error(`team ${pick.teamId} not found`);

  // Pre-warm the on-demand feeds before the model loop starts: a stale
  // moment costs one fetch here rather than mid-session, so the pick's tool
  // calls hit the fresh path (one SELECT). Both never throw.
  await Promise.all([
    ensureFreshProjections(database, clock, { season: settings.season, week: 0 }),
    ensureFreshPlayerFeed(database, clock),
  ]);

  {
    const sessionId = await claimPickSession(database, settings, clock, pick, team);

    if (sessionId !== null) {
      // Same pairing as runSession.ts: stage partials for the live transcript
      // (§12.1) and mirror the deltas onto the draft workflow's run stream.
      const stagePartial = createPartialSink(database, clock, sessionId);
      const streamPartial = createRunStreamPartialSink(sessionId);
      const modelStep = createModelStep(database, {
        onPartial: async (partial) => {
          await stagePartial(partial);
          await streamPartial(partial);
        },
      });
      await runSession(sessionId, {
        db: database,
        clock,
        tools: toolsForKind("draft_pick"),
        toolConfig: env.toolConfig,
        // §5.4 / §5.1 on-demand: week 0 keeps `proj_points` on the board
        // current; the player feed keeps draft-day injury news current.
        refreshProjections: async (season, week) => {
          await ensureFreshProjections(database, clock, { season, week });
        },
        refreshPlayerFeed: async () => {
          await ensureFreshPlayerFeed(database, clock);
        },
        modelStep,
        buildSystemPrompt: async () =>
          buildSystemPrompt({
            modelLabel: team.modelLabel,
            teamName: team.name ?? "(unnamed)",
            teamId: team.id,
            datetimeEt: formatEt(clock.now()),
            phase: "drafting",
            week: settings.currentWeek,
            ...promptRulesFromSettings(settings),
          }),
        buildContext: async (ctx) => ({
          brief: await readBrief("draft_pick", ctx.sessionContext),
          snapshot: await buildContextSnapshot(ctx),
        }),
        // Stop issuing model calls once the pick is gone or the draft moved on.
        shouldContinue: async () => {
          const d = await getDraft(database);
          if (!d || d.status !== "running") return false;
          if (d.currentPick !== pick.pickNo) return false;
          if (d.autopickFlag) return false;
          const already = await database.select().from(draftPicks).where(eq(draftPicks.pickNo, pick.pickNo));
          return already.length === 0;
        },
        onAlarms: async (alarms) => notifyAlarms(database, clock, alarms),
      });
    }

    // Did the agent record the pick?
    const recorded = await database.select().from(draftPicks).where(eq(draftPicks.pickNo, pick.pickNo));
    if (recorded.length > 0) return "agent";

    const state = await getDraft(database);
    if (state?.status === "paused") {
      // Store the remaining clock and wait for a resume (§10.2).
      const remaining = Math.max(0, Math.round((pick.clockEndsAt.getTime() - clock.now().getTime()) / 1000));
      await database
        .update(draftTable)
        .set({ clockRemainingSeconds: remaining, updatedAt: clock.now() })
        .where(eq(draftTable.id, 1));
      if (sessionId !== null) {
        await database.update(sessions).set({ status: "paused" }).where(eq(sessions.id, sessionId));
      }
      return "paused";
    }

    const reason = state?.autopickFlag
      ? "auto-pick: commissioner"
      : clock.now() >= pick.clockEndsAt
        ? "auto-pick: deadline"
        : "auto-pick: session ended without a pick";
    await autoPick(database, clock, { ...pick, reason });
    if (sessionId !== null) {
      await database
        .update(sessions)
        .set({ status: "timed_out", endedAt: clock.now() })
        .where(eq(sessions.id, sessionId));
    }
    return "autopick";
  }
}

/** Auto-pick per §10.4, recorded exactly like an agent pick but marked. */
export async function autoPick(
  database: EngineDb,
  clock: Clock,
  pick: { pickNo: number; round: number; slotInRound: number; teamId: number; reason: string },
): Promise<string> {
  const choice = await autoPickCandidate(database, pick.teamId, pick.pickNo);
  if (!choice) throw new Error(`no eligible player for auto-pick at ${pick.pickNo}`);
  const candidate = choice.player_id;
  const settings = await getSettings(database);

  await database.transaction(async (tx) => {
    await tx.insert(draftPicks).values({
      pickNo: pick.pickNo,
      round: pick.round,
      slotInRound: pick.slotInRound,
      teamId: pick.teamId,
      playerId: candidate,
      madeBy: "autopick",
      reason: pick.reason,
      pickedAt: clock.now(),
    });
    await tx.insert(rosterEntries).values({
      teamId: pick.teamId,
      playerId: candidate,
      acquiredVia: "draft",
      acquiredAt: clock.now(),
    });
    // Draft-time slotting (commissioner, 2026-08-29): same placement an agent
    // pick gets — first open eligible starting slot, bench only when full.
    await autofillDraftLineupSlot(
      tx,
      pick.teamId,
      { playerId: candidate, position: choice.position, fantasyPositions: choice.fantasy_positions },
      settings.currentWeek,
    );
    await recordTransaction(tx, {
      type: "draft_pick",
      week: null,
      teamIds: [pick.teamId],
      payload: {
        pick_no: pick.pickNo,
        round: pick.round,
        player_id: candidate,
        made_by: "autopick",
        reason: pick.reason,
      },
    });
  });
  return candidate;
}

/** Commissioner controls (§10.2, §12.2). */
export async function pauseDraft(database: EngineDb, clock: Clock): Promise<void> {
  await database
    .update(draftTable)
    .set({ status: "paused", updatedAt: clock.now() })
    .where(eq(draftTable.id, 1));
}

export async function resumeDraft(database: EngineDb, clock: Clock): Promise<void> {
  await database
    .update(draftTable)
    .set({ status: "running", updatedAt: clock.now() })
    .where(eq(draftTable.id, 1));
}

export async function forceAutoPick(database: EngineDb, clock: Clock): Promise<void> {
  await database.update(draftTable).set({ autopickFlag: true, updatedAt: clock.now() }).where(eq(draftTable.id, 1));
}

/** The draft board state the room polls every 3 seconds (§10.2). */
export async function draftState(database: EngineDb, clock: Clock) {
  const state = await getDraft(database);
  const picks = await database.select().from(draftPicks).orderBy(draftPicks.pickNo);
  const allTeams = await database.select().from(teams);
  const settings = await getSettings(database);
  const order = state?.order ?? [];
  const onClockTeamId =
    state?.currentPick && order.length > 0
      ? order[snakeSlot(state.currentPick, order.length).orderIndex]!
      : null;

  const pickedIds = picks.map((p) => p.playerId);
  const names =
    pickedIds.length > 0
      ? await database
          .select({ playerId: players.playerId, name: players.fullName })
          .from(players)
          .where(inArray(players.playerId, pickedIds))
      : [];
  const nameOf = new Map(names.map((n) => [n.playerId, n.name]));

  return {
    status: state?.status ?? "not_started",
    current_pick: state?.currentPick ?? null,
    total_picks: settings.draftRounds * Math.max(1, order.length),
    clock_ends_at: state?.clockEndsAt?.toISOString() ?? null,
    seconds_left:
      state?.clockEndsAt ? Math.max(0, Math.round((state.clockEndsAt.getTime() - clock.now().getTime()) / 1000)) : null,
    on_the_clock: onClockTeamId
      ? { team_id: onClockTeamId, name: allTeams.find((t) => t.id === onClockTeamId)?.name ?? null }
      : null,
    order,
    picks: picks.map((p) => ({
      pick_no: p.pickNo,
      round: p.round,
      team_id: p.teamId,
      player_id: p.playerId,
      player_name: nameOf.get(p.playerId) ?? p.playerId,
      made_by: p.madeBy,
      reason: p.reason,
    })),
  };
}

/**
 * One advisory lock for the whole draft, so only one runner can be taking a
 * pick's attempt number at a time. A draft is strictly sequential, so a single
 * lock costs nothing.
 */
const DRAFT_PICK_LOCK_KEY = 728_314_502;

/**
 * Create the session for a pick, or return null because another runner already
 * has one live.
 *
 * §10.2: a pick resumed after a pause gets a NEW session, so the attempt
 * number has to step past any session already recorded for this pick —
 * otherwise the idempotency key collides with the paused one, no session is
 * created, and the pick falls through to an auto-pick the agent never earned.
 *
 * Reading that number and creating the session have to be one atomic step. A
 * double-clicked resume, or a resume racing a run that is still alive, would
 * otherwise both read attempt 1, the first would write `draft:5:1`, and the
 * second would then read it back, take attempt 2, and start a *second* live
 * session for the same pick — two model calls racing `make_pick`, with
 * whichever loses ending without a pick and getting auto-picked.
 */
export async function claimPickSession(
  database: EngineDb,
  settings: LeagueSettings,
  clock: Clock,
  pick: { pickNo: number; round: number; clockEndsAt: Date },
  team: { id: number; modelId: string },
): Promise<number | null> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${DRAFT_PICK_LOCK_KEY})`);

    const prior = await tx
      .select({ key: sessions.idempotencyKey, status: sessions.status })
      .from(sessions)
      .where(like(sessions.idempotencyKey, `draft:${pick.pickNo}:%`));

    // Someone is already on this pick. Two runners on one pick is the failure
    // this whole function exists to prevent.
    if (prior.some((p) => p.status === "queued" || p.status === "running")) return null;

    let highest = 0;
    for (const row of prior) {
      const n = Number(row.key.split(":")[2]);
      if (Number.isFinite(n) && n > highest) highest = n;
    }

    return createSession(tx, settings, {
      teamId: team.id,
      kind: "draft_pick",
      trigger: "draft",
      idempotencyKey: draftSessionKey(pick.pickNo, highest + 1),
      modelId: team.modelId,
      dueAt: clock.now(),
      now: clock.now(),
      // The deadline IS the draft clock (§8.3).
      deadlineAt: pick.clockEndsAt,
      context: {
        pick_no: pick.pickNo,
        round: pick.round,
        seconds_left: Math.max(0, Math.round((pick.clockEndsAt.getTime() - clock.now().getTime()) / 1000)),
      },
    });
  });
}

/** The next `draft:{pick}:{attempt}` number for a pick (§10.2). */
export async function nextAttemptNumber(database: EngineDb, pickNo: number): Promise<number> {
  const prior = await database
    .select({ key: sessions.idempotencyKey })
    .from(sessions)
    .where(like(sessions.idempotencyKey, `draft:${pickNo}:%`));
  let highest = 0;
  for (const row of prior) {
    const n = Number(row.key.split(":")[2]);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return highest + 1;
}

/** Exported under a clear name for tests. */
export { nextAttemptNumber as nextAttemptNumberForTest };
