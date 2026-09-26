/**
 * Full league schema (SPEC §6). All timestamps UTC (timestamptz). All tables
 * have created_at; mutable tables have updated_at. Text columns carry TS union
 * types instead of pg enums so statuses can extend without a migration.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { pgTable } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export type Phase = "pre_draft" | "drafting" | "regular" | "playoffs" | "complete";
export type SessionKind =
  | "onboarding"
  | "draft_pick"
  | "weekly_review"
  | "post_waivers"
  | "trade_window"
  | "trade_response"
  | "trade_vote"
  | "lineup_check"
  | "injury_response"
  | "board_reply"
  | "self_check_in"
  | "manual"
  | "smoke"
  | "reporter_draft_grades"
  | "reporter_recap"
  | "reporter_preview"
  | "reporter_trade_note"
  | "reporter_power_rankings";
export type SessionStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "skipped"
  | "paused";
export type TradeStatus =
  | "proposed"
  | "accepted"
  | "executed"
  | "vetoed"
  | "failed"
  | "rejected"
  | "countered"
  | "cancelled"
  | "expired"
  | "superseded";
export type StartingSlot = "QB" | "RB1" | "RB2" | "WR1" | "WR2" | "TE" | "FLEX" | "DST" | "K";
export type LineupSlot = StartingSlot | "IR";
export type TransactionType =
  | "draft_pick"
  | "add"
  | "drop"
  | "waiver_add"
  | "trade"
  | "ir_move"
  | "lineup"
  | "commissioner";
export type AcquisitionVia = "draft" | "waiver" | "free_agent" | "trade" | "commissioner";

/** Roster slot definition stored in league_settings.roster_slots. */
export interface RosterSlots {
  QB: number;
  RB: number;
  WR: number;
  TE: number;
  FLEX: number;
  DST: number;
  K: number;
  BN: number;
  IR: number;
}

