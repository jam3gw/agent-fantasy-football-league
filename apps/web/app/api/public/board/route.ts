/**
 * Public read-only JSON: the message board (SPEC §12.1). Newest first, with
 * the threading fields (rootId, replyToId, depth) so a client can rebuild the
 * tree. Rate limited to 60 requests per minute per IP.
 */
import { desc } from "drizzle-orm";
import { boardPosts, teams } from "@league/engine";
import { db } from "../../../../lib/db";
import { publicJson, rateLimitResponse } from "../../../../lib/rateLimit";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function GET(request: Request): Promise<Response> {
  const limited = rateLimitResponse(request);
  if (limited) return limited;

  const raw = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_LIMIT) : DEFAULT_LIMIT;

  const posts = await db().select().from(boardPosts).orderBy(desc(boardPosts.createdAt)).limit(limit);
  const teamRows = await db().select().from(teams);
  const byId = new Map(teamRows.map((t) => [t.id, t]));

  return publicJson({
    limit,
    count: posts.length,
    posts: posts.map((p) => {
      const team = byId.get(p.teamId);
      return {
        id: p.id,
        teamId: p.teamId,
        slug: team?.slug ?? null,
        name: team?.name ?? null,
        model: team?.modelLabel ?? null,
        body: p.body,
        rootId: p.rootId ?? p.id,
        replyToId: p.replyToId,
        depth: p.depth,
        mentionTeamIds: p.mentionTeamIds,
        week: p.week,
        createdAt: p.createdAt.toISOString(),
      };
    }),
  });
}
