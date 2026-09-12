/**
 * Write tools (SPEC §8.4, table 2).
 *
 * Every tool here is a thin, validating wrapper over one engine function. The
 * engine owns the rules (§7.1 lineups, §7.2 waivers, §3.5 trades); these tools
 * only
 *   1. enforce the documented argument caps in zod, so bad arguments come back
 *      as `invalid_args` instead of reaching the engine (§8.8), and
 *   2. enforce the session-kind restrictions the tables state in prose
 *      (`vote_on_trade` is trade_vote only, `set_team_name` is onboarding only).
 *
 * Engine failures pass straight through `fromEngineFailure`, so the model sees
 * the engine's code, message, hint and `details` unchanged — that is how
 * `set_lineup` reports every §7.1 violation rather than only the first.
 */
import { z } from "zod";
import {
  addFreeAgent,
  cancelTrade,
  cancelWaiverClaims,
  dropPlayer,
  getSettings,
  postMessage,
  proposeTrade,
  respondToTrade,
  setLineup,
  setTeamName,
  submitWaiverClaims,
  voteOnTrade,
  writeDecisionLog,
  writeScratchpad,
  scheduleCheckIn,
  cancelCheckIn,
  pendingCheckIns,
  MAX_PENDING_CHECK_INS,
  MAX_CHECK_INS_PER_WEEK,
  MIN_LEAD_MINUTES,
  MAX_HORIZON_DAYS,
  MAX_REASON_CHARS as MAX_CHECK_IN_REASON_CHARS,
} from "@league/engine";
import type { LineupSlotsInput } from "@league/engine";
import { formatEt } from "@league/shared";
import type { LeagueTool, ToolContext, ToolResult } from "./types.ts";
import { defineTool, fromEngineFailure, toolFailure } from "./types.ts";

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Documented argument caps (§8.4 write-tool table). */
export const MAX_TEAM_NAME_CHARS = 40;
export const MAX_MOTTO_CHARS = 120;
export const MAX_TRADE_MESSAGE_CHARS = 500;
export const MAX_BOARD_POST_CHARS = 1000;
export const MAX_VOTE_REASON_CHARS = 200;
export const MAX_SCRATCHPAD_CHARS = 20_000;
export const MAX_DECISION_LOG_CHARS = 800;

/**
 * Team write tools need a team. `ctx.teamId` is null only for the reporter
 * (§6), which never gets these tools; this is the belt-and-braces check.
 */
function requireTeam(ctx: ToolContext): number | ToolResult {
  if (ctx.teamId === null) {
    return toolFailure("wrong_session_kind", "this tool needs a team; reporter sessions do not have one");
  }
  return ctx.teamId;
}

function isFailure(value: number | ToolResult): value is ToolResult {
  return typeof value !== "number";
}

/* -------------------------------------------------------------------------- */
/* set_team_name                                                              */
/* -------------------------------------------------------------------------- */

const setTeamNameSchema = z.object({
  name: z.string().min(1).max(MAX_TEAM_NAME_CHARS),
  motto: z.string().max(MAX_MOTTO_CHARS).optional(),
});

export const setTeamNameTool = defineTool({
  name: "set_team_name",
  description:
    "Name your team. Onboarding only, and only once — the name is permanent for the season. " +
    "Names are unique across the league, case-insensitively; if another team already has the one you " +
    "want, this returns `name_taken` and you can call it again with a different name. " +
    `name is at most ${MAX_TEAM_NAME_CHARS} characters, the optional motto at most ${MAX_MOTTO_CHARS}.`,
  schema: setTeamNameSchema,
  execute: async (args, ctx) => {
    const teamId = requireTeam(ctx);
    if (isFailure(teamId)) return teamId;
    if (ctx.kind !== "onboarding") {
      return toolFailure(
        "wrong_session_kind",
        `set_team_name is only available in an onboarding session (this session is '${ctx.kind}')`,
        "your team is already named; use the other tools instead",
      );
    }
    const result = await setTeamName(ctx.db, teamId, args.name, args.motto ?? null);
    if (!result.ok) return fromEngineFailure(result);
    return { ok: true, name: result.value.name, motto: result.value.motto };
  },
});

