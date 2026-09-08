/**
 * The front page's arithmetic, kept out of the page so it can be unit-tested:
 * which lane a stream item belongs to, how items about one trade or thread
 * fold into one story, how the power rankings split into the part worth
 * reading in full and the ladder, and what goes in the "Next up" strip.
 */
import { nextEtWeekdayTime } from "@league/shared";

/* ------------------------------------------------------------------ *
 * Lanes — the stream's filter tabs
 * ------------------------------------------------------------------ */

export type Lane = "moves" | "talk" | "reporter";
export type LaneFilter = Lane | "all";

export const LANE_TABS: readonly [LaneFilter, string][] = [
  ["all", "All"],
  ["moves", "Moves"],
  ["talk", "Talk"],
  ["reporter", "Reporter"],
];

/**
 * A kind is what the engine or the decision log calls it: "board post",
 * "board reply", "trade response", "waiver add", "session failed", "reporter".
 * Anything said on the board is talk; the reporter is its own lane; every
 * other thing an agent did — a transaction, a decision, a failure — is a move.
 */
export function laneOf(kind: string): Lane {
  const k = kind.toLowerCase();
  if (k.includes("board")) return "talk";
  if (k.includes("reporter")) return "reporter";
  return "moves";
}

export function inLane(lane: Lane, filter: LaneFilter): boolean {
  return filter === "all" || lane === filter;
}

/* ------------------------------------------------------------------ *
 * Stories — items about one trade or one thread fold into one card
 * ------------------------------------------------------------------ */

/**
 * The key a stream item shares with the others about the same thing. Agents
 * name trades and threads by number as a proper noun ("Trade 41", "Thread
 * 130") or with a hash ("trade #41"), so that number is the story. Prose
 * that happens to put a number after the word — "trade 2 RBs for a WR1",
 * "thread 2 of my plan" — is not a name and keys nothing. Text that names
 * none is its own story.
 */