export const leagueSettings = pgTable("league_settings", {
  id: integer("id").primaryKey().default(1),
  season: integer("season").notNull(),
  currentWeek: integer("current_week").notNull().default(1),
  startWeek: integer("start_week").notNull().default(1),
  regularSeasonEndWeek: integer("regular_season_end_week").notNull().default(14),
  playoffStartWeek: integer("playoff_start_week").notNull().default(15),
  playoffTeams: integer("playoff_teams").notNull().default(6),
  rosterSlots: jsonb("roster_slots").$type<RosterSlots>().notNull(),
  scoringSettings: jsonb("scoring_settings").$type<Record<string, number>>().notNull(),
  irEligibleStatuses: text("ir_eligible_statuses").array().notNull(),
  waiverClearHours: integer("waiver_clear_hours").notNull().default(48),
  waiverRunTimeEt: text("waiver_run_time_et").notNull().default("04:30"),
  tradeReviewHours: integer("trade_review_hours").notNull().default(24),
  tradeVetoVotes: integer("trade_veto_votes").notNull().default(7),
  tradeMaxOffersPerDay: integer("trade_max_offers_per_day").notNull().default(3),
  tradeOfferExpiryHours: integer("trade_offer_expiry_hours").notNull().default(48),
  tradeDeadlineWeek: integer("trade_deadline_week").notNull().default(11),
  draftClockSeconds: integer("draft_clock_seconds").notNull().default(180),
  draftRounds: integer("draft_rounds").notNull().default(14),
  scheduleSeed: text("schedule_seed"),
  phase: text("phase").$type<Phase>().notNull().default("pre_draft"),
  /** Editable loop-guard and misc settings (SPEC §8.3: settings, not constants). */
  extra: jsonb("extra").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const teams = pgTable(
  "teams",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    /**
     * Null until the agent names its own team in onboarding (§8.6). The seed
     * deliberately leaves it null — naming the team is the agent's, and it is
     * the first thing every model does.
     */
    name: text("name"),
    motto: text("motto"),
    modelId: text("model_id").notNull(),
    modelLabel: text("model_label").notNull(),
    provider: text("provider").notNull(),
    draftSlot: integer("draft_slot"),
    waiverPriority: integer("waiver_priority"),
    tiebreakRand: numeric("tiebreak_rand", { precision: 10, scale: 9, mode: "number" }).notNull(),
    paused: boolean("paused").notNull().default(false),
    eliminated: boolean("eliminated").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    /**
     * Two teams may not share a name, case-insensitively. Board mentions route
     * by matching `@Team Name` against every team (board.ts), so a duplicate
     * would send each team the other's mentions and wake both for every reply.
     *
     * This is a database constraint rather than only a check in `setTeamName`
     * because onboarding runs six sessions at once: under READ COMMITTED two
     * of them can both read "not taken" and both write. Partial, so the eleven
     * teams still holding a null name never collide with each other.
     */
    uniqueIndex("teams_name_lower_uq").on(sql`lower(${t.name})`).where(sql`${t.name} is not null`),
  ],
);

export const players = pgTable(
  "players",
  {
    playerId: text("player_id").primaryKey(),
    fullName: text("full_name").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    position: text("position"),
    fantasyPositions: text("fantasy_positions").array(),
    nflTeam: text("nfl_team"),
    status: text("status"),
    injuryStatus: text("injury_status"),
    injuryBodyPart: text("injury_body_part"),
    active: boolean("active").notNull().default(true),
    depthChartOrder: integer("depth_chart_order"),
    number: integer("number"),
    yearsExp: integer("years_exp"),
    gsisId: text("gsis_id"),
    espnId: text("espn_id"),
    yahooId: text("yahoo_id"),
    waiverUntil: tstz("waiver_until"),
    trendingAdds: integer("trending_adds"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (t) => [
    index("players_yahoo_id_idx").on(t.yahooId),
    index("players_waiver_until_idx").on(t.waiverUntil),
    index("players_nfl_team_idx").on(t.nflTeam),
  ],
);

export const nflGames = pgTable(
  "nfl_games",
  {
    gameId: text("game_id").primaryKey(),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    kickoffAt: tstz("kickoff_at").notNull(),
    home: text("home").notNull(),
    away: text("away").notNull(),
    homeScore: integer("home_score"),
    awayScore: integer("away_score"),
    status: text("status").$type<"scheduled" | "live" | "final">().notNull().default("scheduled"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("nfl_games_season_week_idx").on(t.season, t.week)],
);

export const rosterEntries = pgTable(
  "roster_entries",
  {
    id: serial("id").primaryKey(),
    teamId: integer("team_id")
      .notNull()
      .references(() => teams.id),
    playerId: text("player_id")
      .notNull()
      .references(() => players.playerId)
      .unique(),
    acquiredAt: tstz("acquired_at").notNull(),
    acquiredVia: text("acquired_via").$type<AcquisitionVia>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("roster_entries_team_idx").on(t.teamId)],
);

export const lineupEntries = pgTable(
  "lineup_entries",
  {
    id: serial("id").primaryKey(),
    teamId: integer("team_id")
      .notNull()
      .references(() => teams.id),
    week: integer("week").notNull(),
    playerId: text("player_id")
      .notNull()
      .references(() => players.playerId),
    slot: text("slot").$type<LineupSlot>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("lineup_entries_team_week_slot_uq").on(t.teamId, t.week, t.slot),
    uniqueIndex("lineup_entries_team_week_player_uq").on(t.teamId, t.week, t.playerId),
    index("lineup_entries_team_week_idx").on(t.teamId, t.week),
  ],
);

export const playerWeekStats = pgTable(
  "player_week_stats",
  {
    playerId: text("player_id").notNull(),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    // The player's NFL team and opponent for this game, as the stats feed
    // reported them at the time — unlike players.nfl_team they survive a
    // mid-season trade, which is what defense-vs-position aggregation needs.
    nflTeam: text("nfl_team"),
    opponent: text("opponent"),
    stats: jsonb("stats").$type<Record<string, number>>().notNull(),
    ptsPpr: numeric("pts_ppr", { precision: 8, scale: 2, mode: "number" }),
    enginePts: numeric("engine_pts", { precision: 8, scale: 2, mode: "number" }),
    source: text("source").$type<"sleeper" | "nflverse">().notNull().default("sleeper"),
    final: boolean("final").notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.playerId, t.season, t.week] }),
    index("player_week_stats_season_week_idx").on(t.season, t.week),
  ],
);

export const playerWeekProj = pgTable(
  "player_week_proj",
  {
    playerId: text("player_id").notNull(),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    projPtsPpr: numeric("proj_pts_ppr", { precision: 8, scale: 2, mode: "number" }),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.playerId, t.season, t.week] }),
    // The on-demand refresh probes max(updated_at) by (season, week) on
    // every projection read; without this it is a full-table scan.
    index("player_week_proj_season_week_idx").on(t.season, t.week),
  ],
);

