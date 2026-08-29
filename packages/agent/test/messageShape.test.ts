/**
 * Every message the loop builds, validated against the SDK's own schema.
 *
 * This exists because the suite was green through two bugs that made every
 * session on production fail, four days before the draft:
 *
 *   AI_InvalidPromptError: System messages are not allowed in the prompt or
 *   messages fields. Use the instructions option instead.
 *
 *   AI_InvalidPromptError: The messages do not match the ModelMessage[] schema.
 *
 * The reason nothing caught them is that every other test passes a `modelStep`
 * or `generate` stub, and a stub accepts whatever it is handed. `ai` exports
 * `modelMessageSchema`, the same validator `generateText` runs, so this checks
 * the real contract without a network call or a key.
 *
 * The second bug is the instructive one: it only appeared on a session's
 * *second* step, once a tool call from the first had to be sent back. A test
 * that never gets past one step cannot see it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { modelMessageSchema } from "ai";
import { FixedClock } from "@league/shared";
import { initLeagueSettings, modelPrices, sessions, teams } from "@league/engine";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import {
  runSession,
  stubOldestToolResults,
  toolOutput,
  type ModelMessage,
  type ModelStepResult,
  type RunSessionDeps,
} from "../src/session.ts";
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

async function makeSession(): Promise<number> {
  const team = (
    await db
      .insert(teams)
      .values({ slug: "a", name: "A", modelId: "test/model", modelLabel: "T", provider: "t", tiebreakRand: 0.5 })
      .returning({ id: teams.id })
  )[0]!.id;
  const rows = await db
    .insert(sessions)
    .values({
      teamId: team,
      kind: "weekly_review",
      trigger: "test",
      idempotencyKey: `k-${Math.random()}`,
      modelId: "test/model",
      status: "queued",
      context: {
        deadline_at: new Date(clock.now().getTime() + 60 * 60_000).toISOString(),
        tool_call_ceiling: 5,
      },
    })
    .returning({ id: sessions.id });
  return rows[0]!.id;
}

const pingTool: LeagueTool = defineTool({
  name: "get_league_state",
  description: "read state",
  schema: z.object({}),
  async execute() {
    return { week: 2, teams: 12 };
  },
});
const failingTool: LeagueTool = defineTool({
  name: "set_lineup",
  description: "fails on purpose",
  schema: z.object({}),
  async execute() {
    // §8.4's documented failure shape, which the agent is meant to read.
    return { ok: false, error: "invalid_args", message: "nope", hint: "try again" };
  },
});
const unserializableTool: LeagueTool = defineTool({
  name: "player_research",
  description: "returns values JSON.stringify would silently rewrite",
  schema: z.object({}),
  async execute() {
    // The mock draft's onboarding failures: a live Date in a result meta
    // passed every recorded-transcript check (stringify renders it as an ISO
    // string) and failed the SDK's strict JSON validation on the next step.
    // NaN and Infinity record as null, and an undefined disappears — all
    // legal-looking in the transcript, all fatal live.
    return {
      ok: true,
      items: [{ when: new Date("2026-08-29T12:00:00Z"), nan: NaN, inf: Infinity }],
      missing: undefined,
      meta: { updated_at: new Date("2026-08-29T12:00:00Z") },
    };
  },
});

const logTool: LeagueTool = defineTool({
  name: "write_decision_log",
  description: "end the session",
  ending: true,
  schema: z.object({ summary: z.string() }),
  async execute() {
    return { ok: true, written: true };
  },
});

function step(partial: Partial<ModelStepResult>): ModelStepResult {
  return {
    text: "",
    toolCalls: [],
    usage: { inputTokens: 100, outputTokens: 10, reasoningTokens: 0, cachedInputTokens: 0 },
    gatewayCostUsd: null,
    billedTo: "gateway",
    assistantMessage: { role: "assistant", content: partial.text ?? "" },
    ...partial,
  };
}

/** Every message the loop ever handed the model, across all steps. */
function capturingDeps(script: ModelStepResult[], seen: ModelMessage[][]): RunSessionDeps {
  let i = 0;
  return {
    db,
    clock,
    tools: [pingTool, failingTool, unserializableTool, logTool],
    toolConfig: {},
    buildSystemPrompt: async () => "system prompt",
    buildContext: async (_ctx: ToolContext) => ({ brief: "brief", snapshot: { week: 2 } }),
    modelStep: async (req) => {
      seen.push(req.messages.map((m) => structuredClone(m)));
      return script[Math.min(i++, script.length - 1)]!;
    },
  };
}

