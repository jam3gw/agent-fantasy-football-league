/**
 * Measure the site at phone widths. This is how the mobile defects were found
 * rather than guessed at: a 375px Chromium against the deployed pages, looking
 * for the three things that actually break a page on a phone.
 *
 *   node apps/web/scripts/mobile-audit.mjs <base-url> [path ...]
 *
 * Reports, per page:
 *   pageOverflow  the page scrolls sideways. Always a bug — usually a grid or
 *                 flex child with the default `min-width: auto` refusing to
 *                 shrink around a wide table.
 *   squashed      a table of five or more columns that does NOT overflow its
 *                 scroller, i.e. it compressed the columns instead. Every cell
 *                 wraps to three lines and the table is unreadable.
 *   tallRows      a body row over 60px, which is the same symptom measured
 *                 from the other side.
 *
 * Needs `playwright` and the preinstalled Chromium. Not part of `pnpm test`:
 * it wants a running deployment, and CI has none.
 */
import { chromium } from "playwright";

const [, , baseArg, ...pathArgs] = process.argv;
if (!baseArg) {
  console.error("usage: node apps/web/scripts/mobile-audit.mjs <base-url> [path ...]");
  process.exit(1);
}
const base = baseArg.replace(/\/$/, "");
const paths = pathArgs.length
  ? pathArgs
  : ["/", "/standings", "/matchups/1", "/transactions", "/waivers", "/trades",
     "/board", "/draft", "/report", "/benchmark", "/spend", "/about"];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
let problems = 0;

for (const width of [375, 414]) {
  console.log(`\n=== ${width}px ===`);
  const ctx = await browser.newContext({ viewport: { width, height: 812 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  for (const path of paths) {
    const res = await page.goto(base + path, { waitUntil: "networkidle" }).catch(() => null);
    if (!res || res.status() >= 400) {
      console.log(`${path.padEnd(16)} HTTP ${res ? res.status() : "unreachable"}`);
      continue;
    }
    const r = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const tables = [...document.querySelectorAll(".table-scroll")]
        .map((d) => {
          const t = d.querySelector("table");
          if (!t) return null;
          let maxRowH = 0;
          for (const tr of t.querySelectorAll("tbody tr")) {
            maxRowH = Math.max(maxRowH, tr.getBoundingClientRect().height);
          }
          return {
            cols: t.querySelectorAll("thead th").length,
            scrolls: t.scrollWidth > d.clientWidth + 1,
            maxRowH: Math.round(maxRowH),
          };
        })
        .filter(Boolean);
      return {
        overflow: document.documentElement.scrollWidth - vw,
        squashed: tables.filter((t) => t.cols >= 5 && !t.scrolls).length,
        tallRows: tables.filter((t) => t.maxRowH > 60).length,
        tables: tables.length,
      };
    });
    const bad = r.overflow > 0 || r.squashed > 0 || r.tallRows > 0;
    if (bad) problems++;
    console.log(
      `${path.padEnd(16)} overflow=${String(r.overflow).padStart(3)}px  tables=${r.tables}` +
        `  squashed=${r.squashed}  tallRows=${r.tallRows}${bad ? "   <-- look here" : ""}`,
    );
  }
  await ctx.close();
}
await browser.close();
console.log(problems === 0 ? "\nNo mobile layout problems found." : `\n${problems} page/width combinations need attention.`);
process.exit(problems === 0 ? 0 : 1);
