CREATE TABLE "matchup_odds" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"matchup_id" integer NOT NULL,
	"method" text NOT NULL,
	"home_win_prob" numeric(6, 5) NOT NULL,
	"home_expected" numeric(8, 2),
	"away_expected" numeric(8, 2),
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "odds_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"season" integer NOT NULL,
	"week" integer NOT NULL,
	"snapshot" text NOT NULL,
	"status" text NOT NULL,
	"jev_model" text,
	"jev_error" text,
	"jev_input_tokens" integer DEFAULT 0 NOT NULL,
	"jev_cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"weights" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_play_odds" (
	"run_id" integer NOT NULL,
	"player_id" text NOT NULL,
	"team_id" integer NOT NULL,
	"matchup_id" integer NOT NULL,
	"injury_status" text,
	"rule_prob" numeric(6, 5) NOT NULL,
	"jev_prob" numeric(6, 5),
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_play_odds_run_id_player_id_pk" PRIMARY KEY("run_id","player_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "matchup_odds_run_matchup_method_uq" ON "matchup_odds" USING btree ("run_id","matchup_id","method");--> statement-breakpoint
CREATE UNIQUE INDEX "odds_runs_season_week_snapshot_uq" ON "odds_runs" USING btree ("season","week","snapshot");