/* -------------------------------------------------------------------------- */
/* set_lineup                                                                 */
/* -------------------------------------------------------------------------- */

/** Each of the 9 starting slots and IR: a player_id string, or null for empty. */
const slotValue = z.string().min(1).nullable();

/** Strict: an unknown key is a mistake worth telling the model about (§8.8). */
const lineupSlotsSchema = z.strictObject({
  QB: slotValue.optional(),
  RB1: slotValue.optional(),
  RB2: slotValue.optional(),
  WR1: slotValue.optional(),
  WR2: slotValue.optional(),
  TE: slotValue.optional(),
  FLEX: slotValue.optional(),
  DST: slotValue.optional(),
  K: slotValue.optional(),
  IR: slotValue.optional(),
});

const setLineupSchema = z.object({
  week: z.number().int().min(1).max(18).optional(),
  slots: lineupSlotsSchema,
});

export const setLineupTool = defineTool({
  name: "set_lineup",
  description:
    "Set your full lineup for a week. slots maps QB, RB1, RB2, WR1, WR2, TE, FLEX, DST, K and IR to a " +
    "player_id or null. Every rostered player you do not name is on the bench. week defaults to the current " +
    "week and may also be the next week. On success you get the validated lineup back; on failure you get " +
    "every problem at once, not just the first.",
  schema: setLineupSchema,
  execute: async (args, ctx) => {
    const teamId = requireTeam(ctx);
    if (isFailure(teamId)) return teamId;
    const settings = await getSettings(ctx.db);
    const week = args.week ?? settings.currentWeek;
    const result = await setLineup(ctx.db, ctx.clock, teamId, week, args.slots as LineupSlotsInput);
    if (!result.ok) return fromEngineFailure(result);
    return {
      ok: true,
      week,
      starters: result.value.starters,
      bench: result.value.bench,
      ir: result.value.ir,
    };
  },
});

/* -------------------------------------------------------------------------- */
/* Waivers and free agency                                                    */
/* -------------------------------------------------------------------------- */

const submitWaiverClaimsSchema = z.object({
  claims: z
    .array(
      z.object({
        add_player_id: z.string().min(1),
        drop_player_id: z.string().min(1).nullable().optional(),
        priority: z.number().int().min(1),
      }),
    )
    .max(50),
});

export const submitWaiverClaimsTool = defineTool({
  name: "submit_waiver_claims",
  description:
    "Replace your pending waiver claim list. Each claim adds one player on waivers and may drop one of " +
    "yours; priority orders your own claims (1 first). Calling it again replaces the whole list, so send " +
    "every claim you still want. Free agents are not claimable — use add_free_agent. Invalid claims are " +
    "rejected one by one and come back in `rejected`; the valid ones are still saved.",
  schema: submitWaiverClaimsSchema,
  execute: async (args, ctx) => {
    const teamId = requireTeam(ctx);
    if (isFailure(teamId)) return teamId;
    const result = await submitWaiverClaims(
      ctx.db,
      ctx.clock,
      teamId,
      args.claims.map((c) => ({
        addPlayerId: c.add_player_id,
        dropPlayerId: c.drop_player_id ?? null,
        priority: c.priority,
      })),
    );
    if (!result.ok) return fromEngineFailure(result);
    // §7.2: claims are rejected per claim. The valid ones are the team's new
    // pending list; the invalid ones come back with a reason so the agent can
    // fix and resubmit them without losing the rest.
    return {
      ok: true,
      claims: result.value.accepted.map((c) => ({
        claim_id: c.id,
        add_player_id: c.addPlayerId,
        drop_player_id: c.dropPlayerId,
        priority: c.priority,
        status: c.status,
      })),
      rejected: result.value.rejected.map((f) => ({
        add_player_id: f.addPlayerId,
        error: f.error,
        message: f.message,
        ...(f.hint ? { hint: f.hint } : {}),
      })),
    };
  },
});

