/**
 * Turning a flat `session_events` list into the shape the redesigned
 * transcript reads as: one step per assistant turn, with the tool calls that
 * step made nested inside it (SPEC §12.1 — the same events, nothing added and
 * nothing dropped).
 *
 * Everything here is a pure function over serialisable events, for the same
 * reason `components/transcript.tsx` is: the static page is a server
 * component and the live view is a client one, and a step must look identical
 * whether it arrived through the database or through the live poll.
 *
 * Nothing here reads the database. A player's name, a roster size, a
 * transaction — all of it is recovered from what the tools already returned
 * into the transcript, so the live view can derive exactly what the finished
 * page does without a second round trip.
 */
import { assistantReasoning, type TranscriptEvent } from "@/components/transcript";

/* -------------------------------------------------------------------------- */
/* Reading event content safely                                               */
/* -------------------------------------------------------------------------- */

/**
 * Event content is `Record<string, unknown>` off the wire and genuinely
 * unknown — an event written by an older runner may be missing any field, and
 * a tool result is whatever that tool returned. Every read goes through these
 * so a shape that does not match renders as "unknown" instead of throwing in
 * a server component.
 */
export function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Every object in a list, dropping anything that is not one. */
export function objects(value: unknown): Record<string, unknown>[] {
  return arr(value).flatMap((v) => {
    const o = obj(v);
    return o ? [o] : [];
  });
}

/** The `items` page of a paged tool result (`pageRows` in the agent package). */
export function items(result: unknown): Record<string, unknown>[] {
  const r = obj(result);
  return r ? objects(r.items) : [];
}

/* -------------------------------------------------------------------------- */
/* Steps                                                                      */
/* -------------------------------------------------------------------------- */

export interface StepToolCall {
  /** `tool_call_id` when the runner recorded one; the seq otherwise. */
  key: string;
  name: string;
  args: unknown;
  /** The tool's return value, or null while the call is still in flight. */
  result: unknown;
  /** True when the tool refused the call — a failure result or a bad schema. */
  failed: boolean;
  /** §8.8: whether this call counted against the invalid-call guard. */
  invalid: boolean;
  createdAt: string | Date | null;
}

export interface Step {
  /** 1-based position in the rail. The brief is step 1. */
  n: number;
  /** The lowest seq in the step, which is what the anchor id is built from. */
  seq: number;
  kind: "brief" | "turn";
  /** The assistant's visible text for this turn. */
  text: string | null;
  /** Extracted reasoning, when the provider returned any (§8.1: never asked for). */
  reasoning: string | null;
  costUsd: number | null;
  usage: unknown;
  calls: StepToolCall[];
  /** Everything in the step that is not an assistant message or a tool call. */
  notes: TranscriptEvent[];
  /** The brief step only: the system prompt, the brief and the snapshot. */
  brief: { prompt: unknown; brief: unknown; snapshot: unknown } | null;
  createdAt: string | Date | null;
  /** The events this step was built from, in order, for the raw view. */
  events: TranscriptEvent[];
}

const ANCHOR = "step";

export function stepAnchor(step: Step): string {
  return `${ANCHOR}-${step.n}`;
}

/**
 * The step's thinking log, or null when the provider returned none.
 *
 * `assistantReasoning` is the single reader — the runner records reasoning
 * first-class on the assistant event, and falls back to the reasoning parts
 * inside the raw assistant message for events written before it did. This
 * only turns its "nothing" into a null, which is what the rest of this file
 * uses for an absent value. §8.1 is unaffected either way: reasoning is never
 * asked for, only shown when a provider returns it.
 */
export function reasoningOf(content: Record<string, unknown>): string | null {
  const reasoning = assistantReasoning(content);
  return reasoning === "" ? null : reasoning;
}

/** A tool result the tools' own failure shape marks as refused (`ok: false`). */
function isFailure(result: unknown): boolean {
  const r = obj(result);
  return r !== null && r.ok === false;
}

function emptyStep(n: number, seq: number, kind: Step["kind"], createdAt: string | Date | null): Step {
  return {
    n,
    seq,
    kind,
    text: null,
    reasoning: null,
    costUsd: null,
    usage: null,
    calls: [],
    notes: [],
    brief: null,
    createdAt,
    events: [],
  };
}

