/**
 * The `/sessions` page's filter logic, kept out of the client component so it
 * can be tested without React.
 *
 * A session with no team is the league reporter's (`sessions.team_id` is
 * nullable for exactly that reason), so the team filter carries a sentinel
 * for it alongside the twelve team slugs.
 */
import type { SessionStatus } from "@league/engine";

/** The team-filter value that selects the reporter's sessions. */
export const REPORTER = "reporter";
export const ALL = "all";

/** Every status a session can be in, in the order the filter lists them. */
export const SESSION_STATUSES: readonly SessionStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "skipped",
  "paused",
];

/** The two statuses that mean "happening now". */
export function isLive(status: string): boolean {
  return status === "queued" || status === "running";
}

/** What the sessions page needs of a session row, and nothing that is not public. */
export interface SessionListRow {
  id: number;
  teamId: number | null;
  teamSlug: string | null;
  teamName: string | null;
  modelLabel: string | null;
  kind: string;
  status: string;
  startedAt: Date | null;
  createdAt: Date;
  toolCalls: number;
  costUsd: number;
}

/** The team-filter key for a row: its slug, or the reporter sentinel. */
export function teamKey(row: Pick<SessionListRow, "teamId" | "teamSlug">): string {
  return row.teamId === null ? REPORTER : (row.teamSlug ?? String(row.teamId));
}

export function filterSessions<T extends Pick<SessionListRow, "teamId" | "teamSlug" | "status" | "kind">>(
  rows: readonly T[],
  team: string,
  status: string,
  kind: string = ALL,
): T[] {
  return rows.filter(
    (row) =>
      (team === ALL || teamKey(row) === team) &&
      (status === ALL || row.status === status) &&
      (kind === ALL || row.kind === kind),
  );
}