export const matchups = pgTable(
  "matchups",
  {
    id: serial("id").primaryKey(),
    week: integer("week").notNull(),
    homeTeamId: integer("home_team_id")
      .notNull()
      .references(() => teams.id),
    awayTeamId: integer("away_team_id")
      .notNull()
      .references(() => teams.id),
    homePoints: numeric("home_points", { precision: 8, scale: 2, mode: "number" }),
    awayPoints: numeric("away_points", { precision: 8, scale: 2, mode: "number" }),
    final: boolean("final").notNull().default(false),
    isPlayoff: boolean("is_playoff").notNull().default(false),
    playoffRound: integer("playoff_round"),
    winnerTeamId: integer("winner_team_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("matchups_week_idx").on(t.week)],
);

export const waiverClaims = pgTable(
  "waiver_claims",
  {
    id: serial("id").primaryKey(),
    teamId: integer("team_id")
      .notNull()
      .references(() => teams.id),
    addPlayerId: text("add_player_id")
      .notNull()
      .references(() => players.playerId),
    dropPlayerId: text("drop_player_id"),
    priority: integer("priority").notNull(),
    status: text("status").$type<"pending" | "success" | "failed" | "cancelled">().notNull().default("pending"),
    failureReason: text("failure_reason"),
    createdAt: createdAt(),
    processedAt: tstz("processed_at"),
    runId: integer("run_id"),
  },
  (t) => [index("waiver_claims_team_status_idx").on(t.teamId, t.status)],
);

export interface WaiverRunSummary {
  orderBefore: number[];
  orderAfter: number[];
  results: Array<{
    claimId: number;
    teamId: number;
    addPlayerId: string;
    dropPlayerId: string | null;
    status: "success" | "failed";
    failureReason?: string;
  }>;
}

export const waiverRuns = pgTable("waiver_runs", {
  id: serial("id").primaryKey(),
  runAt: tstz("run_at").notNull(),
  summary: jsonb("summary").$type<WaiverRunSummary>().notNull(),
  createdAt: createdAt(),
});

export const trades = pgTable(
  "trades",
  {
    id: serial("id").primaryKey(),
    proposerTeamId: integer("proposer_team_id")
      .notNull()
      .references(() => teams.id),
    counterpartyTeamId: integer("counterparty_team_id")
      .notNull()
      .references(() => teams.id),
    givePlayerIds: text("give_player_ids").array().notNull(),
    getPlayerIds: text("get_player_ids").array().notNull(),
    message: text("message"),
    status: text("status").$type<TradeStatus>().notNull().default("proposed"),
    proposedAt: tstz("proposed_at").notNull(),
    respondedAt: tstz("responded_at"),
    reviewEndsAt: tstz("review_ends_at"),
    resolvedAt: tstz("resolved_at"),
    parentTradeId: integer("parent_trade_id"),
    resolutionReason: text("resolution_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("trades_status_idx").on(t.status),
    index("trades_proposer_idx").on(t.proposerTeamId),
    index("trades_counterparty_idx").on(t.counterpartyTeamId),
  ],
);

export const tradeVotes = pgTable(
  "trade_votes",
  {
    tradeId: integer("trade_id")
      .notNull()
      .references(() => trades.id),
    teamId: integer("team_id")
      .notNull()
      .references(() => teams.id),
    vote: text("vote").$type<"allow" | "veto">().notNull(),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tradeId, t.teamId] })],
);

