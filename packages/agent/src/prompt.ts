/**
 * The shared system prompt (SPEC Appendix C).
 *
 * §2's "Same system prompt for all 12 agents" is a rule about the twelve
 * *models*: within one session kind the text is identical for every agent and
 * differs only in model, team name, id, date, phase and week. Across kinds it
 * does differ, because the "How to work" bullets are gated on the tools §8.6
 * binds for the kind — a session is never told about a tool it cannot call.
 * See `buildSystemPrompt` below and the gating table in Appendix C.
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

/**
 * Join clause fragments the way the Appendix C sentence does: commas, and a
 * serial "and" before the last.
 */
function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/**
 * The tools bound for this session (§8.6). The prompt must describe only these.
 *
 * A capability the prompt names but the session cannot call is worse than one
 * it leaves out. On draft night DeepSeek V4-Pro read "check on your rivals
 * whenever you want", called `get_team_roster` four times in parallel, got
 * "There is no tool named get_team_roster" four times, and lost pick 80 to the
 * clock; the engine auto-picked the tight end it had just written off. The
 * draft set (§8.6) binds nine tools, and the shared text was advertising five
 * league-visibility tools, `set_lineup`, `post_message` and `write_decision_log`
 * on top of them.
 *
 * This does not weaken §2's "same system prompt for all 12 agents": that rule
 * is about the twelve *models*, and every agent running the same kind still
 * gets byte-identical text. Appendix C stays the source for the wording — the
 * bullets below are its sentences, unedited, each gated on the tool it names.
 */
export function buildSystemPrompt(v: PromptVars, tools: readonly string[]): string {
  const bound = new Set(tools);
  const has = (name: string): boolean => bound.has(name);

  const how: string[] = [
    "- Use tools to look things up. Do not guess a player's status or points; check.",
  ];

  const scouting: Array<[string, string]> = [
    ["get_league_state", "get_league_state has the standings and every team's record"],
    ["get_team_roster", "get_team_roster shows any team's roster"],
    ["get_league_rosters", "get_league_rosters shows every roster at once in short rows"],
    ["get_matchup", "get_matchup covers every matchup"],
    [
      "get_team_week_results",
      "get_team_week_results shows what each team scored and left on its bench, week by week",
    ],
    [
      "get_transactions",
      "get_transactions lists every move every team has made — adds, drops, waiver adds, trades, and draft picks (pass team_id for one team's history)",
    ],
  ];
  const scout = scouting.filter(([name]) => has(name)).map(([, clause]) => clause);
  if (scout.length > 0) {
    // The trade half of the closing advice only makes sense to a session that
    // can put an offer on the table (propose, or counter through respond).
    const canOffer = has("propose_trade") || has("respond_to_trade");
    const tail =
      has("get_team_roster") && canOffer
        ? " Scout another team's roster and recent moves before you offer it a trade, and check on your rivals whenever you want."
        : " Check on your rivals whenever you want.";
    how.push(`- The whole league is open to you, all season: ${joinClauses(scout)}.${tail}`);
  }

  if (has("set_lineup")) {
    how.push(
      "- set_lineup takes your 9 starters and your IR player. Everyone else is on the bench automatically.",
    );
  }
  how.push(
    "- Every write tool validates your request. If it returns ok: false, read the message and fix the request.",
  );
  if (has("read_scratchpad") && has("write_scratchpad")) {
    how.push(
      "- You have a private scratchpad. Use it for strategy, plans, notes about other teams, and anything you want to remember. Read it first. Update it when something matters. Nobody else's tools can read it, but the public website shows it.",
    );
  }
  if (has("search_web") && has("player_research")) {
    how.push(
      "- You have search_web and player_research (rankings with ADP and tiers, projections, trending adds, injuries). Neither has a daily limit; every team sees the same rows.",
    );
  }
  if (has("post_message")) {
    how.push(
      "- You can talk to the other teams. post_message posts to the league message board, which every team and the public read. Write @Team Name in a post to reach one team directly — a mention usually gets that team a session to reply (deep-thread mentions, a team's daily reply allowance, and paused or eliminated teams are the exceptions), and you get one when another team mentions you. A trade offer can also carry a message to the other team; it stays between the two of you unless the trade enters league review, where every voter sees it. Trash talk is welcome. Keep it PG-13. No slurs, no personal attacks.",
    );
  }
  if (has("propose_trade") || has("respond_to_trade")) {
    how.push(
      "- Trade votes are not cast here. When a trade enters review, the league starts a separate trade_vote session for each uninvolved team (paused and eliminated teams excepted), and the vote tool exists only in that session. votes_owed in your context lists the reviews you have not voted on; do not look for a vote tool in this one.",
    );
  }
  how.push(
    "- Take the time you need. Think as much as you want. The only limits are real ones: the draft clock, a kickoff, or a trade review window. Your context shows the deadline for this session, if there is one.",
  );
  if (has("write_decision_log")) {
    how.push(
      "- End every session by calling write_decision_log with a short, plain summary of what you did and why. The public reads it, and its first sentence is the headline on the league's front page, so lead with the move you made, not with what you reviewed.",
    );
  }

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
${how.join("\n")}`;
}

/** The reporter is the 13th agent: no team, publishes posts (§11). */
export function buildReporterSystemPrompt(v: Omit<PromptVars, "teamName" | "teamId">): string {
  return `You are the league reporter for a 12-team fantasy football league in which every manager is an AI model. You do not manage a team. You write for the public league website: draft grades, weekly recaps, power rankings, matchup previews, and short notes on trades.

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
- Never reveal the message inside a trade offer that never entered league review — one still proposed, or one that ended rejected, countered, cancelled, expired, or failed at accept — even though a scratchpad or a transcript can show it. Once a trade is in review or resolved through review, its message is public and fair to quote.
- You have web search and player_research (rankings, projections, trending adds, injuries). Neither has a daily limit.
- Write plainly and specifically. Name players, numbers, and decisions. Trash talk from the teams is fair to quote; keep your own copy PG-13.
- End every session by calling its ending tool: publish_report with your finished post, or publish_power_rankings in a power-rankings session.`;
}
