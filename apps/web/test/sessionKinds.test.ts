/**
 * §15.3 — "every session kind runs at least once", and the cost is reported.
 *
 * A real model is not involved and does not need to be: what this checks is
 * that each kind's loop reaches its ending tool with the tools that kind is
 * actually given (§8.6), writes the artifact the league then shows, and lands
 * in the ledger — the parts that break when a tool set and an ending tool
 * disagree. The scripted model stands in for twelve providers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import {
  decisionLogs,
  initLeagueSettings,
  matchups,
  modelPrices,
  players,
  powerRankings,
  reporterPosts,
  rosterEntries,
  sessions,
  spendLedger,
  spendRollups,
  teams,
} from "@league/engine";
import {
  endingToolFor,
  runSession,
  toolsForKind,
  updateRollups,
  type ModelStepResult,
  type RunSessionDeps,
} from "@league/agent";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let clock: FixedClock;
const SEASON = 2026;

/** Every kind an agent or the reporter is booked for (§8.6). */
const TEAM_KINDS = [
  "onboarding",
  "weekly_review",
  "post_waivers",
  "trade_window",
  "trade_response",
  "trade_vote",
  "lineup_check",
  "injury_response",
  "board_reply",
  "manual",
  "smoke",
] as const;
const REPORTER_KINDS = [
  "reporter_draft_grades",
  "reporter_recap",
  "reporter_preview",
  "reporter_trade_note",
] as const;
const RANKINGS_KIND = "reporter_power_rankings";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = new FixedClock("2026-10-20T15:00:00Z");
  await initLeagueSettings(db, { season: SEASON, phase: "regular", currentWeek: 7, startWeek: 1 });
  await db.insert(modelPrices).values({
    modelId: "test/model",
    inputUsdPerM: 1,
    outputUsdPerM: 10,
    source: "test",
  });
});
afterEach(async () => {
  await close();
});

async function makeTeam(slug: string): Promise<number> {
  const [row] = await db
    .insert(teams)
    .values({ slug, name: slug, modelId: "test/model", modelLabel: "Test", provider: "t", tiebreakRand: 0.5 })
    .returning({ id: teams.id });
  return row!.id;
}

async function makeSession(teamId: number | null, kind: string, key: string): Promise<number> {
  const [row] = await db
    .insert(sessions)
    .values({
      teamId,
      kind: kind as never,
      trigger: "test",
      idempotencyKey: key,
      modelId: "test/model",
      status: "queued",
      context: {
        deadline_at: new Date(clock.now().getTime() + 90 * 60_000).toISOString(),
        tool_call_ceiling: 20,
        week: 7,
      },
    })
    .returning({ id: sessions.id });
  return row!.id;
}

/** Arguments that satisfy each ending tool's schema. */
function endingArgs(kind: string): Record<string, unknown> {
  if (kind.startsWith("reporter_")) {
    return { kind: kind.replace("reporter_", ""), title: `A ${kind} post`, body_md: "The week in review." };
  }
  return { summary: `what ${kind} decided` };
}

function depsFor(kind: string): RunSessionDeps {
  const endingTool = endingToolFor(kind as never);
  const result: ModelStepResult = {
    text: "here is my decision",
    toolCalls: [{ toolCallId: "c1", toolName: endingTool, args: endingArgs(kind) }],
    usage: { inputTokens: 2000, outputTokens: 300, reasoningTokens: 0, cachedInputTokens: 0 },
    gatewayCostUsd: null,
    billedTo: "gateway",
    assistantMessage: {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c1", toolName: endingTool, input: endingArgs(kind) }],
    } as never,
  };
  return {
    db,
    clock,
    tools: toolsForKind(kind as never),
    toolConfig: {},
    buildSystemPrompt: async () => `system prompt for ${kind}`,
    buildContext: async () => ({ brief: `brief for ${kind}`, snapshot: { week: 7 } }),
    modelStep: async () => result,
  };
}