export const transactions = pgTable(
  "transactions",
  {
    id: serial("id").primaryKey(),
    type: text("type").$type<TransactionType>().notNull(),
    week: integer("week"),
    teamIds: integer("team_ids").array().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("transactions_type_idx").on(t.type), index("transactions_created_idx").on(t.createdAt)],
);

export const boardPosts = pgTable(
  "board_posts",
  {
    id: serial("id").primaryKey(),
    teamId: integer("team_id")
      .notNull()
      .references(() => teams.id),
    body: text("body").notNull(),
    replyToId: integer("reply_to_id"),
    rootId: integer("root_id"),
    depth: integer("depth").notNull().default(0),
    mentionTeamIds: integer("mention_team_ids").array().notNull().default([]),
    week: integer("week"),
    createdAt: createdAt(),
  },
  (t) => [index("board_posts_created_idx").on(t.createdAt), index("board_posts_root_idx").on(t.rootId)],
);

export const scratchpads = pgTable("scratchpads", {
  teamId: integer("team_id")
    .primaryKey()
    .references(() => teams.id),
  content: text("content").notNull().default(""),
  updatedAt: updatedAt(),
});

export const scratchpadVersions = pgTable(
  "scratchpad_versions",
  {
    id: serial("id").primaryKey(),
    teamId: integer("team_id")
      .notNull()
      .references(() => teams.id),
    content: text("content").notNull(),
    sessionId: integer("session_id"),
    createdAt: createdAt(),
  },
  (t) => [index("scratchpad_versions_team_idx").on(t.teamId)],
);

