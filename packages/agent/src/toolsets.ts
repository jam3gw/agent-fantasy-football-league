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

/**
 * Index every tool by name, refusing duplicates.
 *
 * A `Map` built from entries keeps the *last* of any repeated key, so a second
 * tool defined with a name the read table already uses silently replaced it
 * for every session kind, team kinds included. That is exactly what happened
 * to `get_team_week_results`: the reporter's thinner copy — no paging, so no
 * §8.2 character cap, and no `model` or `lineup_efficiency` — was what all
 * twelve agents actually got. Throwing here makes the next one a failed build
 * instead of a quiet substitution.
 */
function indexByName(tools: LeagueTool[]): Map<string, LeagueTool> {
  const index = new Map<string, LeagueTool>();
  for (const t of tools) {
    if (index.has(t.name)) throw new Error(`two tools are defined with the name ${t.name}`);
    index.set(t.name, t);
  }
  return index;
}

function byName(tools: LeagueTool[], names: string[]): LeagueTool[] {
  const index = indexByName(tools);
  const out: LeagueTool[] = [];
  for (const n of names) {
    const t = index.get(n);
    if (!t) throw new Error(`tool set references an unknown tool: ${n}`);
    out.push(t);
  }
  return out;
}

const ALL = [...READ_TOOLS, ...WRITE_TOOLS, ...DRAFT_TOOLS, ...REPORTER_TOOLS];

/** "Read tools" in §8.6 means the whole first table, web search and player research included. */
const READ = READ_TOOLS.map((t) => t.name);
const SCRATCHPAD = ["read_scratchpad", "write_scratchpad"];
const LOG = ["write_decision_log"];
/**
 * §8.10: the kinds that may book a check-in. Every team kind that has room to
 * think ahead — not `draft_pick` (180 seconds and one job), not `smoke` (it is
 * a smoke test), and not `self_check_in` itself, which is the chaining guard
 * the engine also enforces.
 */
const CHECK_IN = ["schedule_check_in", "cancel_check_in", "list_check_ins"];

/** Read tools minus the scratchpad reader, which the scratchpad group re-adds. */
const READ_ONLY_NO_PAD = READ.filter((n) => n !== "read_scratchpad");

/** The tool set for each session kind. Exported so tests can walk every kind. */
export const SETS: Record<SessionKind, string[]> = {
  onboarding: [
    ...READ_ONLY_NO_PAD,
    ...CHECK_IN,
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
    "player_research",
    ...SCRATCHPAD,
    "make_pick",
  ],
  weekly_review: [
    ...READ_ONLY_NO_PAD,
    ...CHECK_IN,
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
    ...CHECK_IN,
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
    ...CHECK_IN,
    "set_lineup",
    "add_free_agent",
    "drop_player",
    ...SCRATCHPAD,
    ...LOG,
  ],
  injury_response: [
    ...READ_ONLY_NO_PAD,
    ...CHECK_IN,
    "set_lineup",
    "add_free_agent",
    "drop_player",
    "submit_waiver_claims",
    ...SCRATCHPAD,
    ...LOG,
  ],
  board_reply: ["read_board", "get_league_state", "get_team_roster", "post_message", ...LOG],
  /**
   * §8.10. A check-in exists to answer the question the agent left itself and
   * act on the answer, so it can do anything time-sensitive: the lineup, the
   * wire, a trade waiting on a reply. It cannot *propose* a trade or post to
   * the board — those have their own windows and their own limits — and it
   * cannot book another check-in, so it can never become a way to run a
   * second weekly review or to keep going past the ceiling.
   */
  self_check_in: [
    ...READ_ONLY_NO_PAD,
    "list_check_ins",
    "cancel_check_in",
    "set_lineup",
    "add_free_agent",
    "drop_player",
    "submit_waiver_claims",
    "cancel_waiver_claims",
    "respond_to_trade",
    ...SCRATCHPAD,
    ...LOG,
  ],
  // The commissioner's free-objective session: every team tool except voting
  // and naming, which belong to their own kinds (§8.6).
  manual: [
    ...READ_ONLY_NO_PAD,
    ...WRITE_TOOLS.map((t) => t.name).filter((n) => n !== "vote_on_trade" && n !== "set_team_name"),
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
  // A kind can name the same tool twice (a group plus an explicit entry);
  // de-duplicate, preserving order.
  return byName(ALL, [...new Set(names)]);
}

export { READ_TOOLS, WRITE_TOOLS, DRAFT_TOOLS, REPORTER_TOOLS };
