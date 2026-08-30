-- Rankings moved from FantasyPros to Sleeper's projection feed (SPEC 5.7,
-- 2026-08-29). Sleeper's player_id is already our canonical id, so the external
-- id map, the unmatched queue, and the request cache/quota ledger have no
-- remaining reader.
--
-- All four hold derived or operational data only: fp_cache is API responses
-- under a TTL, fp_usage is a request counter, fp_player_map and
-- rankings_unmatched exist solely to resolve foreign player ids. No league
-- state -- rosters, transactions, results -- references any of them.
DROP TABLE IF EXISTS "fp_cache";--> statement-breakpoint
DROP TABLE IF EXISTS "fp_usage";--> statement-breakpoint
DROP TABLE IF EXISTS "fp_player_map";--> statement-breakpoint
DROP TABLE IF EXISTS "rankings_unmatched";--> statement-breakpoint
ALTER TABLE "rankings" DROP COLUMN IF EXISTS "fp_player_id";--> statement-breakpoint
-- The board is rebuilt from scratch by the next ingest, and the rows sitting
-- there now are the truncated free-tier ones (68 players against a gate of
-- 200), so there is nothing worth keeping.
DELETE FROM "rankings";--> statement-breakpoint
-- The agent research tool has no daily allowance: it reads our own tables.
ALTER TABLE "league_settings" DROP COLUMN IF EXISTS "fantasypros_daily_allowance";
