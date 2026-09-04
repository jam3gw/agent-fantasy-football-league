"use client";

/**
 * One session as a row, and the list of them a team page shows. The row is
 * the same one `/sessions` groups under each team, so a session reads the
 * same wherever it is listed.
 */
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { formatEtStamp } from "@/components/broadcast";
import {
  isBad,
  isLive,
  kindLabel,
  relativeTime,
  rowTime,
  sessionTitle,
  statusLabel,
  type SessionListRow,
} from "@/lib/sessionsFilter";

/** A row, with an optional tail for the sub-line — the spend page adds token counts. */
export type SessionRowData = SessionListRow & { detail?: string };

/** A plain list of rows, for a page that already knows whose sessions they are. */
export function SessionRows({ rows }: { rows: SessionRowData[] }) {
  const now = useNow();
  return (
    <div className="flex flex-col">
      {rows.map((s) => (
        <SessionRow key={s.id} row={s} now={now} />
      ))}
    </div>
  );
}

/**
 * One session: the whole row is the link. The dot and the status carry the
 * same colour so a scan down either column finds the live and the failed
 * ones; the title is what the agent decided, and the sub-line is what kind
 * of session it was and how to find it by number.
 */
export function SessionRow({ row, now }: { row: SessionRowData; now: Date | null }) {
  const live = isLive(row.status);
  const bad = isBad(row.status);
  const paused = row.status === "paused";
  const tone = live ? "text-accent" : bad ? "text-danger" : paused ? "text-warn" : "text-muted";
  const dot = live
    ? "bg-[var(--green-light)] shadow-[0_0_0_3px_rgba(74,143,74,0.25)]"
    : bad
      ? "bg-danger"
      : paused
        ? "bg-warn"
        : row.status === "skipped"
          ? "bg-border-strong"
          : "bg-accent";
  const at = rowTime(row);
  return (
    <Link
      href={`/sessions/${row.id}`}
      className="grid grid-cols-[18px_minmax(0,1fr)] items-start gap-x-3.5 border-t border-border/80 px-5 py-3.5 transition-colors duration-300 first:border-t-0 hover:bg-[rgba(47,93,52,0.06)] sm:grid-cols-[18px_minmax(0,1fr)_auto]"
    >
      <span className="flex justify-center pt-1.5">
        <span aria-hidden="true" className={`h-[9px] w-[9px] rounded-full ${live ? "live-dot" : ""} ${dot}`} />
      </span>
      <span className="flex min-w-0 flex-col gap-[3px]">
        <span className="text-[15px] font-semibold leading-[1.35] text-pretty text-foreground">{sessionTitle(row)}</span>
        <span className="text-[13px] leading-[1.4] text-muted">
          {kindLabel(row.kind)} · {row.toolCalls} tool call{row.toolCalls === 1 ? "" : "s"} · session {row.id}
          {row.detail ? ` · ${row.detail}` : null}
        </span>
      </span>
      {/* On a phone the title needs the width, so status, time and cost
          drop to one line under it instead of a column beside it. */}
      <span className="col-start-2 mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 sm:col-start-auto sm:mt-0 sm:flex-col sm:items-end sm:gap-[3px] sm:text-right">
        <span className={`whitespace-nowrap text-[13px] font-semibold ${tone}`}>{statusLabel(row.status)}</span>
        <span className="whitespace-nowrap text-[12px] tabular-nums text-faint">
          {/*
            The page is prerendered and served for up to 300 s, so "12 min
            ago" is only true in the browser: the server and the first client
            render show the stamp, and the relative form takes over on mount.
          */}
          <time dateTime={at.toISOString()} title={formatEtStamp(at)}>
            {now ? relativeTime(at, now) : formatEtStamp(at)}
          </time>
          {" · "}${row.costUsd.toFixed(2)}
        </span>
      </span>
    </Link>
  );
}

/**
 * The browser's clock to the minute, null on the server and during hydration
 * so the prerendered stamp survives it, ticking once a minute after. One
 * interval serves every row on the page.
 */
const tickListeners = new Set<() => void>();
let ticker: number | null = null;
function subscribeTick(listener: () => void): () => void {
  tickListeners.add(listener);
  if (ticker === null) ticker = window.setInterval(() => tickListeners.forEach((l) => l()), 60_000);
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && ticker !== null) {
      window.clearInterval(ticker);
      ticker = null;
    }
  };
}
const minuteNow = () => Math.floor(Date.now() / 60_000);
const minuteOnServer = () => 0;

export function useNow(): Date | null {
  const minute = useSyncExternalStore(subscribeTick, minuteNow, minuteOnServer);
  return minute === 0 ? null : new Date(minute * 60_000);
}
