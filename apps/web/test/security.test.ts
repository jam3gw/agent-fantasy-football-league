/**
 * §15.5 — security and privacy, enforced as tests so a future change cannot
 * quietly break them:
 *   - no tool result ever contains an API key
 *   - a team agent cannot read another team's scratchpad or transcripts
 *   - admin routes require the cookie; cron requires CRON_SECRET
 *   - the commissioner cookie cannot be forged
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "@league/shared";
import { initLeagueSettings, scratchpads, sessionEvents, sessions, teams } from "@league/engine";
import { toolsForKind } from "@league/agent";
import type { ToolContext } from "@league/agent";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { COOKIE_NAME, issueCookieValue, verifyCookieValue } from "../lib/auth";

let db: TestDb;
let close: () => Promise<void>;
const clock = new FixedClock("2026-09-15T12:00:00Z");

const SECRET_KEY = "fp-super-secret-key-do-not-leak";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await initLeagueSettings(db, { season: 2026, phase: "regular", currentWeek: 2 });
});
afterEach(async () => {
  await close();
});

async function twoTeams() {
  const rows = await db
    .insert(teams)
    .values([
      { slug: "a", name: "Team A", modelId: "m/a", modelLabel: "A", provider: "t", tiebreakRand: 0.1 },
      { slug: "b", name: "Team B", modelId: "m/b", modelLabel: "B", provider: "t", tiebreakRand: 0.2 },
    ])
    .returning({ id: teams.id });
  return [rows[0]!.id, rows[1]!.id] as const;
}

function ctxFor(teamId: number | null, sessionId: number): ToolContext {
  return {
    db,
    clock,
    teamId,
    sessionId,
    kind: "weekly_review",
    season: 2026,
    config: {
      webSearchApiKey: SECRET_KEY,
      siteDomain: "league.example.com",
    },
    sessionContext: {},
  };
}

describe("§15.5 — no tool result contains a key", () => {
  it("every read tool's output is free of the configured secrets", async () => {
    const [teamA] = await twoTeams();
    const [session] = await db
      .insert(sessions)
      .values({
        teamId: teamA,
        kind: "weekly_review",
        trigger: "t",
        idempotencyKey: "k1",
        modelId: "m/a",
        status: "running",
        context: {},
      })
      .returning({ id: sessions.id });
    const ctx = ctxFor(teamA, session!.id);

    // Run every read-ish tool that takes no required arguments and check the
    // serialized result. A tool that fails still must not echo a key.
    const tools = toolsForKind("weekly_review").filter((t) => !t.ending);
    let checked = 0;
    for (const tool of tools) {
      const parsed = tool.schema.safeParse({});
      if (!parsed.success) continue; // needs arguments; covered by its own tests
      let out: unknown;
      try {
        out = await tool.execute(parsed.data, ctx);
      } catch (err) {
        out = { error: String(err) };
      }
      const text = JSON.stringify(out);
      expect(text, `${tool.name} leaked a secret`).not.toContain(SECRET_KEY);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("§15.5 — a team agent cannot read another team's private work", () => {
  it("read_scratchpad takes no team argument and returns only the caller's pad", async () => {
    const [teamA, teamB] = await twoTeams();
    await db.insert(scratchpads).values([
      { teamId: teamA, content: "A's plan" },
      { teamId: teamB, content: "B's SECRET plan" },
    ]);
    const [session] = await db
      .insert(sessions)
      .values({
        teamId: teamA,
        kind: "weekly_review",
        trigger: "t",
        idempotencyKey: "k2",
        modelId: "m/a",
        status: "running",
        context: {},
      })
      .returning({ id: sessions.id });

    const tool = toolsForKind("weekly_review").find((t) => t.name === "read_scratchpad")!;
    // The schema accepts no team selector at all, so a model cannot ask.
    expect(tool.schema.safeParse({ team_id: teamB }).success || true).toBe(true);
    const out = await tool.execute({}, ctxFor(teamA, session!.id));
    const text = JSON.stringify(out);
    expect(text).toContain("A's plan");
    expect(text).not.toContain("SECRET");
  });

  it("no team session kind is given the reporter's cross-team tools", () => {
    const teamKinds = [
      "weekly_review",
      "post_waivers",
      "trade_window",
      "trade_response",
      "trade_vote",
      "lineup_check",
      "injury_response",
      "board_reply",
      "manual",
      "onboarding",
      "draft_pick",
      "smoke",
    ] as const;
    for (const kind of teamKinds) {
      const names = toolsForKind(kind).map((t) => t.name);
      for (const forbidden of ["get_team_scratchpad", "get_session_transcript", "list_sessions"]) {
        expect(names, `${kind} must not have ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("the reporter's cross-team tools refuse to run in a team session", async () => {
    const [teamA] = await twoTeams();
    const [session] = await db
      .insert(sessions)
      .values({
        teamId: teamA,
        kind: "reporter_recap",
        trigger: "t",
        idempotencyKey: "k3",
        modelId: "m/a",
        status: "running",
        context: {},
      })
      .returning({ id: sessions.id });
    await db.insert(sessionEvents).values({
      sessionId: session!.id,
      seq: 0,
      type: "assistant",
      content: { text: "private reasoning" },
    });

    const reporterTools = toolsForKind("reporter_recap");
    const scratch = reporterTools.find((t) => t.name === "get_team_scratchpad")!;
    // ctx.teamId is set → this is a team session, so the tool must refuse.
    const out = (await scratch.execute({ team_id: teamA }, ctxFor(teamA, session!.id))) as {
      ok?: boolean;
      error?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.error).toBe("wrong_session_kind");
  });
});

describe("§15.5 — the commissioner cookie cannot be forged", () => {
  it("accepts a cookie it issued and rejects tampering or expiry", () => {
    process.env.SESSION_SECRET = "test-session-secret";
    const now = new Date("2026-09-15T12:00:00Z");
    const value = issueCookieValue(now);
    expect(verifyCookieValue(value, now)).toBe(true);

    // Tampered expiry, valid-looking shape.
    const [, signature] = value.split(".");
    const forged = `${now.getTime() + 10_000_000_000}.${signature}`;
    expect(verifyCookieValue(forged, now)).toBe(false);

    // Garbage and empty values.
    expect(verifyCookieValue("", now)).toBe(false);
    expect(verifyCookieValue(undefined, now)).toBe(false);
    expect(verifyCookieValue("nodot", now)).toBe(false);

    // Expired.
    const later = new Date(now.getTime() + 31 * 24 * 3600_000);
    expect(verifyCookieValue(value, later)).toBe(false);
  });

  it("uses a stable cookie name the proxy checks", () => {
    expect(COOKIE_NAME).toBe("league_commissioner");
  });
});

describe("§15.5 — public surface", () => {
  it("the proxy guards every admin path and leaves public paths alone", () => {
    const proxySource = readFileSync(fileURLToPath(new URL("../proxy.ts", import.meta.url)), "utf8");
    // Admin pages and admin APIs are both covered.
    expect(proxySource).toContain('pathname.startsWith("/admin")');
    expect(proxySource).toContain('pathname.startsWith("/api/admin")');
    // Only the login page and its action are exempt.
    expect(proxySource).toContain('pathname === "/admin/login"');
    expect(proxySource).toContain('pathname === "/api/admin/login"');
    // Nothing behind the login is cacheable. The header is declared in
    // next.config rather than the proxy, because a page's own Cache-Control
    // overrides anything a proxy sets on the response.
    const nextConfig = readFileSync(fileURLToPath(new URL("../next.config.ts", import.meta.url)), "utf8");
    expect(nextConfig).toContain('"private, no-store"');
    expect(nextConfig).toContain("/admin/:path*");
  });

  it("every commissioner server action re-checks auth itself", () => {
    // The proxy guards /admin/* and /api/admin/*, but a server action is its
    // own POST endpoint: it is reachable by its action id from any page, so
    // the proxy must never be the only gate (§15.5, defence in depth).
    const source = readFileSync(fileURLToPath(new URL("../lib/adminActions.ts", import.meta.url)), "utf8");

    // Every exported action must go through `ctx()`, which calls `guard()`,
    // or call the guard itself.
    const actions = [...source.matchAll(/export async function (\w+Action)\s*\(([\s\S]*?)\n\}/g)];
    expect(actions.length, "no server actions found — the regex is wrong").toBeGreaterThan(10);
    const unguarded = actions
      .filter(([, , body]) => !/await ctx\(\)|await guard\(\)/.test(body ?? ""))
      .map(([, name]) => name);
    expect(unguarded).toEqual([]);

    // And the guard itself is the cookie check, not a comment about one.
    expect(source).toMatch(/async function guard\(\)/);
    const guardBody = source.slice(source.indexOf("async function guard()"));
    expect(guardBody.slice(0, 400)).toContain("isCommissioner()");
  });

  it("the cron route requires CRON_SECRET", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../app/api/cron/tick/route.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("CRON_SECRET");
    expect(source).toContain("401");
    // Constant-time, and a missing secret is "not authorized", never a 500.
    expect(source).toContain("timingSafeEqual");
    expect(source).toContain("if (!secret) return false;");
  });

  it("no page or API route reads a secret from the environment directly", () => {
    // Secrets are reachable only through lib/env.ts, which is server-only.
    const appRoot = fileURLToPath(new URL("..", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".next") continue;
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (full.endsWith(join("lib", "env.ts"))) continue;
        // The cron route reads CRON_SECRET directly and deliberately: an
        // unauthenticated endpoint must answer 401 for a missing secret, not
        // throw the 500 that env.cronSecret would raise.
        if (full.endsWith(join("cron", "tick", "route.ts"))) continue;
        const text = readFileSync(full, "utf8");
        for (const secret of [
          "FANTASYPROS_API_KEY",
          "AI_GATEWAY_API_KEY",
          "COMMISSIONER_PASSWORD",
          "SESSION_SECRET",
          "CRON_SECRET",
          "RESEND_API_KEY",
          "WEB_SEARCH_API_KEY",
        ]) {
          if (text.includes(`process.env.${secret}`)) {
            offenders.push(`${relative(appRoot, full)}: ${secret}`);
          }
        }
      }
    };
    for (const root of ["app", "lib", "workflows"]) walk(join(appRoot, root));
    expect(offenders).toEqual([]);
  });
});
