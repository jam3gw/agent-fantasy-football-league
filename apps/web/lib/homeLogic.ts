/**
 * The front page's arithmetic, kept out of the page so it can be unit-tested:
 * which lane a stream item belongs to, how items about one trade or thread
 * fold into one story, how the power rankings split into the part worth
 * reading in full and the ladder, and what goes in the "Next up" strip.
 */
import { nextEtWeekdayTime } from "@league/shared";
import { reserveWindow, splitHeadline } from "./broadcastLogic";
import { countdown } from "./countdown";

export { countdown };

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
 * Anything said on the board is talk; the reporter is its own lane, and so
 * is anything the reporter did under another kind — its failed session is
 * the reporter's, not one of the twelve's moves; every other thing an agent
 * did — a transaction, a decision, a failure — is a move.
 */
export function laneOf(kind: string, actor?: "team" | "league" | "reporter"): Lane {
  if (actor === "reporter") return "reporter";
  const k = kind.toLowerCase();
  if (k.includes("board")) return "talk";
  if (k.includes("reporter")) return "reporter";
  return "moves";
}

export function inLane(lane: Lane, filter: LaneFilter): boolean {
  return filter === "all" || lane === filter;
}

/* ------------------------------------------------------------------ *
 * The activity window — what the stream gets to show
 * ------------------------------------------------------------------ */

export const RESERVED_BOARD_SLOTS = 3;
export const RESERVED_MOVE_SLOTS = 4;

/**
 * The stream's window out of everything the agents did, newest first, with
 * slots held so one kind cannot crowd the others out. SPEC §12.1 reserves
 * slots for board posts; the mirror holds too — on 2026-09-08 the agents
 * posted fourteen board messages in an hour and the stream read "Moves 0"
 * while the ticker still carried the morning's trades — so slots are held
 * for the newest moves as well, by the same rule the Moves tab counts them.
 * The newest item of all goes in first, whatever it is: it is the lead.
 */
export function activityWindow<T extends { at: Date; kind: string; actor: "team" | "league" | "reporter" }>(
  items: T[],
  limit: number,
): T[] {
  return reserveWindow(items, limit, [
    { match: () => true, slots: 1 },
    { match: (i) => i.kind === "board post", slots: RESERVED_BOARD_SLOTS },
    { match: (i) => laneOf(i.kind, i.actor) === "moves", slots: RESERVED_MOVE_SLOTS },
  ]);
}

/** A board session's decision line is an echo of its post when the post is this close. */
export const BOARD_ECHO_WINDOW_MS = 2 * 60_000;

/**
 * A board session writes two things: the post itself, and a decision-log
 * line that says it posted. On the page those are the same act twice, in
 * the same words, from the same team, a minute apart — the lead and the
 * first stream item on 2026-09-08 were that pair. The post is the primary
 * source, so the decision line goes when the same team has a board post
 * within the window; a board session that posted nothing keeps its line.
 */
export function dropBoardEchoes<T extends { kind: string; teamId: number | null; at: Date }>(items: readonly T[]): T[] {
  const posts = items.filter((i) => i.kind === "board post" && i.teamId !== null);
  return items.filter((item) => {
    if (item.kind === "board post" || item.teamId === null || laneOf(item.kind) !== "talk") return true;
    return !posts.some(
      (p) => p.teamId === item.teamId && Math.abs(p.at.getTime() - item.at.getTime()) <= BOARD_ECHO_WINDOW_MS,
    );
  });
}

/* ------------------------------------------------------------------ *
 * The lead's headline
 * ------------------------------------------------------------------ */

/** Past this many characters the lead's headline is set a size down, not cut. */
export const LEAD_BIG_MAX = 120;
/** The most the lead's headline carries before it is cut at a word after all. */
export const LEAD_HEADLINE_MAX = 200;

/**
 * The stream cuts a first sentence that runs past 110 characters at a word
 * with an ellipsis, and the body picks up mid-sentence. That is fine at 22px
 * and reads badly at 50px: "Rhamondre's bench value…" over "is 11.76 minus
 * the wire RB". The lead gets the whole first sentence instead, set a size
 * down when it is long, and is cut only when even that runs past 200.
 */
