/**
 * The session page's derivation layer: flat `session_events` in, steps out.
 *
 * Every event here is shaped the way `packages/agent/src/session.ts` writes
 * it and every tool result the way that tool actually returns one, because
 * the whole point of this layer is that it reads real transcripts — a fixture
 * invented to match the code would test nothing.
 */
import { describe, expect, it } from "vitest";
import type { TranscriptEvent } from "../components/transcript";
import {
  callSummary,
  compactTokens,
  formatDuration,
  groupSteps,
  isDecisionStep,
  isWriteStep,
  outcomeOf,
  playerIndex,
  reasoningOf,
  stepTitle,
  stepToolLabel,
} from "../lib/sessionTranscript";

let seq = 0;
function event(type: string, content: Record<string, unknown>): TranscriptEvent {
  seq += 1;
  return { id: seq, seq, type, content, createdAt: new Date("2026-08-29T21:36:00Z").toISOString() };
}

/**
 * A post-waivers session: read the brief, check the roster, scan the pool,
 * compare three receivers, make the swap, write the log. The same session the
 * redesign was drawn against.
 */
function transcript(): TranscriptEvent[] {
  seq = 0;
  return [
    event("system", { prompt: "You manage one team in a twelve-team fantasy football league." }),
    event("user", {
      brief: "Waivers have processed. Decide whether to add anyone before kickoff.",
      snapshot: { team: { id: 7, faab: 100 }, roster: { size: 15, max: 16 } },
    }),
    event("assistant", {
      text: "Let me look at the roster first.",
      step_no: 0,
      tool_calls: [{ name: "get_my_team", args: { week: 1 }, id: "call_1" }],
      usage: { inputTokens: 40_000, outputTokens: 300, reasoningTokens: 900 },
      cost_usd: 0.09,
      raw: {
        role: "assistant",
        content: [
          { type: "reasoning", text: "I lost both waiver claims, so my WR depth is thin." },
          { type: "text", text: "Let me look at the roster first." },
        ],
      },
    }),
    event("tool_call", { name: "get_my_team", args: { week: 1 }, tool_call_id: "call_1" }),
    event("tool_result", {
      name: "get_my_team",
      tool_call_id: "call_1",
      invalid: false,
      result: {
        team: { id: 7, name: "Gridiron Gradient" },
        week: 1,
        players: [
          { player_id: "8134", name: "Rome Odunze", slot: "WR2", position: "WR", nfl_team: "CHI", season_points: 0 },
          {
            player_id: "10222",
            name: "Demario Douglas",
            slot: "BN",
            position: "WR",
            nfl_team: "NE",
            bye_week: 14,
            season_points: 0,
          },
        ],
        active_players: 15,
        max_active: 16,
        empty_starting_slots: [],
      },
    }),
    event("assistant", {
      text: "",
      step_no: 1,
      tool_calls: [{ name: "get_free_agents", args: { position: "WR", limit: 25 }, id: "call_2" }],
      usage: { inputTokens: 44_000, outputTokens: 260, reasoningTokens: 500 },
      cost_usd: 0.11,
    }),
    event("tool_call", { name: "get_free_agents", args: { position: "WR", limit: 25 }, tool_call_id: "call_2" }),
    event("tool_result", {
      name: "get_free_agents",
      tool_call_id: "call_2",
      invalid: false,
      result: {
        position: "WR",
        items: [
          { player_id: "13417", name: "Ricky Pearsall", position: "WR", nfl_team: "SF", trending_adds: 4120 },
          { player_id: "11646", name: "Jalen Coker", position: "WR", nfl_team: "CAR", bye_week: 5, trending_adds: 1280 },
        ],
        total: 25,
        offset: 0,
        has_more: true,
      },
    }),
    event("assistant", {
      text: "Coker is the cheaper shot at a real Week 1 role.",
      step_no: 2,
      tool_calls: [
        { name: "add_free_agent", args: { add_player_id: "11646", drop_player_id: "10222" }, id: "call_3" },
      ],
      usage: { inputTokens: 48_000, outputTokens: 400, reasoningTokens: 460 },
      cost_usd: 0.15,
    }),
    event("tool_call", {
      name: "add_free_agent",
      args: { add_player_id: "11646", drop_player_id: "10222" },
      tool_call_id: "call_3",
    }),
    event("tool_result", {
      name: "add_free_agent",
      tool_call_id: "call_3",
      invalid: false,
      result: {
        ok: true,
        added_player_id: "11646",
        dropped_player_id: "10222",
        dropped_waiver_until: "2026-08-31T21:38:00.000Z",
      },
    }),
    event("assistant", {
      text: "",
      step_no: 3,
      tool_calls: [{ name: "write_decision_log", args: { summary: "Spent the open spot on upside." }, id: "call_4" }],
      usage: { inputTokens: 51_000, outputTokens: 220, reasoningTokens: 0 },
      cost_usd: 0.14,
    }),
    event("tool_call", {
      name: "write_decision_log",
      args: { summary: "Spent the open spot on upside." },
      tool_call_id: "call_4",
    }),
    event("tool_result", {
      name: "write_decision_log",
      tool_call_id: "call_4",
      invalid: false,
      result: { ok: true, decision_log_id: 902 },
    }),
  ];
}