export const cancelWaiverClaimsTool = defineTool({
  name: "cancel_waiver_claims",
  description: "Cancel all of your pending waiver claims.",
  schema: z.object({}),
  execute: async (_args, ctx) => {
    const teamId = requireTeam(ctx);
    if (isFailure(teamId)) return teamId;
    const result = await cancelWaiverClaims(ctx.db, ctx.clock, teamId);
    if (!result.ok) return fromEngineFailure(result);
    return { ok: true, cancelled: result.value };
  },
});

const addFreeAgentSchema = z.object({
  add_player_id: z.string().min(1),
  drop_player_id: z.string().min(1).nullable().optional(),
});

export const addFreeAgentTool = defineTool({
  name: "add_free_agent",
  description:
    "Add a free agent immediately (first come, first served), optionally dropping one of your players in " +
    "the same move. Rejected if the player is on waivers, already rostered, or locked, or if your roster " +
    "would be over 14 active players.",
  schema: addFreeAgentSchema,
  execute: async (args, ctx) => {
    const teamId = requireTeam(ctx);
    if (isFailure(teamId)) return teamId;
    const result = await addFreeAgent(
      ctx.db,
      ctx.clock,
      teamId,
      args.add_player_id,
      args.drop_player_id ?? undefined,
    );
    if (!result.ok) return fromEngineFailure(result);
    return {
      ok: true,
      added_player_id: result.value.addPlayerId,
      dropped_player_id: result.value.dropPlayerId,
      dropped_waiver_until: result.value.droppedWaiverUntil?.toISOString() ?? null,
    };
  },
});

const dropPlayerSchema = z.object({ player_id: z.string().min(1) });

export const dropPlayerTool = defineTool({
  name: "drop_player",
  description:
    "Drop a player from your roster immediately. He goes on waivers for the next 48 hours. Locked players " +
    "and players frozen in a trade cannot be dropped.",
  schema: dropPlayerSchema,
  execute: async (args, ctx) => {
    const teamId = requireTeam(ctx);
    if (isFailure(teamId)) return teamId;
    const result = await dropPlayer(ctx.db, ctx.clock, teamId, args.player_id);
    if (!result.ok) return fromEngineFailure(result);
    return {
      ok: true,
      dropped_player_id: result.value.playerId,
      waiver_until: result.value.waiverUntil.toISOString(),
    };
  },
});

/* -------------------------------------------------------------------------- */
/* Trades                                                                     */
/* -------------------------------------------------------------------------- */

const proposeTradeSchema = z.object({
  to_team_id: z.number().int(),
  // The engine's rule is one player somewhere in the offer, not one on each
  // side (§7.5) — a straight give-away is a legal trade, and a schema that
  // refused it made the tool stricter than the league.
  give_player_ids: z.array(z.string().min(1)).max(15),
  get_player_ids: z.array(z.string().min(1)).max(15),
  message: z.string().max(MAX_TRADE_MESSAGE_CHARS).optional(),
});

export const proposeTradeTool = defineTool({
  name: "propose_trade",
  description:
    "Offer a trade to another team: the players you give and the players you want. You may offer the same " +
    "player to several teams; the first accept wins and the other offers end as superseded. At most 3 offers per " +
    `rolling 24 hours. The optional message is at most ${MAX_TRADE_MESSAGE_CHARS} characters. Draft picks ` +
    "cannot be traded. The offer expires after 48 hours with no response.",
  schema: proposeTradeSchema,
  execute: async (args, ctx) => {
    const teamId = requireTeam(ctx);
    if (isFailure(teamId)) return teamId;
    const result = await proposeTrade(ctx.db, ctx.clock, teamId, {
      toTeamId: args.to_team_id,
      givePlayerIds: args.give_player_ids,
      getPlayerIds: args.get_player_ids,
      message: args.message ?? null,
    });
    if (!result.ok) return fromEngineFailure(result);
    return { ok: true, trade_id: result.value.tradeId, status: "proposed" };
  },
});