/**
 * Group the transcript into steps.
 *
 * The system prompt, the brief and the context snapshot open the session as
 * step 1. After that a step is one assistant turn plus the tool calls it made:
 * an `assistant` event opens a new step, and the `tool_call` / `tool_result`
 * pairs that follow belong to it, which is exactly the order the runner
 * writes them in. Nudges (§8.8) are `user` events mid-session and stay with
 * the step they interrupted rather than opening one, because the reader is
 * following the agent's turns, not the loop's messages.
 *
 * A result without its call — a transcript that starts mid-session, an event
 * the live poll has not caught up to — still shows: the call is created from
 * the result so nothing silently disappears.
 */
export function groupSteps(events: TranscriptEvent[]): Step[] {
  const steps: Step[] = [];
  let current: Step | null = null;
  const byCallId = new Map<string, StepToolCall>();

  const open = (kind: Step["kind"], e: TranscriptEvent): Step => {
    const step = emptyStep(steps.length + 1, e.seq, kind, e.createdAt);
    steps.push(step);
    return step;
  };

  for (const e of events) {
    const content = e.content ?? {};

    // The opening `user` event carries the brief and the snapshot, so it joins
    // the step the system prompt opened. Once a turn has started, a `user`
    // event is a §8.8 nudge instead and belongs to the turn it interrupted.
    if (e.type === "system" || (e.type === "user" && (current === null || current.kind === "brief"))) {
      const step = current?.kind === "brief" ? current : (current = open("brief", e));
      const existing = step.brief ?? { prompt: null, brief: null, snapshot: null };
      step.brief = {
        prompt: e.type === "system" ? (content.prompt ?? content) : existing.prompt,
        brief: e.type === "user" ? (content.brief ?? null) : existing.brief,
        snapshot: e.type === "user" ? (content.snapshot ?? null) : existing.snapshot,
      };
      step.events.push(e);
      continue;
    }

    if (e.type === "assistant") {
      const step = (current = open("turn", e));
      step.text = str(content.text);
      step.reasoning = reasoningOf(content);
      step.costUsd = num(content.cost_usd);
      step.usage = content.usage ?? null;
      step.events.push(e);
      // The calls this turn announced, so a call that has been made but whose
      // result has not landed yet still renders (the live view's common case).
      for (const c of arr(content.tool_calls)) {
        const o = obj(c);
        const name = o ? str(o.name) : null;
        if (!o || !name) continue;
        const key = str(o.id) ?? `${e.seq}-${step.calls.length}`;
        const call: StepToolCall = {
          key,
          name,
          args: o.args ?? null,
          result: null,
          failed: false,
          invalid: false,
          createdAt: e.createdAt,
        };
        step.calls.push(call);
        byCallId.set(key, call);
      }
      continue;
    }

    if (e.type === "tool_call" || e.type === "tool_result") {
      const step = current ?? (current = open("turn", e));
      const name = str(content.name);
      const id = str(content.tool_call_id);
      const known = id ? byCallId.get(id) : undefined;
      const call =
        known ??
        (() => {
          const made: StepToolCall = {
            key: id ?? `${e.seq}`,
            name: name ?? "tool",
            args: null,
            result: null,
            failed: false,
            invalid: false,
            createdAt: e.createdAt,
          };
          step.calls.push(made);
          if (id) byCallId.set(id, made);
          return made;
        })();

      if (e.type === "tool_call") {
        call.args = content.args ?? call.args;
        if (name) call.name = name;
      } else {
        call.result = content.result ?? null;
        call.failed = isFailure(call.result);
        call.invalid = content.invalid === true;
        if (name) call.name = name;
      }
      step.events.push(e);
      continue;
    }

    // error, info, and the mid-session nudges: they belong to the step that
    // was running. A transcript that opens with one — a resumed session writes
    // `info {resumed}` before the prompt (§9.2) — opens the brief step, so the
    // note sits with the prompt it preceded instead of becoming a nameless
    // step 1 above it.
    const step = current ?? (current = open(steps.length === 0 ? "brief" : "turn", e));
    step.notes.push(e);
    step.events.push(e);
  }

  return steps;
}

