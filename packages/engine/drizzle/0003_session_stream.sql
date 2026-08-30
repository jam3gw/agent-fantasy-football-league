-- Live transcript stream (SPEC 12.1): the in-flight partial output of a
-- running session's current model step. One row per session, upserted as
-- deltas stream in, deleted when the step's assistant event is recorded.
--
-- Note: drizzle-kit also re-generated the FantasyPros drops here because the
-- hand-written 0002 migration shipped without a snapshot; those statements are
-- removed from this file (production already ran them), and 0003_snapshot.json
-- now records the true current schema.
CREATE TABLE "session_stream" (
	"session_id" integer PRIMARY KEY NOT NULL,
	"step_no" integer NOT NULL,
	"reasoning" text DEFAULT '' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_stream" ADD CONSTRAINT "session_stream_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;