export const decisionLogs = pgTable(
  "decision_logs",
  {
    id: serial("id").primaryKey(),
    teamId: integer("team_id")
      .notNull()
      .references(() => teams.id),
    sessionId: integer("session_id"),
    week: integer("week"),
    kind: text("kind").$type<SessionKind>().notNull(),
    summary: text("summary").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("decision_logs_team_idx").on(t.teamId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    teamId: integer("team_id").references(() => teams.id),
    kind: text("kind").$type<SessionKind>().notNull(),
    trigger: text("trigger").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: text("status").$type<SessionStatus>().notNull().default("queued"),
    workflowRunId: text("workflow_run_id"),
    modelId: text("model_id").notNull(),
    startedAt: tstz("started_at"),
    endedAt: tstz("ended_at"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    toolCalls: integer("tool_calls").notNull().default(0),
    invalidToolCalls: integer("invalid_tool_calls").notNull().default(0),
    endedBy: text("ended_by").$type<"ending_tool" | "ceiling" | "deadline" | null>(),
    error: text("error"),
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sessions_team_started_idx").on(t.teamId, t.startedAt)],
);

export const sessionEvents = pgTable(
  "session_events",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id),
    seq: integer("seq").notNull(),
    type: text("type")
      .$type<"system" | "user" | "assistant" | "tool_call" | "tool_result" | "error" | "info">()
      .notNull(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("session_events_session_seq_idx").on(t.sessionId, t.seq)],
);

/**
 * The in-flight partial output of a running session's current model step, so
 * the live transcript can show what an agent is writing while it writes it.
 * One row per session, overwritten as deltas stream in and deleted once the
 * step's assistant event lands in `session_events`. Transient by design: it is
 * never part of the durable transcript and never read by `restoreSession`.
 */
export const sessionStream = pgTable("session_stream", {
  sessionId: integer("session_id")
    .primaryKey()
    .references(() => sessions.id),
  stepNo: integer("step_no").notNull(),
  reasoning: text("reasoning").notNull().default(""),
  text: text("text").notNull().default(""),
  updatedAt: updatedAt(),
});

export const scheduledJobs = pgTable(
  "scheduled_jobs",
  {
    id: serial("id").primaryKey(),
    type: text("type").notNull(),
    dueAt: tstz("due_at").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: text("status").$type<"due" | "claimed" | "done" | "failed">().notNull().default("due"),
    claimedAt: tstz("claimed_at"),
    doneAt: tstz("done_at"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("scheduled_jobs_status_due_idx").on(t.status, t.dueAt)],
);

export const draft = pgTable("draft", {
  id: integer("id").primaryKey().default(1),
  status: text("status").$type<"not_started" | "running" | "paused" | "complete">().notNull().default("not_started"),
  order: integer("order").array(),
  currentPick: integer("current_pick"),
  clockEndsAt: tstz("clock_ends_at"),
  clockRemainingSeconds: integer("clock_remaining_seconds"),
  startedAt: tstz("started_at"),
  endedAt: tstz("ended_at"),
  autopickFlag: boolean("autopick_flag").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const draftPicks = pgTable("draft_picks", {
  pickNo: integer("pick_no").primaryKey(),
  round: integer("round").notNull(),
  slotInRound: integer("slot_in_round").notNull(),
  teamId: integer("team_id")
    .notNull()
    .references(() => teams.id),
  playerId: text("player_id")
    .notNull()
    .references(() => players.playerId),
  madeBy: text("made_by").$type<"agent" | "autopick">().notNull(),
  reason: text("reason").notNull(),
  pickedAt: tstz("picked_at").notNull(),
});

export const rankings = pgTable(
  "rankings",
  {
    playerId: text("player_id").notNull(),
    set: text("set").$type<"draft" | "weekly" | "ros">().notNull(),
    week: integer("week").notNull().default(0),
    rank: integer("rank"),
    posRank: text("pos_rank"),
    tier: integer("tier"),
    adp: numeric("adp", { precision: 8, scale: 2, mode: "number" }),
    ecrDelta: numeric("ecr_delta", { precision: 8, scale: 2, mode: "number" }),
    sourceCounts: jsonb("source_counts").$type<Record<string, number>>(),
    fetchedAt: tstz("fetched_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.playerId, t.set, t.week] })],
);

export const teamWeekResults = pgTable(
  "team_week_results",
  {
    teamId: integer("team_id").notNull(),
    week: integer("week").notNull(),
    actualPoints: numeric("actual_points", { precision: 8, scale: 2, mode: "number" }).notNull(),
    optimalPoints: numeric("optimal_points", { precision: 8, scale: 2, mode: "number" }).notNull(),
    pointsLeftOnBench: numeric("points_left_on_bench", { precision: 8, scale: 2, mode: "number" }).notNull(),
    faPoints: numeric("fa_points", { precision: 8, scale: 2, mode: "number" }).notNull(),
    emptyStartingSlots: integer("empty_starting_slots").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.week] })],
);

export const spendLedger = pgTable(
  "spend_ledger",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id),
    teamId: integer("team_id"),
    kind: text("kind").$type<SessionKind>().notNull(),
    modelId: text("model_id"),
    stepNo: integer("step_no").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull(),
    source: text("source").$type<"gateway" | "price_table" | "tool">().notNull(),
    toolName: text("tool_name"),
    // §6 defines the column; the league bills the AI Gateway for every step
    // (commissioner's decision, 2026-08-28), so it always reads `gateway`.
    // The wider type stays so the ledger is comparable if that is revisited.
    billedTo: text("billed_to")
      .$type<"gateway" | "byok:openai" | "byok:xai" | "byok:vertex" | "byok:anthropic">()
      .notNull()
      .default("gateway"),
    createdAt: createdAt(),
  },
  (t) => [index("spend_ledger_team_created_idx").on(t.teamId, t.createdAt), index("spend_ledger_session_idx").on(t.sessionId)],
);

export const spendRollups = pgTable(
  "spend_rollups",
  {
    scope: text("scope").$type<"agent" | "league">().notNull(),
    scopeKey: text("scope_key").notNull(),
    period: text("period").$type<"day" | "week" | "season">().notNull(),
    periodStart: text("period_start").notNull(),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    sessions: integer("sessions").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.scopeKey, t.period, t.periodStart] })],
);

