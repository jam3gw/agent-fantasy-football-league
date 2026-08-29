/**
 * The site is read on a phone as often as anything else, and every one of
 * these was a real defect measured in a 375px-wide Chromium against the
 * deployed site — not a style preference. `apps/web/scripts/mobile-audit.mjs`
 * is the measurement; this file keeps the fixes from being undone.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const ui = readFileSync(join(appRoot, "components/ui.tsx"), "utf8");
const sessionSteps = readFileSync(join(appRoot, "components/session-steps.tsx"), "utf8");
const css = readFileSync(join(appRoot, "app/globals.css"), "utf8");

describe("a wide table scrolls instead of squashing", () => {
  it("the table is not pinned to its container's width", () => {
    // `min-w-full` pins the table to the scroller, so more columns just make
    // narrower columns: /benchmark rendered seven of them in 375px, and every
    // cell wrapped to three lines. A minimum proportional to the column count
    // makes it overflow the scroller, which is what the scroller is for.
    expect(ui).not.toMatch(/className="[^"]*min-w-full/);
    expect(ui).toMatch(/minWidth/);
    expect(ui).toContain("MIN_COLUMN_REM");
  });

  it("headers do not wrap", () => {
    expect(ui).toMatch(/whitespace-nowrap[^"]*px-2 py-2 font-medium/);
  });

  it("the scroll container can actually shrink", () => {
    // Without `min-width: 0` a scroller that is itself a grid or flex child is
    // sized by its content and pushes the page sideways instead of scrolling.
    const block = css.slice(css.indexOf(".table-scroll"), css.indexOf(".table-scroll") + 200);
    expect(block).toContain("overflow-x: auto");
    expect(block).toContain("min-width: 0");
  });
});

describe("cards can shrink", () => {
  it("Card carries min-w-0", () => {
    // A grid child defaults to `min-width: auto` — its content's minimum — so
    // a card holding a wide table refused to shrink and the whole /benchmark
    // page scrolled sideways by 63px at 375px.
    expect(ui).toMatch(/<section className="min-w-0 /);
  });
});

describe("no layout forces three columns onto a phone", () => {
  it("every grid of three or more columns is behind a breakpoint", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".next") continue;
          walk(full);
          continue;
        }
        if (!/\.tsx$/.test(entry.name)) continue;
        const text = readFileSync(full, "utf8");
        // Two short columns are fine on a phone — a pair of stats reads well.
        // Three or more is not, so those must be behind a breakpoint.
        for (const m of text.matchAll(/(^|[\s"'`])(grid-cols-([3-9]|1[0-2]))/g)) {
          offenders.push(`${full.replace(appRoot, "")}: ${m[2]}`);
        }
      }
    };
    walk(join(appRoot, "app"));
    walk(join(appRoot, "components"));
    expect(offenders).toEqual([]);
  });
});

describe("the session transcript's own tables scroll", () => {
  // These are hand-rolled rather than built from `Table`, because a roster and
  // a free-agent pool need slot chips, injury flags and per-column alignment
  // that the generic component does not carry. They still have to obey the
  // same rule: a real minimum width, so the table overflows its scroller
  // instead of wrapping every player's name onto three lines.
  it("every table inside a step sits in a scroller", () => {
    const tables = sessionSteps.match(/<table/g) ?? [];
    const scrollers = sessionSteps.match(/className="table-scroll"/g) ?? [];
    expect(tables.length).toBeGreaterThan(0);
    expect(scrollers).toHaveLength(tables.length);
  });

  it("every table has a minimum width so it scrolls rather than squashes", () => {
    const tables = sessionSteps.match(/<table className="[^"]*"/g) ?? [];
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) expect(table).toMatch(/min-w-\[/);
  });
});
