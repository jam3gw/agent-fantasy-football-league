/**
 * The session loop (§8.2) and its loop guards (§8.3), driven by a scripted
 * model so no network or key is involved. Also covers §8.7 (a ledger row per
 * model step) and §8.8 (the invalid-tool-call nudge).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { FixedClock } from "@league/shared";
import {
  decisionLogs,
  initLeagueSettings,
  sessionEvents,
  sessions,
  spendLedger,
  teams,
  modelPrices,
} from "@league/engine";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { runSession, endingToolFor, type ModelStepResult, type RunSessionDeps } from "../src/session.ts";
import { defineTool, type LeagueTool, type ToolContext } from "../src/tools/types.ts";

let db: TestDb;
let close: () => Promise<void>;
let clock: FixedClock;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = new FixedClock("2026-09-15T12:00:00Z");
  await initLeagueSettings(db, { season: 2026, phase: "regular", currentWeek: 2 });
  await db.insert(modelPrices).values({
    modelId: "test/model",
    inputUsdPerM: 1,
    outputUsdPerM: 10,
    cachedInputUsdPerM: 0.1,
    source: "test",
  });
});
afterEach(async () => {
  await close();
});

async function makeSession(kind: string, overrides: Record<string, unknown> = {}): Promise<number> {
  const [team] = await db
    .insert(teams)
    .values({ slug: "t1", name: "Test", modelId: "test/model", modelLabel: "Test", provider: "test", tiebreakRand: 0.5 })
    .returning({ id: teams.id });
  const rows = await db
    .insert(sessions)
    .values({
      teamId: team!.id,
      kind: kind as never,
      trigger: "test",
      idempotencyKey: `k-${kind}-${Math.random()}`,
      modelId: "test/model",
      status: "queued",
      context: {
        deadline_at: new Date(clock.now().getTime() + 60 * 60_000).toISOString(),
        tool_call_ceiling: 3,
        ...overrides,
      },
    })
    .returning({ id: sessions.id });
  return rows[0]!.id;
}

/** A trivial ending tool and a counter tool, so the loop has something to run. */
let toolRuns: string[] = [];
const logTool: LeagueTool = defineTool({
  name: "write_decision_log",
  description: "end the session",
  ending: true,
  schema: z.object({ summary: z.string().max(800) }),
  async execute(args, ctx) {
    toolRuns.push("write_decision_log");
    await ctx.db.insert(decisionLogs).values({
      teamId: ctx.teamId!,
      kind: ctx.kind,
      summary: args.summary,
      sessionId: ctx.sessionId,
      week: 2,
    });
    return { ok: true, written: true };
  },
});
const pingTool: LeagueTool = defineTool({
  name: "get_league_state",
  description: "read state",
  schema: z.object({}),
  async execute() {
    toolRuns.push("get_league_state");
    return { week: 2 };
  },
});

function step(partial: Partial<ModelStepResult>): ModelStepResult {
  return {
    text: "",
    toolCalls: [],
    usage: { inputTokens: 1000, outputTokens: 100, reasoningTokens: 0, cachedInputTokens: 0 },
    gatewayCostUsd: null,
    billedTo: "gateway",
    assistantMessage: { role: "assistant", content: partial.text ?? "" },
    ...partial,
  };
}

function deps(script: ModelStepResult[], extra: Partial<RunSessionDeps> = {}): RunSessionDeps {
  let i = 0;
  return {
    db,
    clock,
    tools: [pingTool, logTool],
    toolConfig: {},
    buildSystemPrompt: async () => "system",
    buildContext: async (_ctx: ToolContext) => ({ brief: "brief", snapshot: { week: 2 } }),
    modelStep: async () => script[Math.min(i++, script.length - 1)]!,
    ...extra,
  };
}

