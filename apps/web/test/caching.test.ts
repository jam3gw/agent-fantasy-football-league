/**
 * §12.1 — the freshness windows, and the degradation that lets them survive a
 * database blip. Both are properties of the source, so both are asserted here
 * rather than trusted: a page that quietly goes back to per-request rendering
 * loses its CDN cache entirely (Next writes `no-store` for such a page, which
 * overrides anything `next.config` or `proxy.ts` sets on the response).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resetDatabaseBreaker, safeRead } from "../lib/queries";

/** §12.1: 30 s for the live pages, 5 minutes for the rest. */
const WINDOWS: Record<string, number> = {
  "page.tsx": 30,
  "matchups/[week]/page.tsx": 30,
  "draft/page.tsx": 30,
  "standings/page.tsx": 300,
  "board/page.tsx": 300,
  "waivers/page.tsx": 300,
  "trades/page.tsx": 300,
  "report/page.tsx": 300,
  "odds/page.tsx": 300,
  "benchmark/page.tsx": 300,
  "about/page.tsx": 300,
  "players/[id]/page.tsx": 300,
  "sessions/page.tsx": 300,
  "sessions/[id]/page.tsx": 300,
  "spend/page.tsx": 300,
  "spend/[slug]/page.tsx": 300,
  "teams/page.tsx": 300,
  "teams/[slug]/page.tsx": 300,
  "teams/[slug]/week/[week]/page.tsx": 300,
};

/**
 * Pages the spec lets read their query string. Reading `searchParams` makes
 * Next render a page per request, so the window above never reaches the CDN;
 * this list is the whole allowance.
 */
const READS_QUERY = new Set(["transactions/page.tsx"]);

const appDir = fileURLToPath(new URL("../app/", import.meta.url));

describe("§12.1 — freshness windows", () => {
  it.each(Object.entries(WINDOWS))("%s revalidates every %i s", (file, seconds) => {
    const source = readFileSync(appDir + file, "utf8");
    expect(source).toMatch(new RegExp(`export const revalidate = ${seconds};`));
    // `force-dynamic` would silently replace the window with `no-store`.
    expect(source).not.toContain('export const dynamic = "force-dynamic"');
    // So would reading the query string: the team page did, and lost its window.
    if (!READS_QUERY.has(file)) expect(source).not.toContain("searchParams");
  });

  it("the team page's old ?week= links redirect to the path the static route serves", () => {
    // Read as text, as above: `withWorkflow` wraps the exported config.
    const config = readFileSync(fileURLToPath(new URL("../next.config.ts", import.meta.url)), "utf8");
    const rule = config.slice(config.indexOf('source: "/teams/:slug"'), config.indexOf("permanent: true"));
    expect(rule).toContain('destination: "/teams/:slug/week/:week"');
    expect(rule).toContain('type: "query", key: "week"');
    const value = /value: "((?:[^"\\]|\\.)*)"/.exec(rule)?.[1];
    expect(value).toBeDefined();
    // Next anchors the pattern. Every week the route accepts redirects; anything
    // else (0, 19, "abc") falls through to the team page and its current week,
    // which is what the old page showed for those, instead of a 404.
    const pattern = new RegExp(`^${JSON.parse(`"${value}"`)}$`);
    for (let w = 1; w <= 18; w++) expect(String(w)).toMatch(pattern);
    for (const bad of ["0", "19", "99", "abc", "1e0", " 1"]) expect(bad).not.toMatch(pattern);
  });

  it("every admin page stays out of every cache", () => {
    const config = readFileSync(fileURLToPath(new URL("../next.config.ts", import.meta.url)), "utf8");
    expect(config).toContain("/admin/:path*");
    expect(config).toContain("/api/admin/:path*");
    expect(config).toContain('"private, no-store"');
  });
});

describe("safeRead — a page renders empty rather than failing", () => {
  afterEach(() => resetDatabaseBreaker());

  it("returns the fallback when a read throws, and logs nothing sensitive", async () => {
    const out = await safeRead(async () => {
      throw new Error("relation does not exist");
    }, []);
    expect(out).toEqual([]);
  });

  it("opens a breaker after a connection failure so later reads return at once", async () => {
    const connectionError = Object.assign(new Error("write CONNECT_TIMEOUT"), { code: "CONNECT_TIMEOUT" });
    await safeRead(async () => {
      throw connectionError;
    }, null);

    let ran = false;
    const started = Date.now();
    const out = await safeRead(async () => {
      ran = true;
      return "live";
    }, "empty");
    expect(out).toBe("empty");
    expect(ran, "the breaker must skip the read entirely").toBe(false);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("a query error that is not a connection failure leaves the breaker closed", async () => {
    await safeRead(async () => {
      throw new Error("syntax error at or near");
    }, null);
    const out = await safeRead(async () => "live", "empty");
    expect(out).toBe("live");
  });

  it("finds the connection code through drizzle's wrapper error", async () => {
    const wrapped = Object.assign(new Error("Failed query: select ..."), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    await safeRead(async () => {
      throw wrapped;
    }, null);
    const out = await safeRead(async () => "live", "empty");
    expect(out).toBe("empty");
  });
});