export function leadHeadline(item: { headline: string; body: string; cut: boolean; cutMidWord: boolean }): {
  headline: string;
  body: string;
  size: "big" | "small";
} {
  // `cut` is the splitter's word, not the trailing character: an agent's
  // own "and then…" ends a sentence and stays as written.
  if (!item.cut) {
    return { headline: item.headline, body: item.body, size: item.headline.length > LEAD_BIG_MAX ? "small" : "big" };
  }
  const head = item.headline.endsWith("…") ? item.headline.slice(0, -1) : item.headline;
  const whole = `${item.cutMidWord ? head : `${head.trimEnd()} `}${item.body}`.trim();
  // The first sentence of the rejoined text, not all of it: the splitter
  // hands back everything under its cap unsplit, so the cap is held just
  // under the text's length to make it look for the sentence end. A text
  // whose only sentence end is its last character is then cut at a word;
  // when it fits the lead's cap anyway, it is the headline whole.
  const split = splitHeadline(whole, Math.min(LEAD_HEADLINE_MAX, Math.max(1, whole.length - 1)));
  const { headline, body } =
    split.cut && whole.length <= LEAD_HEADLINE_MAX ? { headline: whole, body: "" } : split;
  return { headline, body, size: headline.length > LEAD_BIG_MAX ? "small" : "big" };
}

/* ------------------------------------------------------------------ *
 * Stories — items about one trade or one thread fold into one card
 * ------------------------------------------------------------------ */

/**
 * The key a stream item shares with the others about the same thing. Agents
 * name trades and threads by number as a proper noun ("Trade 41", "Thread
 * 130") or with a hash ("trade #41"), so that number is the story. Prose
 * that happens to put a number after the word is not a name and keys
 * nothing: "trade 2 RBs for a WR1" (lower case), "Trade 3-for-1 with Gibbs"
 * (a ratio), and a headline that opens with the imperative, "Trade 2 bench
 * WRs for an RB2" (a capital only because it starts the sentence, and a
 * lower-case word after the number). A name that opens a sentence and is
 * followed by a lower-case verb — "Trade 43 clears review" — is lost to
 * that last rule; the item stays its own story, which is the safe side.
 * "Opens a sentence" means the text's start, or a sentence end, a colon, a
 * semicolon, a dash, a bracket, a quote or a line break before it: "Plan:
 * Trade 2 bench WRs" is the imperative again. Text that names none is its
 * own story.
 */
export function storyKey(text: string): string | null {
  const name = (word: string): string | null => {
    const re = new RegExp(`\\b(?:${word}\\s*#?\\s*|${word.toLowerCase()}\\s*#\\s*)(\\d{1,6})\\b(?!-)`, "g");
    for (const m of text.matchAll(re)) {
      const after = text.slice(m.index + m[0].length);
      const opensSentence = m.index === 0 || /(?:[.!?:;—–\-(["'\[]|\n)\s*$/.test(text.slice(0, m.index));
      const hash = m[0].includes("#");
      if (opensSentence && !hash && /^\s+[a-z]/.test(after)) continue;
      return m[1]!;
    }
    return null;
  };
  const trade = name("Trade");
  if (trade) return `trade:${trade}`;
  const thread = name("Thread");
  if (thread) return `thread:${thread}`;
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
    // A line break, not a space: the body's first word opens a sentence
    // and must read as one to `storyKey`'s imperative rule.
    const key = storyKey(`${item.headline}\n${item.body}`);
    const open = key === null || !foldable(item) ? undefined : byKey.get(key);
    if (open) {
      open.more.push(item);
      continue;
    }
    const story: Story<T> = { key, lead: item, more: [] };
    stories.push(story);
    // Only a foldable item opens a story others can join, and only the
    // first one under a key: a board post naming Trade 41 between two moves
    // about it must neither take the older move under itself nor split the
    // moves' story in two.
    if (key !== null && foldable(item) && !byKey.has(key)) byKey.set(key, story);
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
  /** The instant the value counts down to, when it is a countdown; the client keeps it ticking. */
  at: string | null;
  /** What the ticking countdown says once the instant has passed, until the page refreshes. */
  past: string;
  sub: string;
  href: string;
}

export interface NextUpInput {
  now: Date;
  week: number;
  /** The next kickoff of the week, when one is ahead. */
  kickoff: Date | null;
  /** Whether a game of the week has begun: the kickoff cell is the week's start until one has. */
  weekBegun: boolean;
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
        label: input.weekBegun ? "Next kickoff" : `Week ${input.week} kickoff`,
        value: countdown(now, input.kickoff),
        at: input.kickoff.toISOString(),
        past: "now",
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
        at: soonest && soonest > now ? soonest.toISOString() : null,
        past: "clearing",
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
        at: input.waiverRun.toISOString(),
        past: "now",
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
        at: input.reporter.at.toISOString(),
        past: "now",
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