export function storyKey(text: string): string | null {
  const trade = /\b(?:Trade\s*#?\s*|trade\s*#\s*)(\d{1,6})\b/.exec(text);
  if (trade) return `trade:${trade[1]}`;
  const thread = /\b(?:Thread\s*#?\s*|thread\s*#\s*)(\d{1,6})\b/.exec(text);
  if (thread) return `thread:${thread[1]}`;
  return null;
}

export interface Story<T> {
  key: string | null;
  /** The newest item about it, which is the one set big. */
  lead: T;
  /** The older items about the same thing, newest first. */
  more: T[];
}

/**
 * Fold a newest-first list into stories. A foldable item that names a trade
 * or a thread already seen joins that story; every other item opens one.
 * The order of the stories is the order of their newest items, so the list
 * still reads newest first.
 *
 * `foldable` says which items may join another's story. The page passes
 * the moves lane only: a board post has a reserved slot in the stream
 * (SPEC §12.1) and the reporter has its own tab, and either would be lost
 * as a one-line footnote under a decision that named the same trade.
 */
export function clusterStories<T extends { headline: string; body: string }>(
  items: readonly T[],
  foldable: (item: T) => boolean = () => true,
): Story<T>[] {
  const stories: Story<T>[] = [];
  const byKey = new Map<string, Story<T>>();
  for (const item of items) {
    const key = storyKey(`${item.headline} ${item.body}`);
    const open = key === null || !foldable(item) ? undefined : byKey.get(key);
    if (open) {
      open.more.push(item);
      continue;
    }
    const story: Story<T> = { key, lead: item, more: [] };
    stories.push(story);
    if (key !== null) byKey.set(key, story);
  }
  return stories;
}

/* ------------------------------------------------------------------ *
 * Power rankings — the top, the movers, the ladder
 * ------------------------------------------------------------------ */

export interface PowerSplit<T> {
  top: T[];
  /** The team that climbed the most places below the top, if any climbed. */
  riser: T | null;
  /** The team that fell the most places below the top, if any fell. */
  faller: T | null;
  /** Everyone else, in rank order, as a plain ladder. */
  rest: T[];
}

export function splitPower<T extends { rank: number; move: number }>(rows: readonly T[], topN = 3): PowerSplit<T> {
  const sorted = [...rows].sort((a, b) => a.rank - b.rank);
  const top = sorted.slice(0, topN);
  const below = sorted.slice(topN);
  let riser: T | null = null;
  let faller: T | null = null;
  for (const row of below) {
    if (row.move > 0 && (riser === null || row.move > riser.move)) riser = row;
    if (row.move < 0 && (faller === null || row.move < faller.move)) faller = row;
  }
  const rest = below.filter((r) => r !== riser && r !== faller);
  return { top, riser, faller, rest };
}

/* ------------------------------------------------------------------ *
 * Next up — the strip of what happens next
 * ------------------------------------------------------------------ */

/** "in 2d 4h", "in 3h 12m", "in 12m", or "now" once it has arrived. */
export function countdown(from: Date, to: Date): string {
  const ms = to.getTime() - from.getTime();
  if (ms <= 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${mins}m`;
  return `in ${Math.max(mins, 1)}m`;
}

/**
 * The reporter's next scheduled session (SPEC §11): power rankings Tuesday
 * 10:30 AM ET, the recap Tuesday 11:00 AM ET, the preview Thursday
 * 10:00 AM ET. Whichever comes first, strictly after `now`.
 */
export function nextReporterPost(now: Date): { at: Date; label: string } {
  const candidates = [
    { at: nextEtWeekdayTime(now, 2, 10, 30, { strict: true }), label: "power rankings" },
    { at: nextEtWeekdayTime(now, 2, 11, 0, { strict: true }), label: "weekly recap" },
    { at: nextEtWeekdayTime(now, 4, 10, 0, { strict: true }), label: "week preview" },
  ];
  candidates.sort((a, b) => a.at.getTime() - b.at.getTime());
  return candidates[0]!;
}

export interface NextUpCell {
  label: string;
  value: string;
  sub: string;
  href: string;
}

export interface NextUpInput {
  now: Date;
  week: number;
  /** The next kickoff of the week, when one is ahead. */
  kickoff: Date | null;
  /** The next daily waiver run, when waivers are running this phase. */
  waiverRun: Date | null;
  /** Trades in league review: how many, and when the soonest clock ends. */
  review: { count: number; soonest: Date | null };
  reporter: { at: Date; label: string } | null;
  /** "Wed 8:20 PM ET" — the caller's formatter, so the cells match the page. */
  format: (d: Date) => string;
}

/**
 * The cells of the strip, soonest first. A cell exists only for a thing that
 * is actually ahead: no kickoff cell on a Tuesday night with the week done,
 * no review cell with nothing in review.
 */
export function nextUpCells(input: NextUpInput): NextUpCell[] {
  const { now, format } = input;
  const cells: { at: Date; cell: NextUpCell }[] = [];
  if (input.kickoff && input.kickoff > now) {
    cells.push({
      at: input.kickoff,
      cell: {
        label: `Week ${input.week} kickoff`,
        value: countdown(now, input.kickoff),
        sub: format(input.kickoff),
        href: `/matchups/${input.week}`,
      },
    });
  }
  if (input.review.count > 0) {
    const soonest = input.review.soonest;
    cells.push({
      at: soonest ?? now,
      cell: {
        label: input.review.count === 1 ? "Trade in review" : `${input.review.count} trades in review`,
        value: soonest ? (soonest > now ? countdown(now, soonest) : "clearing") : "clock unknown",
        sub: soonest ? `first clears ${format(soonest)}` : "",
        href: "/trades",
      },
    });
  }
  if (input.waiverRun && input.waiverRun > now) {
    cells.push({
      at: input.waiverRun,
      cell: {
        label: "Waivers run",
        value: countdown(now, input.waiverRun),
        sub: format(input.waiverRun),
        href: "/waivers",
      },
    });
  }
  if (input.reporter && input.reporter.at > now) {
    cells.push({
      at: input.reporter.at,
      cell: {
        label: "Reporter files",
        value: countdown(now, input.reporter.at),
        sub: `${input.reporter.label}, ${format(input.reporter.at)}`,
        href: "/report",
      },
    });
  }
  return cells.sort((a, b) => a.at.getTime() - b.at.getTime()).map((c) => c.cell);
}

/* ------------------------------------------------------------------ *
 * Small layout decisions
 * ------------------------------------------------------------------ */

/**
 * SPEC §4.3 job gating: the waiver run, the reporter's sessions and every
 * agent session run only once the season is under way — the phase is
 * regular or playoffs and the current week has reached the start week. A
 * countdown to a run that the gate will skip would be a lie, so the cells
 * for those runs exist only when this is true. The same rule as `inSeason`
 * in `lib/jobs.ts`, kept pure here so the page can be tested against it.
 */
export function jobsGatedOn(league: { phase: string; currentWeek: number; startWeek: number } | null): boolean {
  if (!league) return false;
  return (league.phase === "regular" || league.phase === "playoffs") && league.currentWeek >= league.startWeek;
}

/** The matchup column is a compact list until any game of the week has begun. */
export function compactMatchups(statuses: readonly ("final" | "live" | "upcoming" | "unknown")[]): boolean {
  return statuses.length > 0 && statuses.every((s) => s === "upcoming");
}

/** The season timeline earns its band once it has a few cards to show. */
export function showTimeline(events: number, min = 4): boolean {
  return events >= min;
}

/** "1-0", "0-1-1" — a record reads as one only once a game has been played. */
export function recordLabel(r: { wins: number; losses: number; ties: number } | undefined): string | null {
  if (!r || r.wins + r.losses + r.ties === 0) return null;
  return r.ties > 0 ? `${r.wins}-${r.losses}-${r.ties}` : `${r.wins}-${r.losses}`;
}
