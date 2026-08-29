/**
 * The live thinking stream (SPEC §12.1): the model step accumulates reasoning
 * and text deltas and stages them through `onPartial`; the sink upserts one
 * `session_stream` row per session; the session loop deletes that row the
 * moment the step's full assistant event is durable.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { initLeagueSettings, modelPrices, sessionEvents, sessionStream, sessions, teams } from "@league/engine";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { fakeStreamResult, type FakePart } from "./helpers/stream.ts";
import { createModelStep, partialFlushIntervalMs } from "../src/modelStep.ts";
import { clearPartial, createPartialSink, type StreamPartial } from "../src/stream.ts";
import { runSession, type ModelStepResult, type RunSessionDeps } from "../src/session.ts";
import { defineTool, type LeagueTool } from "../src/tools/types.ts";

describe("createModelStep streaming", () => {
  function stepWith(parts: FakePart[], onPartial: (p: StreamPartial) => Promise<void>) {
    return createModelStep({} as never, {
      stream: (() =>
        fakeStreamResult({
          parts,
          text: "final text",
          usage: { inputTokens: 5, outputTokens: 3 },
        })) as never,
      onPartial,
      flushIntervalMs: 0,
    });
  }

  it("accumulates reasoning and text deltas and stages each flush with the step number", async () => {
    const flushes: StreamPartial[] = [];
    const step = stepWith(
      [
        { type: "reasoning-delta", text: "hmm, " },
        { type: "reasoning-delta", text: "the flex spot" },
        { type: "text-delta", text: "I will " },
        { type: "text-delta", text: "start Achane." },
      ],
      async (p) => {
        flushes.push(p);
      },
    );

    const result = await step({ modelId: "test/model", messages: [], tools: [] }, 4);

    expect(flushes.length).toBe(4);
    expect(flushes[0]).toEqual({ stepNo: 4, reasoning: "hmm, ", text: "" });
    expect(flushes.at(-1)).toEqual({
      stepNo: 4,
      reasoning: "hmm, the flex spot",
      text: "I will start Achane.",
    });
    // The step's result is unchanged by streaming: one complete message.
    expect(result.text).toBe("final text");
    expect(result.usage.inputTokens).toBe(5);
  });

  it("throttles flushes by wall clock rather than writing one per delta", async () => {
    const flushes: StreamPartial[] = [];
    const step = createModelStep({} as never, {
      stream: (() =>
        fakeStreamResult({
          parts: Array.from({ length: 50 }, () => ({ type: "text-delta", text: "x" }) as FakePart),
        })) as never,
      onPartial: async (p) => {
        flushes.push(p);
      },
      // A generous interval: only the first delta can flush inside this test.
      flushIntervalMs: 60_000,
    });
    await step({ modelId: "test/model", messages: [], tools: [] }, 0);
    expect(flushes.length).toBe(1);
    expect(flushes[0]!.text).toBe("x");
  });

  it("backs the flush interval off as the partial grows, so long steps do not rewrite kilobytes twice a second", () => {
    expect(partialFlushIntervalMs(0)).toBe(500);
    expect(partialFlushIntervalMs(8_000)).toBe(500);
    expect(partialFlushIntervalMs(8_001)).toBe(2_000);
    expect(partialFlushIntervalMs(32_001)).toBe(5_000);
  });

  it("rethrows a provider failure delivered as an error part, since streamText does not throw", async () => {
    const step = createModelStep({} as never, {
      stream: (() =>
        fakeStreamResult({
          parts: [
            { type: "text-delta", text: "half a tho" },
            { type: "error", error: new Error("provider fell over") },
          ],
        })) as never,
      flushIntervalMs: 0,
    });
    await expect(step({ modelId: "test/model", messages: [], tools: [] }, 0)).rejects.toThrow(
      "provider fell over",
    );
  });

  it("ignores non-delta parts and still resolves tool calls from the result", async () => {
    const step = createModelStep({} as never, {
      stream: (() =>
        fakeStreamResult({
          parts: [{ type: "tool-input-start" }, { type: "text-delta", text: "picking" }],
          toolCalls: [{ toolCallId: "c1", toolName: "make_pick", input: { player_id: "123" } }],
        })) as never,
      flushIntervalMs: 0,
    });
    const result = await step({ modelId: "test/model", messages: [], tools: [] }, 0);
    expect(result.toolCalls).toEqual([{ toolCallId: "c1", toolName: "make_pick", args: { player_id: "123" } }]);
  });
});

describe("partial sink and session_stream lifecycle", () => {
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

  it("upserts one row per session, overwriting as the step streams", async () => {
    const id = await makeSession();
    const sink = createPartialSink(db, clock, id);

    await sink({ stepNo: 0, reasoning: "thinking", text: "" });
    await sink({ stepNo: 0, reasoning: "thinking harder", text: "and writing" });

    const rows = await db.select().from(sessionStream).where(eq(sessionStream.sessionId, id));
    expect(rows.length).toBe(1);
    expect(rows[0]!.reasoning).toBe("thinking harder");
    expect(rows[0]!.text).toBe("and writing");
    expect(rows[0]!.stepNo).toBe(0);

    await clearPartial(db, id);
    expect(await db.select().from(sessionStream).where(eq(sessionStream.sessionId, id))).toEqual([]);
  });

  it("swallows write failures — a preview must never kill a model step", async () => {
    // Session 999999 does not exist, so the FK rejects the insert.
    const sink = createPartialSink(db, clock, 999_999);
    await expect(sink({ stepNo: 0, reasoning: "r", text: "t" })).resolves.toBeUndefined();
  });

  it("the session loop deletes the staged partial once the assistant event is durable", async () => {
    const id = await makeSession();

    const logTool: LeagueTool = defineTool({
      name: "write_decision_log",
      description: "end the session",
      ending: true,
      schema: z.object({ summary: z.string() }),
      async execute() {
        return { ok: true };
      },
    });

    const sink = createPartialSink(db, clock, id);
    const deps: RunSessionDeps = {
      db,
      clock,
      tools: [logTool],
      toolConfig: {},
      buildSystemPrompt: async () => "system",
      buildContext: async () => ({ brief: "brief", snapshot: {} }),
      // Stage a partial exactly the way a streaming step would, then return
      // the completed step; the loop must clear the row after recording it.
      modelStep: async (): Promise<ModelStepResult> => {
        await sink({ stepNo: 0, reasoning: "let me think", text: "half-written" });
        return {
          text: "done",
          toolCalls: [{ toolCallId: "c1", toolName: "write_decision_log", args: { summary: "ok" } }],
          usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, cachedInputTokens: 0 },
          gatewayCostUsd: null,
          billedTo: "gateway",
          assistantMessage: { role: "assistant", content: "done" },
        };
      },
    };

    const result = await runSession(id, deps);
    expect(result.status).toBe("succeeded");
    expect(await db.select().from(sessionStream).where(eq(sessionStream.sessionId, id))).toEqual([]);
  });

  it("a resumed session discards the killed invocation's stale partial before its first step", async () => {
    const id = await makeSession();
    // The prior invocation got as far as a transcript and a staged partial,
    // then died. Mark the row running (resume path) and leave the partial.
    await db.insert(sessionEvents).values([
      { sessionId: id, seq: 0, type: "system", content: { prompt: "system" }, createdAt: clock.now() },
      { sessionId: id, seq: 1, type: "user", content: { brief: "brief", snapshot: {} }, createdAt: clock.now() },
    ]);
    await db.update(sessions).set({ status: "running" }).where(eq(sessions.id, id));
    await createPartialSink(db, clock, id)({ stepNo: 0, reasoning: "from the dead invocation", text: "" });

    let partialAtFirstStep: string | null = "unread";
    const logTool: LeagueTool = defineTool({
      name: "write_decision_log",
      description: "end the session",
      ending: true,
      schema: z.object({ summary: z.string() }),
      async execute() {
        return { ok: true };
      },
    });
    const deps: RunSessionDeps = {
      db,
      clock,
      tools: [logTool],
      toolConfig: {},
      buildSystemPrompt: async () => "system",
      buildContext: async () => ({ brief: "brief", snapshot: {} }),
      modelStep: async (): Promise<ModelStepResult> => {
        const rows = await db.select().from(sessionStream).where(eq(sessionStream.sessionId, id));
        partialAtFirstStep = rows[0]?.reasoning ?? null;
        return {
          text: "done",
          toolCalls: [{ toolCallId: "c1", toolName: "write_decision_log", args: { summary: "ok" } }],
          usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, cachedInputTokens: 0 },
          gatewayCostUsd: null,
          billedTo: "gateway",
          assistantMessage: { role: "assistant", content: "done" },
        };
      },
    };

    const result = await runSession(id, deps);
    expect(result.status).toBe("succeeded");
    // The stale partial was gone before the resumed session's first step ran.
    expect(partialAtFirstStep).toBeNull();
  });

  it("a failed session leaves no stale thinking preview behind", async () => {
    const id = await makeSession();
    const sink = createPartialSink(db, clock, id);
    const deps: RunSessionDeps = {
      db,
      clock,
      tools: [],
      toolConfig: {},
      buildSystemPrompt: async () => "system",
      buildContext: async () => ({ brief: "brief", snapshot: {} }),
      modelStep: async () => {
        await sink({ stepNo: 0, reasoning: "mid-thought", text: "" });
        throw new Error("provider exploded");
      },
    };

    const result = await runSession(id, deps);
    expect(result.status).toBe("failed");
    expect(await db.select().from(sessionStream).where(eq(sessionStream.sessionId, id))).toEqual([]);
  });
});
