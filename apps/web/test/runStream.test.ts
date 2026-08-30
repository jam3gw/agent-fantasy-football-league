/**
 * Workflow run streams (lib/runStream.ts). The delta logic is what keeps the
 * run stream additive — each chunk carries only what is new, with `reset`
 * marking the restarts a reader must honor — and the emit path must swallow
 * every failure, or a stream hiccup could fail the model step it observes.
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
    ).toEqual({ reasoning: "thinking", text: "hi", reset: true });
  });

  it("returns only the appended suffix within a step", () => {
    expect(
      partialDelta(
        { stepNo: 0, reasoning: "think", text: "h" },
        { stepNo: 0, reasoning: "thinking more", text: "hi" },
      ),
    ).toEqual({ reasoning: "ing more", text: "i", reset: false });
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
    ).toEqual({ reasoning: "new", text: "", reset: true });
  });

  it("flags reset when a same-step partial is not an extension", () => {
    // Defense in depth: within one sink instance partials are append-only
    // today, but the contract must survive a producer that restarts.
    expect(
      partialDelta(
        { stepNo: 0, reasoning: "first attempt", text: "" },
        { stepNo: 0, reasoning: "second", text: "" },
      ),
    ).toEqual({ reasoning: "second", text: "", reset: true });
  });

  it("handles the closing step's stepNo -1 as its own step", () => {
    expect(
      partialDelta(
        { stepNo: 4, reasoning: "loop", text: "loop" },
        { stepNo: -1, reasoning: "closing", text: "" },
      ),
    ).toEqual({ reasoning: "closing", text: "", reset: true });
  });

  it("keeps a contentless restart — only an empty extension is silent", () => {
    // A step's first flush can be empty (the throttle flushes on the very
    // first delta part); the reset must survive it or a reader would keep a
    // failed attempt's chunks and concatenate both attempts.
    expect(
      partialDelta(
        { stepNo: -2, reasoning: "", text: "" },
        { stepNo: 5, reasoning: "", text: "" },
      ),
    ).toEqual({ reasoning: "", text: "", reset: true });
  });
});

describe("createRunStreamPartialSink", () => {
  it("emits deltas and skips empty ones", async () => {
    const chunks: RunStreamChunk[] = [];
    const sink = createRunStreamPartialSink(42, async (c) => {
      chunks.push(c);
      return true;
    });

    await sink({ stepNo: 0, reasoning: "a", text: "" });
    await sink({ stepNo: 0, reasoning: "ab", text: "x" });
    await sink({ stepNo: 0, reasoning: "ab", text: "x" }); // no change → no chunk
    await sink({ stepNo: 1, reasoning: "c", text: "" });

    expect(chunks).toEqual([
      { kind: "model_delta", sessionId: 42, stepNo: 0, reasoning: "a", text: "", reset: true },
      { kind: "model_delta", sessionId: 42, stepNo: 0, reasoning: "b", text: "x", reset: false },
      { kind: "model_delta", sessionId: 42, stepNo: 1, reasoning: "c", text: "", reset: true },
    ]);
  });

  it("concatenated deltas rebuild the partial as of the last flush", async () => {
    // The throttle means the tail past the final flush reaches only
    // session_events; the stream reconstructs exactly what was flushed.
    const chunks: RunStreamChunk[] = [];
    const sink = createRunStreamPartialSink(7, async (c) => {
      chunks.push(c);
      return true;
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

  it("a fresh sink re-streaming a step the stream already carries flags reset", async () => {
    // A retried workflow step builds a new sink but the session loop resumes
    // with the same step counter — stream writes bypass the event log, so the
    // chunks from the failed attempt are still on the stream. The reader's
    // cue to discard them is reset:true on the re-emission.
    const chunks: RunStreamChunk[] = [];
    const emit = async (c: RunStreamChunk) => {
      chunks.push(c);
      return true;
    };
    await createRunStreamPartialSink(9, emit)({ stepNo: 5, reasoning: "attempt one", text: "" });
    await createRunStreamPartialSink(9, emit)({ stepNo: 5, reasoning: "attempt", text: "" });

    expect(chunks).toEqual([
      { kind: "model_delta", sessionId: 9, stepNo: 5, reasoning: "attempt one", text: "", reset: true },
      { kind: "model_delta", sessionId: 9, stepNo: 5, reasoning: "attempt", text: "", reset: true },
    ]);
  });

  it("does not advance past a dropped write — the next delta covers the hole", async () => {
    // Partials are cumulative, so a failed emit must leave `prev` where the
    // reader last caught up; otherwise later suffixes concatenate around an
    // undetectable gap for the rest of the step.
    const chunks: RunStreamChunk[] = [];
    let failNext = false;
    const sink = createRunStreamPartialSink(3, async (c) => {
      if (failNext) {
        failNext = false;
        return false;
      }
      chunks.push(c);
      return true;
    });

    await sink({ stepNo: 0, reasoning: "one ", text: "" });
    failNext = true;
    await sink({ stepNo: 0, reasoning: "one two ", text: "" }); // dropped
    await sink({ stepNo: 0, reasoning: "one two three", text: "" });

    expect(chunks).toEqual([
      { kind: "model_delta", sessionId: 3, stepNo: 0, reasoning: "one ", text: "", reset: true },
      { kind: "model_delta", sessionId: 3, stepNo: 0, reasoning: "two three", text: "", reset: false },
    ]);
  });
});

describe("emitRunChunk", () => {
  const chunk: RunStreamChunk = {
    kind: "draft_pick",
    picksMade: 1,
    autoPicks: 0,
    completed: false,
    pausedAt: null,
  };

  it("is a silent no-op outside a workflow context", async () => {
    // getWritable() throws here (no workflow or step is running); the helper
    // must swallow that so tests and scripts never notice the stream.
    await expect(emitRunChunk(chunk)).resolves.toBe(false);
  });

  it("swallows a rejected write and releases the lock", async () => {
    const writable = new WritableStream<RunStreamChunk>({
      write: async () => {
        throw new Error("stream backend down");
      },
    });
    await expect(emitRunChunk(chunk, () => writable)).resolves.toBe(false);
    // The lock was released even though the write rejected — a second writer
    // can be acquired. (An unreleased lock would hang the step's request.)
    expect(() => writable.getWriter()).not.toThrow();
  });

  it("swallows a locked stream (concurrent writer)", async () => {
    const writable = new WritableStream<RunStreamChunk>();
    const held = writable.getWriter(); // getWriter() inside emit throws
    await expect(emitRunChunk(chunk, () => writable)).resolves.toBe(false);
    held.releaseLock();
  });

  it("reports true when the write lands", async () => {
    const received: RunStreamChunk[] = [];
    const writable = new WritableStream<RunStreamChunk>({
      write: async (c) => {
        received.push(c);
      },
    });
    await expect(emitRunChunk(chunk, () => writable)).resolves.toBe(true);
    expect(received).toEqual([chunk]);
  });
});
