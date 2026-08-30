/**
 * Workflow run streams (lib/runStream.ts). The delta logic is what keeps the
 * run stream additive — each chunk carries only what is new — and the emit
 * path must be a silent no-op outside a workflow context, or every unit test
 * and local script that touches runSession/draft would start throwing.
 */
import { describe, expect, it } from "vitest";
import {
  createRunStreamPartialSink,
  emitRunChunk,
  partialDelta,
  type RunStreamChunk,
} from "../lib/runStream";

describe("partialDelta", () => {
  it("returns the full strings on a first flush", () => {
    expect(
      partialDelta(
        { stepNo: -2, reasoning: "", text: "" },
        { stepNo: 0, reasoning: "thinking", text: "hi" },
      ),
    ).toEqual({ reasoning: "thinking", text: "hi" });
  });

  it("returns only the appended suffix within a step", () => {
    expect(
      partialDelta(
        { stepNo: 0, reasoning: "think", text: "h" },
        { stepNo: 0, reasoning: "thinking more", text: "hi" },
      ),
    ).toEqual({ reasoning: "ing more", text: "i" });
  });

  it("returns null when nothing changed", () => {
    const p = { stepNo: 3, reasoning: "same", text: "same" };
    expect(partialDelta(p, { ...p })).toBeNull();
  });

  it("starts over on a new step", () => {
    expect(
      partialDelta(
        { stepNo: 0, reasoning: "old step", text: "old" },
        { stepNo: 1, reasoning: "new", text: "" },
      ),
    ).toEqual({ reasoning: "new", text: "" });
  });

  it("starts over when the partial is not an extension (retry reset)", () => {
    // The model step's visibility-option retry restarts accumulation from "".
    expect(
      partialDelta(
        { stepNo: 0, reasoning: "first attempt", text: "" },
        { stepNo: 0, reasoning: "second", text: "" },
      ),
    ).toEqual({ reasoning: "second", text: "" });
  });

  it("handles the closing step's stepNo -1 as its own step", () => {
    expect(
      partialDelta(
        { stepNo: 4, reasoning: "loop", text: "loop" },
        { stepNo: -1, reasoning: "closing", text: "" },
      ),
    ).toEqual({ reasoning: "closing", text: "" });
  });
});

describe("createRunStreamPartialSink", () => {
  it("emits deltas and skips empty ones", async () => {
    const chunks: RunStreamChunk[] = [];
    const sink = createRunStreamPartialSink(42, async (c) => {
      chunks.push(c);
    });

    await sink({ stepNo: 0, reasoning: "a", text: "" });
    await sink({ stepNo: 0, reasoning: "ab", text: "x" });
    await sink({ stepNo: 0, reasoning: "ab", text: "x" }); // no change → no chunk
    await sink({ stepNo: 1, reasoning: "c", text: "" });

    expect(chunks).toEqual([
      { kind: "model_delta", sessionId: 42, stepNo: 0, reasoning: "a", text: "" },
      { kind: "model_delta", sessionId: 42, stepNo: 0, reasoning: "b", text: "x" },
      { kind: "model_delta", sessionId: 42, stepNo: 1, reasoning: "c", text: "" },
    ]);
  });

  it("concatenated deltas reconstruct the step's accumulated partial", async () => {
    const chunks: RunStreamChunk[] = [];
    const sink = createRunStreamPartialSink(7, async (c) => {
      chunks.push(c);
    });
    const flushes = [
      { stepNo: 2, reasoning: "I sho", text: "" },
      { stepNo: 2, reasoning: "I should start", text: "Start" },
      { stepNo: 2, reasoning: "I should start Chase", text: "Starting Chase." },
    ];
    for (const f of flushes) await sink(f);

    const rebuilt = chunks.reduce(
      (acc, c) => (c.kind === "model_delta" ? { reasoning: acc.reasoning + c.reasoning, text: acc.text + c.text } : acc),
      { reasoning: "", text: "" },
    );
    expect(rebuilt).toEqual({ reasoning: "I should start Chase", text: "Starting Chase." });
  });
});

describe("emitRunChunk", () => {
  it("is a silent no-op outside a workflow context", async () => {
    // getWritable() throws here (no workflow or step is running); the helper
    // must swallow that so tests and scripts never notice the stream.
    await expect(
      emitRunChunk({ kind: "draft_pick", picksMade: 1, autoPicks: 0, completed: false, pausedAt: null }),
    ).resolves.toBeUndefined();
  });
});
