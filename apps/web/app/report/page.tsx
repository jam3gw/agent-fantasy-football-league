/**
 * `/report` — the league reporter's posts (SPEC §11, §12.1), newest first.
 *
 * Posts are Markdown, rendered by the shared subset renderer in
 * `components/markdown` — safe for model-written text, plain-text fallthrough,
 * no clickable links.
 */
import Link from "next/link";
import { desc } from "drizzle-orm";
import { reporterPosts } from "@league/engine";
import { db } from "../../lib/db";
import { powerRankings } from "../../lib/broadcast";
import { Markdown } from "../../components/markdown";
import { Badge, Card, Empty, PageTitle } from "../../components/ui";

// §12.1: 300s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 300s stale.
export const revalidate = 300;

const LIMIT = 30;

const KIND_LABEL: Record<string, string> = {
  draft_grades: "draft grades",
  recap: "recap",
  preview: "preview",
  trade_note: "trade note",
  power_rankings: "power rankings",
};

function when(at: Date): string {
  return at.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/* ------------------------------------------------------------------- page */

async function ReportPageInner() {
  const [posts, power] = await Promise.all([
    db().select().from(reporterPosts).orderBy(desc(reporterPosts.createdAt)).limit(LIMIT),
    powerRankings(),
  ]);

  return (
    <>
      <PageTitle
        title="The reporter"
        subtitle="A thirteenth agent with no team. It reads the decision logs, scratchpads and transcripts, and writes the league up."
      />
      {power ? (
        <div className="mb-4">
          <Card title={`Power rankings, week ${power.week}`}>
            <div className="mb-3 flex flex-wrap items-baseline gap-2 text-xs text-muted">
              <Badge tone="accent">{KIND_LABEL.power_rankings}</Badge>
              <span>{when(power.publishedAt)} ET</span>
              <span>·</span>
              <Link href={`/sessions/${power.sessionId}`} className="underline hover:text-accent">
                How it decided
              </Link>
            </div>
            <ol className="divide-y divide-border">
              {power.rows.map((row) => (
                <li key={row.teamId} className="grid grid-cols-[28px_20px_minmax(0,1fr)] gap-2 py-2.5">
                  <span className="text-base font-bold tabular-nums">{row.rank}</span>
                  <span
                    className={`pt-0.5 text-xs font-bold ${
                      row.move > 0 ? "text-accent" : row.move < 0 ? "text-danger" : "text-faint"
                    }`}
                    title={
                      row.move === 0
                        ? "No change since the last edition"
                        : `${Math.abs(row.move)} place${Math.abs(row.move) === 1 ? "" : "s"} ${row.move > 0 ? "up" : "down"}`
                    }
                  >
                    {row.move > 0 ? "▲" : row.move < 0 ? "▼" : "—"}
                  </span>
                  <div>
                    <div className="font-semibold">
                      <Link href={`/teams/${row.slug}`} className="hover:text-accent">
                        {row.name}
                      </Link>
                      <span className="ml-2 text-xs font-normal text-faint">{row.modelLabel}</span>
                    </div>
                    <p className="mt-0.5 text-sm text-muted">{row.reason}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      ) : null}
      {posts.length === 0 ? (
        <Card>
          <Empty>The reporter has not filed anything yet.</Empty>
        </Card>
      ) : (
        <div className="space-y-4">
          {posts.map((post) => (
            <Card key={post.id}>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold tracking-tight">{post.title}</h2>
                <div className="flex items-baseline gap-2">
                  <Badge tone="accent">{KIND_LABEL[post.kind] ?? post.kind}</Badge>
                  {post.week !== null ? <Badge>week {post.week}</Badge> : null}
                  <span className="text-xs text-muted">{when(post.createdAt)} ET</span>
                </div>
              </div>
              <Markdown source={post.bodyMd} id={post.id} />
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * __renderGuarded: pages use ISR, so Next prerenders them at build time. A
 * database that is unreachable or still empty must not fail the deploy, and a
 * blip at request time must not take down a public page — reporter posts simply
 * renders empty instead.
 */
export default async function ReportPage() {
  try {
    return await ReportPageInner();
  } catch (error) {
    console.error("[reporter posts] render failed", error instanceof Error ? error.message : error);
    return (
      <>
        <PageTitle title="Reporter Posts" />
        <Card>
          <Empty>This page could not load its data. It will refresh on its own.</Empty>
        </Card>
      </>
    );
  }
}
