/**
 * §2: "Same system prompt for all 12 agents" — and every league rule the
 * prompt states is a setting (§3), so none of them may be a literal. Before
 * this, changing the veto threshold, the waiver time, the trade deadline, the
 * playoff shape or the FantasyPros allowance on /admin/settings left the
 * prompt telling all twelve agents the old value.
 */
import { describe, expect, it } from "vitest";
import { buildReporterSystemPrompt, buildSystemPrompt, promptRulesFromSettings } from "../src/prompt.ts";
import { DRAFT_TOOLS, READ_TOOLS, REPORTER_TOOLS, SETS, WRITE_TOOLS, toolsForKind } from "../src/toolsets.ts";
import type { SessionKind } from "@league/engine";

/** The fullest team set: what the Appendix C text assumes it may describe. */
const FULL = toolsForKind("weekly_review").map((t) => t.name);

/** Every tool the league defines, for the "names nothing it cannot call" check. */
const EVERY_TOOL = [...READ_TOOLS, ...WRITE_TOOLS, ...DRAFT_TOOLS, ...REPORTER_TOOLS].map((t) => t.name);

const settings = {
  startWeek: 1,
  regularSeasonEndWeek: 14,
  playoffStartWeek: 15,
  playoffTeams: 6,
  waiverRunTimeEt: "04:30",
  tradeReviewHours: 24,
  tradeVetoVotes: 7,
  tradeMaxOffersPerDay: 3,
  tradeDeadlineWeek: 11,
};

const base = {
  modelLabel: "Model X",
  teamName: "Team X",
  teamId: 1,
  datetimeEt: "Tuesday, September 8, 2026 at 9:00 AM ET",
  phase: "regular",
  week: 2,
};