/* -------------------------------------------------------------------------- */
/* Naming a step                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What each tool is doing, in the words a reader following the league would
 * use. A tool with no entry falls back to its own name, which is why an
 * unmapped or brand new tool still reads sensibly in the rail.
 */
const TOOL_VERB: Record<string, string> = {
  get_league_state: "Checked the league",
  get_my_team: "Checked the roster",
  get_team_roster: "Checked a rival roster",
  get_league_rosters: "Scouted every roster",
  get_matchup: "Looked at the matchup",
  get_team_week_results: "Read the week's results",
  get_player_stats: "Compared players",
  search_players: "Searched for players",
  get_free_agents: "Scanned free agents",
  get_available_players: "Scanned the draft pool",
  get_nfl_schedule: "Checked the NFL schedule",
  get_transactions: "Read recent transactions",
  get_waiver_claims: "Checked waiver claims",
  get_pending_trades: "Checked pending trades",
  get_trade: "Read a trade offer",
  read_board: "Read the board",
  read_scratchpad: "Read its notes",
  web_search: "Searched the web",
  player_research: "Researched a player",
  get_draft_state: "Checked the draft board",
  set_team_name: "Named the team",
  set_lineup: "Set the lineup",
  submit_waiver_claims: "Submitted waiver claims",
  cancel_waiver_claims: "Cancelled waiver claims",
  add_free_agent: "Added a free agent",
  drop_player: "Dropped a player",
  propose_trade: "Proposed a trade",
  respond_to_trade: "Answered a trade offer",
  cancel_trade: "Cancelled a trade",
  vote_on_trade: "Voted on a trade",
  post_message: "Posted to the board",
  write_scratchpad: "Updated its notes",
  write_decision_log: "Wrote the decision log",
  schedule_check_in: "Booked a check-in",
  cancel_check_in: "Cancelled a check-in",
  list_check_ins: "Listed its check-ins",
  make_pick: "Made the pick",
  get_decision_logs: "Read the decision logs",
  get_team_scratchpad: "Read a team's notes",
  list_sessions: "Listed sessions",
  get_session_transcript: "Read a transcript",
  get_power_rankings: "Read the power rankings",
  publish_report: "Published the report",
  publish_power_rankings: "Published the power rankings",
};

/** The write tools: the ones that change the league, marked as such (§8.4). */
const WRITE_TOOLS = new Set([
  "set_team_name",
  "set_lineup",
  "submit_waiver_claims",
  "cancel_waiver_claims",
  "add_free_agent",
  "drop_player",
  "propose_trade",
  "respond_to_trade",
  "cancel_trade",
  "vote_on_trade",
  "post_message",
  "make_pick",
  "publish_report",
  "publish_power_rankings",
]);

export function isWriteStep(step: Step): boolean {
  return step.calls.some((c) => WRITE_TOOLS.has(c.name));
}

/** The step that ends the session, which the rail marks as the decision. */
export function isDecisionStep(step: Step): boolean {
  return step.calls.some((c) => c.name === "write_decision_log" || c.name === "make_pick");
}

/**
 * A short title for the step. A turn is named after what it did — its write
 * tool if it made one, otherwise its first read — because "Added a free agent"
 * is what a reader is scanning the rail for, not "step 5".
 */
export function stepTitle(step: Step): string {
  if (step.kind === "brief") return "Read the brief";
  const write = step.calls.find((c) => WRITE_TOOLS.has(c.name));
  const lead = write ?? step.calls[0];
  if (!lead) return step.text ? "Thought it through" : "Model step";
  const verb = TOOL_VERB[lead.name] ?? lead.name.replace(/_/g, " ");
  if (step.calls.length > 1) {
    const others = step.calls.length - 1;
    return `${verb} +${others} more`;
  }
  return verb;
}

/** The mono tool label under the rail row: the tools this step called. */
export function stepToolLabel(step: Step): string | null {
  if (step.kind === "brief") return "context snapshot";
  const names = [...new Set(step.calls.map((c) => c.name))];
  if (names.length === 0) return null;
  return names.length <= 2 ? names.join(", ") : `${names[0]} +${names.length - 1}`;
}

/**
 * The one-line summary beside the step title — "returned 15 players" — so a
 * collapsed step still says what happened. Purpose-built per tool where the
 * result has an obvious count, generic where it does not.
 */