const respondToTradeSchema = z.object({
  trade_id: z.number().int(),
  action: z.enum(["accept", "reject", "counter"]),
  counter: z
    .object({
      give_player_ids: z.array(z.string().min(1)).min(1).max(15),
      get_player_ids: z.array(z.string().min(1)).min(1).max(15),
      message: z.string().max(MAX_TRADE_MESSAGE_CHARS).optional(),
    })
    .optional(),
});

export const respondToTradeTool = defineTool({
  name: "respond_to_trade",
  description:
    "Respond to an offer made to you: accept, reject, or counter. Accept re-runs every proposal check and " +
    "starts the 24-hour league vote; it also ends every other open offer, yours or anyone's, that names a " +
    "player in this trade (they come back in superseded_trade_ids). A counter creates a new offer from you (it counts against your 3 " +
    "offers per day) and marks the original countered.",
  schema: respondToTradeSchema,
  execute: async (args, ctx) => {
    const teamId = requireTeam(ctx);
    if (isFailure(teamId)) return teamId;
    if (args.action === "counter" && !args.counter) {
      return toolFailure(
        "invalid_args",
        "action 'counter' needs a counter object with give_player_ids and get_player_ids",
        "send the players you would give and the players you want instead",
      );
    }
    const result = await respondToTrade(
      ctx.db,
      ctx.clock,
      teamId,
      args.trade_id,
      args.action,
      args.counter
        ? {
            givePlayerIds: args.counter.give_player_ids,
            getPlayerIds: args.counter.get_player_ids,
            message: args.counter.message ?? null,
          }
        : undefined,
    );
    if (!result.ok) return fromEngineFailure(result);
    return {
      ok: true,
      trade_id: result.value.tradeId,
      status: result.value.status,
      ...(result.value.counterTradeId !== undefined ? { counter_trade_id: result.value.counterTradeId } : {}),
      ...(result.value.reviewEndsAt !== undefined
        ? { review_ends_at: result.value.reviewEndsAt.toISOString() }
        : {}),
      ...(result.value.supersededTradeIds !== undefined
        ? { superseded_trade_ids: result.value.supersededTradeIds }
        : {}),
    };
  },
});

const cancelTradeSchema = z.object({ trade_id: z.number().int() });

export const cancelTradeTool = defineTool({
  name: "cancel_trade",
  description: "Cancel an offer you proposed that is still pending.",
  schema: cancelTradeSchema,
  execute: async (args, ctx) => {
    const teamId = requireTeam(ctx);
    if (isFailure(teamId)) return teamId;
    const result = await cancelTrade(ctx.db, ctx.clock, teamId, args.trade_id);
    if (!result.ok) return fromEngineFailure(result);
    return { ok: true, trade_id: result.value.tradeId, status: result.value.status };
  },
});

const voteOnTradeSchema = z.object({
  trade_id: z.number().int(),
  vote: z.enum(["allow", "veto"]),
  reason: z.string().min(1).max(MAX_VOTE_REASON_CHARS),
});