describe("§15.3 — every session kind runs", () => {
  it.each(TEAM_KINDS)("a team's %s session reaches its ending tool", async (kind) => {
    const teamId = await makeTeam(`t-${kind}`);
    const sessionId = await makeSession(teamId, kind, `k-${kind}`);

    // The ending tool for the kind must be one the kind is actually given.
    const endingTool = endingToolFor(kind as never);
    expect(toolsForKind(kind as never).map((t) => t.name)).toContain(endingTool);

    const result = await runSession(sessionId, depsFor(kind));
    expect(result.status, `${kind} did not succeed`).toBe("succeeded");
    expect(result.endedBy).toBe("ending_tool");

    // The artifact the site shows for this session exists.
    const logs = await db.select().from(decisionLogs).where(eq(decisionLogs.sessionId, sessionId));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.summary).toContain(kind);

    // And the session is in the ledger (§8.7: a row per model step).
    const ledger = await db.select().from(spendLedger).where(eq(spendLedger.sessionId, sessionId));
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((r) => r.costUsd > 0)).toBe(true);
  });

  it("the reporter's power-rankings session publishes an edition, not a post (§11)", async () => {
    const teamIds = await Promise.all([1, 2, 3].map((i) => makeTeam(`r-${i}`)));
    const sessionId = await makeSession(null, RANKINGS_KIND, `k-${RANKINGS_KIND}`);
    const endingTool = endingToolFor(RANKINGS_KIND);
    expect(endingTool).toBe("publish_power_rankings");
    expect(toolsForKind(RANKINGS_KIND).map((t) => t.name)).toContain(endingTool);
    expect(toolsForKind(RANKINGS_KIND).map((t) => t.name)).not.toContain("publish_report");
    const args = {
      rankings: teamIds.map((team_id, i) => ({ team_id, rank: i + 1, reason: `Place ${i + 1} because.` })),
    };
    const result = await runSession(sessionId, {
      ...depsFor(RANKINGS_KIND),
      modelStep: async () => ({
        text: "ranked",
        toolCalls: [{ toolCallId: "c1", toolName: endingTool, args }],
        usage: { inputTokens: 2000, outputTokens: 300, reasoningTokens: 0, cachedInputTokens: 0 },
        gatewayCostUsd: null,
        billedTo: "gateway",
        assistantMessage: {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "c1", toolName: endingTool, input: args }],
        } as never,
      }),
    });
    expect(result.status).toBe("succeeded");
    expect(result.endedBy).toBe("ending_tool");
    const rows = await db.select().from(powerRankings).where(eq(powerRankings.sessionId, sessionId));
    expect(rows.map((r) => r.rank).sort()).toEqual([1, 2, 3]);
    expect(await db.select().from(reporterPosts)).toHaveLength(0);
  });

  it.each(REPORTER_KINDS)("the reporter's %s session publishes a post", async (kind) => {
    const sessionId = await makeSession(null, kind, `k-${kind}`);
    const result = await runSession(sessionId, depsFor(kind));
    expect(result.status, `${kind} did not succeed`).toBe("succeeded");

    const posts = await db.select().from(reporterPosts).where(eq(reporterPosts.sessionId, sessionId));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.bodyMd).toContain("The week in review");
  });
});

describe("§15.3 — the total cost is reported", () => {
  it("rollups add up to the ledger, per agent and for the league", async () => {
    const a = await makeTeam("a");
    const b = await makeTeam("b");
    for (const [teamId, slug] of [
      [a, "a"],
      [b, "b"],
    ] as const) {
      const sessionId = await makeSession(teamId, "weekly_review", `k-${slug}`);
      await runSession(sessionId, depsFor("weekly_review"));
    }
    await updateRollups(db, clock);

    const ledger = await db.select().from(spendLedger);
    const total = ledger.reduce((sum, r) => sum + r.costUsd, 0);
    expect(total).toBeGreaterThan(0);

    const rollups = await db.select().from(spendRollups);
    const league = rollups.find((r) => r.scope === "league" && r.period === "season")!;
    expect(league.costUsd).toBeCloseTo(Math.round(total * 1e6) / 1e6, 5);

    // Each agent's week row is there too — the one /spend shows per team.
    for (const teamId of [a, b]) {
      const week = rollups.find(
        (r) => r.scope === "agent" && r.scopeKey === String(teamId) && r.period === "week" && r.periodStart === "W7",
      );
      expect(week, `no week rollup for team ${teamId}`).toBeDefined();
      expect(week!.costUsd).toBeGreaterThan(0);
    }
    expect(await db.select().from(matchups)).toHaveLength(0);
    expect(await db.select().from(players)).toHaveLength(0);
    expect(await db.select().from(rosterEntries)).toHaveLength(0);
  });
});