export const costAlarmRules = pgTable("cost_alarm_rules", {
  id: serial("id").primaryKey(),
  scope: text("scope")
    .$type<"session" | "agent_day" | "agent_week" | "agent_season" | "league_day" | "league_season">()
    .notNull(),
  thresholdUsd: numeric("threshold_usd", { precision: 12, scale: 2, mode: "number" }).notNull(),
  stepUsd: numeric("step_usd", { precision: 12, scale: 2, mode: "number" }),
  enabled: boolean("enabled").notNull().default(true),
  channels: text("channels").array().notNull().default(["email", "site"]),
  updatedAt: updatedAt(),
});

export const costAlarms = pgTable(
  "cost_alarms",
  {
    id: serial("id").primaryKey(),
    ruleId: integer("rule_id")
      .notNull()
      .references(() => costAlarmRules.id),
    scopeKey: text("scope_key").notNull(),
    periodStart: text("period_start").notNull(),
    amountUsd: numeric("amount_usd", { precision: 12, scale: 6, mode: "number" }).notNull(),
    thresholdUsd: numeric("threshold_usd", { precision: 12, scale: 2, mode: "number" }).notNull(),
    firedAt: tstz("fired_at").notNull(),
    notifiedVia: text("notified_via").array().notNull().default([]),
    acknowledgedAt: tstz("acknowledged_at"),
  },
  (t) => [uniqueIndex("cost_alarms_dedupe_uq").on(t.ruleId, t.scopeKey, t.periodStart, t.thresholdUsd)],
);

export const toolCosts = pgTable("tool_costs", {
  toolName: text("tool_name").primaryKey(),
  usdPerCall: numeric("usd_per_call", { precision: 12, scale: 6, mode: "number" }).notNull(),
  updatedAt: updatedAt(),
});

export const modelPrices = pgTable("model_prices", {
  modelId: text("model_id").primaryKey(),
  inputUsdPerM: numeric("input_usd_per_m", { precision: 12, scale: 4, mode: "number" }).notNull(),
  outputUsdPerM: numeric("output_usd_per_m", { precision: 12, scale: 4, mode: "number" }).notNull(),
  reasoningUsdPerM: numeric("reasoning_usd_per_m", { precision: 12, scale: 4, mode: "number" }),
  cachedInputUsdPerM: numeric("cached_input_usd_per_m", { precision: 12, scale: 4, mode: "number" }),
  contextWindow: integer("context_window"),
  source: text("source").notNull(),
  updatedAt: updatedAt(),
});

export const scoringDiscrepancies = pgTable("scoring_discrepancies", {
  id: serial("id").primaryKey(),
  playerId: text("player_id").notNull(),
  season: integer("season").notNull(),
  week: integer("week").notNull(),
  ptsPpr: numeric("pts_ppr", { precision: 8, scale: 2, mode: "number" }),
  enginePts: numeric("engine_pts", { precision: 8, scale: 2, mode: "number" }),
  diff: numeric("diff", { precision: 8, scale: 2, mode: "number" }),
  createdAt: createdAt(),
});

