"use client";

import Link from "next/link";
import { useState } from "react";
import { CardLink, Nothing } from "@/components/broadcast";
import { useUrlState } from "@/components/list-controls";
import { EVENTS } from "@/lib/analytics";
import { currentPage, trackEvent } from "@/lib/track";
import { SessionRow, useNow } from "@/components/session-rows";
import { readParam } from "@/lib/listControls";
import {
  ALL,
  KIND_FILTERS,
  KIND_PARAMS,
  REPORTER,
  STATUS_FILTERS,
  STATUS_PARAMS,
  filterSessions,
  groupSessions,
  isLive,
  kindLabel,
  matchStatus,
  statusLabel,
  teamKey,
  teamLabel,
  type SessionListRow,
} from "@/lib/sessionsFilter";

/** Rows a team's card shows before "Show N more", with every team on the page. */
const ROWS_PER_TEAM = 4;
/** The same, once one team is picked and its card is the whole page. */
const ROWS_FOR_ONE_TEAM = 40;

/**
 * The cross-team sessions list: every session that has started, grouped
 * under its team, each row led by what the agent decided rather than a
 * numeric id. The rows arrive already fetched from the server page (queued
 * sessions are left out there); the three filters are URL state
 * applied over that page of rows, which is the right size for a league that
 * runs hundreds of sessions a week, not millions.
 */