describe("runSession (§8.2)", () => {
  beforeEach(() => {
    toolRuns = [];
  });

  it("ends when the ending tool succeeds and records a ledger row per model step", async () => {
    const id = await makeSession("weekly_review");
    const result = await runSession(
      id,
      deps([
        step({ toolCalls: [{ toolCallId: "1", toolName: "get_league_state", args: {} }] }),
        step({ toolCalls: [{ toolCallId: "2", toolName: "write_decision_log", args: { summary: "done" } }] }),
      ]),
    );
    expect(result.status).toBe("succeeded");
    expect(result.endedBy).toBe("ending_tool");
    expect(result.toolCalls).toBe(2);
    expect(toolRuns).toEqual(["get_league_state", "write_decision_log"]);

    const ledger = await db.select().from(spendLedger).where(eq(spendLedger.sessionId, id));
    expect(ledger).toHaveLength(2); // one per model step
    // 1000 input @ $1/M + 100 output @ $10/M = 0.001 + 0.001
    expect(ledger[0]!.costUsd).toBeCloseTo(0.002, 6);
    const s = (await db.select().from(sessions).where(eq(sessions.id, id)))[0]!;
    expect(s.status).toBe("succeeded");
    expect(s.costUsd).toBeCloseTo(0.004, 6);
    expect(s.inputTokens).toBe(2000);
  });

  it("stops with no tool calls and writes the placeholder log when none was written", async () => {
    const id = await makeSession("weekly_review");
    const result = await runSession(id, deps([step({ text: "I have nothing to do." })]));
    expect(result.status).toBe("succeeded");
    const logs = await db.select().from(decisionLogs);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.summary).toBe("(no summary written)");
  });

  it("takes the closing model step and accepts a decision log written there", async () => {
    const id = await makeSession("weekly_review");
    const result = await runSession(
      id,
      deps([
        step({ text: "thinking" }), // no tool calls → loop breaks
        step({ toolCalls: [{ toolCallId: "c", toolName: "write_decision_log", args: { summary: "late" } }] }),
      ]),
    );
    expect(result.status).toBe("succeeded");
    const logs = await db.select().from(decisionLogs);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.summary).toBe("late");
  });

  it("enforces the tool-call ceiling with one final nudge (§8.3)", async () => {
    const id = await makeSession("weekly_review", { tool_call_ceiling: 2 });
    const result = await runSession(
      id,
      // every step calls the read tool and never ends
      deps([step({ toolCalls: [{ toolCallId: "x", toolName: "get_league_state", args: {} }] })]),
    );
    expect(result.endedBy).toBe("ceiling");
    const s = (await db.select().from(sessions).where(eq(sessions.id, id)))[0]!;
    expect(s.endedBy).toBe("ceiling");
    // The nudge is recorded as the user message it is, so the site can show
    // why the session ended and a resumed step replays it verbatim.
    const events = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, id));
    expect(
      events.some((e) => e.type === "user" && (e.content as Record<string, unknown>).nudge === "ceiling"),
    ).toBe(true);
  });

  it("skips a session whose deadline has already passed", async () => {
    const id = await makeSession("lineup_check", {
      deadline_at: new Date(clock.now().getTime() - 60_000).toISOString(),
    });
    const result = await runSession(id, deps([step({})]));
    expect(result.status).toBe("skipped");
    const s = (await db.select().from(sessions).where(eq(sessions.id, id)))[0]!;
    expect(s.status).toBe("skipped");
  });

  it("times out when the deadline passes mid-session", async () => {
    const id = await makeSession("weekly_review");
    let calls = 0;
    const result = await runSession(
      id,
      deps([step({ toolCalls: [{ toolCallId: "x", toolName: "get_league_state", args: {} }] })], {
        modelStep: async () => {
          calls++;
          if (calls === 2) clock.advance(2 * 60 * 60_000); // blow past the deadline
          return step({ toolCalls: [{ toolCallId: "x", toolName: "get_league_state", args: {} }] });
        },
      }),
    );
    expect(result.status).toBe("timed_out");
    expect(result.endedBy).toBe("deadline");
  });

  it("counts invalid tool calls and nudges after five (§8.8)", async () => {
    const id = await makeSession("weekly_review", { tool_call_ceiling: 50 });
    let n = 0;
    const result = await runSession(
      id,
      deps([], {
        modelStep: async () => {
          n++;
          if (n <= 6) {
            // bad args for the log tool: summary must be a string
            return step({ toolCalls: [{ toolCallId: `b${n}`, toolName: "write_decision_log", args: { summary: 123 } }] });
          }
          return step({ toolCalls: [{ toolCallId: "ok", toolName: "write_decision_log", args: { summary: "fine" } }] });
        },
      }),
    );
    expect(result.invalidToolCalls).toBeGreaterThanOrEqual(5);
    expect(result.status).toBe("succeeded");
    const logs = await db.select().from(decisionLogs);
    expect(logs[0]!.summary).toBe("fine");
  });

  it("an unknown tool name is an invalid call, not a crash", async () => {
    const id = await makeSession("weekly_review");
    const result = await runSession(
      id,
      deps([
        step({ toolCalls: [{ toolCallId: "1", toolName: "no_such_tool", args: {} }] }),
        step({ toolCalls: [{ toolCallId: "2", toolName: "write_decision_log", args: { summary: "recovered" } }] }),
      ]),
    );
    expect(result.invalidToolCalls).toBe(1);
    expect(result.status).toBe("succeeded");
  });

  it("a throwing tool is reported to the model and does not fail the session", async () => {
    const boom: LeagueTool = defineTool({
      name: "get_league_state",
      description: "explodes",
      schema: z.object({}),
      async execute() {
        throw new Error("upstream is down");
      },
    });
    const id = await makeSession("weekly_review");
    const result = await runSession(
      id,
      deps(
        [
          step({ toolCalls: [{ toolCallId: "1", toolName: "get_league_state", args: {} }] }),
          step({ toolCalls: [{ toolCallId: "2", toolName: "write_decision_log", args: { summary: "coped" } }] }),
        ],
        { tools: [boom, logTool] },
      ),
    );
    expect(result.status).toBe("succeeded");
    const events = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, id));
    const toolResult = events.find(
      (e) => e.type === "tool_result" && JSON.stringify(e.content).includes("upstream is down"),
    );
    expect(toolResult).toBeDefined();
  });

  it("a reporter session that publishes nothing fails with no_report", async () => {
    const rows = await db
      .insert(sessions)
      .values({
        teamId: null,
        kind: "reporter_recap",
        trigger: "test",
        idempotencyKey: "reporter-1",
        modelId: "test/model",
        status: "queued",
        context: { deadline_at: new Date(clock.now().getTime() + 3600_000).toISOString() },
      })
      .returning({ id: sessions.id });
    const result = await runSession(rows[0]!.id, deps([step({ text: "no post" })]));
    expect(result.status).toBe("failed");
    expect(result.error).toBe("no_report");
  });

  it("records a full transcript of the session", async () => {
    const id = await makeSession("weekly_review");
    await runSession(
      id,
      deps([step({ toolCalls: [{ toolCallId: "1", toolName: "write_decision_log", args: { summary: "hi" } }] })]),
    );
    const events = await db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, id))
      .orderBy(sessionEvents.seq);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("system");
    expect(types[1]).toBe("user");
    expect(types).toContain("assistant");
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
  });
});