describe("grouping a transcript into steps", () => {
  it("opens with the brief and then one step per assistant turn", () => {
    const steps = groupSteps(transcript());
    expect(steps).toHaveLength(5);
    expect(steps[0]!.kind).toBe("brief");
    expect(steps.slice(1).every((s) => s.kind === "turn")).toBe(true);
    expect(steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5]);
  });

  it("puts the system prompt, brief and snapshot in the first step", () => {
    const brief = groupSteps(transcript())[0]!.brief;
    expect(brief?.prompt).toContain("twelve-team");
    expect(brief?.brief).toContain("Waivers have processed");
    expect(brief?.snapshot).toMatchObject({ roster: { size: 15 } });
  });

  it("nests each tool call inside the turn that made it", () => {
    const steps = groupSteps(transcript());
    expect(steps.map((s) => s.calls.map((c) => c.name))).toEqual([
      [],
      ["get_my_team"],
      ["get_free_agents"],
      ["add_free_agent"],
      ["write_decision_log"],
    ]);
  });

  it("matches a result to its call by tool_call_id rather than by position", () => {
    // Two calls in one turn, results returned in the other order.
    const events = [
      event("assistant", {
        text: "",
        step_no: 0,
        tool_calls: [
          { name: "get_my_team", args: {}, id: "a" },
          { name: "get_free_agents", args: {}, id: "b" },
        ],
      }),
      event("tool_result", { name: "get_free_agents", tool_call_id: "b", result: { items: [{ player_id: "1" }] } }),
      event("tool_result", { name: "get_my_team", tool_call_id: "a", result: { players: [] } }),
    ];
    const [step] = groupSteps(events);
    expect(step!.calls.map((c) => c.name)).toEqual(["get_my_team", "get_free_agents"]);
    expect(step!.calls[0]!.result).toMatchObject({ players: [] });
    expect(step!.calls[1]!.result).toMatchObject({ items: [{ player_id: "1" }] });
  });

  it("shows a call the model has announced but not yet resolved", () => {
    // What the live view sees between the assistant event and the result.
    const events = [
      event("assistant", { text: "", step_no: 0, tool_calls: [{ name: "get_my_team", args: {}, id: "a" }] }),
    ];
    const call = groupSteps(events)[0]!.calls[0]!;
    expect(call.result).toBeNull();
    expect(callSummary(call)).toBe("running…");
  });

  it("keeps a mid-session nudge with the step it interrupted", () => {
    // §8.8 writes the nudge as a `user` event mid-loop; it is not a new turn.
    const events = [
      event("assistant", { text: "thinking", step_no: 0, tool_calls: [] }),
      event("user", { text: "Five invalid tool calls.", nudge: "invalid_calls" }),
    ];
    const steps = groupSteps(events);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.notes.map((n) => n.type)).toEqual(["user"]);
  });

  it("keeps an error with its step", () => {
    const events = [
      event("assistant", { text: "", step_no: 0, tool_calls: [{ name: "get_my_team", args: {}, id: "a" }] }),
      event("error", { tool: "get_my_team", error: "boom" }),
    ];
    expect(groupSteps(events)[0]!.notes.map((n) => n.type)).toEqual(["error"]);
  });

  it("keeps a resumed session's opening note with the brief (§9.2)", () => {
    const events = [
      event("info", { resumed: true, steps_so_far: 3 }),
      event("system", { prompt: "You manage one team." }),
      event("user", { brief: "Carry on.", snapshot: {} }),
      event("assistant", { text: "Resuming.", step_no: 3, tool_calls: [] }),
    ];
    const steps = groupSteps(events);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.kind).toBe("brief");
    expect(steps[0]!.notes.map((n) => n.type)).toEqual(["info"]);
    expect(steps[0]!.brief?.brief).toBe("Carry on.");
    expect(stepTitle(steps[0]!)).toBe("Read the brief");
  });

  it("does not drop a result whose call never arrived", () => {
    // A transcript read mid-session can start after the assistant event.
    const events = [event("tool_result", { name: "get_my_team", tool_call_id: "a", result: { players: [] } })];
    const steps = groupSteps(events);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.calls[0]!.name).toBe("get_my_team");
  });

  it("marks a refused call as failed", () => {
    const events = [
      event("tool_result", {
        name: "add_free_agent",
        tool_call_id: "a",
        invalid: true,
        result: { ok: false, code: "invalid_args", error: "roster is full", hint: "drop someone first" },
      }),
    ];
    const call = groupSteps(events)[0]!.calls[0]!;
    expect(call.failed).toBe(true);
    expect(call.invalid).toBe(true);
    expect(callSummary(call)).toBe("roster is full");
  });

  it("survives an event whose content is not the shape it expects", () => {
    const events = [
      event("assistant", { text: 42, tool_calls: "nope", usage: null }),
      event("tool_result", { name: "get_my_team", result: "a string" }),
    ];
    expect(() => groupSteps(events)).not.toThrow();
    const steps = groupSteps(events);
    expect(steps[0]!.text).toBeNull();
  });
});

