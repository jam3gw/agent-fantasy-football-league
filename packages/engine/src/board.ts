/**
 * Message board writes (§8.4 post_message, §6 board_posts, §9.3 board.posted).
 * Only agents post; humans read. Mentions are `@Team Name`, case-insensitive
 * exact team name.
 */
import { eq } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "./db/index.ts";
import { boardPosts, teams } from "./db/schema.ts";
import type { EngineResult } from "./errors.ts";
import { fail, ok } from "./errors.ts";
import { handleEvent } from "./events.ts";
import { getSettings } from "./settings.ts";

export const MAX_POST_LENGTH = 1000;

/** Case-insensitive `@Team Name` mention parse against current team names. */
export function parseMentions(body: string, allTeams: Array<{ id: number; name: string | null }>): number[] {
  const lower = body.toLowerCase();
  const mentioned: number[] = [];
  for (const t of allTeams) {
    if (!t.name) continue;
    if (lower.includes(`@${t.name.toLowerCase()}`)) mentioned.push(t.id);
  }
  return mentioned;
}

export async function postMessage(
  db: EngineDb,
  clock: Clock,
  teamId: number,
  body: string,
  replyToId?: number | null,
): Promise<EngineResult<{ postId: number; mentionTeamIds: number[] }>> {
  if (!body.trim()) return fail("invalid_args", "post body is empty");
  if (body.length > MAX_POST_LENGTH)
    return fail("too_long", `post body is ${body.length} characters; the maximum is ${MAX_POST_LENGTH}`);

  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    const author = (await tx.select().from(teams).where(eq(teams.id, teamId)))[0];
    if (!author) return fail("not_found", `team ${teamId} does not exist`);
    if (author.paused) return fail("team_paused", "your team is paused; posting is disabled");

    let depth = 0;
    let rootId: number | null = null;
    if (replyToId != null) {
      const parent = (await tx.select().from(boardPosts).where(eq(boardPosts.id, replyToId)))[0];
      if (!parent) return fail("not_found", `post ${replyToId} does not exist`);
      depth = parent.depth + 1;
      rootId = parent.rootId ?? parent.id;
    }

    const allTeams = await tx.select({ id: teams.id, name: teams.name }).from(teams);
    const mentionTeamIds = parseMentions(body, allTeams).filter((id) => id !== teamId);

    const inserted = await tx
      .insert(boardPosts)
      .values({
        teamId,
        body,
        replyToId: replyToId ?? null,
        rootId,
        depth,
        mentionTeamIds,
        week: settings.currentWeek,
      })
      .returning({ id: boardPosts.id });
    const postId = inserted[0]!.id;
    if (rootId === null) {
      await tx.update(boardPosts).set({ rootId: postId }).where(eq(boardPosts.id, postId));
    }

    await handleEvent(tx, clock, {
      type: "board.posted",
      postId,
      authorTeamId: teamId,
      mentionTeamIds,
      depth,
    });
    return ok({ postId, mentionTeamIds });
  });
}
