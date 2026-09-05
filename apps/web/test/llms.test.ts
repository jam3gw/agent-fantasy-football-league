/**
 * `/llms.txt` (§12.1) is prose about the API, and prose drifts. Two guards:
 * every route under `app/api/public` is documented, and everything the
 * guide documents exists. Plus the shape checks a reader relies on.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_API_ROUTES, renderLlmsTxt } from "../lib/llms";
import { TRANSACTION_TYPES } from "../lib/transactionTypes";

vi.mock("../lib/db", () => ({
  db: () => {
    throw new Error("connect ECONNREFUSED db.internal:5432");
  },
}));

const publicDir = fileURLToPath(new URL("../app/api/public", import.meta.url));

/** Every `route.ts` under app/api/public as a URL path, e.g. `/api/public/matchups/[week]`. */
function routesOnDisk(dir = publicDir, prefix = "/api/public"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routesOnDisk(full, `${prefix}/${entry}`));
    else if (entry === "route.ts") out.push(prefix);
  }
  return out.sort();
}

const sample = {
  base: "https://league.example.com",
  season: 2026,
  week: 3,
  phase: "regular_season",
  teams: [
    { slug: "claude", name: "The Sonnets", model: "Claude Opus 5" },
    { slug: "gpt", name: null, model: "GPT-5" },
  ],
};

describe("llms.txt", () => {
  it("documents every public API route, and nothing that does not exist", () => {
    expect([...PUBLIC_API_ROUTES].sort()).toEqual(routesOnDisk());
    for (const route of PUBLIC_API_ROUTES) {
      const dir = join(publicDir, route.replace("/api/public", "").replace(/^\//, ""));
      expect(existsSync(join(dir, "route.ts")), route).toBe(true);
    }
  });

  it("mentions each route's path in the text", () => {
    const text = renderLlmsTxt(sample);
    for (const route of PUBLIC_API_ROUTES) {
      // `[week]` on disk is written `{week}` for readers.
      const shown = route.replace(/\[(\w+)\]/g, "{$1}");
      expect(text, shown).toContain(shown);
    }
  });

  it("follows the llms.txt shape and uses absolute links", () => {
    const text = renderLlmsTxt(sample);
    expect(text.startsWith("# Agent Fantasy Football League\n\n> ")).toBe(true);
    expect(text).toContain("Season 2026, week 3, phase `regular_season`.");
    expect(text).toContain("[The Sonnets](https://league.example.com/api/public/teams/claude)");
    // An unnamed team falls back to its slug rather than "null".
    expect(text).toContain("[gpt](https://league.example.com/api/public/teams/gpt)");
    expect(text).not.toContain("null");
    expect(text).toContain("60 requests per minute");
  });

  it("prints the transaction type list the route validates against", () => {
    const text = renderLlmsTxt(sample);
    expect(text).toContain(`\`type\` in ${TRANSACTION_TYPES.join(", ")}.`);
  });

  it("names the real matchup lineup keys, not prose approximations", () => {
    const text = renderLlmsTxt(sample);
    expect(text).toContain("slot, playerId, name, position, nflTeam, and points");
    expect(text).toContain("`currentWeek`");
  });

  it("lists every public page from the sitemap plus the dynamic ones", () => {
    const text = renderLlmsTxt(sample);
    for (const path of ["/", "/about", "/benchmark", "/standings", "/board", "/trades", "/transactions", "/waivers", "/players/{id}", "/report", "/spend", "/draft", "/sessions", "/teams", "/matchups/1"]) {
      expect(text, path).toContain(`${sample.base}${path})`);
    }
  });

  it("handles a season with no current week or phase yet", () => {
    const text = renderLlmsTxt({ ...sample, week: null, phase: null });
    expect(text).toContain("Season 2026, week ?, phase `unknown`.");
  });

  describe("baseUrl", () => {
    const saved = process.env.SITE_DOMAIN;
    afterEach(() => {
      if (saved === undefined) delete process.env.SITE_DOMAIN;
      else process.env.SITE_DOMAIN = saved;
    });

    it("is absolute when SITE_DOMAIN is set", async () => {
      process.env.SITE_DOMAIN = "league.example.com";
      const { baseUrl } = await import("../app/llms.txt/route");
      expect(baseUrl()).toBe("https://league.example.com");
    });

    it("is empty, so links are relative, when SITE_DOMAIN is unset", async () => {
      delete process.env.SITE_DOMAIN;
      const { baseUrl } = await import("../app/llms.txt/route");
      expect(baseUrl()).toBe("");
      const text = renderLlmsTxt({ ...sample, base: baseUrl() });
      expect(text).toContain("[Standings](/api/public/standings)");
    });
  });

  it("serves markdown with a cache window even when the database is down", async () => {
    const { GET } = await import("../app/llms.txt/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("cache-control")).toContain("s-maxage=300");
    const text = await res.text();
    expect(text).toContain("The league has not started yet.");
    expect(text).toContain("- No teams yet.");
    expect(text).not.toContain("ECONNREFUSED");
  });
});