export function SessionsList({
  rows,
  teams,
  reporterModel,
}: {
  rows: SessionListRow[];
  teams: Array<{ slug: string; label: string; model: string | null }>;
  reporterModel: string;
}) {
  const url = useUrlState();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const now = useNow();

  const team = readParam(url.get("team"), [...teams.map((t) => t.slug), REPORTER]);
  const status = readParam(url.get("status"), STATUS_PARAMS);
  const kind = readParam(url.get("kind"), KIND_PARAMS);

  const matching = filterSessions(rows, team, status, kind);
  const groups = groupSessions(matching);
  const live = rows.filter((r) => isLive(r.status));
  const liveTeams = new Set(live.map(teamKey));
  const countOf = (key: string) => (key === ALL ? rows.length : rows.filter((r) => teamKey(r) === key).length);

  const pickTeam = (value: string) => {
    setExpanded({});
    url.set({ team: value });
  };
  // A legacy `?kind=trade_vote` link lands on a kind no chip names; the
  // "Every kind" chip is left unlit so the reader sees a filter is on. A
  // legacy status lights the chip that folds it in.
  const kindChipOn = (value: string) => kind === value;
  const statusChipOn = (value: string) => (value === ALL ? status === ALL : value === status || matchStatus(value, status));

  const teamChips: Array<{ value: string; label: string; model: string | null }> = [
    { value: ALL, label: "All teams", model: null },
    ...teams.map((t) => ({ value: t.slug, label: t.label, model: t.model })),
    { value: REPORTER, label: "League reporter", model: reporterModel },
  ];

  return (
    <div>
      {live.length > 0 ? (
        <div className="-mt-4 mb-8 flex flex-wrap items-center gap-x-[18px] gap-y-2.5 rounded-xl border border-accent/30 bg-accent-soft px-4 py-3">
          <span className="inline-flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.1em] text-accent">
            <span
              aria-hidden="true"
              className="live-dot h-2 w-2 rounded-full bg-[var(--green-light)] shadow-[0_0_0_3px_rgba(74,143,74,0.25)]"
            />
            Live now
          </span>
          {live.map((s) => (
            <Link
              key={s.id}
              href={`/sessions/${s.id}`}
              className="group inline-flex items-baseline gap-2 text-[14px]"
            >
              {/*
                `globals.css` colours every `a` unlayered, which outranks any
                Tailwind colour utility on the anchor itself, so the text
                inside carries its own colour — here and on the rows below.
              */}
              <span className="font-semibold text-foreground transition-colors group-hover:text-accent">
                {teamLabel(s)}
              </span>
              <span className="text-muted">
                {kindLabel(s.kind)} · {statusLabel(s.status).toLowerCase()}
              </span>
            </Link>
          ))}
        </div>
      ) : null}

      <div className="mb-7 flex flex-col gap-3.5">
        <div className="scroll-x flex gap-2 pb-0.5" role="group" aria-label="Team">
          {teamChips.map((chip) => {
            const on = team === chip.value;
            return (
              <button
                key={chip.value}
                type="button"
                aria-pressed={on}
                onClick={() => pickTeam(chip.value)}
                className={`inline-flex h-9 flex-shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3.5 text-[13px] font-semibold transition-colors duration-300 hover:border-accent ${
                  on
                    ? "border-foreground bg-foreground text-background"
                    : "border-border-strong bg-surface text-foreground"
                }`}
              >
                {liveTeams.has(chip.value) ? (
                  <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-accent-bright" />
                ) : null}
                {chip.label}
                {chip.model ? <span className="text-[12px] font-normal opacity-65">{chip.model}</span> : null}
                <span className="text-[12px] font-medium tabular-nums opacity-65">{countOf(chip.value)}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[11px] font-bold uppercase tracking-[0.1em] text-faint">Show</span>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Status">
            {STATUS_FILTERS.map((f) => (
              <Chip key={f.value} on={statusChipOn(f.value)} onClick={() => url.set({ status: f.value })}>
                {f.label}
              </Chip>
            ))}
          </div>
          <span aria-hidden="true" className="mx-1.5 h-[18px] w-px bg-border-strong" />
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Kind">
            {KIND_FILTERS.map((f) => (
              <Chip key={f.value} on={kindChipOn(f.value)} onClick={() => url.set({ kind: f.value })}>
                {f.label}
              </Chip>
            ))}
          </div>
          <span className="ml-auto text-[12px] text-faint">
            {matching.length} of {rows.length} sessions
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-5">
        {groups.length === 0 ? (
          <Nothing>{rows.length === 0 ? "No session has run yet." : "No session matches these filters."}</Nothing>
        ) : (
          groups.map((g) => {
            const limit = team === ALL ? ROWS_PER_TEAM : ROWS_FOR_ONE_TEAM;
            const shown = expanded[g.key] ? g.rows : g.rows.slice(0, limit);
            const more = g.rows.length - shown.length;
            return (
              <section
                key={g.key}
                aria-labelledby={`sessions-${g.key}`}
                className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b border-border bg-background px-5 pb-3.5 pt-4">
                  <div className="flex flex-wrap items-baseline gap-2.5">
                    <h2 id={`sessions-${g.key}`} className="text-[17px] font-bold tracking-[-0.02em]">
                      {g.name}
                    </h2>
                    <span className="text-[13px] text-muted">{g.model ?? reporterModel}</span>
                    <span className="text-[12px] tabular-nums text-faint">
                      {g.rows.length} session{g.rows.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {g.teamSlug ? <CardLink href={`/teams/${g.teamSlug}`}>Team page</CardLink> : null}
                </div>
                <div id={`sessions-${g.key}-rows`} className="flex flex-col">
                  {shown.map((s) => (
                    <SessionRow key={s.id} row={s} now={now} />
                  ))}
                </div>
                {more > 0 ? (
                  <div className="flex justify-center border-t border-border/80 px-5 pb-4 pt-3">
                    <button
                      type="button"
                      aria-expanded={false}
                      aria-controls={`sessions-${g.key}-rows`}
                      onClick={() => {
                        trackEvent(EVENTS.showMore, { page: currentPage(), noun: "sessions" });
                        setExpanded((e) => ({ ...e, [g.key]: true }));
                      }}
                      className="rounded-md border border-border-strong bg-transparent px-4 py-1.5 text-[13px] font-medium text-foreground transition-colors duration-300 hover:border-accent hover:bg-accent-soft hover:text-accent"
                    >
                      Show {more} more
                    </button>
                  </div>
                ) : null}
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`h-[30px] rounded-full border px-3 text-[13px] font-medium transition-colors duration-300 hover:border-accent hover:text-accent ${
        on ? "border-accent/35 bg-[rgba(47,93,52,0.1)] text-accent" : "border-border-strong bg-transparent text-muted"
      }`}
    >
      {children}
    </button>
  );
}
