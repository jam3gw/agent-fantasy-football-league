import "server-only";
/**
 * The freshness stamp behind the site's auto-refresh (SPEC §12.1). One
 * round trip per poll: a single row of scalar subqueries over the maxima of
 * the append-only ids and `updated_at` columns that change whenever anything
 * a spectator can see changes — transcripts, transactions, board and reporter
 * posts, session status, live matchup points, the draft clock, commissioner
 * actions (pause, model swap, reversals — `teams` itself has no updated_at,
 * and §12.2 logs every admin action), and the settings singleton (week and
 * phase flips). The client compares stamps and re-renders only when the
 * stamp moves, so an idle league costs one tiny query per open tab per
 * interval. An agent renaming its team is covered by its session's own
 * transcript events.
 *
 * Deliberately not covered: `players` — it is tens of thousands of rows with
 * no `updated_at` index, ingest touches it constantly during games, and every
 * spectator-visible consequence (points, matchups, transactions) already
 * moves the stamp through the columns above.
 */
import { sql } from "drizzle-orm";
import type { EngineDb } from "@league/engine";
import { leagueSettings } from "@league/engine";

export async function computePulseStamp(database: EngineDb): Promise<string> {
  // Anchored on the settings singleton so the whole read is one statement;
  // an un-seeded database has no row and stamps as such. The subqueries are
  // plain SQL with static identifiers. Beware the correlated-subquery trap:
  // `(select max(updated_at) from t)` where `t` lacks that column silently
  // resolves against the OUTER league_settings row and turns the whole
  // statement into an aggregate — every inner column below is verified to
  // exist on its inner table, and the tests exercise each one.
  // Timestamps go through extract(epoch ...) so the stamp keeps microsecond
  // precision as a plain number: stringifying a driver-mapped Date truncates
  // to seconds, and two writes inside one second would stamp identically.
  const rows = await database
    .select({
      settings: sql<unknown>`extract(epoch from updated_at)`,
      events: sql<unknown>`(select max(id) from session_events)`,
      tx: sql<unknown>`(select max(id) from transactions)`,
      board: sql<unknown>`(select max(id) from board_posts)`,
      reporter: sql<unknown>`(select max(id) from reporter_posts)`,
      rankings: sql<unknown>`(select max(id) from power_rankings)`,
      sessions: sql<unknown>`(select extract(epoch from max(updated_at)) from sessions)`,
      matchups: sql<unknown>`(select extract(epoch from max(updated_at)) from matchups)`,
      draft: sql<unknown>`(select extract(epoch from max(updated_at)) from draft)`,
      commissioner: sql<unknown>`(select max(id) from commissioner_actions)`,
    })
    .from(leagueSettings)
    .where(sql`${leagueSettings.id} = 1`);
  const row = rows[0];
  if (!row) return "unseeded";
  return [
    row.settings,
    row.events,
    row.tx,
    row.board,
    row.reporter,
    row.rankings,
    row.sessions,
    row.matchups,
    row.draft,
    row.commissioner,
  ]
    .map((v) => String(v ?? ""))
    .join("|");
}
