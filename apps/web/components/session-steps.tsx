/**
 * The redesigned session transcript (SPEC §12.1), rendered as steps.
 *
 * The old page was eighteen flat events, each one a row of badges over a
 * collapsed blob of JSON: everything the spec asks for and none of what a
 * reader came for. This says what the agent decided first, then lets anyone
 * walk the steps that got there — one card per assistant turn with its tool
 * calls nested inside, collapsed by default, the raw arguments and result
 * always one disclosure away.
 *
 * Purpose-built renderers cover the tools a team session actually leans on
 * (roster, free agents, player stats, roster moves, the decision log); every
 * other tool falls back to the same JSON view the page has always had, so a
 * new tool is readable the day it ships and can be given a renderer later.
 *
 * Pure presentation over serialisable props — no hooks, no server-only
 * imports — so the static page and the live view render a step identically
 * (the same rule `components/transcript.tsx` follows).
 */
import Link from "next/link";
import { formatEt } from "@league/shared";
import { formatEtClock } from "@/components/broadcast";
import { Json } from "@/components/transcript";
import {
  type KnownPlayer,
  type Outcome,
  type Step,
  type StepToolCall,
  arr,
  callSummary,
  isDecisionStep,
  isWriteStep,
  items,
  num,
  obj,
  objects,
  playerLabel,
  stepAnchor,
  stepMoney,
  stepSummary,
  stepTitle,
  str,
} from "@/lib/sessionTranscript";

/* -------------------------------------------------------------------------- */
/* Small shared pieces                                                        */
/* -------------------------------------------------------------------------- */

/** The disclosure triangle every collapsible on this page shares. */
function Chevron({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      width="10"
      height="10"
      fill="currentColor"
      className={`shrink-0 transition-transform duration-150 group-open:rotate-90 ${className}`}
    >
      <path d="M4 2l5 4-5 4z" />
    </svg>
  );
}

function Disclosure({
  label,
  children,
  className = "",
  tone = "muted",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  tone?: "muted" | "accent" | "faint";
}) {
  const colour = tone === "accent" ? "text-accent" : tone === "faint" ? "text-faint" : "text-muted";
  return (
    <details className={`group min-w-0 ${className}`}>
      <summary
        className={`flex cursor-pointer list-none items-center gap-1.5 text-[12px] ${colour} hover:text-accent [&::-webkit-details-marker]:hidden`}
      >
        <Chevron />
        {label}
      </summary>
      {children}
    </details>
  );
}

/** The tool's own header line: outcome mark, mono name, one-line summary. */
function ToolHeader({ call }: { call: StepToolCall }) {
  const summary = callSummary(call);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-background-alt px-3 py-2">
      <span
        aria-hidden="true"
        className={`text-[12px] ${call.failed ? "text-danger" : "text-accent"}`}
      >
        {call.result === null ? "…" : call.failed ? "✕" : "✓"}
      </span>
      <span className="font-mono text-[12px] font-medium">{call.name}</span>
      {summary ? <span className="text-[12px] text-muted">{summary}</span> : null}
      {call.invalid ? (
        <span className="rounded bg-[rgba(138,59,48,0.1)] px-1.5 py-0.5 text-[11px] font-medium text-danger">
          invalid
        </span>
      ) : null}
    </div>
  );
}

/** Arguments and result, verbatim — §12.1's requirement, one click away. */
function RawCall({ call, label = "Raw arguments and result" }: { call: StepToolCall; label?: string }) {
  return (
    <Disclosure label={label} tone="faint" className="px-3 py-2">
      {call.args !== null && call.args !== undefined ? <Json value={call.args} /> : null}
      <Json value={call.result} />
    </Disclosure>
  );
}

function ToolPanel({ call, children }: { call: StepToolCall; children?: React.ReactNode }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-[10px] border border-border">
      <ToolHeader call={call} />
      {children}
      <div className="border-t border-border">
        <RawCall call={call} />
      </div>
    </div>
  );
}