export const reporterPosts = pgTable("reporter_posts", {
  id: serial("id").primaryKey(),
  kind: text("kind").$type<"draft_grades" | "recap" | "preview" | "trade_note">().notNull(),
  week: integer("week"),
  title: text("title").notNull(),
  bodyMd: text("body_md").notNull(),
  sessionId: integer("session_id"),
  createdAt: createdAt(),
});

/**
 * Power rankings (§11). One edition per `reporter_power_rankings` session:
 * twelve rows, ranks 1–12, each with the reporter's one- or two-sentence
 * reason. Editions are never edited; a later session writes a new one, and the
 * site shows the newest with movement against the one before it.
 */
export const powerRankings = pgTable(
  "power_rankings",
  {
    id: serial("id").primaryKey(),
    /** The fantasy week in play when the edition was published. */
    week: integer("week").notNull(),
    teamId: integer("team_id").notNull(),
    rank: integer("rank").notNull(),
    reason: text("reason").notNull(),
    sessionId: integer("session_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("power_rankings_session_team_uq").on(t.sessionId, t.teamId),
    uniqueIndex("power_rankings_session_rank_uq").on(t.sessionId, t.rank),
    index("power_rankings_session_idx").on(t.sessionId),
  ],
);

export type OddsSnapshot = "thu" | "sun";
export type OddsMethod = "baseline" | "rule" | "jev_composite" | "jev_direct";

/**
 * Matchup odds (§11.1). One run per season, week and snapshot; every method's
 * probabilities for that run hang off it. Scoring is computed on read from
 * `matchups` and `player_week_stats`, never stored.
 */
export const oddsRuns = pgTable(
  "odds_runs",
  {
    id: serial("id").primaryKey(),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    snapshot: text("snapshot").$type<OddsSnapshot>().notNull(),
    status: text("status").$type<"succeeded" | "partial">().notNull(),
    /** The versioned id Jev answered with; null when Jev was not called. */
    jevModel: text("jev_model"),
    jevError: text("jev_error"),
    jevInputTokens: integer("jev_input_tokens").notNull().default(0),
    jevCostUsd: numeric("jev_cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    /** The status table and variance weights this run used. */
    weights: jsonb("weights").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("odds_runs_season_week_snapshot_uq").on(t.season, t.week, t.snapshot)],
);

export const matchupOdds = pgTable(
  "matchup_odds",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id").notNull(),
    matchupId: integer("matchup_id").notNull(),
    method: text("method").$type<OddsMethod>().notNull(),
    homeWinProb: numeric("home_win_prob", { precision: 6, scale: 5, mode: "number" }).notNull(),
    homeExpected: numeric("home_expected", { precision: 8, scale: 2, mode: "number" }),
    awayExpected: numeric("away_expected", { precision: 8, scale: 2, mode: "number" }),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("matchup_odds_run_matchup_method_uq").on(t.runId, t.matchupId, t.method)],
);

export const playerPlayOdds = pgTable(
  "player_play_odds",
  {
    runId: integer("run_id").notNull(),
    playerId: text("player_id").notNull(),
    teamId: integer("team_id").notNull(),
    matchupId: integer("matchup_id").notNull(),
    injuryStatus: text("injury_status"),
    ruleProb: numeric("rule_prob", { precision: 6, scale: 5, mode: "number" }).notNull(),
    jevProb: numeric("jev_prob", { precision: 6, scale: 5, mode: "number" }),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.playerId] })],
);

export const commissionerActions = pgTable("commissioner_actions", {
  id: serial("id").primaryKey(),
  action: text("action").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  reason: text("reason"),
  createdAt: createdAt(),
});

export const health = pgTable("health", {
  key: text("key").primaryKey(),
  lastSuccessAt: tstz("last_success_at"),
  lastError: text("last_error"),
  lastErrorAt: tstz("last_error_at"),
});

export const clockOverride = pgTable("clock_override", {
  id: integer("id").primaryKey().default(1),
  nowAt: tstz("now_at"),
});
