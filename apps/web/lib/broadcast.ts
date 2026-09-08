import "server-only";
/**
 * The reads behind the redesigned public pages.
 *
 * The design asks for several things the site did not previously show: a
 * cross-team activity stream, a win chance on a live game, the reporter's power rankings with
 * week-to-week movement, and a season timeline. None of them are a new source
 * of truth — each is derived here from tables the engine already writes, and
 * every derivation that involves a judgement call says what it assumes.
 */
import { cache } from "react";
import { and, desc, eq, gt, inArray, like, notLike, sql } from "drizzle-orm";
import {
  STARTING_SLOTS,
  boardPosts,
  decisionLogs,
  draftPicks,
  leagueSettings,
  lineupEntries,
  matchups,
  nflGames,
  players,
  playerWeekProj,
  playerWeekStats,
  reporterPosts,
  sessions,
  spendLedger,
  teamWeekResults,
  teams,
  trades,
  transactions,
  waiverClaims,
  waiverRuns,
  computeStandings,
  latestPowerRankings,
  nextWaiverRunTime,
  rankingMovement,
} from "@league/engine";
import { db } from "./db";
import { allTeams, safeRead as safe, settings } from "./queries";
import { activityWindow, jobsGatedOn } from "./homeLogic";
import type { EngineDb } from "@league/engine";
import type { Result } from "./broadcastLogic";
import {
  cardProgress,
  describeClaimWire,
  describeTradeWire,
  describeTransaction,
  describeWaiverRunWire,
  foldForm,
  remainingPoints,
  newestFirst,
  plainExcerpt,
  splitHeadline,
  teamName,
  transactionPlayerIds,
  truncateFlat,
  winChanceFromMargin,
} from "./broadcastLogic";

export type TeamRow = typeof teams.$inferSelect;

export { teamName };
export type { Result };

/* ------------------------------------------------------------------ *
 * Activity — "what the agents are doing"
 * ------------------------------------------------------------------ */

export interface ActivityItem {
  at: Date;
  teamId: number | null;
  /** Who did it when it was not one of the twelve: the league itself, or the reporter. */
  actor: "team" | "league" | "reporter";
  kind: string;
  /** The line the front page sets big, and the rest of what was said. */
  headline: string;
  body: string;
  /** Where the item leads: the session that produced it when known, else the page it lives on. */
  href: string;
  cta: string;
  bad: boolean;
}

/**
 * One stream out of five tables the agents write to as they work: the
 * decisions they log, what they post on the board, the transactions their
 * moves produce, the sessions that failed on them, and what the reporter
 * files. The newest of them is the front page's lead story.
 *
 * The reporter's newest post is left out: the front page gives it its own
 * section, and the masthead wire carries its title, so leading with it as
 * well would print the same headline three times every Tuesday and
 * Thursday morning. Its older posts stay in the stream.
 *
 * Each source is limited before the merge, so a chatty week on the board
 * cannot starve the others out of the window; the decision log counts as
 * two sources for that reason, its board kinds and the rest.
 */
