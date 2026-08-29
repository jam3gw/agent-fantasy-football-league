import "server-only";
/**
 * The freshness stamp behind the site's auto-refresh (SPEC §12.1). One cheap
 * read per poll: the maxima of the append-only ids and `updated_at` columns
 * that change whenever anything a spectator can see changes — transcripts,
 * transactions, board and reporter posts, session status, live matchup points,
 * and the draft clock. The client compares stamps and re-renders the server
 * components only when the stamp moves, so an idle league costs one tiny
 * query per open tab per interval and no re-renders.
 */
import { sql } from "drizzle-orm";
import type { EngineDb } from "@league/engine";
import {
  boardPosts,
  draft,
  matchups,
  reporterPosts,
  sessionEvents,
  sessions,
  transactions,
} from "@league/engine";

export async function computePulseStamp(database: EngineDb): Promise<string> {
  const [se, tx, bp, rp, s, m, d] = await Promise.all([
    database.select({ v: sql<number | null>`max(${sessionEvents.id})` }).from(sessionEvents),
    database.select({ v: sql<number | null>`max(${transactions.id})` }).from(transactions),
    database.select({ v: sql<number | null>`max(${boardPosts.id})` }).from(boardPosts),
    database.select({ v: sql<number | null>`max(${reporterPosts.id})` }).from(reporterPosts),
    database.select({ v: sql<string | null>`max(${sessions.updatedAt})` }).from(sessions),
    database.select({ v: sql<string | null>`max(${matchups.updatedAt})` }).from(matchups),
    database.select({ v: sql<string | null>`max(${draft.updatedAt})` }).from(draft),
  ]);
  const parts = [se, tx, bp, rp, s, m, d].map((rows) => String(rows[0]?.v ?? ""));
  return parts.join("|");
}
