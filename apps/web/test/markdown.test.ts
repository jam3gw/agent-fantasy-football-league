/**
 * The shared Markdown subset renderer carries everything model-written on the
 * public pages — reporter posts, scratchpads, board posts, feed items. What
 * matters is that the subset renders, that anything outside it falls through
 * as literal text, and that nothing model-written ever becomes a clickable
 * link.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InlineMarkdown, Markdown } from "../components/markdown";

function block(source: string): string {
  return renderToStaticMarkup(createElement(Markdown, { source, id: "t" }));
}

function inline(source: string): string {
  return renderToStaticMarkup(createElement(InlineMarkdown, { source, id: "t" }));
}

describe("the markdown subset", () => {
  it("renders inline bold, italic and code", () => {
    const html = block("A **bold** move, an *italic* aside, a `code` key.");
    expect(html).toContain("<strong");
    expect(html).toContain("bold</strong>");
    expect(html).toContain("<em");
    expect(html).toContain("italic</em>");
    expect(html).toContain("<code");
    expect(html).toContain("code</code>");
    expect(html).not.toContain("**");
  });

  it("leaves underscore emphasis alone, because stat keys carry underscores", () => {
    expect(block("the `pts_allow_14_20` bucket")).toContain("pts_allow_14_20");
    expect(block("_not italics_")).toContain("_not italics_");
  });

  it("renders headings, bullets, numbers, quotes and rules", () => {
    const html = block("## Plan\n- first\n- second\n1. one\n> quoted\n\n---");
    expect(html).toContain("Plan");
    expect(html).toContain("<ul");
    expect(html).toContain("<li>first</li>");
    expect(html).toContain("<ol");
    expect(html).toContain("<blockquote");
    expect(html).toContain("quoted");
    expect(html).toContain("<hr");
    expect(html).not.toContain("##");
  });

  it("renders triple emphasis as bold italic rather than leaving stray asterisks", () => {
    const html = block("A ***bold italic*** aside.");
    expect(html).toContain("<strong");
    expect(html).toContain("<em>bold italic</em>");
    expect(html).not.toContain("*");
  });

  it("renders a spaced thematic break (`- - -`) as a rule, not a bullet", () => {
    const html = block("above\n\n- - -\n\nbelow");
    expect(html).toContain("<hr");
    expect(html).not.toContain("<ul");
  });

  it("renders fenced blocks verbatim in monospace — their lines are not markdown", () => {
    const html = block("before\n```\n# not a heading\n- not a bullet\n```\nafter");
    expect(html).toContain("<pre");
    expect(html).toContain("# not a heading\n- not a bullet");
    expect(html).not.toContain("<ul");
    expect(html).not.toContain("text-lg");
  });

  it("still renders an unclosed fence rather than swallowing it", () => {
    const html = block("```\ntrapped text");
    expect(html).toContain("trapped text");
  });

  it("renders a one-line fence (```code```) without swallowing the code or what follows", () => {
    const html = block("before\n```code here``` trailing prose\nafter");
    expect(html).toContain("<pre");
    expect(html).toContain("code here");
    expect(html).toContain("trailing prose");
    expect(html).toContain("after");
  });

  it("drops a language tag as an info string but keeps non-tag content on the fence line", () => {
    const tagged = block("```ts\nconst x = 1\n```");
    expect(tagged).toContain("const x = 1");
    expect(tagged).not.toContain("ts\n");
    const inlineJson = block('```{"json": 1}\ntrapped');
    expect(inlineJson).toContain('{&quot;json&quot;: 1}');
    expect(inlineJson).toContain("trapped");
  });

  it("does not close a backtick fence with a tilde fence", () => {
    const html = block("```\ncode\n~~~\nmore code\n```\nprose");
    expect(html).toContain("~~~");
    expect(html).toContain("more code");
    expect(html).toContain("prose");
    expect(html).not.toContain("<p>more code");
  });

  it("normalizes CRLF line endings", () => {
    const html = block("- one\r\n- two");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
  });

  it("never renders a link as an anchor — model text must not become an href", () => {
    const html = block("See [the site](https://example.com) for more.");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href");
  });

  it("never renders image syntax as an img", () => {
    const html = block("![a picture](https://example.com/x.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("![a picture]");
  });

  it("escapes raw HTML — the one security invariant of a page full of model text", () => {
    const html = block('<script>alert(1)</script><img src=x onerror="y">');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("falls through unrecognised syntax as plain text rather than swallowing it", () => {
    const html = block("| a | table |\n| - | ----- |");
    expect(html).toContain("| a | table |");
  });
});

describe("the inline renderer for one-line feed items", () => {
  it("renders inline tokens and nothing else", () => {
    const html = inline("Named my team **The Gibbs Factor** with the motto: *Zero RB? Never heard of her.*");
    expect(html).toContain("The Gibbs Factor</strong>");
    expect(html).toContain("<em");
    expect(html).not.toContain("<p");
  });

  it("degrades an unbalanced marker to literal text rather than eating content", () => {
    const html = inline("A truncated **bold that never closes");
    expect(html).toContain("**bold that never closes");
    expect(html).not.toContain("<strong");
  });
});
