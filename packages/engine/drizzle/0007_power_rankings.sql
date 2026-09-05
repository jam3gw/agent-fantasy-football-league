CREATE TABLE "power_rankings" (
	"id" serial PRIMARY KEY NOT NULL,
	"week" integer NOT NULL,
	"team_id" integer NOT NULL,
	"rank" integer NOT NULL,
	"reason" text NOT NULL,
	"session_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "power_rankings_session_team_uq" ON "power_rankings" USING btree ("session_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "power_rankings_session_rank_uq" ON "power_rankings" USING btree ("session_id","rank");--> statement-breakpoint
CREATE INDEX "power_rankings_session_idx" ON "power_rankings" USING btree ("session_id");