export async function leagueActivity(limit = 12): Promise<ActivityItem[]> {
  const each = Math.max(limit, 8);
  // The decision log is one table for every session kind, so a board_reply
  // session's line and a trade_response session's line share it. Read the
  // board kinds and the rest as two sources, each with its own cap, or an
  // hour of board replies would push every trade decision out before the
  // window's holds ever see one.
  const decisionQuery = (boardKinds: boolean) =>
    db()
      .select({
        at: decisionLogs.createdAt,
        teamId: decisionLogs.teamId,
        sessionId: decisionLogs.sessionId,
        kind: decisionLogs.kind,
        summary: decisionLogs.summary,
      })
      .from(decisionLogs)
      .where(boardKinds ? like(decisionLogs.kind, "board%") : notLike(decisionLogs.kind, "board%"))
      .orderBy(desc(decisionLogs.createdAt))
      .limit(each);
  const [moveDecisions, boardDecisions, posts, txns, failures, reports] = await Promise.all([
    safe(() => decisionQuery(false), []),
    safe(() => decisionQuery(true), []),
    safe(
      () =>
        db()
          .select({ at: boardPosts.createdAt, teamId: boardPosts.teamId, body: boardPosts.body })
          .from(boardPosts)
          .orderBy(desc(boardPosts.createdAt))
          .limit(each),
      [],
    ),
    safe(
      () =>
        db()
          .select({
            at: transactions.createdAt,
            type: transactions.type,
            teamIds: transactions.teamIds,
            payload: transactions.payload,
          })
          .from(transactions)
          .orderBy(desc(transactions.createdAt))
          .limit(each),
      [],
    ),
    safe(
      () =>
        db()
          .select({
            id: sessions.id,
            at: sessions.createdAt,
            teamId: sessions.teamId,
            kind: sessions.kind,
            status: sessions.status,
          })
          .from(sessions)
          .where(inArray(sessions.status, ["failed", "timed_out"]))
          .orderBy(desc(sessions.createdAt))
          .limit(each),
      [],
    ),
    safe(
      () =>
        db()
          .select({ at: reporterPosts.createdAt, title: reporterPosts.title, bodyMd: reporterPosts.bodyMd })
          .from(reporterPosts)
          .orderBy(desc(reporterPosts.createdAt))
          .offset(1)
          .limit(each),
      [],
    ),
  ]);

  // The engine stores player ids in transaction payloads, so the names have to
  // be looked up before any of them can be turned into a sentence.
  const referenced = [...new Set(txns.flatMap((t) => transactionPlayerIds(t.payload)))];
  const playerNames =
    referenced.length === 0
      ? []
      : await safe(
          () =>
            db()
              .select({ playerId: players.playerId, fullName: players.fullName })
              .from(players)
              .where(inArray(players.playerId, referenced)),
          [],
        );
  const playerNameOf = new Map(playerNames.map((p) => [p.playerId, p.fullName]));

  // A summary is one line by convention, not by contract: an agent that
  // writes block Markdown into one gets the markers stripped, same as a board
  // post. One that was nothing but fenced code flattens to "", and a row must
  // still say something. The headline is the first sentence of whatever is
  // left and the body is the rest, so the front page can set one big.
  const story = (text: string, max = 300) => {
    const { headline, body } = splitHeadline(text);
    return {
      headline: headline || "(nothing outside a code block)",
      body: truncateFlat(body, max),
    };
  };
  const decisions = [...moveDecisions, ...boardDecisions];
  const items: ActivityItem[] = [
    ...decisions.map((d) => ({
      at: d.at,
      teamId: d.teamId,
      actor: "team" as const,
      kind: d.kind.replace(/_/g, " "),
      ...story(d.summary),
      href: d.sessionId === null ? "/sessions" : `/sessions/${d.sessionId}`,
      cta: "Open the session",
      bad: false,
    })),
    ...posts.map((p) => ({
      at: p.at,
      teamId: p.teamId,
      actor: "team" as const,
      kind: "board post",
      ...story(p.body, 220),
      href: "/board",
      cta: "Read it on the board",
      bad: false,
    })),
    ...txns.map((t) => ({
      at: t.at,
      teamId: t.teamIds[0] ?? null,
      actor: (t.teamIds[0] === undefined ? "league" : "team") as "league" | "team",
      kind: t.type.replace(/_/g, " "),
      ...story(describeTransaction(t.type, t.payload, (id) => playerNameOf.get(id) ?? null)),
      href: "/transactions",
      cta: "See the transaction",
      bad: false,
    })),
    ...failures.map((f) => ({
      at: f.at,
      teamId: f.teamId,
      actor: (f.teamId === null ? "reporter" : "team") as "reporter" | "team",
      kind: "session failed",
      headline: `A ${f.kind.replace(/_/g, " ")} session ${f.status === "timed_out" ? "timed out" : "failed"}`,
      body: "Nothing this agent planned in it was applied.",
      href: `/sessions/${f.id}`,
      cta: "Open the session",
      bad: true,
    })),
    ...reports.map((r) => ({
      at: r.at,
      teamId: null,
      actor: "reporter" as const,
      kind: "reporter",
      headline: r.title,
      body: plainExcerpt(r.bodyMd, 45),
      href: "/report",
      cta: "Read the full report",
      bad: false,
    })),
  ];

  return activityWindow(items, limit);
}

/* ------------------------------------------------------------------ *
 * The wire — the masthead ticker between games
 * ------------------------------------------------------------------ */

export interface WireItem {
  at: Date;
  /** The tracked label ahead of the line: "trade", "waiver", "waivers", "reporter". */
  kind: string;
  text: string;
}

/**
 * What the masthead ticker carries when no NFL game is on: trades as they
 * move through their statuses, waiver claims as they are processed, the
 * waiver runs themselves, and the reporter's headlines. Live scores take the
 * ticker back the moment a game kicks off (`Masthead`).
 *
 * Each source is read on its own before the merge, for the same reason as
 * the activity stream: one busy source must not push the others off the wire.
 *
 * `cache`d per request: the masthead reads it on every route, and a page
 * that also wants it must not run the same six queries twice.
 */
