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

  it("never renders a link as an anchor — model text must not become an href", () => {
    const html = block("See [the site](https://example.com) for more.");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href");
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
});