/**
 * A refused call is the one case where the raw view is the point: the reason
 * and the hint the tool returned are what explain the next step.
 */
function FailedCall({ call }: { call: StepToolCall }) {
  const r = obj(call.result);
  return (
    <ToolPanel call={call}>
      <div className="px-3 py-2.5">
        <p className="text-[13px] leading-[1.55] text-danger">{str(r?.error) ?? "The tool refused this call."}</p>
        {str(r?.hint) ? <p className="mt-1 text-[12px] leading-[1.5] text-muted">{str(r?.hint)}</p> : null}
      </div>
    </ToolPanel>
  );
}

const PENDING = (
  <div className="px-3 py-2.5 text-[13px] text-muted">
    Waiting for the result<span className="live-dot ml-1 inline-block">…</span>
  </div>
);

/* -------------------------------------------------------------------------- */
/* Purpose-built tool renderers                                               */
/* -------------------------------------------------------------------------- */

/** A cell that keeps numbers aligned the way the rest of the site does. */
function Num({ value, suffix = "" }: { value: number | null; suffix?: string }) {
  return <span className="tabular-nums">{value === null ? "—" : `${value}${suffix}`}</span>;
}

/**
 * `get_my_team` / `get_team_roster`: the roster as a roster — slot, player,
 * team and this week's opponent — instead of fifteen JSON objects. Starters
 * first, in slot order, because that is the shape the agent is reasoning about.
 */
