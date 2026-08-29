/**
 * §8.10 — the check-in's brief carries the agent's own reason and, when the
 * booking recorded one, the reasoning behind it ("Why you booked it"). A
 * check-in booked before the reasoning field existed must not wake to a brief
 * that references a reasoning that is not there — the static brief text stays
 * silent about it and the dynamic line is only appended when one was stored.
 */
import { describe, expect, it } from "vitest";
import { readBrief } from "../lib/briefs";

describe("the self_check_in brief (§8.10)", () => {
  it("appends the reason and the reasoning the agent gave", async () => {
    const brief = await readBrief("self_check_in", {
      reason: "did Achane practise on Thursday?",
      reasoning: "he sat out Wednesday and my FLEX call hinges on his status",
    });
    expect(brief).toContain("Your reason: did Achane practise on Thursday?");
    expect(brief).toContain("Why you booked it: he sat out Wednesday and my FLEX call hinges on his status");
  });

  it("neither shows nor promises a reasoning for a booking that predates the field", async () => {
    const brief = await readBrief("self_check_in", { reason: "old booking" });
    expect(brief).toContain("Your reason: old booking");
    expect(brief).not.toContain("Why you booked it");
    // The static text must not mention it either, or a legacy check-in wakes
    // to a brief pointing at something that is not below.
    expect(brief.toLowerCase()).not.toContain("reasoning");
  });
});
