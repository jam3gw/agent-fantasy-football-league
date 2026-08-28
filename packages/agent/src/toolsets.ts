/**
 * Tool sets per session kind (SPEC §8.6). Every model gets the same tools,
 * the same schemas, and the same prompt text (§2) — only the kind changes
 * which tools are on the table.
 */
import type { SessionKind } from "@league/engine";
import type { LeagueTool } from "./tools/types.ts";
import { READ_TOOLS } from "./tools/read.ts";
import { WRITE_TOOLS } from "./tools/write.ts";
import { DRAFT_TOOLS } from "./tools/draft.ts";
import { REPORTER_TOOLS } from "./tools/reporter.ts";

function byName(tools: LeagueTool[], names: string[]): LeagueTool[] {
  const index = new Map(tools.map((t) => [t.name, t]));
  const out: LeagueTool[] = [];
  for (const n of names) {
    const t = index.get(n);
    if (!t) throw new Error(`tool set references an unknown tool: ${n}`);
    out.push(t);
  }
  return out;
}

const ALL = [...READ_TOOLS, ...WRITE_TOOLS, ...DRAFT_TOOLS, ...REPORTER_TOOLS];

/** "Read tools" in §8.6 means the whole first table, web search and FantasyPros included. */
const READ = READ_TOOLS.map((t) => t.name);
const SCRATCHPAD = ["read_scratchpad", "write_scratchpad"];
const LOG = ["write_decision_log"];

/** Read tools minus the scratchpad reader, which the scratchpad group re-adds. */
const READ_ONLY_NO_PAD = READ.filter((n) => n !== "read_scratchpad");

const SETS: Record<SessionKind, string[]> = {
  onboarding: [
    ...READ_ONLY_NO_PAD,
    "get_draft_state",
    "get_available_players",
    "set_team_name",
    ...SCRATCHPAD,
    ...LOG,
  ],
  // draft_pick has no write_decision_log: make_pick's reason is the log (§8.6).
  draft_pick: [
    "get_draft_state",
    "get_available_players",
    "get_player_stats",
    "search_players",
    "web_search",
    "fantasypros_lookup",
    ...SCRATCHPAD,
    "make_pick",
  ],
  weekly_review: [
    ...READ_ONLY_NO_PAD,
    "set_lineup",
    "submit_waiver_claims",
    "cancel_waiver_claims",
    "add_free_agent",
    "drop_player",
    "propose_trade",
    "respond_to_trade",
    "post_message",
    ...SCRATCHPAD,
    ...LOG,
  ],
  post_waivers: [
    ...READ_ONLY_NO_PAD,
    "add_free_agent",
    "drop_player",
    "set_lineup",
    "propose_trade",
    "respond_to_trade",
    "post_message",
    ...SCRATCHPAD,
    ...LOG,
  ],
  trade_window: [
    ...READ_ONLY_NO_PAD,
    "propose_trade",
    "respond_to_trade",
    "cancel_trade",
    "add_free_agent",
    "drop_player",
    "set_lineup",
    "post_message",
    ...SCRATCHPAD,
    ...LOG,
  ],
  trade_response: [...READ_ONLY_NO_PAD, "respond_to_trade", "post_message", ...SCRATCHPAD, ...LOG],
  // Deliberately narrow (§8.6): the voter sees the trade and the rosters only.
  trade_vote: [
    "get_trade",
    "get_team_roster",
    "get_player_stats",
    "get_league_state",
    "vote_on_trade",
    ...LOG,
  ],
  lineup_check: [
    ...READ_ONLY_NO_PAD,
    "set_lineup",
    "add_free_agent",
    "drop_player",
    ...SCRATCHPAD,
    ...LOG,
  ],
  injury_response: [
    ...READ_ONLY_NO_PAD,
    "set_lineup",
    "add_free_agent",
    "drop_player",
    "submit_waiver_claims",
    ...SCRATCHPAD,
    ...LOG,
  ],
  board_reply: ["read_board", "get_league_state", "get_team_roster", "post_message", ...LOG],
  // The commissioner's free-objective session: every team tool except voting
  // and naming, which belong to their own kinds (§8.6).
  manual: [
    ...READ_ONLY_NO_PAD,
    ...WRITE_TOOLS.map((t) => t.name).filter(
      (n) => n !== "vote_on_trade" && n !== "set_team_name" && n !== "read_scratchpad",
    ),
    "read_scratchpad",
  ],
  smoke: ["get_league_state", ...LOG],
  reporter_draft_grades: [...READ_ONLY_NO_PAD, ...REPORTER_TOOLS.map((t) => t.name)],
  reporter_recap: [...READ_ONLY_NO_PAD, ...REPORTER_TOOLS.map((t) => t.name)],
  reporter_preview: [...READ_ONLY_NO_PAD, ...REPORTER_TOOLS.map((t) => t.name)],
  reporter_trade_note: [...READ_ONLY_NO_PAD, ...REPORTER_TOOLS.map((t) => t.name)],
};

/** The tools a session of this kind may call. */
export function toolsForKind(kind: SessionKind): LeagueTool[] {
  const names = SETS[kind];
  if (!names) throw new Error(`no tool set defined for session kind ${kind}`);
  // De-duplicate while preserving order (get_team_week_results appears in both
  // the read table and the reporter table).
  return byName(ALL, [...new Set(names)]);
}

export { READ_TOOLS, WRITE_TOOLS, DRAFT_TOOLS, REPORTER_TOOLS };