describe("endingToolFor (§8.2)", () => {
  it("maps each kind to its ending tool", () => {
    expect(endingToolFor("draft_pick")).toBe("make_pick");
    expect(endingToolFor("reporter_recap")).toBe("publish_report");
    expect(endingToolFor("weekly_review")).toBe("write_decision_log");
    expect(endingToolFor("smoke")).toBe("write_decision_log");
  });
});

describe("§4.1 — a session survives the 800-second step cap", () => {
  it("stops between model calls when the budget runs out, then resumes from the transcript", async () => {
    toolRuns = [];
    const sessionId = await makeSession("weekly_review");

    // First step: one tool call, then the budget is gone. A FixedClock does not
    // advance on its own, so the budget is zero — the loop must stop after the
    // model call it already started, not before recording it.
    const firstStep = step({
      text: "looking",
      toolCalls: [{ toolCallId: "c1", toolName: "get_league_state", args: {} }],
      assistantMessage: {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "get_league_state", input: {} }],
      } as never,
    });
    const first = await runSession(sessionId, {
      ...deps([firstStep]),
      stepBudgetMs: 60_000,
      // The call itself takes two minutes of league time, so the budget is gone
      // by the time the loop comes round again.
      modelStep: async () => {
        clock.advance(120_000);
        return firstStep;
      },
    });
    expect(first.status).toBe("interrupted");
    expect(first.steps).toBe(1);
    expect(toolRuns).toEqual(["get_league_state"]);

    // The session is still running, not finished, and nothing terminal was set.
    const mid = (await db.select().from(sessions).where(eq(sessions.id, sessionId)))[0]!;
    expect(mid.status).toBe("running");
    expect(mid.endedAt).toBeNull();

    // Second step: resumes and finishes. The model sees the history it had.
    let seenMessages: unknown[] = [];
    const second = await runSession(sessionId, {
      ...deps([
        step({
          text: "done",
          toolCalls: [{ toolCallId: "c2", toolName: "write_decision_log", args: { summary: "ok" } }],
          assistantMessage: {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "c2", toolName: "write_decision_log", input: { summary: "ok" } },
            ],
          } as never,
        }),
      ]),
      modelStep: async (req) => {
        seenMessages = req.messages;
        return step({
          text: "done",
          toolCalls: [{ toolCallId: "c2", toolName: "write_decision_log", args: { summary: "ok" } }],
          assistantMessage: {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "c2", toolName: "write_decision_log", input: { summary: "ok" } },
            ],
          } as never,
        });
      },
    });
    expect(second.status).toBe("succeeded");
    expect(second.endedBy).toBe("ending_tool");

    // The resumed prompt is the original one: system, brief, the assistant turn
    // that already happened, and its tool result.
    const roles = (seenMessages as Array<{ role: string }>).map((m) => m.role);
    expect(roles.slice(0, 4)).toEqual(["system", "user", "assistant", "tool"]);
    expect(String(JSON.stringify(seenMessages))).toContain("get_league_state");

    // The context snapshot was built once, and the tool ran once per call —
    // a resume must never repeat work that is already in the transcript.
    expect(toolRuns).toEqual(["get_league_state", "write_decision_log"]);
    const brief = (await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId))).filter(
      (e) => e.type === "user" && "brief" in (e.content as Record<string, unknown>),
    );
    expect(brief).toHaveLength(1);
  });
});