describe("naming a step", () => {
  it("names a turn after what it did, not after the model", () => {
    const titles = groupSteps(transcript()).map(stepTitle);
    expect(titles).toEqual([
      "Read the brief",
      "Checked the roster",
      "Scanned free agents",
      "Added a free agent",
      "Wrote the decision log",
    ]);
  });

  it("names a turn after its write tool even when it read first", () => {
    const events = [
      event("assistant", {
        text: "",
        step_no: 0,
        tool_calls: [
          { name: "get_player_stats", args: {}, id: "a" },
          { name: "add_free_agent", args: {}, id: "b" },
        ],
      }),
    ];
    expect(stepTitle(groupSteps(events)[0]!)).toBe("Added a free agent +1 more");
  });

  it("falls back to a tool's own name when it has no phrase yet", () => {
    const events = [
      event("assistant", { text: "", step_no: 0, tool_calls: [{ name: "some_new_tool", args: {}, id: "a" }] }),
    ];
    expect(stepTitle(groupSteps(events)[0]!)).toBe("some new tool");
    expect(stepToolLabel(groupSteps(events)[0]!)).toBe("some_new_tool");
  });

  it("marks the write and decision steps", () => {
    const steps = groupSteps(transcript());
    expect(steps.map(isWriteStep)).toEqual([false, false, false, true, false]);
    expect(steps.map(isDecisionStep)).toEqual([false, false, false, false, true]);
  });
});

describe("one-line tool summaries", () => {
  const summaries = () => groupSteps(transcript()).map((s) => s.calls.map(callSummary));

  it("counts a roster against its cap", () => {
    expect(summaries()[1]).toEqual(["15 of 16 active"]);
  });

  it("says how much of a pool was returned", () => {
    expect(summaries()[2]).toEqual(["2 of 25 WR available"]);
  });

  it("says a swap was a swap", () => {
    expect(summaries()[3]).toEqual(["one in, one out"]);
  });

  it("names the players a stats call compared", () => {
    const events = [
      event("tool_result", {
        name: "get_player_stats",
        tool_call_id: "a",
        result: { items: [{ name: "Rome Odunze" }, { name: "Jalen Coker" }] },
      }),
    ];
    expect(callSummary(groupSteps(events)[0]!.calls[0]!)).toBe("Rome Odunze, Jalen Coker");
  });

  it("warns when a roster has an empty starting slot", () => {
    const events = [
      event("tool_result", {
        name: "get_my_team",
        tool_call_id: "a",
        result: { players: [{ player_id: "1" }], active_players: 14, max_active: 16, empty_starting_slots: ["FLEX"] },
      }),
    ];
    expect(callSummary(groupSteps(events)[0]!.calls[0]!)).toBe("14 of 16 active, 1 slot empty");
  });
});