describe("system prompt (Appendix C)", () => {
  it("states the league defaults in words", () => {
    const p = buildSystemPrompt({ ...base, ...promptRulesFromSettings(settings) }, FULL);
    expect(p).toContain("4:30 AM ET");
    expect(p).toContain("24-hour review");
    expect(p).toContain("7 vetoes cancel a trade");
    expect(p).toContain("Max 3 offers per day");
    expect(p).toContain("Deadline after week 11");
    expect(p).toContain("Regular season weeks 1-14");
    expect(p).toContain("Playoffs weeks 15-17, 6 teams");
    expect(p).toContain("player_research");
  });

  it("tells every agent how to scout other teams and how to reach them", () => {
    const p = buildSystemPrompt({ ...base, ...promptRulesFromSettings(settings) }, FULL);
    // Scouting: other rosters, the standings, and every team's weekly numbers.
    expect(p).toContain("get_team_roster");
    expect(p).toContain("standings");
    expect(p).toContain("get_team_week_results");
    expect(p).toContain("get_transactions");
    // Communication: the board for the league, @mentions for one team, the
    // message on a trade offer for the counterparty.
    expect(p).toContain("message board");
    expect(p).toContain("@Team Name");
    expect(p).toContain("trade offer can also carry a message");
  });

  it("follows every setting when the commissioner changes one", () => {
    const changed = promptRulesFromSettings({
      ...settings,
      waiverRunTimeEt: "13:15",
      tradeReviewHours: 48,
      tradeVetoVotes: 8,
      tradeMaxOffersPerDay: 5,
      tradeDeadlineWeek: 12,
      regularSeasonEndWeek: 13,
      playoffStartWeek: 14,
      playoffTeams: 4,
    });
    for (const p of [
      buildSystemPrompt({ ...base, ...changed }, FULL),
      buildReporterSystemPrompt({ ...base, ...changed }),
    ]) {
      expect(p).toContain("1:15 PM ET");
      expect(p).toContain("48-hour review");
      expect(p).toContain("8 vetoes cancel a trade");
      expect(p).toContain("Deadline after week 12");
      expect(p).toContain("Regular season weeks 1-13");
      expect(p).toContain("Playoffs weeks 14-16, 4 teams");
      expect(p).toContain("player_research");
      // Nothing from the old defaults survives anywhere in the text.
      expect(p).not.toContain("4:30 AM ET");
      expect(p).not.toContain("7 vetoes");
      expect(p).not.toContain("week 11");
      expect(p).not.toContain("weeks 15-17");
    }
  });

  /*
   * The bug this pins: `buildSystemPrompt` took no session kind, so every
   * draft_pick session was told "get_team_roster shows any team's roster ...
   * check on your rivals whenever you want" and "End every session by calling
   * write_decision_log" — neither of which the draft set (§8.6) binds. On
   * draft night DeepSeek V4-Pro believed it and spent the end of its pick-80
   * clock on four parallel get_team_roster calls that could only ever answer
   * "There is no tool named get_team_roster". It was auto-picked.
   */
  it("names no tool the session cannot call, for every kind", () => {
    const rules = promptRulesFromSettings(settings);
    for (const kind of Object.keys(SETS) as SessionKind[]) {
      const bound = new Set(toolsForKind(kind).map((t) => t.name));
      const p = buildSystemPrompt({ ...base, ...rules }, [...bound]);
      for (const tool of EVERY_TOOL) {
        if (bound.has(tool)) continue;
        expect(p, `the ${kind} prompt names ${tool}, which ${kind} cannot call`).not.toContain(tool);
      }

      /*
       * Tool names are identifiers; the capability claims around them are
       * prose, and prose is what an agent actually acts on. "before you offer
       * it a trade" names no tool, so the loop above cannot see it.
       */
      if (!bound.has("propose_trade") && !bound.has("respond_to_trade")) {
        expect(p, `${kind} is told to offer a trade it cannot offer`).not.toContain(
          "before you offer it a trade",
        );
      }
      if (!bound.has("web_search")) {
        expect(p, `${kind} is promised web search it does not have`).not.toContain("You have web search");
      }
      if (!bound.has("write_scratchpad")) {
        expect(p, `${kind} is promised a scratchpad it cannot write`).not.toContain(
          "You have a private scratchpad",
        );
      }
    }
  });

  /*
   * The rule above is one-directional: a bug that dropped a bullet the session
   * CAN act on would pass it silently, and the agent would simply never be told
   * about a tool it has. Assert the other direction for every kind too.
   */
  it("keeps every bullet whose tools the kind does bind", () => {
    const rules = promptRulesFromSettings(settings);
    const gated: Array<[string[], string]> = [
      [["set_lineup"], "- set_lineup takes your 9 starters and your IR player."],
      [["read_scratchpad", "write_scratchpad"], "- You have a private scratchpad."],
      [["web_search", "player_research"], "- You have web search and player_research"],
      [["post_message"], "- You can talk to the other teams. post_message posts to the league message board"],
      [["write_decision_log"], "- End every session by calling write_decision_log"],
      [["get_team_roster"], "get_team_roster shows any team's roster"],
      [["get_league_rosters"], "get_league_rosters shows every roster at once in short rows"],
      [["get_transactions"], "get_transactions lists every move every team has made"],
    ];
    for (const kind of Object.keys(SETS) as SessionKind[]) {
      const bound = new Set(toolsForKind(kind).map((t) => t.name));
      const p = buildSystemPrompt({ ...base, ...rules }, [...bound]);
      for (const [needs, text] of gated) {
        if (!needs.every((n) => bound.has(n))) continue;
        expect(p, `the ${kind} prompt drops "${text}" although ${kind} binds ${needs.join(" + ")}`).toContain(text);
      }
      // Whatever else is gated, the unconditional bullets are always there.
      expect(p, kind).toContain("- Use tools to look things up.");
      expect(p, kind).toContain("- Every write tool validates your request.");
      expect(p, kind).toContain("- Take the time you need.");
    }
  });

  it("uses the short scouting tail when the session cannot put an offer on the table", () => {
    const rules = promptRulesFromSettings(settings);
    // lineup_check reads the whole league but has no trade tool.
    const p = buildSystemPrompt({ ...base, ...rules }, toolsForKind("lineup_check").map((t) => t.name));
    expect(p).toContain("get_transactions lists every move every team has made");
    expect(p).toContain(" Check on your rivals whenever you want.");
    expect(p).not.toContain("before you offer it a trade");
  });

  it("keeps the Appendix C text verbatim for a kind that has every tool it names", () => {
    const rules = promptRulesFromSettings(settings);
    const p = buildSystemPrompt({ ...base, ...rules }, FULL);
    expect(p).toContain(
      "- The whole league is open to you, all season: get_league_state has the standings and every team's record, get_team_roster shows any team's roster, get_league_rosters shows every roster at once in short rows, get_matchup covers every matchup, get_team_week_results shows what each team scored and left on its bench, week by week, and get_transactions lists every move every team has made — adds, drops, waiver adds, trades, and draft picks (pass team_id for one team's history). Scout another team's roster and recent moves before you offer it a trade, and check on your rivals whenever you want.",
    );
    expect(p).toContain("- set_lineup takes your 9 starters and your IR player.");
    expect(p).toContain("- End every session by calling write_decision_log");
  });

  it("drops the bullets the draft set cannot act on, and keeps the ones it can", () => {
    const rules = promptRulesFromSettings(settings);
    const draft = toolsForKind("draft_pick").map((t) => t.name);
    const p = buildSystemPrompt({ ...base, ...rules }, draft);
    // Gone: league visibility, the lineup, the board, the decision log.
    expect(p).not.toContain("The whole league is open to you");
    expect(p).not.toContain("set_lineup");
    expect(p).not.toContain("post_message");
    expect(p).not.toContain("write_decision_log");
    // Kept: the scratchpad and the research tools, which the draft set binds.
    expect(p).toContain("You have a private scratchpad.");
    expect(p).toContain("player_research");
    // And the rules half is untouched — a drafting agent still needs them.
    expect(p).toContain("Regular season weeks 1-14");
  });

  it("differs between two agents only in model, team, date, phase and week", () => {
    const rules = promptRulesFromSettings(settings);
    const a = buildSystemPrompt({ ...base, ...rules, modelLabel: "A", teamName: "Alpha", teamId: 1 }, FULL);
    const b = buildSystemPrompt({ ...base, ...rules, modelLabel: "B", teamName: "Beta", teamId: 2 }, FULL);
    const strip = (s: string) => s.split("\n").filter((l) => !l.startsWith("You are ")).join("\n");
    expect(strip(a)).toBe(strip(b));
  });
});
