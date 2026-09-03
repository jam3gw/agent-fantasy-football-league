"use client";

import Link from "next/link";
import { useState } from "react";
import { LiveDot, Nothing, formatEtStamp } from "@/components/broadcast";
import { FilterBar, FilterSelect, ShowMore, useUrlState } from "@/components/list-controls";
import { page, readParam } from "@/lib/listControls";
import {
  REPORTER,
  SESSION_STATUSES,
  filterSessions,
  isLive,
  teamKey,
  type SessionListRow,
} from "@/lib/sessionsFilter";

/** Rows revealed per "show more". */
const STEP = 100;

/**
 * The cross-team sessions table. The rows arrive already fetched from the
 * server page; the three filters are URL state applied over that page of
 * rows, which is the right size for a league that runs hundreds of sessions
 * a week, not millions.
 */
export function SessionsTable({
  rows,
  teams,
}: {
  rows: SessionListRow[];
  teams: Array<{ slug: string; label: string }>;
}) {
  const url = useUrlState();
  const [limit, setLimit] = useState(STEP);
  const kinds = [...new Set(rows.map((r) => r.kind))].sort();
  const team = readParam(url.get("team"), [...teams.map((t) => t.slug), REPORTER]);
  const status = readParam(url.get("status"), SESSION_STATUSES);
  const kind = readParam(url.get("kind"), kinds);

  const matching = filterSessions(rows, team, status, kind);
  const { items: shown, more } = page(matching, limit);
  const live = rows.filter((r) => isLive(r.status));
  const teamLabel = (row: SessionListRow) =>
    row.teamId === null ? "League reporter" : (row.teamName ?? row.modelLabel ?? row.teamSlug ?? "A team");

  return (
    <div>
      {live.length > 0 ? (
        <div className="mb-4 rounded-lg border border-accent/30 bg-accent-soft px-3.5 py-3">
          <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent">Live now</div>
          <ul className="flex flex-col gap-1.5">
            {live.map((s) => (
              <li key={s.id} className="flex flex-wrap items-baseline gap-2.5 text-[13px]">
                <LiveDot className="bg-[var(--green-lighter)]" />
                <Link href={`/sessions/${s.id}`} className="font-semibold text-accent hover:underline">
                  session {s.id}
                </Link>
                <span>{teamLabel(s)}</span>
                <span className="text-faint">
                  {s.kind.replace(/_/g, " ")} · {s.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <FilterBar count={`${matching.length} of ${rows.length} sessions`}>
        <FilterSelect
          id="sessions-team"
          label="Team"
          value={team}
          onChange={(v) => url.set({ team: v })}
          allLabel="All teams"
          options={[...teams.map((t) => ({ value: t.slug, label: t.label })), { value: REPORTER, label: "League reporter" }]}
        />
        <FilterSelect
          id="sessions-status"
          label="Status"
          value={status}
          onChange={(v) => url.set({ status: v })}
          allLabel="All statuses"
          options={SESSION_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, " ") }))}
        />
        <FilterSelect
          id="sessions-kind"
          label="Kind"
          value={kind}
          onChange={(v) => url.set({ kind: v })}
          allLabel="All kinds"
          options={kinds.map((k) => ({ value: k, label: k.replace(/_/g, " ") }))}
        />
      </FilterBar>

      <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
        {shown.length === 0 ? (
          <Nothing>{rows.length === 0 ? "No session has run yet." : "No session matches these filters."}</Nothing>
        ) : (
          <div className="table-scroll">
            <table className="w-full min-w-[720px] text-[13px]">
              <thead>
                <tr className="bg-background-alt text-left text-[10px] font-bold uppercase tracking-[0.1em] text-muted">
                  <th className="whitespace-nowrap px-3 py-2.5">ID</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Team</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Kind</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Status</th>
                  <th className="whitespace-nowrap px-3 py-2.5">Started</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right">Tools</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={s.id} className="border-t border-border/80">
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <Link href={`/sessions/${s.id}`} className="font-semibold text-accent">
                        {s.id}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      {s.teamId === null ? (
                        <span className="text-muted">League reporter</span>
                      ) : (
                        <Link href={`/teams/${teamKey(s)}`} className="hover:text-accent">
                          {teamLabel(s)}
                        </Link>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">{s.kind.replace(/_/g, " ")}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <span
                        className={
                          s.status === "failed" || s.status === "timed_out"
                            ? "text-danger"
                            : isLive(s.status)
                              ? "font-semibold text-accent"
                              : "text-muted"
                        }
                      >
                        {s.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-muted">
                      {s.startedAt ? formatEtStamp(s.startedAt) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{s.toolCalls}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">${s.costUsd.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <ShowMore more={more} noun="sessions" onClick={() => setLimit((n) => n + STEP)} />
    </div>
  );
}
