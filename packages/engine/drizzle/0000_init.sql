CREATE TABLE "board_posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"team_id" integer NOT NULL,
	"body" text NOT NULL,
	"reply_to_id" integer,
	"root_id" integer,
	"depth" integer DEFAULT 0 NOT NULL,
	"mention_team_ids" integer[] DEFAULT '{}' NOT NULL,
	"week" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clock_override" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"now_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "commissioner_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_alarm_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"threshold_usd" numeric(12, 2) NOT NULL,
	"step_usd" numeric(12, 2),
	"enabled" boolean DEFAULT true NOT NULL,
	"channels" text[] DEFAULT '{"email","site"}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_alarms" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"scope_key" text NOT NULL,
	"period_start" text NOT NULL,
	"amount_usd" numeric(12, 6) NOT NULL,
	"threshold_usd" numeric(12, 2) NOT NULL,
	"fired_at" timestamp with time zone NOT NULL,
	"notified_via" text[] DEFAULT '{}' NOT NULL,
	"acknowledged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "decision_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"team_id" integer NOT NULL,
	"session_id" integer,
	"week" integer,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"order" integer[],
	"current_pick" integer,
	"clock_ends_at" timestamp with time zone,
	"clock_remaining_seconds" integer,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"autopick_flag" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_picks" (
	"pick_no" integer PRIMARY KEY NOT NULL,
	"round" integer NOT NULL,
	"slot_in_round" integer NOT NULL,
	"team_id" integer NOT NULL,
	"player_id" text NOT NULL,
	"made_by" text NOT NULL,
	"reason" text NOT NULL,
	"picked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fp_cache" (
	"url_key" text PRIMARY KEY NOT NULL,
	"body" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fp_player_map" (
	"fp_player_id" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"matched_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fp_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"team_id" integer,
	"day_et" date NOT NULL,
	"request_no" integer NOT NULL,
	"endpoint" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"session_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health" (
	"key" text PRIMARY KEY NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "league_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"season" integer NOT NULL,
	"current_week" integer DEFAULT 1 NOT NULL,
	"start_week" integer DEFAULT 1 NOT NULL,
	"regular_season_end_week" integer DEFAULT 14 NOT NULL,
	"playoff_start_week" integer DEFAULT 15 NOT NULL,
	"playoff_teams" integer DEFAULT 6 NOT NULL,
	"roster_slots" jsonb NOT NULL,
	"scoring_settings" jsonb NOT NULL,
	"ir_eligible_statuses" text[] NOT NULL,
	"waiver_clear_hours" integer DEFAULT 48 NOT NULL,
	"waiver_run_time_et" text DEFAULT '04:30' NOT NULL,
	"trade_review_hours" integer DEFAULT 24 NOT NULL,
	"trade_veto_votes" integer DEFAULT 7 NOT NULL,
	"trade_max_offers_per_day" integer DEFAULT 3 NOT NULL,
	"trade_offer_expiry_hours" integer DEFAULT 48 NOT NULL,
	"trade_deadline_week" integer DEFAULT 11 NOT NULL,
	"draft_clock_seconds" integer DEFAULT 180 NOT NULL,
	"draft_rounds" integer DEFAULT 14 NOT NULL,
	"schedule_seed" text,
	"fantasypros_daily_allowance" integer DEFAULT 3 NOT NULL,
	"phase" text DEFAULT 'pre_draft' NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lineup_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"team_id" integer NOT NULL,
	"week" integer NOT NULL,
	"player_id" text NOT NULL,
	"slot" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matchups" (
	"id" serial PRIMARY KEY NOT NULL,
	"week" integer NOT NULL,
	"home_team_id" integer NOT NULL,
	"away_team_id" integer NOT NULL,
	"home_points" numeric(8, 2),
	"away_points" numeric(8, 2),
	"final" boolean DEFAULT false NOT NULL,
	"is_playoff" boolean DEFAULT false NOT NULL,
	"playoff_round" integer,
	"winner_team_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_prices" (
	"model_id" text PRIMARY KEY NOT NULL,
	"input_usd_per_m" numeric(12, 4) NOT NULL,
	"output_usd_per_m" numeric(12, 4) NOT NULL,
	"reasoning_usd_per_m" numeric(12, 4),
	"cached_input_usd_per_m" numeric(12, 4),
	"context_window" integer,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nfl_games" (
	"game_id" text PRIMARY KEY NOT NULL,
	"season" integer NOT NULL,
	"week" integer NOT NULL,
	"kickoff_at" timestamp with time zone NOT NULL,
	"home" text NOT NULL,
	"away" text NOT NULL,
	"home_score" integer,
	"away_score" integer,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_week_proj" (
	"player_id" text NOT NULL,
	"season" integer NOT NULL,
	"week" integer NOT NULL,
	"proj_pts_ppr" numeric(8, 2),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_week_proj_player_id_season_week_pk" PRIMARY KEY("player_id","season","week")
);
--> statement-breakpoint
CREATE TABLE "player_week_stats" (
	"player_id" text NOT NULL,
	"season" integer NOT NULL,
	"week" integer NOT NULL,
	"stats" jsonb NOT NULL,
	"pts_ppr" numeric(8, 2),
	"engine_pts" numeric(8, 2),
	"source" text DEFAULT 'sleeper' NOT NULL,
	"final" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_week_stats_player_id_season_week_pk" PRIMARY KEY("player_id","season","week")
);
--> statement-breakpoint
CREATE TABLE "players" (
	"player_id" text PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"position" text,
	"fantasy_positions" text[],
	"nfl_team" text,
	"status" text,
	"injury_status" text,
	"injury_body_part" text,
	"active" boolean DEFAULT true NOT NULL,
	"depth_chart_order" integer,
	"number" integer,
	"years_exp" integer,
	"gsis_id" text,
	"espn_id" text,
	"yahoo_id" text,
	"waiver_until" timestamp with time zone,
	"trending_adds" integer,
	"raw" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rankings" (
	"player_id" text NOT NULL,
	"fp_player_id" text,
	"set" text NOT NULL,
	"week" integer DEFAULT 0 NOT NULL,
	"rank" integer,
	"pos_rank" text,
	"tier" integer,
	"adp" numeric(8, 2),
	"ecr_delta" numeric(8, 2),
	"source_counts" jsonb,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rankings_player_id_set_week_pk" PRIMARY KEY("player_id","set","week")
);
--> statement-breakpoint
CREATE TABLE "rankings_unmatched" (
	"id" serial PRIMARY KEY NOT NULL,
	"fp_player_id" text NOT NULL,
	"fp_name" text NOT NULL,
	"fp_team" text,
	"fp_position" text,
	"raw" jsonb,
	"resolved_player_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reporter_posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"week" integer,
	"title" text NOT NULL,
	"body_md" text NOT NULL,
	"session_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roster_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"team_id" integer NOT NULL,
	"player_id" text NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"acquired_via" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_entries_player_id_unique" UNIQUE("player_id")
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'due' NOT NULL,
	"claimed_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "scoring_discrepancies" (
	"id" serial PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"season" integer NOT NULL,
	"week" integer NOT NULL,
	"pts_ppr" numeric(8, 2),
	"engine_pts" numeric(8, 2),
	"diff" numeric(8, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scratchpad_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"team_id" integer NOT NULL,
	"content" text NOT NULL,
	"session_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scratchpads" (
	"team_id" integer PRIMARY KEY NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"team_id" integer,
	"kind" text NOT NULL,
	"trigger" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"workflow_run_id" text,
	"model_id" text NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"invalid_tool_calls" integer DEFAULT 0 NOT NULL,
	"ended_by" text,
	"error" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "spend_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"team_id" integer,
	"kind" text NOT NULL,
	"model_id" text,
	"step_no" integer NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) NOT NULL,
	"source" text NOT NULL,
	"tool_name" text,
	"billed_to" text DEFAULT 'gateway' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_rollups" (
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	"period" text NOT NULL,
	"period_start" text NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_rollups_scope_scope_key_period_period_start_pk" PRIMARY KEY("scope","scope_key","period","period_start")
);
--> statement-breakpoint
CREATE TABLE "team_week_results" (
	"team_id" integer NOT NULL,
	"week" integer NOT NULL,
	"actual_points" numeric(8, 2) NOT NULL,
	"optimal_points" numeric(8, 2) NOT NULL,
	"points_left_on_bench" numeric(8, 2) NOT NULL,
	"fa_points" numeric(8, 2) NOT NULL,
	"empty_starting_slots" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_week_results_team_id_week_pk" PRIMARY KEY("team_id","week")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text,
	"motto" text,
	"model_id" text NOT NULL,
	"model_label" text NOT NULL,
	"provider" text NOT NULL,
	"draft_slot" integer,
	"waiver_priority" integer,
	"tiebreak_rand" numeric(10, 9) NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"eliminated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "tool_costs" (
	"tool_name" text PRIMARY KEY NOT NULL,
	"usd_per_call" numeric(12, 6) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_votes" (
	"trade_id" integer NOT NULL,
	"team_id" integer NOT NULL,
	"vote" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trade_votes_trade_id_team_id_pk" PRIMARY KEY("trade_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"proposer_team_id" integer NOT NULL,
	"counterparty_team_id" integer NOT NULL,
	"give_player_ids" text[] NOT NULL,
	"get_player_ids" text[] NOT NULL,
	"message" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"proposed_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"review_ends_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"parent_trade_id" integer,
	"resolution_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"week" integer,
	"team_ids" integer[] NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waiver_claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"team_id" integer NOT NULL,
	"add_player_id" text NOT NULL,
	"drop_player_id" text,
	"priority" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"run_id" integer
);
--> statement-breakpoint
CREATE TABLE "waiver_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_posts" ADD CONSTRAINT "board_posts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_alarms" ADD CONSTRAINT "cost_alarms_rule_id_cost_alarm_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."cost_alarm_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_logs" ADD CONSTRAINT "decision_logs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_picks" ADD CONSTRAINT "draft_picks_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_picks" ADD CONSTRAINT "draft_picks_player_id_players_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("player_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineup_entries" ADD CONSTRAINT "lineup_entries_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineup_entries" ADD CONSTRAINT "lineup_entries_player_id_players_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("player_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matchups" ADD CONSTRAINT "matchups_home_team_id_teams_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matchups" ADD CONSTRAINT "matchups_away_team_id_teams_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_player_id_players_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("player_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scratchpad_versions" ADD CONSTRAINT "scratchpad_versions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scratchpads" ADD CONSTRAINT "scratchpads_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_votes" ADD CONSTRAINT "trade_votes_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_votes" ADD CONSTRAINT "trade_votes_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_proposer_team_id_teams_id_fk" FOREIGN KEY ("proposer_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_counterparty_team_id_teams_id_fk" FOREIGN KEY ("counterparty_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_claims" ADD CONSTRAINT "waiver_claims_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_claims" ADD CONSTRAINT "waiver_claims_add_player_id_players_player_id_fk" FOREIGN KEY ("add_player_id") REFERENCES "public"."players"("player_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_posts_created_idx" ON "board_posts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "board_posts_root_idx" ON "board_posts" USING btree ("root_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_alarms_dedupe_uq" ON "cost_alarms" USING btree ("rule_id","scope_key","period_start","threshold_usd");--> statement-breakpoint
CREATE INDEX "decision_logs_team_idx" ON "decision_logs" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "fp_usage_team_day_idx" ON "fp_usage" USING btree ("team_id","day_et");--> statement-breakpoint
CREATE UNIQUE INDEX "lineup_entries_team_week_slot_uq" ON "lineup_entries" USING btree ("team_id","week","slot");--> statement-breakpoint
CREATE UNIQUE INDEX "lineup_entries_team_week_player_uq" ON "lineup_entries" USING btree ("team_id","week","player_id");--> statement-breakpoint
CREATE INDEX "lineup_entries_team_week_idx" ON "lineup_entries" USING btree ("team_id","week");--> statement-breakpoint
CREATE INDEX "matchups_week_idx" ON "matchups" USING btree ("week");--> statement-breakpoint
CREATE INDEX "nfl_games_season_week_idx" ON "nfl_games" USING btree ("season","week");--> statement-breakpoint
CREATE INDEX "player_week_stats_season_week_idx" ON "player_week_stats" USING btree ("season","week");--> statement-breakpoint
CREATE INDEX "players_yahoo_id_idx" ON "players" USING btree ("yahoo_id");--> statement-breakpoint
CREATE INDEX "players_waiver_until_idx" ON "players" USING btree ("waiver_until");--> statement-breakpoint
CREATE INDEX "players_nfl_team_idx" ON "players" USING btree ("nfl_team");--> statement-breakpoint
CREATE INDEX "roster_entries_team_idx" ON "roster_entries" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "scheduled_jobs_status_due_idx" ON "scheduled_jobs" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "scratchpad_versions_team_idx" ON "scratchpad_versions" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "session_events_session_seq_idx" ON "session_events" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "sessions_team_started_idx" ON "sessions" USING btree ("team_id","started_at");--> statement-breakpoint
CREATE INDEX "spend_ledger_team_created_idx" ON "spend_ledger" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE INDEX "spend_ledger_session_idx" ON "spend_ledger" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "trades_status_idx" ON "trades" USING btree ("status");--> statement-breakpoint
CREATE INDEX "trades_proposer_idx" ON "trades" USING btree ("proposer_team_id");--> statement-breakpoint
CREATE INDEX "trades_counterparty_idx" ON "trades" USING btree ("counterparty_team_id");--> statement-breakpoint
CREATE INDEX "transactions_type_idx" ON "transactions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "transactions_created_idx" ON "transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "waiver_claims_team_status_idx" ON "waiver_claims" USING btree ("team_id","status");