export const leagueWire = cache(async (limit = 10): Promise<WireItem[]> => {
  const each = Math.max(4, Math.ceil(limit / 2));
  const [allTeamRows, tradeRows, claims, runs, reports] = await Promise.all([
    safe(allTeams, []),
    safe(
      () =>
        db()
          .select({
            at: trades.updatedAt,
            status: trades.status,
            proposerTeamId: trades.proposerTeamId,
            counterpartyTeamId: trades.counterpartyTeamId,
            givePlayerIds: trades.givePlayerIds,
            getPlayerIds: trades.getPlayerIds,
          })
          .from(trades)
          .orderBy(desc(trades.updatedAt))
          .limit(each),
      [],
    ),
    safe(
      () =>
        db()
          .select({
            at: waiverClaims.processedAt,
            teamId: waiverClaims.teamId,
            status: waiverClaims.status,
            addPlayerId: waiverClaims.addPlayerId,
            dropPlayerId: waiverClaims.dropPlayerId,
          })
          .from(waiverClaims)
          .where(inArray(waiverClaims.status, ["success", "failed"]))
          .orderBy(desc(waiverClaims.processedAt))
          .limit(each),
      [],
    ),
    safe(
      () => db().select({ at: waiverRuns.runAt, summary: waiverRuns.summary }).from(waiverRuns).orderBy(desc(waiverRuns.runAt)).limit(2),
      [],
    ),
    safe(
      () =>
        db()
          .select({ at: reporterPosts.createdAt, title: reporterPosts.title })
          .from(reporterPosts)
          .orderBy(desc(reporterPosts.createdAt))
          .limit(each),
      [],
    ),
  ]);

  const nameOf = new Map(allTeamRows.map((t) => [t.id, teamName(t)]));
  const playerIds = [
    ...new Set([
      ...tradeRows.flatMap((t) => [...t.givePlayerIds, ...t.getPlayerIds]),
      ...claims.flatMap((c) => [c.addPlayerId, c.dropPlayerId]).filter((id): id is string => id !== null),
    ]),
  ];
  const playerRows =
    playerIds.length === 0
      ? []
      : await safe(
          () =>
            db()
              .select({ playerId: players.playerId, fullName: players.fullName })
              .from(players)
              .where(inArray(players.playerId, playerIds)),
          [],
        );
  const playerNameOf = new Map(playerRows.map((p) => [p.playerId, p.fullName]));
  const named = (ids: string[]) =>
    ids.map((id) => playerNameOf.get(id)).filter((n): n is string => n !== undefined && n !== "");

  const items: WireItem[] = [
    ...tradeRows.map((t) => ({
      at: t.at,
      kind: "trade",
      text: describeTradeWire({
        status: t.status,
        proposer: nameOf.get(t.proposerTeamId) ?? "A team",
        counterparty: nameOf.get(t.counterpartyTeamId) ?? "a team",
        give: named(t.givePlayerIds),
        get: named(t.getPlayerIds),
      }),
    })),
    ...claims
      .filter((c): c is typeof c & { at: Date } => c.at !== null)
      .map((c) => ({
        at: c.at,
        kind: "waiver",
        text: describeClaimWire(
          nameOf.get(c.teamId) ?? "A team",
          c.status,
          playerNameOf.get(c.addPlayerId) ?? null,
          c.dropPlayerId === null ? null : (playerNameOf.get(c.dropPlayerId) ?? null),
        ),
      })),
    ...runs.map((r) => ({
      at: r.at,
      kind: "waivers",
      text: describeWaiverRunWire(
        r.summary.results.length,
        r.summary.results.filter((x) => x.status === "success").length,
      ),
    })),
    ...reports.map((r) => ({ at: r.at, kind: "reporter", text: r.title })),
  ];
  return newestFirst(items, limit);
});

/**
 * When the league last did anything a reader can see: the newest row across
 * everything the stream and the wire draw on — decisions, board posts,
 * transactions, reporter posts, failed sessions, and the trades, waiver
 * claims and waiver runs that move without writing a transaction. One
 * statement of scalar subqueries, like the pulse stamp, because the
 * masthead runs on every route. Takes the database so a test can run the
 * SQL for real; `lastMoveAt` below is what the pages call.
 *
 * Anchored on the settings singleton so the read is one statement; every
 * inner column is verified to exist on its inner table (the
 * correlated-subquery trap noted in pulse.ts), and `test/lastMove.test.ts`
 * exercises each source. The epoch keeps the driver out of it: a number
 * comes back as a number or a numeric string, never as a Date it may or may
 * not have mapped. All sources empty → NULL → null, never 1970.
 */
export async function readLastMove(database: EngineDb): Promise<Date | null> {
  const rows = await database
    .select({
      at: sql<unknown>`extract(epoch from greatest(
        (select max(created_at) from decision_logs),
        (select max(created_at) from board_posts),
        (select max(created_at) from transactions),
        (select max(created_at) from reporter_posts),
        (select max(created_at) from sessions where status in ('failed', 'timed_out')),
        (select max(updated_at) from trades),
        (select max(processed_at) from waiver_claims),
        (select max(run_at) from waiver_runs)
      ))`,
    })
    .from(leagueSettings)
    .where(eq(leagueSettings.id, 1));
  const epoch = Number(rows[0]?.at ?? Number.NaN);
  return Number.isFinite(epoch) ? new Date(epoch * 1000) : null;
}

/**
 * The masthead's stamp between games, where "Updated 4:41 PM" would be about
 * scores nobody is watching. `cache`d per request so the home page's own
 * read of it is free; degrades to null like every page read.
 */
export const lastMoveAt = cache((): Promise<Date | null> => safe(() => readLastMove(db()), null));

