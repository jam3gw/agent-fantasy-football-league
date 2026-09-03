"use client";

import Link from "next/link";
import { useState } from "react";
import { LiveDot, Nothing, formatEtStamp } from "@/components/broadcast";
import {
  ALL,
  REPORTER,
  SESSION_STATUSES,
  filterSessions,
  isLive,
  teamKey,
  type SessionListRow,
} from "@/lib/sessionsFilter";

/**
 * The cross-team sessions table. The rows arrive already fetched from the
 * server page; the two filters are client state over that page of rows, which
 * is the right size for a league that runs hundreds of sessions, not millions.
 */
export function SessionsTable({
  rows,
  teams,
}: {
  rows: SessionListRow[];
  teams: Array<{ slug: string; label: string }>;
}) {
  const [team, setTeam] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);
  const shown = filterSessions(rows, team, status);
  const live = rows.filter((r) => isLive(r.status));
  const teamLabel = (row: SessionListRow) =>
    row.teamId === null ? "League reporter" : (row.teamName ?? row.modelLabel ?? row.teamSlug ?? "A team");

  const selectClass =
    "rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-[13px] text-foreground";

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

      <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
        <label className="sr-only" htmlFor="sessions-team">
          Team
        </label>
        <select
          id="sessions-team"
          className={selectClass}
          value={team}
          onChange={(e) => setTeam(e.target.value)}
        >
          <option value={ALL}>All teams</option>
          {teams.map((t) => (
            <option key={t.slug} value={t.slug}>
              {t.label}
            </option>
          ))}
          <option value={REPORTER}>League reporter</option>
        </select>
        <label className="sr-only" htmlFor="sessions-status">
          Status
        </label>
        <select
          id="sessions-status"
          className={selectClass}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value={ALL}>All statuses</option>
          {SESSION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <span className="text-[12px] text-faint">
          {shown.length} of {rows.length} sessions
        </span>
      </div>

      <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
        {shown.length === 0 ? (
          <Nothing>
            {rows.length === 0 ? "No session has run yet." : "No session matches these filters."}
          </Nothing>
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
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                      ${s.costUsd.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
