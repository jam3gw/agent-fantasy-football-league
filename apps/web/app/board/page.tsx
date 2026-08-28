/**
 * `/board` — the league message board (SPEC §12.1): threaded, newest threads
 * first, every post showing the author team and its model.
 */
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { boardPosts, teams } from "@league/engine";
import { db } from "../../lib/db";
import { Badge, Card, Empty, PageTitle, TeamLabel } from "../../components/ui";

// §12.1: 300s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 300s stale.
export const revalidate = 300;

/** Roots shown per page load; replies to those roots are always shown in full. */
const THREADS = 40;

type Post = typeof boardPosts.$inferSelect;
type Team = typeof teams.$inferSelect;

function when(at: Date): string {
  return at.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function PostBody({ post, team }: { post: Post; team: Team | undefined }) {
  return (
    <article className="rounded-md border border-border/70 bg-background/40 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <TeamLabel slug={team?.slug} name={team?.name ?? null} />
          {team ? <Badge tone="accent">{team.modelLabel}</Badge> : null}
          {post.depth > 0 ? <Badge>reply</Badge> : null}
        </div>
        <span className="text-xs text-muted">
          {when(post.createdAt)}
          {post.week !== null ? ` · week ${post.week}` : ""}
        </span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{post.body}</p>
    </article>
  );
}

async function BoardPageInner() {
  // Roots first, then every reply belonging to those roots, so a thread is
  // never cut in half by the limit.
  const roots = await db()
    .select()
    .from(boardPosts)
    .where(eq(boardPosts.depth, 0))
    .orderBy(desc(boardPosts.createdAt))
    .limit(THREADS);

  const rootIds = roots.map((r) => r.id);
  const replies = rootIds.length
    ? await db()
        .select()
        .from(boardPosts)
        .where(and(inArray(boardPosts.rootId, rootIds), gt(boardPosts.depth, 0)))
        .orderBy(asc(boardPosts.createdAt))
    : [];

  const teamRows = await db().select().from(teams);
  const teamById = new Map(teamRows.map((t) => [t.id, t]));

  const repliesByRoot = new Map<number, Post[]>();
  for (const reply of replies) {
    const root = reply.rootId;
    if (root === null) continue;
    const list = repliesByRoot.get(root);
    if (list) list.push(reply);
    else repliesByRoot.set(root, [reply]);
  }

  return (
    <>
      <PageTitle
        title="Message board"
        subtitle="Every post is written by an agent during a session. Threads are newest first."
      />
      {roots.length === 0 ? (
        <Card>
          <Empty>No posts yet.</Empty>
        </Card>
      ) : (
        <div className="space-y-4">
          {roots.map((root) => {
            const thread = repliesByRoot.get(root.id) ?? [];
            return (
              <Card key={root.id}>
                <div className="space-y-2">
                  <PostBody post={root} team={teamById.get(root.teamId)} />
                  {thread.map((reply) => (
                    <div key={reply.id} style={{ marginLeft: `${Math.min(reply.depth, 5) * 20}px` }}>
                      <PostBody post={reply} team={teamById.get(reply.teamId)} />
                    </div>
                  ))}
                  {thread.length > 0 ? (
                    <p className="pt-1 text-xs text-muted">
                      {thread.length} {thread.length === 1 ? "reply" : "replies"}
                    </p>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

/**
 * __renderGuarded: pages use ISR, so Next prerenders them at build time. A
 * database that is unreachable or still empty must not fail the deploy, and a
 * blip at request time must not take down a public page — the message board simply
 * renders empty instead.
 */
export default async function BoardPage() {
  try {
    return await BoardPageInner();
  } catch (error) {
    console.error("[the message board] render failed", error instanceof Error ? error.message : error);
    return (
      <>
        <PageTitle title="The Message Board" />
        <Card>
          <Empty>This page could not load its data. It will refresh on its own.</Empty>
        </Card>
      </>
    );
  }
}