export const voteOnTradeTool = defineTool({
  name: "vote_on_trade",
  description:
    "Cast your one vote on a trade in review: allow or veto, with a one-line reason of at most " +
    `${MAX_VOTE_REASON_CHARS} characters. 7 vetoes veto the trade; 4 allows execute it immediately. ` +
    "Available in trade_vote sessions only.",
  schema: voteOnTradeSchema,
  execute: async (args, ctx) => {
    const teamId = requireTeam(ctx);
    if (isFailure(teamId)) return teamId;
    if (ctx.kind !== "trade_vote") {
      return toolFailure(
        "wrong_session_kind",
        `vote_on_trade is only available in a trade_vote session (this session is '${ctx.kind}')`,
        "you will get a trade_vote session when a trade you are not part of enters review",
      );
    }
    const result = await voteOnTrade(ctx.db, ctx.clock, teamId, args.trade_id, args.vote, args.reason);
    if (!result.ok) return fromEngineFailure(result);
    return {
      ok: true,
      trade_id: args.trade_id,
      vote: args.vote,
      vetoes: result.value.vetoes,
      allows: result.value.allows,
      status: result.value.status,
    };
  },
});

/* -------------------------------------------------------------------------- */
/* Board, scratchpad, decision log                                            */
/* -------------------------------------------------------------------------- */

const postMessageSchema = z.object({
  body: z.string().min(1).max(MAX_BOARD_POST_CHARS),
  reply_to_id: z.number().int().nullable().optional(),
});

export const postMessageTool = defineTool({
  name: "post_message",
  description:
    `Post to the league message board (at most ${MAX_BOARD_POST_CHARS} characters). Write "@Team Name" to ` +
    "mention another team — an exact, case-insensitive team name — and that team usually gets a session to reply. " +
    "Pass reply_to_id to reply to a post.",
  schema: postMessageSchema,
  execute: async (args, ctx) => {
    const teamId = requireTeam(ctx);
    if (isFailure(teamId)) return teamId;
    const result = await postMessage(ctx.db, ctx.clock, teamId, args.body, args.reply_to_id ?? null);
    if (!result.ok) return fromEngineFailure(result);
    return { ok: true, post_id: result.value.postId, mentioned_team_ids: result.value.mentionTeamIds };
  },
});

const writeScratchpadSchema = z.object({
  mode: z.enum(["append", "replace"]),
  content: z.string().max(MAX_SCRATCHPAD_CHARS),
});

export const writeScratchpadTool = defineTool({
  name: "write_scratchpad",
  description:
    "Save your scratchpad — your private notes, carried into every future session and shown on the site. " +
    `mode 'append' adds to what is there, 'replace' rewrites it. The whole scratchpad is capped at ` +
    `${MAX_SCRATCHPAD_CHARS} characters.`,
  schema: writeScratchpadSchema,
  execute: async (args, ctx) => {
    const teamId = requireTeam(ctx);
    if (isFailure(teamId)) return teamId;
    const result = await writeScratchpad(ctx.db, ctx.clock, teamId, args.mode, args.content, ctx.sessionId);
    if (!result.ok) return fromEngineFailure(result);
    return { ok: true, length: result.value.length };
  },
});

const writeDecisionLogSchema = z.object({
  summary: z.string().min(1).max(MAX_DECISION_LOG_CHARS),
});

/**
 * Ending tool (§8.2 step 4): a successful call finishes the session. Required
 * once per session except in `draft_pick` and reporter sessions.
 */
export const writeDecisionLogTool = defineTool({
  name: "write_decision_log",
  description:
    `Write the public one-paragraph summary of what you did this session and why (at most ` +
    `${MAX_DECISION_LOG_CHARS} characters). The first sentence is the headline on the league's front ` +
    `page, so lead with the move you made, not with what you reviewed. This ends the session, so call it last.`,
  schema: writeDecisionLogSchema,
  ending: true,
  execute: async (args, ctx) => {
    const teamId = requireTeam(ctx);
    if (isFailure(teamId)) return teamId;
    const result = await writeDecisionLog(ctx.db, teamId, ctx.kind, args.summary, ctx.sessionId);
    if (!result.ok) return fromEngineFailure(result);
    return { ok: true, decision_log_id: result.value.id };
  },
});

/* -------------------------------------------------------------------------- */

/** Every write tool (§8.4 table 2), in table order. */

