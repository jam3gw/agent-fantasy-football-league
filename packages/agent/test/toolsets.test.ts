/**
 * Tool sets per session kind (§8.6) and the identical-tools rule (§2:
 * "Same prompt, same tools, same information for all twelve agents").
 */
import { describe, expect, it } from "vitest";
import type { SessionKind } from "@league/engine";
import { DEFAULT_SESSION_GUARDS } from "@league/engine";
import { z } from "zod";
import { SETS, toolsForKind } from "../src/toolsets.ts";
import { READ_TOOLS } from "../src/tools/read.ts";
import { WRITE_TOOLS } from "../src/tools/write.ts";
import { DRAFT_TOOLS } from "../src/tools/draft.ts";
import { REPORTER_TOOLS } from "../src/tools/reporter.ts";
import { endingToolFor } from "../src/session.ts";

const ALL_KINDS = Object.keys(DEFAULT_SESSION_GUARDS) as SessionKind[];

function names(kind: SessionKind): string[] {
  return toolsForKind(kind).map((t) => t.name);
}

describe("tool sets (§8.6)", () => {
  it("defines a set for every session kind, with no duplicates", () => {
    for (const kind of ALL_KINDS) {
      const n = names(kind);
      expect(n.length, kind).toBeGreaterThan(0);
      expect(new Set(n).size, `${kind} has duplicate tools`).toBe(n.length);
    }
  });

  it("every kind's ending tool is actually in its set", () => {
    for (const kind of ALL_KINDS) {
      expect(names(kind), kind).toContain(endingToolFor(kind));
    }
  });

  it("exactly one tool in each set is marked ending", () => {
    for (const kind of ALL_KINDS) {
      const ending = toolsForKind(kind).filter((t) => t.ending);
      expect(ending.map((t) => t.name), kind).toHaveLength(1);
    }
  });

  /*
   * The count is quoted in prose in SPEC Appendix C and in prompt.ts as the
   * evidence for how narrow the draft set is, and it was wrong once already:
   * §8.6's table writes the two scratchpad tools as one row, so counting the
   * table gives eight. Pin it to the code.
   */
  it("binds nine tools for draft_pick, the number Appendix C quotes", () => {
    expect(toolsForKind("draft_pick")).toHaveLength(9);
  });

  it("draft_pick has make_pick and no write_decision_log (the pick reason is the log)", () => {
    const n = names("draft_pick");
    expect(n).toContain("make_pick");
    expect(n).not.toContain("write_decision_log");
    expect(n).toContain("get_draft_state");
    expect(n).toContain("get_available_players");
  });

  it("trade_vote is the narrow set from §8.6", () => {
    expect(names("trade_vote").sort()).toEqual(
      ["get_league_state", "get_player_stats", "get_team_roster", "get_trade", "vote_on_trade", "write_decision_log"].sort(),
    );
  });

  it("smoke is just get_league_state and the log (§8.1 smoke test)", () => {
    expect(names("smoke").sort()).toEqual(["get_league_state", "write_decision_log"]);
  });

  it("reporter kinds get reporter tools and read tools, but no team write tools", () => {
    for (const kind of ALL_KINDS.filter((k) => k.startsWith("reporter_"))) {
      const n = names(kind);
      expect(n, kind).toContain(kind === "reporter_power_rankings" ? "publish_power_rankings" : "publish_report");
      expect(n, kind).toContain("get_session_transcript");
      expect(n, kind).toContain("get_team_scratchpad");
      // no team writes
      for (const forbidden of [
        "set_lineup",
        "propose_trade",
        "add_free_agent",
        "drop_player",
        "vote_on_trade",
        "post_message",
        "submit_waiver_claims",
        "write_scratchpad",
      ]) {
        expect(n, `${kind} must not have ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("team kinds never get reporter tools that read other teams' private work", () => {
    const teamKinds = ALL_KINDS.filter((k) => !k.startsWith("reporter_"));
    for (const kind of teamKinds) {
      const n = names(kind);
      for (const forbidden of ["get_team_scratchpad", "get_session_transcript", "list_sessions", "publish_report"]) {
        expect(n, `${kind} must not have ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("manual has every team write tool except voting and naming (§8.6)", () => {
    const n = names("manual");
    expect(n).toContain("set_lineup");
    expect(n).toContain("propose_trade");
    expect(n).toContain("post_message");
    expect(n).not.toContain("vote_on_trade");
    expect(n).not.toContain("set_team_name");
  });

  it("onboarding can name the team and study the board but cannot pick", () => {
    const n = names("onboarding");
    expect(n).toContain("set_team_name");
    expect(n).toContain("get_available_players");
    expect(n).not.toContain("make_pick");
  });

  it("the read tools reach every session kind that §8.6 says gets them", () => {
    for (const kind of ["weekly_review", "post_waivers", "trade_window", "lineup_check", "injury_response"] as SessionKind[]) {
      const n = names(kind);
      expect(n, kind).toContain("get_league_state");
      expect(n, kind).toContain("web_search");
      expect(n, kind).toContain("player_research");
      expect(n, kind).toContain("read_scratchpad");
      expect(n, kind).toContain("write_scratchpad");
    }
  });

  it("tool schemas and descriptions are identical objects across kinds (same tools for every model)", () => {
    const a = toolsForKind("weekly_review").find((t) => t.name === "set_lineup");
    const b = toolsForKind("lineup_check").find((t) => t.name === "set_lineup");
    expect(a).toBe(b); // the same instance, so no model can get a different schema
  });
});

describe("§8.10 — check-in tools", () => {
  it("a check-in cannot book another check-in, or start a trade, or post", () => {
    const names = toolsForKind("self_check_in").map((t) => t.name);
    // The chaining guard, at the tool set as well as in the engine.
    expect(names).not.toContain("schedule_check_in");
    // Proposing a trade and posting to the board have their own windows.
    expect(names).not.toContain("propose_trade");
    expect(names).not.toContain("post_message");
    // But it can act on what it finds — that is the point of booking it.
    for (const tool of ["set_lineup", "add_free_agent", "drop_player", "submit_waiver_claims", "respond_to_trade"]) {
      expect(names, `a check-in needs ${tool}`).toContain(tool);
    }
    expect(names).toContain("write_decision_log");
  });

  it("only the kinds with room to think ahead may schedule one", () => {
    for (const kind of ["weekly_review", "post_waivers", "lineup_check", "injury_response", "onboarding"] as const) {
      expect(toolsForKind(kind).map((t) => t.name), kind).toContain("schedule_check_in");
    }
    // A draft pick has 180 seconds and one job; smoke is a smoke test; the
    // reporter has no team to check in on.
    for (const kind of ["draft_pick", "smoke", "trade_vote", "reporter_recap"] as const) {
      expect(toolsForKind(kind).map((t) => t.name), kind).not.toContain("schedule_check_in");
    }
  });

  it("no reporter kind can schedule or cancel a check-in", () => {
    for (const kind of REPORTER_KINDS) {
      const names = toolsForKind(kind).map((t) => t.name);
      expect(names).not.toContain("schedule_check_in");
      expect(names).not.toContain("cancel_check_in");
    }
  });

  it("each reporter kind has exactly one ending tool, and the rankings kind cannot publish a post (§11)", () => {
    for (const kind of REPORTER_KINDS) {
      const names = toolsForKind(kind).map((t) => t.name);
      const enders = names.filter((n) => n.startsWith("publish_"));
      expect(enders, kind).toEqual([kind === "reporter_power_rankings" ? "publish_power_rankings" : "publish_report"]);
      expect(names, kind).toContain("get_power_rankings");
    }
  });
});

const REPORTER_KINDS = [
  "reporter_draft_grades",
  "reporter_recap",
  "reporter_preview",
  "reporter_trade_note",
  "reporter_power_rankings",
] as const;

describe("tool names are unique", () => {
  it("no two tools share a name", () => {
    const all = [...READ_TOOLS, ...WRITE_TOOLS, ...DRAFT_TOOLS, ...REPORTER_TOOLS];
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const t of all) {
      if (seen.has(t.name)) dupes.push(t.name);
      seen.add(t.name);
    }
    expect(dupes).toEqual([]);
  });

  it("every kind gets the paging read-table get_team_week_results", () => {
    for (const kind of Object.keys(SETS) as SessionKind[]) {
      const tool = toolsForKind(kind).find((t) => t.name === "get_team_week_results");
      if (!tool) continue;
      // The read-table version pages (§8.2); the removed reporter copy did not.
      expect(Object.keys(z.toJSONSchema(tool.schema).properties ?? {}), kind).toContain("limit");
    }
  });
});
