/**
 * The transcript's thinking log (SPEC §12.1). `assistantReasoning` is what
 * decides whether a finished step shows its reasoning: first-class
 * `content.reasoning` on new events, with a fallback into the raw assistant
 * message for events recorded before the field existed — four models' worth
 * of production transcripts hold reasoning parts only there.
 */
import { describe, expect, it } from "vitest";
import { assistantReasoning } from "../components/transcript";

describe("assistantReasoning", () => {
  it("prefers the first-class reasoning field", () => {
    expect(
      assistantReasoning({
        reasoning: "the flex spot is weak",
        raw: { content: [{ type: "reasoning", text: "older text" }] },
      }),
    ).toBe("the flex spot is weak");
  });

  it("falls back to reasoning parts inside the raw assistant message", () => {
    expect(
      assistantReasoning({
        text: "I will start Achane.",
        raw: {
          content: [
            { type: "reasoning", text: "hmm, " },
            { type: "tool-call", toolName: "set_lineup" },
            { type: "reasoning", text: "the flex spot" },
          ],
        },
      }),
    ).toBe("hmm, \n\nthe flex spot");
  });

  it("treats empty reasoning parts as no thinking — Anthropic's omitted display streams empty text", () => {
    expect(
      assistantReasoning({
        reasoning: "  ",
        raw: { content: [{ type: "reasoning", text: "" }, { type: "tool-call" }] },
      }),
    ).toBe("");
  });

  it("handles events with no raw message and raw content that is a plain string", () => {
    expect(assistantReasoning({ text: "done" })).toBe("");
    expect(assistantReasoning({ raw: { content: "done" } })).toBe("");
  });
});