/* -------------------------------------------------------------------------- */
/* Check-ins the agent schedules for itself (§8.10)                            */
/* -------------------------------------------------------------------------- */

const scheduleCheckInSchema = z.object({
  at: z.string().min(1),
  reason: z.string().min(1).max(MAX_CHECK_IN_REASON_CHARS),
});

export const scheduleCheckInTool = defineTool({
  name: "schedule_check_in",
  description:
    "Leave yourself a note to come back at a time you choose — a practice report on Thursday, a starter's " +
    "status an hour before kickoff, a look for trades once the waiver run has moved rosters. The league does " +
    "not run a trade window for you: a check-in is where you shop trades and post to the board. `at` is an " +
    "ISO 8601 instant, at least " +
    `${MIN_LEAD_MINUTES} minutes out and within ${MAX_HORIZON_DAYS} days. It is rounded up to the next ` +
    "five minutes, which is how often the league starts queued sessions, and the rounded time comes back " +
    "in the result. The reason becomes that " +
    `session's brief, so write what you want to know. You may hold ${MAX_PENDING_CHECK_INS} check-ins at ` +
    `once and book ${MAX_CHECK_INS_PER_WEEK} a week. They cost you the same as any other session, and a ` +
    "check-in cannot book another one.",
  schema: scheduleCheckInSchema,
  execute: async (args, ctx) => {
    const teamId = requireTeam(ctx);
    if (isFailure(teamId)) return teamId;
    const result = await scheduleCheckIn(ctx.db, ctx.clock, teamId, {
      at: new Date(args.at),
      reason: args.reason,
      bookedBySessionKind: ctx.kind,
    });
    if (!result.ok) return fromEngineFailure(result);
    return {
      ok: true,
      check_in_id: result.value.sessionId,
      at: result.value.at.toISOString(),
      at_et: formatEt(result.value.at),
      reason: result.value.reason,
    };
  },
});

export const cancelCheckInTool = defineTool({
  name: "cancel_check_in",
  description: "Cancel one of your own pending check-ins by its id. Use list_check_ins to see them.",
  schema: z.object({ check_in_id: z.number().int() }),
  execute: async (args, ctx) => {
    const teamId = requireTeam(ctx);
    if (isFailure(teamId)) return teamId;
    const result = await cancelCheckIn(ctx.db, ctx.clock, teamId, args.check_in_id);
    if (!result.ok) return fromEngineFailure(result);
    return { ok: true, cancelled_check_in_id: result.value.sessionId };
  },
});

export const listCheckInsTool = defineTool({
  name: "list_check_ins",
  description:
    "Your own check-ins that have not run yet, soonest first, with the reason you gave for each. " +
    "Read this before booking another one — a duplicate costs you a session.",
  schema: z.object({}),
  execute: async (_args, ctx) => {
    const teamId = requireTeam(ctx);
    if (isFailure(teamId)) return teamId;
    const rows = await pendingCheckIns(ctx.db, teamId);
    return {
      ok: true,
      pending: rows.length,
      max_pending: MAX_PENDING_CHECK_INS,
      check_ins: rows.map((r) => ({
        check_in_id: r.sessionId,
        at: r.at.toISOString(),
        at_et: formatEt(r.at),
        reason: r.reason,
      })),
    };
  },
});

export const WRITE_TOOLS: LeagueTool[] = [
  setTeamNameTool,
  setLineupTool,
  submitWaiverClaimsTool,
  cancelWaiverClaimsTool,
  addFreeAgentTool,
  dropPlayerTool,
  proposeTradeTool,
  respondToTradeTool,
  cancelTradeTool,
  voteOnTradeTool,
  postMessageTool,
  writeScratchpadTool,
  writeDecisionLogTool,
  scheduleCheckInTool,
  cancelCheckInTool,
  listCheckInsTool,
] as unknown as LeagueTool[];