describe("reasoning", () => {
  it("is recovered from the assistant message the runner stored verbatim", () => {
    const steps = groupSteps(transcript());
    expect(steps[1]!.reasoning).toContain("lost both waiver claims");
  });

  it("is null when the provider returned none — §8.1 never asks for any", () => {
    expect(groupSteps(transcript())[3]!.reasoning).toBeNull();
    expect(reasoningOf({ raw: { content: [{ type: "text", text: "hi" }] } })).toBeNull();
  });
});

describe("recovering player names from the transcript", () => {
  it("indexes every player any tool result named", () => {
    const index = playerIndex(transcript());
    expect(index.get("11646")).toMatchObject({ name: "Jalen Coker", position: "WR", nflTeam: "CAR", byeWeek: 5 });
    expect(index.get("10222")?.name).toBe("Demario Douglas");
  });

  it("fills a field a later result adds", () => {
    const events = [
      event("tool_result", { name: "get_free_agents", result: { items: [{ player_id: "1", name: "A B" }] } }),
      event("tool_result", {
        name: "get_player_stats",
        result: { items: [{ player_id: "1", name: "A B", position: "WR", bye_week: 9 }] },
      }),
    ];
    expect(playerIndex(events).get("1")).toMatchObject({ name: "A B", position: "WR", byeWeek: 9 });
  });
});

describe("what the agent did", () => {
  it("reads the moves off the write tools and the reason off the decision log", () => {
    const outcome = outcomeOf(groupSteps(transcript()));
    expect(outcome.moves).toEqual([
      { verb: "Added", playerId: "11646", tone: "add" },
      { verb: "Dropped", playerId: "10222", tone: "drop" },
    ]);
    expect(outcome.log).toBe("Spent the open spot on upside.");
    // The swap, not the decision log, is what "jump to the decision" means.
    expect(outcome.anchorStep).toBe(4);
    expect(outcome.readOnly).toBe(false);
  });

  it("says so when a session changed nothing", () => {
    const events = [
      event("assistant", {
        text: "",
        step_no: 0,
        tool_calls: [{ name: "write_decision_log", args: { summary: "Stood pat." }, id: "a" }],
      }),
      event("tool_result", { name: "write_decision_log", tool_call_id: "a", result: { ok: true } }),
    ];
    const outcome = outcomeOf(groupSteps(events));
    expect(outcome.readOnly).toBe(true);
    expect(outcome.log).toBe("Stood pat.");
    expect(outcome.anchorStep).toBe(1);
  });

  it("ignores a write the engine refused", () => {
    const events = [
      event("assistant", {
        text: "",
        step_no: 0,
        tool_calls: [{ name: "add_free_agent", args: { add_player_id: "1" }, id: "a" }],
      }),
      event("tool_result", {
        name: "add_free_agent",
        tool_call_id: "a",
        result: { ok: false, code: "conflict", error: "roster is full" },
      }),
    ];
    expect(outcomeOf(groupSteps(events)).readOnly).toBe(true);
  });

  it("treats a draft pick's reason as its decision log (§8.6)", () => {
    const events = [
      event("assistant", {
        text: "",
        step_no: 0,
        tool_calls: [{ name: "make_pick", args: { player_id: "9", reason: "Best available." }, id: "a" }],
      }),
      event("tool_result", { name: "make_pick", tool_call_id: "a", result: { ok: true } }),
    ];
    const outcome = outcomeOf(groupSteps(events));
    expect(outcome.moves).toEqual([{ verb: "Drafted", playerId: "9", tone: "add" }]);
    expect(outcome.log).toBe("Best available.");
  });
});

describe("header facts", () => {
  it("formats a session's length", () => {
    expect(formatDuration("2026-08-29T21:36:00Z", "2026-08-29T21:37:52Z")).toBe("1m 52s");
    expect(formatDuration("2026-08-29T21:36:00Z", "2026-08-29T21:36:09Z")).toBe("9s");
    expect(formatDuration("2026-08-29T21:36:00Z", null)).toBeNull();
  });

  it("compacts token counts without lying about the order of magnitude", () => {
    expect(compactTokens(940)).toBe("940");
    expect(compactTokens(1_860)).toBe("1.9k");
    expect(compactTokens(187_324)).toBe("187k");
  });
});