function expectValid(messages: ModelMessage[], where: string) {
  for (const [i, message] of messages.entries()) {
    const parsed = modelMessageSchema.safeParse(message);
    expect(
      parsed.success,
      `${where}: message ${i} (role ${String((message as { role?: string }).role)}) is not a ModelMessage — ` +
        (parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))),
    ).toBe(true);
  }
}

describe("every message handed to the model is a valid ModelMessage", () => {
  it("holds across a tool call and its result — the step-two shape", async () => {
    const id = await makeSession();
    const seen: ModelMessage[][] = [];
    await runSession(
      id,
      capturingDeps(
        [
          step({ toolCalls: [{ toolCallId: "c1", toolName: "get_league_state", args: {} }] }),
          step({ toolCalls: [{ toolCallId: "c2", toolName: "write_decision_log", args: { summary: "done" } }] }),
        ],
        seen,
      ),
    );

    // Two steps means the second one carried the first's tool result back.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    seen.forEach((messages, step) => expectValid(messages, `step ${step + 1}`));

    // And the tool result is actually there, tagged, rather than absent.
    const toolMessages = seen[1]!.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    const part = (toolMessages[0]!.content as Array<Record<string, unknown>>)[0]!;
    expect(part.type).toBe("tool-result");
    expect((part.output as { type: string }).type).toBe("json");
    expect((part.output as { value: { week: number } }).value.week).toBe(2);
  });

  it("holds for a failed tool result, which is data the agent reads, not a transport error", async () => {
    const id = await makeSession();
    const seen: ModelMessage[][] = [];
    await runSession(
      id,
      capturingDeps(
        [
          step({ toolCalls: [{ toolCallId: "c1", toolName: "set_lineup", args: {} }] }),
          step({ toolCalls: [{ toolCallId: "c2", toolName: "write_decision_log", args: { summary: "done" } }] }),
        ],
        seen,
      ),
    );
    seen.forEach((messages, step) => expectValid(messages, `step ${step + 1}`));

    const part = (seen[1]!.find((m) => m.role === "tool")!.content as Array<Record<string, unknown>>)[0]!;
    // §8.4's failure shape reaches the model as ordinary JSON, so it can read
    // `hint` and retry — not as error-json, which providers may present as a
    // transport failure instead.
    expect((part.output as { type: string }).type).toBe("json");
    expect((part.output as { value: { error: string } }).value.error).toBe("invalid_args");
  });

  it("holds when a tool returns a Date, NaN, Infinity, or undefined", async () => {
    const id = await makeSession();
    const seen: ModelMessage[][] = [];
    await runSession(
      id,
      capturingDeps(
        [
          step({ toolCalls: [{ toolCallId: "c1", toolName: "player_research", args: {} }] }),
          step({ toolCalls: [{ toolCallId: "c2", toolName: "write_decision_log", args: { summary: "done" } }] }),
        ],
        seen,
      ),
    );
    seen.forEach((messages, step) => expectValid(messages, `step ${step + 1}`));

    // The model sees exactly what the transcript records: the JSON image.
    const part = (seen[1]!.find((m) => m.role === "tool")!.content as Array<Record<string, unknown>>)[0]!;
    const value = (part.output as { value: Record<string, unknown> }).value;
    expect(value).toEqual({
      ok: true,
      items: [{ when: "2026-08-29T12:00:00.000Z", nan: null, inf: null }],
      meta: { updated_at: "2026-08-29T12:00:00.000Z" },
    });
  });

  it("degrades an unserializable result to a failure instead of killing the session", () => {
    // BigInt and circular references cannot serialize at all; the outer catch
    // would fail the whole session, so toolOutput degrades to a §8.4 failure.
    const out = toolOutput({ big: BigInt(7) });
    expect(out.type).toBe("json");
    expect(out.value).toMatchObject({ ok: false, error: "unserializable_result" });
    const parsed = modelMessageSchema.safeParse({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c", toolName: "t", output: out }],
    });
    expect(parsed.success).toBe(true);
  });

  it("holds after context trimming replaces an old tool result", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "get_league_state", output: toolOutput({ a: 1 }) }],
      } as ModelMessage,
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c2", toolName: "get_league_state", output: toolOutput({ b: 2 }) }],
      } as ModelMessage,
    ];
    const stubbed = stubOldestToolResults(messages, 1);
    expect(stubbed).toBe(1);
    expectValid(messages, "after trimming");

    // The stub is recognised as already-stubbed on a second pass, so trimming
    // twice does not re-stub and re-count the same part.
    expect(stubOldestToolResults(messages, 1)).toBe(0);
  });
});
