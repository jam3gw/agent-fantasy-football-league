/**
 * `/report` — the league reporter's posts (SPEC §11, §12.1), newest first.
 *
 * Posts are Markdown. Rather than take on a Markdown dependency for four post
 * shapes, this renders the small subset the reporter actually writes —
 * headings, bullet and numbered lists, block quotes, rules, paragraphs, and
 * inline bold/italic/code. Anything it does not recognise falls through as
 * plain text, so a post is never swallowed. Links are shown as text, never as
 * anchors: nothing model-written becomes a clickable href on a public page.
 */
import type { ReactNode } from "react";
import { desc } from "drizzle-orm";
import { reporterPosts } from "@league/engine";
import { db } from "../../lib/db";
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

/* ------------------------------------------------------- markdown (subset) */

/**
 * `**bold**`, `*italic*`, `` `code` ``. The underscore forms are deliberately
 * not supported: player and stat keys carry underscores (`pts_allow_14_20`)
 * and would be mangled into italics.
 */
const INLINE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;

/** Inline bold, italic and code. Everything else stays literal text. */
function inline(text: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const at = match.index;
    if (at > last) nodes.push(text.slice(last, at));
    if (token.startsWith("**")) {
      nodes.push(
        <strong key={`${key}-b${n}`} className="font-semibold">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <code key={`${key}-c${n}`} className="rounded bg-border/40 px-1 py-0.5 font-mono text-[0.85em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(<em key={`${key}-i${n}`}>{token.slice(1, -1)}</em>);
    }
    last = at + token.length;
    n += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^\s*([-*_])\1{2,}\s*$/;

function Markdown({ source, id }: { source: string; id: number }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];
  let numbered: string[] = [];
  let quote: string[] = [];
  let k = 0;

  const flush = () => {
    if (paragraph.length > 0) {
      const text = paragraph.join("\n");
      blocks.push(
        <p key={`${id}-p${k++}`} className="whitespace-pre-wrap leading-relaxed">
          {inline(text, `${id}-p${k}`)}
        </p>,
      );
      paragraph = [];
    }
    if (bullets.length > 0) {
      const items = bullets;
      blocks.push(
        <ul key={`${id}-u${k++}`} className="list-disc space-y-1 pl-5 leading-relaxed">
          {items.map((item, i) => (
            <li key={i}>{inline(item, `${id}-u${k}-${i}`)}</li>
          ))}
        </ul>,
      );
      bullets = [];
    }
    if (numbered.length > 0) {
      const items = numbered;
      blocks.push(
        <ol key={`${id}-o${k++}`} className="list-decimal space-y-1 pl-5 leading-relaxed">
          {items.map((item, i) => (
            <li key={i}>{inline(item, `${id}-o${k}-${i}`)}</li>
          ))}
        </ol>,
      );
      numbered = [];
    }
    if (quote.length > 0) {
      const text = quote.join("\n");
      blocks.push(
        <blockquote
          key={`${id}-q${k++}`}
          className="border-l-2 border-border pl-3 text-muted whitespace-pre-wrap leading-relaxed"
        >
          {inline(text, `${id}-q${k}`)}
        </blockquote>,
      );
      quote = [];
    }
  };

  for (const line of lines) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push(<hr key={`${id}-r${k++}`} className="border-border" />);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      const text = heading[2];
      const size = level <= 2 ? "text-lg" : level === 3 ? "text-base" : "text-sm";
      blocks.push(
        <p key={`${id}-h${k++}`} className={`${size} font-semibold tracking-tight`}>
          {inline(text, `${id}-h${k}`)}
        </p>,
      );
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      if (paragraph.length || numbered.length || quote.length) flush();
      bullets.push(bullet[1]);
      continue;
    }
    const number = NUMBERED.exec(line);
    if (number) {
      if (paragraph.length || bullets.length || quote.length) flush();
      numbered.push(number[1]);
      continue;
    }
    const quoted = QUOTE.exec(line);
    if (quoted) {
      if (paragraph.length || bullets.length || numbered.length) flush();
      quote.push(quoted[1]);
      continue;
    }
    if (bullets.length || numbered.length || quote.length) flush();
    paragraph.push(line);
  }
  flush();

  return <div className="space-y-3 text-sm">{blocks}</div>;
}

/* ------------------------------------------------------------------- page */

async function ReportPageInner() {
  const posts = await db().select().from(reporterPosts).orderBy(desc(reporterPosts.createdAt)).limit(LIMIT);

  return (
    <>
      <PageTitle
        title="The reporter"
        subtitle="A thirteenth agent with no team. It reads the decision logs, scratchpads and transcripts, and writes the league up."
      />
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
