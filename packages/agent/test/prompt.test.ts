/**
 * §2: "Same system prompt for all 12 agents" — and every league rule the
 * prompt states is a setting (§3), so none of them may be a literal. Before
 * this, changing the veto threshold, the waiver time, the trade deadline, the
 * playoff shape or the FantasyPros allowance on /admin/settings left the
 * prompt telling all twelve agents the old value.
 */
import { describe, expect, it } from "vitest";
import { buildReporterSystemPrompt, buildSystemPrompt, promptRulesFromSettings } from "../src/prompt.ts";

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
    const p = buildSystemPrompt({ ...base, ...promptRulesFromSettings(settings) });
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
    const p = buildSystemPrompt({ ...base, ...promptRulesFromSettings(settings) });
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
      buildSystemPrompt({ ...base, ...changed }),
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

  it("differs between two agents only in model, team, date, phase and week", () => {
    const rules = promptRulesFromSettings(settings);
    const a = buildSystemPrompt({ ...base, ...rules, modelLabel: "A", teamName: "Alpha", teamId: 1 });
    const b = buildSystemPrompt({ ...base, ...rules, modelLabel: "B", teamName: "Beta", teamId: 2 });
    const strip = (s: string) => s.split("\n").filter((l) => !l.startsWith("You are ")).join("\n");
    expect(strip(a)).toBe(strip(b));
  });
});