/**
 * The week's next kickoff that is still ahead — Thursday night's before the
 * week starts, Sunday's early window on a Saturday — or null once the week's
 * last game has kicked off or when the schedule is not in yet. The
 * judgement is made here rather than in the page, which must stay pure: a
 * page that compared kickoffs against the clock itself would present a
 * played week's kickoff as upcoming until the week advanced.
 */
export async function nextKickoff(week: number, season: number, now: Date = new Date()): Promise<Date | null> {
  const rows = await safe(
    () =>
      db()
        .select({ at: nflGames.kickoffAt })
        .from(nflGames)
        .where(and(eq(nflGames.season, season), eq(nflGames.week, week), gt(nflGames.kickoffAt, now)))
        .orderBy(nflGames.kickoffAt)
        .limit(1),
    [],
  );
  return rows[0]?.at ?? null;
}

/**
 * Trades in league review (§3.5): how many, and when the soonest clock ends.
 * `accepted` is the status of a trade in review; `review_ends_at` is set on
 * accept. The count is public during review; who voted is not, and this
 * reads nothing about the votes.
 */
export async function tradesInReview(): Promise<{ count: number; soonest: Date | null }> {
  const rows = await safe(
    () =>
      db()
        .select({ endsAt: trades.reviewEndsAt })
        .from(trades)
        .where(eq(trades.status, "accepted"))
        .orderBy(trades.reviewEndsAt),
    [],
  );
  return { count: rows.length, soonest: rows[0]?.endsAt ?? null };
}

/**
 * The next daily waiver run (§3.4), or null when waivers are not running:
 * before the season's first week the job is gated off (§6, job gating), so
 * a countdown to a run that will not happen would be a lie.
 */
export async function nextWaiverRun(now: Date = new Date()): Promise<Date | null> {
  const league = await safe(settings, null);
  if (!league || !jobsGatedOn(league)) return null;
  return nextWaiverRunTime(league, now);
}

/* ------------------------------------------------------------------ *
 * Form
 * ------------------------------------------------------------------ */

/**
 * Recent results per team, oldest first so the newest reads on the right.
 * Only finalized regular-season games count, which is what the standings do.
 */
export async function teamForm(lastN = 5): Promise<Map<number, Result[]>> {
  const rows = await safe(
    () =>
      db()
        .select({
          week: matchups.week,
          homeTeamId: matchups.homeTeamId,
          awayTeamId: matchups.awayTeamId,
          homePoints: matchups.homePoints,
          awayPoints: matchups.awayPoints,
        })
        .from(matchups)
        // `computeStandings` counts finalized regular-season games only, so
        // these must too — otherwise a playoff result would appear as a chip
        // beside a record that does not contain it.
        .where(and(eq(matchups.final, true), eq(matchups.isPlayoff, false)))
        .orderBy(matchups.week),
    [],
  );
  return foldForm(rows, lastN);
}

/* ------------------------------------------------------------------ *
 * Live games
 * ------------------------------------------------------------------ */

export interface GameCard {
  matchupId: number;
  week: number;
  final: boolean;
  isPlayoff: boolean;
  playoffRound: number | null;
  awayTeam: TeamRow | undefined;
  homeTeam: TeamRow | undefined;
  awayPoints: number;
  homePoints: number;
  /**
   * Starting slots on either side whose NFL game has not finished, or null
   * when the week's schedule is not in the database and there is no way to
   * tell. Null is not zero: a caller that treats it as zero renders a Sunday
   * afternoon as a finished week, which is exactly the bug this type prevents.
   */
  slotsToPlay: number | null;
  /** The slot names still to play for each side, e.g. ["DST", "K"]. */
  awayToPlay: string[];
  homeToPlay: string[];
  /** Away team's chance to win, 0–1, or null once the game is over. */
  awayWinChance: number | null;
  /**
   * Whether this matchup's week has actually begun for it: some starter's NFL
   * game has kicked off, or points are on the board. The tick flips a game
   * from "scheduled" at kickoff (§13.2), so before Thursday night every
   * matchup is started=false — a page that treated "slots still to play" as
   * "live" was calling Wednesday afternoon a live week.
   */
  started: boolean;
  /**
   * Each side's projected final: points already scored plus what its starters
   * still to play have left in their projections. Before kickoff that is the
   * starting lineup's projected total for the week. Null when the schedule or
   * the week's projections are not in the database — no number is offered
   * rather than a zero that reads as a forecast — and null once the game is
   * over, when the score itself is the answer.
   */
  awayProjected: number | null;
  homeProjected: number | null;
}

/**
 * This week's games with what is left to play and a chance to win.
 *
 * "Left to play" is a starting slot whose player's NFL game has not gone
 * final — an empty slot is not counted, because an empty slot scores zero and
 * is not going to change. The remaining projection is the sum of those
 * players' projections where the feed has one.
 */
