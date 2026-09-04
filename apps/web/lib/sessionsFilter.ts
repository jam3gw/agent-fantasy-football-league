/**
 * The `/sessions` page's logic, kept out of the client component so it can be
 * tested without React: the filters, the grouping by team, and the one line
 * each row leads with.
 *
 * A session with no team is the league reporter's (`sessions.team_id` is
 * nullable for exactly that reason), so the team filter carries a sentinel
 * for it alongside the twelve team slugs.
 */
import type { SessionStatus } from "@league/engine";
import { NO_SUMMARY_PLACEHOLDER } from "@league/shared";

/** The team-filter value that selects the reporter's sessions. */
export const REPORTER = "reporter";
export const ALL = "all";

/** Every status a session can be in. */
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

/** The two statuses that mean the session ended without making its call. */
export function isBad(status: string): boolean {
  return status === "failed" || status === "timed_out";
}

/**
 * The status chips. `live` folds queued and running together and `failed`
 * folds in a time-out, because a reader asking "what went wrong" does not
 * care which guard fired. The exact statuses still work as URL values, so an
 * old `?status=timed_out` link keeps meaning what it meant.
 */
export const STATUS_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: ALL, label: "All" },
  { value: "live", label: "Live" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "skipped", label: "Skipped" },
];

/** Every value the `status` URL parameter accepts: the chips and the raw statuses. */
export const STATUS_PARAMS: readonly string[] = [...STATUS_FILTERS.map((f) => f.value), ...SESSION_STATUSES];

export function matchStatus(filter: string, status: string): boolean {
  if (filter === ALL) return true;
  if (filter === "live") return isLive(status);
  if (filter === "failed") return isBad(status);
  return status === filter;
}

/**
 * The kind chips: the families a fan thinks in, not the scheduler's enum.
 * `trade` is every trade kind; `waivers` is the weekly review (where claims
 * are filed) and the post-waivers check. An exact kind is still accepted as a
 * URL value for the same reason as the statuses.
 */
export const KIND_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: ALL, label: "Every kind" },
  { value: "lineup_check", label: "Lineups" },
  { value: "trade", label: "Trades" },
  { value: "waivers", label: "Waivers" },
  { value: "injury_response", label: "Injuries" },
  { value: "board_reply", label: "Board" },
];

export function matchKind(filter: string, kind: string): boolean {
  if (filter === ALL) return true;
  if (filter === "trade") return kind.startsWith("trade");
  if (filter === "waivers") return kind === "weekly_review" || kind === "post_waivers";
  return kind === filter;
}

/** What each session kind is, in a reader's words rather than the enum's. */
export const KIND_LABEL: Record<string, string> = {
  onboarding: "Onboarding",
  draft_pick: "Draft pick",
  weekly_review: "Weekly review",
  post_waivers: "Post-waivers check",
  trade_window: "Trade window",
  trade_response: "Trade response",
  trade_vote: "Trade vote",
  lineup_check: "Lineup check",
  injury_response: "Injury response",
  board_reply: "Board reply",
  self_check_in: "Self check-in",
  manual: "Manual run",
  smoke: "Smoke test",
  reporter_draft_grades: "Draft grades",
  reporter_recap: "Weekly recap",
  reporter_preview: "Week preview",
  reporter_trade_note: "Trade note",
};

/** Every value the `kind` URL parameter accepts: the chips and the raw kinds. */
export const KIND_PARAMS: readonly string[] = [...KIND_FILTERS.map((f) => f.value), ...Object.keys(KIND_LABEL)];

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind.replace(/_/g, " ");
}

export const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  timed_out: "Timed out",
  skipped: "Skipped",
  paused: "Paused",
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, " ");
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
  /** The decision log the agent ended with, or null when it wrote none. */
  summary: string | null;
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
    (row) => (team === ALL || teamKey(row) === team) && matchStatus(status, row.status) && matchKind(kind, row.kind),
  );
}

/** The longest a row's title runs before it is cut at a word. */
export const HEADLINE_CHARS = 120;

/**
 * The first sentence of a decision log, cut at a word if it runs long. The
 * log is a paragraph of up to 800 characters; the row wants the one line the
 * agent would lead with.
 */
export function headlineOf(summary: string): string {
  const text = summary.replace(/\s+/g, " ").trim();
  if (text === "") return "";
  const sentence = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
  if (sentence.length <= HEADLINE_CHARS) return sentence;
  const cut = sentence.slice(0, HEADLINE_CHARS);
  const atWord = cut.lastIndexOf(" ");
  const kept = atWord > HEADLINE_CHARS / 2 ? cut.slice(0, atWord) : cut;
  return `${kept.replace(/[\s,;:—-]+$/, "")}…`;
}

/**
 * The line a row leads with: what the agent decided, in its own words, when
 * it left a decision log; otherwise what happened to the session. A reporter
 * session and a draft pick write no log, so those fall back to the kind, and
 * the runner's placeholder log counts as no log.
 */
export function sessionTitle(row: Pick<SessionListRow, "kind" | "status" | "summary">): string {
  const summary = row.summary?.trim() === NO_SUMMARY_PLACEHOLDER ? null : row.summary;
  const headline = summary ? headlineOf(summary) : "";
  if (headline) return headline;
  switch (row.status) {
    case "queued":
      return "Queued — waiting for a turn";
    case "running":
      return `Working through the ${kindLabel(row.kind).toLowerCase()}…`;
    case "paused":
      return "Paused by the commissioner";
    case "failed":
      return "Ended with an error before making a call";
    case "timed_out":
      return "Ran out of time before making a call";
    case "skipped":
      return "Skipped — nothing left to decide";
    default:
      return kindLabel(row.kind);
  }
}

export interface SessionGroup<T> {
  key: string;
  name: string;
  model: string | null;
  /** The team page, or null for the reporter, who has none. */
  teamSlug: string | null;
  rows: T[];
}

/** The name a row's group shows: the team's, or the reporter's. */
export function teamLabel(row: Pick<SessionListRow, "teamId" | "teamName" | "modelLabel" | "teamSlug">): string {
  return row.teamId === null ? "League reporter" : (row.teamName ?? row.modelLabel ?? row.teamSlug ?? "A team");
}

/** When a row happened, for ordering: its start, or its creation while it is still queued. */
export function rowTime(row: Pick<SessionListRow, "startedAt" | "createdAt">): Date {
  return row.startedAt ?? row.createdAt;
}

/**
 * The rows by team, the most recently active team first. `rows` arrive
 * newest first, so each group's first row is its newest and decides the
 * order.
 */
export function groupSessions<T extends SessionListRow>(rows: readonly T[]): SessionGroup<T>[] {
  const groups = new Map<string, SessionGroup<T>>();
  for (const row of rows) {
    const key = teamKey(row);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name: teamLabel(row),
        model: row.teamId === null ? null : row.modelLabel,
        teamSlug: row.teamId === null ? null : row.teamSlug,
        rows: [],
      };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  const newest = (g: SessionGroup<T>) => rowTime(g.rows[0]).getTime();
  return [...groups.values()].sort((a, b) => newest(b) - newest(a));
}

/**
 * "just now", "12 min ago", "3 h ago", "Yesterday 4:41 PM", "Aug 30, 9:02 AM".
 * Relative while it is recent enough to matter, a stamp once it is not.
 */
export function relativeTime(at: Date, now: Date): string {
  const minutes = Math.round((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const clock = at.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  if (hours < 48) return `Yesterday ${clock}`;
  return at.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