export function callSummary(call: StepToolCall): string | null {
  if (call.result === null) return "running…";
  if (call.failed) {
    const r = obj(call.result);
    return str(r?.error) ?? str(r?.code) ?? "refused";
  }
  const r = obj(call.result);
  if (!r) return null;

  switch (call.name) {
    case "get_my_team":
    case "get_team_roster": {
      const players = arr(r.players).length;
      const empty = arr(r.empty_starting_slots).length;
      const max = num(r.max_active);
      const active = num(r.active_players);
      const size = active !== null && max !== null ? `${active} of ${max} active` : `${players} players`;
      return empty > 0 ? `${size}, ${empty} slot${empty === 1 ? "" : "s"} empty` : size;
    }
    case "get_league_rosters": {
      const teams = items(r).length;
      const total = num(r.total);
      return total !== null && total > teams ? `${teams} of ${total} teams` : `${teams} teams`;
    }
    case "get_free_agents":
    case "get_available_players": {
      const shown = items(r).length;
      const total = num(r.total);
      const pos = str(r.position);
      const scope = pos && pos !== "ALL" ? ` ${pos}` : "";
      return total !== null && total > shown
        ? `${shown} of ${total}${scope} available`
        : `${shown}${scope} available`;
    }
    case "get_player_stats": {
      const rows = items(r);
      const names = rows.map((p) => str(p.name)).filter((n): n is string => n !== null);
      return names.length > 0 && names.length <= 3 ? names.join(", ") : `${rows.length} players`;
    }
    case "add_free_agent": {
      const dropped = str(r.dropped_player_id);
      return dropped ? "one in, one out" : "added";
    }
    case "write_decision_log":
      return "session ended";
    case "make_pick":
      return "pick made";
    default: {
      const rows = items(r);
      if (rows.length > 0) return `${rows.length} result${rows.length === 1 ? "" : "s"}`;
      return null;
    }
  }
}

export function stepSummary(step: Step): string | null {
  if (step.kind === "brief") return "the prompt, the brief and the context snapshot";
  const summaries = step.calls.map(callSummary).filter((s): s is string => s !== null);
  if (summaries.length > 0) return summaries.join(" · ");
  if (step.text) return firstSentence(step.text);
  return null;
}

const MAX_SENTENCE_CHARS = 90;

export function firstSentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const stop = trimmed.search(/[.!?](\s|$)/);
  const sentence = stop === -1 ? trimmed : trimmed.slice(0, stop + 1);
  return sentence.length > MAX_SENTENCE_CHARS ? `${sentence.slice(0, MAX_SENTENCE_CHARS - 1)}…` : sentence;
}

/* -------------------------------------------------------------------------- */
/* Players named anywhere in the transcript                                   */
/* -------------------------------------------------------------------------- */

export interface KnownPlayer {
  playerId: string;
  name: string;
  position: string | null;
  nflTeam: string | null;
  byeWeek: number | null;
}

/**
 * Every player the transcript has already named, indexed by id.
 *
 * The write tools answer in ids — `add_free_agent` returns
 * `added_player_id` and nothing else — so a swap card built from that alone
 * would read "added 11646, dropped 10222". The names are already in the
 * transcript, in the roster and free-agent results the agent read before
 * deciding, and this recovers them from there. That keeps the renderers
 * working identically in the live view, which has no database access.
 */
export function playerIndex(events: TranscriptEvent[]): Map<string, KnownPlayer> {
  const index = new Map<string, KnownPlayer>();

  const learn = (value: unknown): void => {
    const o = obj(value);
    if (!o) return;
    const id = str(o.player_id);
    const name = str(o.name);
    if (id && name) {
      const existing = index.get(id);
      index.set(id, {
        playerId: id,
        name,
        position: str(o.position) ?? existing?.position ?? null,
        nflTeam: str(o.nfl_team) ?? existing?.nflTeam ?? null,
        byeWeek: num(o.bye_week) ?? existing?.byeWeek ?? null,
      });
    }
    // Tool results nest players a level or two down — `players`, `items`,
    // `lineup`, `roster` — so walk rather than guess at each tool's shape.
    for (const v of Object.values(o)) {
      if (Array.isArray(v)) v.forEach(learn);
      else if (typeof v === "object" && v !== null) learn(v);
    }
  };

  for (const e of events) {
    if (e.type !== "tool_result") continue;
    learn(e.content.result);
  }
  return index;
}

