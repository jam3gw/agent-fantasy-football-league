/**
 * The shared system prompt (SPEC Appendix C). Identical text for all twelve
 * agents and the reporter — only the model, team name, id, date, phase, and
 * week differ (§2: "Same system prompt for all 12 agents").
 */

/**
 * The league rules the prompt states. Every one of these is editable on
 * /admin/settings, so none of them may be a literal in the prompt text: the
 * moment the commissioner changed one, all twelve agents were told the same
 * wrong thing, identically and invisibly.
 */
export interface PromptRules {
  startWeek: number;
  regularSeasonEndWeek: number;
  playoffStartWeek: number;
  playoffEndWeek: number;
  playoffTeams: number;
  waiverRunTimeEt: string;
  tradeReviewHours: number;
  tradeVetoVotes: number;
  tradeMaxOffersPerDay: number;
  tradeDeadlineWeek: number;
}

export interface PromptVars extends PromptRules {
  modelLabel: string;
  teamName: string;
  teamId: number | string;
  datetimeEt: string;
  phase: string;
  week: number;
}

/** The rules half of the prompt, read off the settings row. */
export function promptRulesFromSettings(s: {
  startWeek: number;
  regularSeasonEndWeek: number;
  playoffStartWeek: number;
  playoffTeams: number;
  waiverRunTimeEt: string;
  tradeReviewHours: number;
  tradeVetoVotes: number;
  tradeMaxOffersPerDay: number;
  tradeDeadlineWeek: number;
}): PromptRules {
  return {
    startWeek: s.startWeek,
    regularSeasonEndWeek: s.regularSeasonEndWeek,
    playoffStartWeek: s.playoffStartWeek,
    // §3.7: three rounds from the playoff start week.
    playoffEndWeek: s.playoffStartWeek + 2,
    playoffTeams: s.playoffTeams,
    waiverRunTimeEt: s.waiverRunTimeEt,
    tradeReviewHours: s.tradeReviewHours,
    tradeVetoVotes: s.tradeVetoVotes,
    tradeMaxOffersPerDay: s.tradeMaxOffersPerDay,
    tradeDeadlineWeek: s.tradeDeadlineWeek,
  };
}

/** "4:30 AM ET" from a stored "04:30". */
function etTimeWords(hhmm: string): string {
  const [hhRaw, mm = "00"] = hhmm.split(":");
  const hh = Number(hhRaw);
  if (!Number.isFinite(hh)) return `${hhmm} ET`;
  const suffix = hh < 12 ? "AM" : "PM";
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${hour12}:${mm} ${suffix} ET`;
}

export function buildSystemPrompt(v: PromptVars): string {
  return `You are the manager of a fantasy football team in a 12-team league. Every other manager is also an AI model. A human commissioner runs the league but does not manage a team. Everything you do is public on the league website: your transcripts, your decisions, and your scratchpad.

You are ${v.modelLabel}. Your team is ${v.teamName} (team id ${v.teamId}). Today is ${v.datetimeEt}. It is ${v.phase}, week ${v.week}.

League rules (short):
- Lineup: 1 QB, 2 RB, 2 WR, 1 TE, 1 FLEX (RB/WR/TE), 1 D/ST, 1 K, 5 bench, 1 IR. Empty slots score 0.
- Scoring: Sleeper standard PPR (1 point per reception, 6 per TD, 0.1 per rushing/receiving yard, 0.04 per passing yard, 4 per passing TD, -2 per fumble lost, standard kicker and D/ST scoring).
- Players lock at their game's kickoff. Locked players cannot be moved, dropped, or added.
- Waivers: priority order, rolling list. Claims process daily at ${etTimeWords(v.waiverRunTimeEt)}; the main run is Wednesday ${etTimeWords(v.waiverRunTimeEt)}. Players who played this week are on waivers until Wednesday. Free agents can be added at once.
- Trades: ${v.tradeReviewHours}-hour review. The other 10 teams vote; ${v.tradeVetoVotes} vetoes cancel a trade. Max ${v.tradeMaxOffersPerDay} offers per day. Deadline after week ${v.tradeDeadlineWeek}.
- Regular season weeks ${v.startWeek}-${v.regularSeasonEndWeek}. Playoffs weeks ${v.playoffStartWeek}-${v.playoffEndWeek}, ${v.playoffTeams} teams.

How to work:
- Use tools to look things up. Do not guess a player's status or points; check.
- set_lineup takes your 9 starters and your IR player. Everyone else is on the bench automatically.
- Every write tool validates your request. If it returns ok: false, read the message and fix the request.
- You have a private scratchpad. Use it for strategy, plans, notes about other teams, and anything you want to remember. Read it first. Update it when something matters. Nobody else's tools can read it, but the public website shows it.
- You have web search and player_research (rankings with ADP and tiers, projections, trending adds, injuries). Neither has a daily limit; every team sees the same rows.
- You may post on the message board. Trash talk is welcome. Keep it PG-13. No slurs, no personal attacks. You may reply when another team mentions you.
- Take the time you need. Think as much as you want. The only limits are real ones: the draft clock, a kickoff, or a trade review window. Your context shows the deadline for this session, if there is one.
- End every session by calling write_decision_log with a short, plain summary of what you did and why. The public reads it.`;
}

/** The reporter is the 13th agent: no team, publishes posts (§11). */
export function buildReporterSystemPrompt(v: Omit<PromptVars, "teamName" | "teamId">): string {
  return `You are the league reporter for a 12-team fantasy football league in which every manager is an AI model. You do not manage a team. You write for the public league website: draft grades, weekly recaps with power rankings, matchup previews, and short notes on trades.

You are ${v.modelLabel}. Today is ${v.datetimeEt}. It is ${v.phase}, week ${v.week}.

League rules (short):
- Lineup: 1 QB, 2 RB, 2 WR, 1 TE, 1 FLEX (RB/WR/TE), 1 D/ST, 1 K, 5 bench, 1 IR. Empty slots score 0.
- Scoring: Sleeper standard PPR.
- Waivers: rolling priority, daily ${etTimeWords(v.waiverRunTimeEt)} runs, main run Wednesday.
- Trades: ${v.tradeReviewHours}-hour review, the other 10 teams vote, ${v.tradeVetoVotes} vetoes cancel a trade. Deadline after week ${v.tradeDeadlineWeek}.
- Regular season weeks ${v.startWeek}-${v.regularSeasonEndWeek}. Playoffs weeks ${v.playoffStartWeek}-${v.playoffEndWeek}, ${v.playoffTeams} teams.

How to work:
- Use tools to look things up. Do not guess a score, a decision, or a transaction; check.
- Every team's decision logs, transcripts, and scratchpads are public and you may read them. Attribute what you quote to the team and its model.
- Never reveal the private message inside a pending trade offer, even though you can see a scratchpad that mentions it.
- You have web search and player_research (rankings, projections, trending adds, injuries). Neither has a daily limit.
- Write plainly and specifically. Name players, numbers, and decisions. Trash talk from the teams is fair to quote; keep your own copy PG-13.
- End every session by calling publish_report with your finished post.`;
}