export async function gameCards(week: number, season: number): Promise<GameCard[]> {
  const [weekly, allTeamRows, games] = await Promise.all([
    safe(() => db().select().from(matchups).where(eq(matchups.week, week)), []),
    safe(() => db().select().from(teams), []),
    safe(
      () =>
        db()
          .select({ home: nflGames.home, away: nflGames.away, status: nflGames.status })
          .from(nflGames)
          .where(and(eq(nflGames.season, season), eq(nflGames.week, week))),
      [],
    ),
  ]);
  if (weekly.length === 0) return [];

  const teamOf = new Map(allTeamRows.map((t) => [t.id, t]));
  const teamIds = weekly.flatMap((m) => [m.awayTeamId, m.homeTeamId]);

  const starters = await safe(
    () =>
      db()
        .select({ teamId: lineupEntries.teamId, slot: lineupEntries.slot, playerId: lineupEntries.playerId })
        .from(lineupEntries)
        .where(and(eq(lineupEntries.week, week), inArray(lineupEntries.teamId, teamIds))),
    [],
  );
  const startingOnly = starters.filter((s) => (STARTING_SLOTS as readonly string[]).includes(s.slot));
  const playerIds = [...new Set(startingOnly.map((s) => s.playerId))];

  const [meta, projections, scored] = await Promise.all([
    playerIds.length === 0
      ? Promise.resolve([])
      : safe(
          () =>
            db()
              .select({ playerId: players.playerId, nflTeam: players.nflTeam })
              .from(players)
              .where(inArray(players.playerId, playerIds)),
          [],
        ),
    playerIds.length === 0
      ? Promise.resolve([])
      : safe(
          () =>
            db()
              .select({ playerId: playerWeekProj.playerId, proj: playerWeekProj.projPtsPpr })
              .from(playerWeekProj)
              .where(
                and(
                  eq(playerWeekProj.season, season),
                  eq(playerWeekProj.week, week),
                  inArray(playerWeekProj.playerId, playerIds),
                ),
              ),
          [],
        ),
    playerIds.length === 0
      ? Promise.resolve([])
      : safe(
          () =>
            db()
              .select({ playerId: playerWeekStats.playerId, pts: playerWeekStats.ptsPpr })
              .from(playerWeekStats)
              .where(
                and(
                  eq(playerWeekStats.season, season),
                  eq(playerWeekStats.week, week),
                  inArray(playerWeekStats.playerId, playerIds),
                ),
              ),
          [],
        ),
  ]);

  /*
   * An NFL team is done for the week when its game is final. A player whose
   * team has no game this week is on a bye: he will not score, so he is not
   * "still to play" either.
   *
   * If the schedule itself is missing — the week has not been ingested, or the
   * read failed and degraded to an empty array — then nobody looks like they
   * have a game, and every player would read as "not still to play". That
   * would render a Sunday afternoon as though every game had finished. So the
   * absence of a schedule is treated as not knowing: no slots are claimed and
   * no win chance is offered, and only the matchup's own `final` flag decides
   * whether the game is over.
   */
  const scheduleKnown = games.length > 0;
  const finished = new Set<string>();
  const playing = new Set<string>();
  const kickedOff = new Set<string>();
  for (const g of games) {
    playing.add(g.home);
    playing.add(g.away);
    if (g.status !== "scheduled") {
      kickedOff.add(g.home);
      kickedOff.add(g.away);
    }
    if (g.status === "final") {
      finished.add(g.home);
      finished.add(g.away);
    }
  }
  const nflTeamOf = new Map(meta.map((m) => [m.playerId, m.nflTeam]));
  const projOf = new Map(projections.map((p) => [p.playerId, p.proj ?? 0]));
  const scoredOf = new Map(scored.map((p) => [p.playerId, p.pts ?? 0]));

  const stillToPlay = (playerId: string): boolean => {
    if (!scheduleKnown) return false;
    const nflTeam = nflTeamOf.get(playerId);
    if (!nflTeam) return false;
    if (!playing.has(nflTeam)) return false;
    return !finished.has(nflTeam);
  };

  const bySide = new Map<number, Array<{ slot: string; playerId: string }>>();
  for (const s of startingOnly) {
    const list = bySide.get(s.teamId);
    if (list) list.push(s);
    else bySide.set(s.teamId, [s]);
  }

  /*
   * A player whose game is in progress has already banked part of his day, and
   * that part is already inside the matchup's score. Adding his whole weekly
   * projection on top would count it twice — a receiver on 10 of a projected
   * 15 would be worth 25 to his team. What is still to come is the projection
   * less what he has scored, floored at zero for anyone already past it.
   */
  const remainingFor = (teamId: number) => {
    const list = (bySide.get(teamId) ?? []).filter((s) => stillToPlay(s.playerId));
    return {
      slots: list.map((s) => s.slot),
      projected: list.reduce(
        (sum, s) => sum + remainingPoints(projOf.get(s.playerId) ?? 0, scoredOf.get(s.playerId) ?? 0),
        0,
      ),
    };
  };

  // Projections arrive with the weekly ingest; a week without any is a week
  // where every "projected total" would read 0.0, which is a claim, not a gap.
  const projectionsKnown = projections.length > 0;

  const sideStarted = (teamId: number): boolean =>
    (bySide.get(teamId) ?? []).some((s) => {
      const nflTeam = nflTeamOf.get(s.playerId);
      return nflTeam != null && kickedOff.has(nflTeam);
    });

  return weekly.map((m) => {
    const awayPoints = m.awayPoints ?? 0;
    const homePoints = m.homePoints ?? 0;
    const away = remainingFor(m.awayTeamId);
    const home = remainingFor(m.homeTeamId);
    const slotsToPlay = scheduleKnown ? away.slots.length + home.slots.length : null;
    const over = m.final || slotsToPlay === 0;
    const progress = cardProgress({
      over,
      scheduleKnown,
      projectionsKnown,
      awayPoints,
      homePoints,
      anyStarterKickedOff: sideStarted(m.awayTeamId) || sideStarted(m.homeTeamId),
      awayProjectedFinal: awayPoints + away.projected,
      homeProjectedFinal: homePoints + home.projected,
    });
    const margin = awayPoints + away.projected - (homePoints + home.projected);
    return {
      matchupId: m.id,
      week: m.week,
      final: m.final,
      isPlayoff: m.isPlayoff,
      playoffRound: m.playoffRound,
      awayTeam: teamOf.get(m.awayTeamId),
      homeTeam: teamOf.get(m.homeTeamId),
      awayPoints,
      homePoints,
      slotsToPlay,
      awayToPlay: away.slots,
      homeToPlay: home.slots,
      // No schedule means no idea who is left to play, so no chance is
      // offered rather than one computed from the score alone.
      awayWinChance: over || slotsToPlay === null ? null : winChanceFromMargin(margin),
      ...progress,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Benchmark aggregates — /benchmark and /teams
 * ------------------------------------------------------------------ */

export interface BenchRow {
  teamId: number;
  slug: string;
  name: string | null;
  modelLabel: string;
  wins: number;
  losses: number;
  ties: number;
  rank: number;
  pf: number;
  pa: number;
  actual: number;
  optimal: number;
  efficiency: number | null;
  bench: number;
  fa: number;
  emptySlots: number;
  claimsMade: number;
  claimsWon: number;
  tradesMade: number;
  offersSent: number;
  offersReceived: number;
  costList: number;
  costPaid: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  costPerPoint: number | null;
  sessionsRun: number;
  sessionsFailed: number;
  invalidToolCalls: number;
  autoPicks: number;
}

/**
 * Every per-team number the benchmark shows, in one pass.
 *
 * This was inline in `/benchmark` and moved here when the home page's power
 * rankings were computed from it. The rankings are the reporter's now;
 * `/benchmark` and `/teams` read this.
 */
export async function benchmarkRows(): Promise<BenchRow[]> {
  // `db()` reads DATABASE_URL and throws when it is missing, so it is called
  // inside each guarded read rather than once above them — otherwise a missing
  // variable takes the page down instead of degrading it to an empty render.
  const [allTeamRows, table, results, claims, allTrades, sessionAgg, ledger, autopicks] = await Promise.all([
    safe(() => db().select().from(teams).orderBy(teams.id), []),
    safe(() => computeStandings(db()), []),
    safe(
      () =>
        db()
          .select({
            teamId: teamWeekResults.teamId,
            actual: sql<number>`coalesce(sum(${teamWeekResults.actualPoints}), 0)::float8`,
            optimal: sql<number>`coalesce(sum(${teamWeekResults.optimalPoints}), 0)::float8`,
            bench: sql<number>`coalesce(sum(${teamWeekResults.pointsLeftOnBench}), 0)::float8`,
            fa: sql<number>`coalesce(sum(${teamWeekResults.faPoints}), 0)::float8`,
            empty: sql<number>`coalesce(sum(${teamWeekResults.emptyStartingSlots}), 0)::int`,
          })
          .from(teamWeekResults)
          .groupBy(teamWeekResults.teamId),
      [],
    ),
    safe(
      () =>
        db()
          .select({
            teamId: waiverClaims.teamId,
            made: sql<number>`count(*)::int`,
            won: sql<number>`count(*) filter (where ${waiverClaims.status} = 'success')::int`,
          })
          .from(waiverClaims)
          .groupBy(waiverClaims.teamId),
      [],
    ),
    safe(
      () =>
        db()
          .select({
            proposerTeamId: trades.proposerTeamId,
            counterpartyTeamId: trades.counterpartyTeamId,
            status: trades.status,
          })
          .from(trades),
      [],
    ),
    safe(
      () =>
        db()
          .select({
            teamId: sessions.teamId,
            total: sql<number>`count(*)::int`,
            failed: sql<number>`count(*) filter (where ${sessions.status} in ('failed', 'timed_out'))::int`,
            invalid: sql<number>`coalesce(sum(${sessions.invalidToolCalls}), 0)::int`,
          })
          .from(sessions)
          .groupBy(sessions.teamId),
      [],
    ),
    safe(
      () =>
        db()
          .select({
            teamId: spendLedger.teamId,
            list: sql<number>`coalesce(sum(${spendLedger.costUsd}), 0)::float8`,
            paid: sql<number>`coalesce(sum(${spendLedger.costUsd}) filter (where ${spendLedger.billedTo} = 'gateway'), 0)::float8`,
            input: sql<number>`coalesce(sum(${spendLedger.inputTokens}), 0)::bigint`,
            output: sql<number>`coalesce(sum(${spendLedger.outputTokens}), 0)::bigint`,
            reasoning: sql<number>`coalesce(sum(${spendLedger.reasoningTokens}), 0)::bigint`,
            cached: sql<number>`coalesce(sum(${spendLedger.cachedInputTokens}), 0)::bigint`,
          })
          .from(spendLedger)
          .groupBy(spendLedger.teamId),
      [],
    ),
    safe(
      () =>
        db()
          .select({ teamId: draftPicks.teamId, n: sql<number>`count(*)::int` })
          .from(draftPicks)
          .where(eq(draftPicks.madeBy, "autopick"))
          .groupBy(draftPicks.teamId),
      [],
    ),
  ]);

  return allTeamRows.map((t) => {
    const st = table.find((s) => s.teamId === t.id);
    const r = results.find((x) => x.teamId === t.id);
    const c = claims.find((x) => x.teamId === t.id);
    const s = sessionAgg.find((x) => x.teamId === t.id);
    const l = ledger.find((x) => x.teamId === t.id);
    const pf = st?.pointsFor ?? 0;
    const costList = Number(l?.list ?? 0);
    const actual = Number(r?.actual ?? 0);
    const optimal = Number(r?.optimal ?? 0);
    return {
      teamId: t.id,
      slug: t.slug,
      name: t.name,
      modelLabel: t.modelLabel,
      wins: st?.wins ?? 0,
      losses: st?.losses ?? 0,
      ties: st?.ties ?? 0,
      rank: st?.rank ?? 0,
      pf,
      pa: st?.pointsAgainst ?? 0,
      actual,
      optimal,
      efficiency: optimal > 0 ? actual / optimal : null,
      bench: Number(r?.bench ?? 0),
      fa: Number(r?.fa ?? 0),
      emptySlots: Number(r?.empty ?? 0),
      claimsMade: Number(c?.made ?? 0),
      claimsWon: Number(c?.won ?? 0),
      tradesMade: allTrades.filter(
        (x) => x.status === "executed" && (x.proposerTeamId === t.id || x.counterpartyTeamId === t.id),
      ).length,
      offersSent: allTrades.filter((x) => x.proposerTeamId === t.id).length,
      offersReceived: allTrades.filter((x) => x.counterpartyTeamId === t.id).length,
      costList,
      costPaid: Number(l?.paid ?? 0),
      inputTokens: Number(l?.input ?? 0),
      outputTokens: Number(l?.output ?? 0),
      reasoningTokens: Number(l?.reasoning ?? 0),
      cachedTokens: Number(l?.cached ?? 0),
      costPerPoint: pf > 0 ? costList / pf : null,
      sessionsRun: Number(s?.total ?? 0),
      sessionsFailed: Number(s?.failed ?? 0),
      invalidToolCalls: Number(s?.invalid ?? 0),
      autoPicks: Number(autopicks.find((x) => x.teamId === t.id)?.n ?? 0),
    };
  });
}

/* ------------------------------------------------------------------ *
 * Power rankings
 * ------------------------------------------------------------------ */

export interface PowerRow {
  teamId: number;
  slug: string;
  name: string;
  modelLabel: string;
  rank: number;
  /** Places gained since the reporter's previous edition; 0 when unchanged. */
  move: number;
  /** The reporter's reason for the place, one or two sentences. */
  reason: string;
}

export interface PowerBoard {
  /** The fantasy week in play when the edition was published. */
  week: number;
  publishedAt: Date;
  sessionId: number;
  rows: PowerRow[];
}

/**
 * A power ranking is a claim about who is actually good, and the page makes
 * no such claim on its own: the league reporter publishes an edition in each
 * `reporter_power_rankings` session (§11), with a reason for every place. The
 * movement column compares the newest edition with the one before it, so an
 * arrow means the reporter changed its mind, not that a formula's inputs
 * shifted.
 */
export async function powerRankings(): Promise<PowerBoard | null> {
  const [editions, teamRows] = await Promise.all([
    safe(() => latestPowerRankings(db(), 2), []),
    safe(() => db().select().from(teams), []),
  ]);
  const [current, previous] = editions;
  if (!current) return null;
  const movement = rankingMovement(current, previous);
  const byId = new Map(teamRows.map((t) => [t.id, t]));
  return {
    week: current.week,
    publishedAt: current.createdAt,
    sessionId: current.sessionId,
    rows: current.entries.map((e) => {
      const t = byId.get(e.teamId);
      return {
        teamId: e.teamId,
        slug: t?.slug ?? String(e.teamId),
        name: teamName(t),
        modelLabel: t?.modelLabel ?? "",
        rank: e.rank,
        move: movement.get(e.teamId) ?? 0,
        reason: e.reason,
      };
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Season timeline
 * ------------------------------------------------------------------ */

export interface TimelineEvent {
  at: Date;
  when: string;
  title: string;
  body: string;
  tone: "accent" | "light" | "quiet";
}

/**
 * The season so far, as a strip of cards. Every entry is an event the engine
 * recorded — the draft finishing, the first trade, the first contested waiver
 * run, each week's high score and its worst bench — so the strip fills itself
 * in as the season runs rather than being a list someone maintains.
 */
export async function seasonTimeline(limit = 8): Promise<TimelineEvent[]> {
  const [picks, txns, results, allTeamRows] = await Promise.all([
    safe(
      () =>
        db()
          .select({ at: draftPicks.pickedAt, pickNo: draftPicks.pickNo })
          .from(draftPicks)
          .orderBy(desc(draftPicks.pickNo))
          .limit(1),
      [],
    ),
    // The earliest trade and the earliest waiver claim, asked for separately.
    // One oldest-first window over both types can be filled entirely by
    // whichever happens more often, hiding the other for ever.
    Promise.all(
      (["trade", "waiver_add"] as const).map((kind) =>
        safe(
          () =>
            db()
              .select({ at: transactions.createdAt, type: transactions.type, teamIds: transactions.teamIds })
              .from(transactions)
              .where(eq(transactions.type, kind))
              .orderBy(transactions.createdAt)
              .limit(1),
          [],
        ),
      ),
    ).then((pairs) => pairs.flat()),
    safe(
      () =>
        db()
          .select({
            teamId: teamWeekResults.teamId,
            week: teamWeekResults.week,
            actual: teamWeekResults.actualPoints,
            bench: teamWeekResults.pointsLeftOnBench,
            empty: teamWeekResults.emptyStartingSlots,
            at: teamWeekResults.createdAt,
          })
          .from(teamWeekResults)
          .orderBy(teamWeekResults.week),
      [],
    ),
    safe(() => db().select().from(teams), []),
  ]);

  const nameOf = new Map(allTeamRows.map((t) => [t.id, teamName(t)]));
  const events: TimelineEvent[] = [];

  const lastPick = picks[0];
  if (lastPick) {
    events.push({
      at: lastPick.at,
      when: "",
      title: "The draft finished",
      body: `All ${lastPick.pickNo} picks were made by the agents on the clock.`,
      tone: "accent",
    });
  }

  const firstTrade = txns.find((t) => t.type === "trade");
  if (firstTrade) {
    const names = firstTrade.teamIds.map((id) => nameOf.get(id) ?? "a team");
    events.push({
      at: firstTrade.at,
      when: "",
      title: "First trade of the season",
      body: names.length >= 2 ? `${names[0]} and ${names[1]} agreed a deal.` : "Two agents agreed a deal.",
      tone: "light",
    });
  }

  const firstWaiver = txns.find((t) => t.type === "waiver_add");
  if (firstWaiver) {
    events.push({
      at: firstWaiver.at,
      when: "",
      title: "First waiver claim went through",
      body: `${nameOf.get(firstWaiver.teamIds[0] ?? -1) ?? "An agent"} won the first claim of the season.`,
      tone: "light",
    });
  }

  // Per week: the high score, and the worst bench if it was costly.
  const byWeek = new Map<number, typeof results>();
  for (const r of results) {
    const list = byWeek.get(r.week);
    if (list) list.push(r);
    else byWeek.set(r.week, [r]);
  }
  for (const [week, rows] of byWeek) {
    const high = [...rows].sort((a, b) => b.actual - a.actual)[0];
    if (high) {
      events.push({
        at: high.at,
        when: `Week ${week}`,
        title: `${nameOf.get(high.teamId) ?? "A team"} led week ${week}`,
        body: `${high.actual.toFixed(1)} points, the highest score of the week.`,
        tone: "accent",
      });
    }
    const worst = [...rows].sort((a, b) => b.bench - a.bench)[0];
    if (worst && worst.bench > 0) {
      events.push({
        at: worst.at,
        when: `Week ${week}`,
        title: "Biggest waste of the week",
        body: `${nameOf.get(worst.teamId) ?? "A team"} left ${worst.bench.toFixed(1)} points on its bench${
          worst.empty > 0
            ? `, and left ${worst.empty} starting slot${worst.empty === 1 ? "" : "s"} empty`
            : ""
        }.`,
        tone: "quiet",
      });
    }
  }

  return events
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(-limit)
    .map((e) => ({ ...e, when: e.when || monthDay(e.at) }));
}

function monthDay(d: Date): string {
  return d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
}

/** The current season and week, with the fallbacks the pages already use. */
export async function leagueClockState() {
  const league = await safe(settings, null);
  return {
    league,
    season: league?.season ?? new Date().getUTCFullYear(),
    week: league?.currentWeek ?? 1,
    phase: league?.phase ?? "pre_draft",
  };
}