function RosterResult({ call }: { call: StepToolCall }) {
  const r = obj(call.result);
  const players = objects(r?.players);
  if (players.length === 0) return <ToolPanel call={call} />;
  const empty = arr(r?.empty_starting_slots)
    .map((s) => str(s))
    .filter((s): s is string => s !== null);

  return (
    <ToolPanel call={call}>
      <div className="table-scroll">
        <table className="w-full min-w-[30rem] text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.06em] text-faint">
              <th className="whitespace-nowrap px-3 py-2 font-medium">Slot</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">Player</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">Opponent</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Season</th>
            </tr>
          </thead>
          <tbody>
            {players.map((p, i) => {
              const slot = str(p.slot) ?? "BN";
              const bench = slot === "BN" || slot === "IR";
              return (
                <tr key={str(p.player_id) ?? i} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-bold ${
                        bench ? "bg-background-alt text-faint" : "bg-accent-soft text-accent"
                      }`}
                    >
                      {slot}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className="font-medium">{str(p.name) ?? str(p.player_id) ?? "—"}</span>
                    <span className="ml-2 text-[12px] text-muted">
                      {[str(p.position), str(p.nfl_team)].filter(Boolean).join(" · ")}
                    </span>
                    {str(p.injury_status) ? (
                      <span className="ml-2 text-[11px] font-medium text-warn">{str(p.injury_status)}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-muted">
                    {str(p.opponent) ?? (p.on_bye_this_week === true ? "bye" : "—")}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Num value={num(p.season_points)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {empty.length > 0 ? (
        <p className="border-t border-border px-3 py-2 text-[12px] text-warn">
          Empty starting slot{empty.length === 1 ? "" : "s"}: {empty.join(", ")} — an empty slot scores 0.
        </p>
      ) : null}
    </ToolPanel>
  );
}

/**
 * `get_free_agents` / `get_available_players`: who was on the table, with the
 * number the agent sorted by. The pool is long, so it is capped here and the
 * rest stays in the raw result rather than pushing the next step off screen.
 */
const POOL_ROWS_SHOWN = 8;

function PoolResult({ call }: { call: StepToolCall }) {
  const r = obj(call.result);
  const rows = items(r);
  if (rows.length === 0) return <ToolPanel call={call} />;
  const shown = rows.slice(0, POOL_ROWS_SHOWN);
  const draft = call.name === "get_available_players";

  return (
    <ToolPanel call={call}>
      <div className="table-scroll">
        <table className="w-full min-w-[34rem] text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.06em] text-faint">
              <th className="whitespace-nowrap px-3 py-2 font-medium">Player</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">Pos</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">{draft ? "Rank" : "Trending"}</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">
                {draft ? "Last season" : "Season"}
              </th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Proj</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p, i) => (
              <tr key={str(p.player_id) ?? i} className="border-b border-border/60 last:border-0">
                <td className="whitespace-nowrap px-3 py-2">
                  <span className="font-medium">{str(p.name) ?? str(p.player_id) ?? "—"}</span>
                  {p.on_waivers === true ? (
                    <span className="ml-2 text-[11px] font-medium text-warn">on waivers</span>
                  ) : null}
                  {str(p.injury_status) ? (
                    <span className="ml-2 text-[11px] font-medium text-warn">{str(p.injury_status)}</span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-muted">
                  {[str(p.position), str(p.nfl_team)].filter(Boolean).join(" · ")}
                </td>
                <td className="px-3 py-2 text-right">
                  <Num value={draft ? num(p.rank) : num(p.trending_adds)} />
                </td>
                <td className="px-3 py-2 text-right">
                  <Num value={draft ? num(p.last_season_points) : num(p.season_points)} />
                </td>
                <td className="px-3 py-2 text-right">
                  <Num value={num(p.proj_pts_ppr) ?? num(p.proj_points)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown.length || r?.has_more === true ? (
        <p className="border-t border-border px-3 py-2 text-[12px] text-muted">
          Showing {shown.length} of {num(r?.total) ?? rows.length} — the full page is in the raw result.
        </p>
      ) : null}
    </ToolPanel>
  );
}

/**
 * `get_player_stats`: a card per player, because this call is always a
 * comparison — the agent is holding two or three of them side by side, and a
 * table of twenty JSON fields is the one shape that hides that.
 */
function PlayerStatsResult({ call }: { call: StepToolCall }) {
  const rows = items(obj(call.result));
  if (rows.length === 0) return <ToolPanel call={call} />;

  return (
    <ToolPanel call={call}>
      <div className="grid gap-2.5 p-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((p, i) => {
          const ownership = obj(p.ownership);
          const owned = str(ownership?.status) === "rostered";
          const team = str(ownership?.team_name);
          const last = obj(p.last_season);
          const now = obj(p.this_season);
          const next = obj(p.next_opponent);
          return (
            <div key={str(p.player_id) ?? i} className="rounded-[10px] border border-border p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[14px] font-semibold">{str(p.name) ?? "—"}</span>
                <span className="text-[11px] text-muted">
                  {[str(p.position), str(p.nfl_team)].filter(Boolean).join(" · ")}
                </span>
              </div>
              <div className="mt-0.5 text-[11px] text-faint">
                {owned ? `Rostered${team ? ` — ${team}` : ""}` : "Free agent"}
                {str(p.injury_status) ? (
                  <span className="ml-1.5 font-medium text-warn">{str(p.injury_status)}</span>
                ) : null}
              </div>
              <dl className="mt-2.5 flex flex-col gap-1 text-[12px]">
                <div className="flex justify-between gap-2">
                  <dt className="text-muted">{num(last?.season) ?? "Last"} PPR</dt>
                  <dd className="font-medium tabular-nums">
                    <Num value={num(last?.total_pts_ppr)} />
                    <span className="ml-1 text-faint">
                      in {num(last?.games) ?? 0} game{num(last?.games) === 1 ? "" : "s"}
                    </span>
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted">This season</dt>
                  <dd className="font-medium tabular-nums">
                    <Num value={num(now?.total)} />
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted">Next</dt>
                  <dd className="font-medium">{str(next?.opponent) ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted">Bye</dt>
                  <dd className="font-medium tabular-nums">{num(p.bye_week) ?? "—"}</dd>
                </div>
              </dl>
            </div>
          );
        })}
      </div>
    </ToolPanel>
  );
}

/** One half of a roster move: who came in, or who went out. */
function MoveSide({
  id,
  verb,
  tone,
  players,
}: {
  id: string;
  verb: string;
  tone: "add" | "drop";
  players: Map<string, KnownPlayer>;
}) {
  const player = players.get(id);
  const meta = [player?.position, player?.nflTeam, player?.byeWeek ? `bye ${player.byeWeek}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="min-w-0">
      <div
        className={`text-[11px] font-bold uppercase tracking-[0.08em] ${
          tone === "add" ? "text-accent" : "text-warn"
        }`}
      >
        {verb}
      </div>
      <div className="mt-1 text-[15px] font-semibold">{player?.name ?? id}</div>
      <div className="text-[12px] text-muted">{meta === "" ? "—" : meta}</div>
    </div>
  );
}

/**
 * `add_free_agent` and `drop_player`: the move itself, in and out, with the
 * names recovered from earlier in the transcript. This is the thing the whole
 * session was for, so it is the one renderer that says nothing about tooling.
 */
function RosterMoveResult({ call, players }: { call: StepToolCall; players: Map<string, KnownPlayer> }) {
  const r = obj(call.result);
  const args = obj(call.args);
  const addedId = str(r?.added_player_id) ?? str(args?.add_player_id);
  const droppedId = str(r?.dropped_player_id) ?? str(args?.drop_player_id) ?? str(args?.player_id);
  const waiverUntil = str(r?.dropped_waiver_until) ?? str(r?.waiver_until);

  return (
    <ToolPanel call={call}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-3 py-3">
        {addedId ? <MoveSide id={addedId} verb="Added" tone="add" players={players} /> : null}
        {addedId && droppedId ? (
          <span aria-hidden="true" className="text-[18px] text-border-strong">
            ⇄
          </span>
        ) : null}
        {droppedId ? <MoveSide id={droppedId} verb="Dropped" tone="drop" players={players} /> : null}
      </div>
      {waiverUntil ? (
        <p className="border-t border-border px-3 py-2 text-[12px] text-muted">
          The dropped player is on waivers until {formatMaybeEt(waiverUntil)}.
        </p>
      ) : null}
    </ToolPanel>
  );
}

function formatMaybeEt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatEt(d);
}

/**
 * `write_decision_log`: the paragraph the agent wrote for the public, which is
 * the session's own closing statement. It is the argument, so it is set as
 * one — not as a JSON string field.
 */
function DecisionLogResult({ call }: { call: StepToolCall }) {
  const summary = str(obj(call.args)?.summary) ?? str(obj(call.args)?.reason);
  return (
    <ToolPanel call={call}>
      {summary ? (
        <blockquote className="border-l-2 border-accent px-3 py-3 text-[14px] leading-[1.65] text-foreground">
          {summary}
        </blockquote>
      ) : null}
    </ToolPanel>
  );
}

/** Scratchpad and board writes: what was written, as text. */
function TextWriteResult({ call }: { call: StepToolCall }) {
  const args = obj(call.args);
  const body = str(args?.text) ?? str(args?.body) ?? str(args?.content) ?? str(args?.message);
  return (
    <ToolPanel call={call}>
      {body ? (
        <p className="whitespace-pre-wrap px-3 py-3 text-[13px] leading-[1.6] text-foreground">{body}</p>
      ) : null}
    </ToolPanel>
  );
}

function ToolCallView({ call, players }: { call: StepToolCall; players: Map<string, KnownPlayer> }) {
  if (call.result === null) {
    return (
      <div className="min-w-0 overflow-hidden rounded-[10px] border border-border">
        <ToolHeader call={call} />
        {PENDING}
      </div>
    );
  }
  if (call.failed) return <FailedCall call={call} />;

  switch (call.name) {
    case "get_my_team":
    case "get_team_roster":
      return <RosterResult call={call} />;
    case "get_free_agents":
    case "get_available_players":
      return <PoolResult call={call} />;
    case "get_player_stats":
      return <PlayerStatsResult call={call} />;
    case "add_free_agent":
    case "drop_player":
      return <RosterMoveResult call={call} players={players} />;
    case "write_decision_log":
    case "make_pick":
      return <DecisionLogResult call={call} />;
    case "write_scratchpad":
    case "post_message":
      return <TextWriteResult call={call} />;
    default:
      return <ToolPanel call={call} />;
  }
}

/* -------------------------------------------------------------------------- */
/* The step card                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Reasoning, disclosed the way every assistant interface discloses it: a quiet
 * "Thought for a moment" line that opens into the text, closed by default.
 * The label carries the reasoning token count rather than a wall-clock
 * duration, because that is what the transcript actually records — the step's
 * elapsed time is not stored per step.
 */
function Thought({ reasoning, tokens }: { reasoning: string; tokens: number | null }) {
  const label = tokens && tokens > 0 ? `Thought — ${tokens.toLocaleString()} reasoning tokens` : "Thought";
  return (
    <Disclosure label={label}>
      <p className="mt-2 whitespace-pre-wrap border-l-2 border-border pl-3 text-[13px] leading-[1.7] text-muted">
        {reasoning}
      </p>
    </Disclosure>
  );
}

export function StepCard({
  step,
  players,
  defaultOpen = false,
}: {
  step: Step;
  players: Map<string, KnownPlayer>;
  defaultOpen?: boolean;
}) {
  const decision = isDecisionStep(step);
  const write = isWriteStep(step);
  const summary = stepSummary(step);
  const at = step.createdAt ? new Date(step.createdAt) : null;
  const reasoningTokens = num(obj(step.usage)?.reasoningTokens);

  return (
    <details
      id={stepAnchor(step)}
      data-step-card
      data-step-kind={decision ? "decision" : write ? "write" : step.kind}
      open={defaultOpen}
      className={`group/step min-w-0 scroll-mt-24 overflow-hidden rounded-xl border bg-surface ${
        decision ? "border-accent" : "border-border"
      }`}
    >
      <summary
        className={`flex cursor-pointer list-none flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-3 [&::-webkit-details-marker]:hidden ${
          decision ? "bg-accent-soft" : ""
        }`}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          width="10"
          height="10"
          fill="currentColor"
          className={`shrink-0 transition-transform duration-150 group-open/step:rotate-90 ${
            decision ? "text-accent" : "text-faint"
          }`}
        >
          <path d="M4 2l5 4-5 4z" />
        </svg>
        <span className="w-4 shrink-0 text-[11px] tabular-nums text-faint">{step.n}</span>
        <span className={`text-[15px] font-semibold tracking-[-0.01em] ${decision ? "text-accent" : ""}`}>
          {stepTitle(step)}
        </span>
        {summary ? <span className="text-[13px] text-muted">{summary}</span> : null}
        {write ? (
          <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-band-text">
            write
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-2.5 text-[12px] tabular-nums text-faint">
          {step.costUsd !== null ? <span title="cost of this model step">{stepMoney(step.costUsd)}</span> : null}
          {at ? (
            <time dateTime={at.toISOString()} title={formatEt(at)}>
              {formatEtClock(at)}
            </time>
          ) : null}
        </span>
      </summary>

      <div className="flex flex-col gap-3 px-4 pb-4 pt-1 sm:pl-[42px]">
        {step.kind === "brief" && step.brief ? (
          <BriefBody brief={step.brief} />
        ) : null}

        {step.reasoning ? <Thought reasoning={step.reasoning} tokens={reasoningTokens} /> : null}

        {step.text ? (
          <p className="whitespace-pre-wrap text-[14px] leading-[1.7] text-foreground">{step.text}</p>
        ) : null}

        {step.calls.map((call) => (
          <ToolCallView key={call.key} call={call} players={players} />
        ))}

        {step.notes.map((note) => (
          <div
            key={note.seq}
            className={`min-w-0 rounded-[10px] border px-3 py-2 ${
              note.type === "error" ? "border-danger/40" : "border-border"
            }`}
          >
            <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">
              {note.type === "error" ? "Error" : note.type === "user" ? "Nudge" : "Note"}
            </div>
            {str(note.content.text) ? (
              <p className="mt-1 text-[13px] leading-[1.6] text-foreground">{str(note.content.text)}</p>
            ) : (
              <Json value={note.content} />
            )}
          </div>
        ))}

        {step.usage ? (
          <Disclosure label="Usage" tone="faint">
            <Json value={step.usage} />
          </Disclosure>
        ) : null}
      </div>
    </details>
  );
}

function BriefBody({ brief }: { brief: NonNullable<Step["brief"]> }) {
  const text = typeof brief.brief === "string" ? brief.brief : null;
  return (
    <>
      {text ? <p className="text-[14px] leading-[1.7] text-foreground">{text}</p> : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:gap-5">
        {brief.prompt !== null && brief.prompt !== undefined ? (
          <Disclosure label="System prompt" tone="accent" className="flex-1">
            <Json value={brief.prompt} />
          </Disclosure>
        ) : null}
        {brief.snapshot !== null && brief.snapshot !== undefined ? (
          <Disclosure label="Context snapshot" tone="accent" className="flex-1">
            <Json value={brief.snapshot} />
          </Disclosure>
        ) : null}
        {text === null && brief.brief !== null && brief.brief !== undefined ? (
          <Disclosure label="Brief" tone="accent" className="flex-1">
            <Json value={brief.brief} />
          </Disclosure>
        ) : null}
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* The outcome banner                                                         */
/* -------------------------------------------------------------------------- */

export function OutcomeBanner({
  outcome,
  players,
  status,
  teamSlug,
}: {
  outcome: Outcome;
  players: Map<string, KnownPlayer>;
  status: string;
  teamSlug: string | null;
}) {
  const running = status === "running" || status === "queued";
  const headline = outcome.readOnly
    ? running
      ? "Still working — nothing changed yet."
      : "Looked, and changed nothing."
    : outcome.moves
        .map((m, i) => {
          const verb = i === 0 ? m.verb : m.verb.charAt(0).toLowerCase() + m.verb.slice(1);
          return m.playerId ? `${verb} ${playerLabel(m.playerId, players)}` : verb;
        })
        .join(", ")
        .concat(".");

  return (
    <section className="rounded-xl border border-accent/50 bg-accent-soft p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="min-w-0 flex-1 basis-[420px]">
          <div className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.12em] text-accent">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
            What the agent did
          </div>
          <p className="mt-2 text-[19px] font-semibold leading-[1.45] tracking-[-0.015em] text-balance">
            {headline}
          </p>
          {outcome.log ? (
            <p className="mt-2 max-w-[62ch] text-[14px] leading-[1.65] text-muted">{outcome.log}</p>
          ) : null}
          <div className="mt-3.5 flex flex-wrap gap-2">
            {outcome.anchorStep !== null ? (
              <a
                href={`#step-${outcome.anchorStep}`}
                className="inline-flex items-center rounded-md bg-accent px-3 py-1.5 transition-colors hover:bg-accent-hover"
              >
                {/*
                  `globals.css` colours every `a` unlayered, which outranks any
                  Tailwind colour utility on the anchor itself — the label has
                  to carry its own colour or it renders accent-on-accent.
                */}
                <span className="text-[13px] font-medium text-band-text">Jump to the decision</span>
              </a>
            ) : null}
            {teamSlug ? (
              <Link
                href={`/teams/${teamSlug}`}
                className="inline-flex items-center rounded-md border border-accent/40 px-3 py-1.5 text-[13px] font-medium text-accent transition-colors hover:border-accent"
              >
                This team&apos;s sessions
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* The header facts                                                           */
/* -------------------------------------------------------------------------- */

export function Fact({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-bold uppercase tracking-[0.1em] text-faint">{label}</dt>
      <dd className="mt-1 text-[14px] font-semibold tabular-nums">{value}</dd>
      {sub ? <dd className="text-[12px] font-normal text-muted">{sub}</dd> : null}
    </div>
  );
}
