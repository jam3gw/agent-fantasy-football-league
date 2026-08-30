/**
 * A small Markdown renderer for model-written text — the reporter's posts, the
 * agents' scratchpads, board posts, and decision summaries.
 *
 * Rather than take on a Markdown dependency, this renders the subset the
 * models actually write — headings, bullet and numbered lists, block quotes,
 * rules, paragraphs, and inline bold/italic/code. Anything it does not
 * recognise falls through as plain text, so nothing is ever swallowed. Links
 * are shown as text, never as anchors: nothing model-written becomes a
 * clickable href on a public page.
 */
import type { ReactNode } from "react";

/**
 * `***bold italic***`, `**bold**`, `*italic*`, `` `code` ``. The underscore
 * forms are deliberately not supported: player and stat keys carry underscores
 * (`pts_allow_14_20`) and would be mangled into italics.
 *
 * `INLINE_TOKEN` in `lib/broadcastLogic.ts` is this pattern's twin, used to
 * keep excerpt cuts off the middle of a token — change both together.
 */
const INLINE = /(\*{3}[^*\n]+\*{3}|\*{2}[^*\n]+\*{2}|\*[^*\n]+\*|`[^`\n]+`)/g;

/** Inline bold, italic and code. Everything else stays literal text. */
function inline(text: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const at = match.index;
    if (at > last) nodes.push(text.slice(last, at));
    if (token.startsWith("***")) {
      nodes.push(
        <strong key={`${key}-s${n}`} className="font-semibold">
          <em>{token.slice(3, -3)}</em>
        </strong>,
      );
    } else if (token.startsWith("**")) {
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

/**
 * Inline-only rendering for one-line contexts — activity feed bodies and
 * decision summaries, which are single flattened sentences rather than
 * documents. Block syntax is left alone; only bold/italic/code render.
 */
export function InlineMarkdown({ source, id }: { source: string; id: string }) {
  return <>{inline(source, id)}</>;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
// CommonMark allows spaces inside a thematic break (`- - -`), so the marker
// may repeat with or without them.
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
/** What may follow an opening fence as an info string: a bare language tag. */
const INFO_STRING = /^[\w+#.-]*$/;

export function Markdown({
  source,
  id,
  className = "space-y-3 text-sm",
}: {
  source: string;
  /** A key prefix — needs to be unique only among sibling Markdown blocks. */
  id: string | number;
  /** Spacing and base text size of the rendered block. */
  className?: string;
}) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];
  let numbered: string[] = [];
  let quote: string[] = [];
  let fence: string[] | null = null;
  let fenceChar = "";
  let k = 0;

  // A fenced block renders verbatim in monospace: its lines are code (or an
  // ASCII table), not Markdown, and block-parsing them would turn a `# comment`
  // into a heading.
  const flushFence = () => {
    if (fence && fence.length > 0) {
      blocks.push(
        <pre
          key={`${id}-f${k++}`}
          className="overflow-x-auto rounded bg-border/40 p-3 font-mono text-[0.85em] leading-relaxed"
        >
          {fence.join("\n")}
        </pre>,
      );
    }
    fence = null;
  };

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
    if (fence !== null) {
      // A closing fence uses the opening's character and carries nothing
      // after the marker (CommonMark: no closing info string). Anything else
      // on such a line is content.
      const close = FENCE.exec(line);
      if (close && close[1][0] === fenceChar && close[2].trim() === "") flushFence();
      else fence.push(line);
      continue;
    }
    const open = FENCE.exec(line);
    if (open) {
      flush();
      const markerChar = open[1][0];
      const rest = open[2];
      const closeAt = rest.indexOf(markerChar.repeat(3));
      if (closeAt >= 0) {
        // A one-line fence (```code```): the code renders, nothing is
        // dropped, and text after the closing marker stays prose.
        const content = rest.slice(0, closeAt).trim();
        fence = content === "" ? [] : [content];
        flushFence();
        const after = rest.slice(closeAt).replace(/^[`~]+/, "").trim();
        if (after !== "") paragraph.push(after);
      } else {
        fenceChar = markerChar;
        // A bare language tag after the marker is an info string and drops;
        // anything else is content and is kept as the fence's first line.
        fence = INFO_STRING.test(rest.trim()) ? [] : [rest];
      }
      continue;
    }
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
  // An unclosed fence still renders — nothing an agent writes is swallowed.
  flushFence();
  flush();

  return <div className={className}>{blocks}</div>;
}