export function playerLabel(id: string | null, index: Map<string, KnownPlayer>): string {
  if (!id) return "—";
  return index.get(id)?.name ?? id;
}

/* -------------------------------------------------------------------------- */
/* What the agent did                                                         */
/* -------------------------------------------------------------------------- */

export interface OutcomeMove {
  /** "Added", "Dropped", "Claimed" — the verb the banner leads with. */
  verb: string;
  playerId: string | null;
  tone: "add" | "drop" | "neutral";
}

export interface Outcome {
  /** The moves this session made, in the order it made them. */
  moves: OutcomeMove[];
  /** The decision log the agent wrote, which is its own account of why. */
  log: string | null;
  /** The step to jump to: the write, or the decision log when there was none. */
  anchorStep: number | null;
  /** True when the session finished having changed nothing. */
  readOnly: boolean;
}

/**
 * What the session actually decided, in the agent's own words where it left
 * any. Read off the write tools it called and the decision log it ended with —
 * nothing is inferred that the transcript does not already say.
 */
export function outcomeOf(steps: Step[]): Outcome {
  const moves: OutcomeMove[] = [];
  let log: string | null = null;
  let anchorStep: number | null = null;

  for (const step of steps) {
    for (const call of step.calls) {
      if (call.failed) continue;
      const args = obj(call.args) ?? {};
      const result = obj(call.result) ?? {};
      switch (call.name) {
        case "add_free_agent": {
          moves.push({
            verb: "Added",
            playerId: str(result.added_player_id) ?? str(args.add_player_id),
            tone: "add",
          });
          const dropped = str(result.dropped_player_id) ?? str(args.drop_player_id);
          if (dropped) moves.push({ verb: "Dropped", playerId: dropped, tone: "drop" });
          anchorStep = step.n;
          break;
        }
        case "drop_player": {
          moves.push({
            verb: "Dropped",
            playerId: str(result.dropped_player_id) ?? str(args.player_id),
            tone: "drop",
          });
          anchorStep = step.n;
          break;
        }
        case "make_pick": {
          moves.push({ verb: "Drafted", playerId: str(args.player_id), tone: "add" });
          anchorStep = step.n;
          // A draft pick's reason is its decision log (§8.6) — that kind of
          // session never calls `write_decision_log`.
          if (log === null) log = str(args.reason);
          break;
        }
        case "set_lineup": {
          moves.push({ verb: "Set the lineup", playerId: null, tone: "neutral" });
          anchorStep = step.n;
          break;
        }
        case "submit_waiver_claims": {
          const claims = arr(args.claims).length;
          moves.push({
            verb: claims > 0 ? `Submitted ${claims} waiver claim${claims === 1 ? "" : "s"}` : "Submitted waiver claims",
            playerId: null,
            tone: "neutral",
          });
          anchorStep = step.n;
          break;
        }
        case "propose_trade": {
          moves.push({ verb: "Proposed a trade", playerId: null, tone: "neutral" });
          anchorStep = step.n;
          break;
        }
        case "post_message": {
          moves.push({ verb: "Posted to the board", playerId: null, tone: "neutral" });
          anchorStep = step.n;
          break;
        }
        case "write_decision_log": {
          log = str(args.summary);
          if (anchorStep === null) anchorStep = step.n;
          break;
        }
        default:
          break;
      }
    }
  }

  return { moves, log, anchorStep, readOnly: moves.length === 0 };
}

/* -------------------------------------------------------------------------- */
/* Header facts                                                               */
/* -------------------------------------------------------------------------- */

/** "1m 52s" — the shape the header shows a session's length in. */
export function formatDuration(startedAt: unknown, endedAt: unknown): string | null {
  const start = toDate(startedAt);
  const end = toDate(endedAt);
  if (!start || !end) return null;
  const seconds = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  return formatSeconds(seconds);
}

export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string" || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "188k", "1.9k", "940" — token counts at a glance, exact value in the title. */
export function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
