/**
 * Draft tools (SPEC §8.4, table 4 — draft sessions only) and the shared
 * auto-pick choice (§10.4).
 *
 * `get_draft_state` and `get_available_players` are reads over the draft board
 * (§10.3). `make_pick` is the one write: it validates §8.4's four checks plus
 * the §10.4 roster rules and then writes the pick, the roster entry and the
 * public transaction in a single database transaction. A drafted player also
 * fills his team's first open eligible starting slot (§3.1 draft-time
 * slotting, 2026-08-29); §7.8's bench-arrival rule covers every other route.
 *
 * `autoPickCandidate` implements §10.4's auto-pick choice and is exported for
 * the draft workflow (§10.2) to reuse when a clock expires.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  SLOT_ELIGIBILITY,
  STARTING_SLOTS,
  draft,
  draftPicks,
  getSettings,
  nflGames,
  playerWeekProj,
  playerWeekStats,
  players,
  rankings,
  recordTransaction,
  rosterEntries, autofillDraftLineupSlot } from "@league/engine";
import type { EngineDb, LeagueSettings, StartingSlot } from "@league/engine";
import type { LeagueTool, ToolResult } from "./types.ts";
import { defineTool, pageRows, toolFailure } from "./types.ts";


/* -------------------------------------------------------------------------- */
/* Roster rules (§10.4)                                                       */
/* -------------------------------------------------------------------------- */

/** Hard position caps during the draft (§10.4). Keys are Sleeper positions. */
export const DRAFT_POSITION_CAPS: Record<string, number> = {
  QB: 3,
  RB: 7,
  WR: 7,
  TE: 3,
  K: 1,
  DEF: 1,
};

/** Positions that can be drafted at all (§10.3 draft board). */
const DRAFTABLE_POSITIONS = Object.keys(DRAFT_POSITION_CAPS);

export const MAX_PICK_REASON_CHARS = 200;
const MAX_AVAILABLE_LIMIT = 60;
const RECENT_PICKS = 12;

/** The position a player counts against for the §10.4 caps. */
function capPosition(p: { position: string | null; fantasyPositions: string[] | null }): string | null {
  if (p.position && DRAFT_POSITION_CAPS[p.position] !== undefined) return p.position;
  for (const fp of p.fantasyPositions ?? []) {
    if (DRAFT_POSITION_CAPS[fp] !== undefined) return fp;
  }
  return p.position ?? p.fantasyPositions?.[0] ?? null;
}

/**
 * The required starting slots (§3.1), expanded from `roster_slots`:
 * QB, RB1, RB2, WR1, WR2, TE, FLEX, DST, K by default.
 */
function requiredStartingSlots(settings: Pick<LeagueSettings, "rosterSlots">): StartingSlot[] {
  const rs = settings.rosterSlots;
  const counts: Array<[StartingSlot[], number]> = [
    [["QB"], rs.QB],
    [["RB1", "RB2"], rs.RB],
    [["WR1", "WR2"], rs.WR],
    [["TE"], rs.TE],
    [["FLEX"], rs.FLEX],
    [["DST"], rs.DST],
    [["K"], rs.K],
  ];
  const slots: StartingSlot[] = [];
  for (const [names, n] of counts) {
    for (let i = 0; i < n; i++) {
      const name = names[i] ?? names[names.length - 1];
      if (name) slots.push(name);
    }
  }
  return slots.filter((s) => STARTING_SLOTS.includes(s));
}

type Positioned = { fantasyPositions: string[] | null; position: string | null };

function eligible(slot: StartingSlot, p: Positioned): boolean {
  const pos = p.fantasyPositions && p.fantasyPositions.length > 0 ? p.fantasyPositions : p.position ? [p.position] : [];
  return SLOT_ELIGIBILITY[slot].some((s) => pos.includes(s));
}

/**
 * Maximum matching of players onto required starting slots (Kuhn's algorithm).
 * FLEX is fillable by RB, WR or TE, so a greedy pass is not exact; the rosters
 * here are at most 14 players against 9 slots, so an exact matching is cheap.
 * Returns the slots that stay unfilled.
 */
export function unfilledStartingSlots(slots: StartingSlot[], roster: Positioned[]): StartingSlot[] {
  const matchOfSlot = new Array<number>(slots.length).fill(-1);

  const tryAssign = (playerIdx: number, seen: boolean[]): boolean => {
    for (let s = 0; s < slots.length; s++) {
      if (seen[s]) continue;
      const slot = slots[s]!;
      if (!eligible(slot, roster[playerIdx]!)) continue;
      seen[s] = true;
      if (matchOfSlot[s] === -1 || tryAssign(matchOfSlot[s]!, seen)) {
        matchOfSlot[s] = playerIdx;
        return true;
      }
    }
    return false;
  };

  for (let p = 0; p < roster.length; p++) {
    tryAssign(p, new Array<boolean>(slots.length).fill(false));
  }
  return slots.filter((_, s) => matchOfSlot[s] === -1);
}

export interface DraftRosterCheckInput {
  settings: LeagueSettings;
  /** The team's current roster (before this pick). */
  roster: Positioned[];
  /** The player being drafted. */
  candidate: Positioned;
  /** Rounds this team still picks in AFTER this pick (§10.4). */
  roundsRemainingAfter: number;
}

export type DraftRosterCheck =
  | { ok: true }
  | { ok: false; error: "position_cap" | "must_fill_starters"; message: string; hint: string };

/** §10.4: position caps and "required starters must be fillable". */
export function checkDraftRosterRules(input: DraftRosterCheckInput): DraftRosterCheck {
  const pos = capPosition(input.candidate);
  if (pos !== null) {
    const cap = DRAFT_POSITION_CAPS[pos];
    if (cap !== undefined) {
      const have = input.roster.filter((r) => capPosition(r) === pos).length;
      if (have + 1 > cap) {
        return {
          ok: false,
          error: "position_cap",
          message: `you already have ${have} ${pos}${have === 1 ? "" : "s"}; the draft cap is ${cap}`,
          hint: "pick a player at another position",
        };
      }
    }
  }

  const required = requiredStartingSlots(input.settings);
  const after = [...input.roster, input.candidate];
  const unfilled = unfilledStartingSlots(required, after);
  if (unfilled.length > input.roundsRemainingAfter) {
    return {
      ok: false,
      error: "must_fill_starters",
      message:
        `after this pick you would still need ${unfilled.length} starter${unfilled.length === 1 ? "" : "s"} ` +
        `(${unfilled.join(", ")}) with only ${input.roundsRemainingAfter} pick` +
        `${input.roundsRemainingAfter === 1 ? "" : "s"} left`,
      hint: `draft one of: ${unfilled.join(", ")}`,
    };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Snake order (§3.8, §10.2)                                                  */
/* -------------------------------------------------------------------------- */

export interface SnakePosition {
  round: number;
  slotInRound: number;
  teamId: number;
}

/** `order[snake(pick_no)]` — 1-based pick number over a snake draft. */
export function snakePosition(order: number[], pickNo: number): SnakePosition | null {
  const n = order.length;
  if (n === 0 || pickNo < 1) return null;
  const round = Math.ceil(pickNo / n);
  const slotInRound = ((pickNo - 1) % n) + 1;
  const index = round % 2 === 1 ? slotInRound - 1 : n - slotInRound;
  const teamId = order[index];
  if (teamId === undefined) return null;
  return { round, slotInRound, teamId };
}

/* -------------------------------------------------------------------------- */
/* Draft board data (§10.3)                                                   */
/* -------------------------------------------------------------------------- */

export interface DraftBoardPlayer {
  player_id: string;
  name: string;
  position: string | null;
  fantasy_positions: string[] | null;
  nfl_team: string | null;
  rank: number | null;
  pos_rank: string | null;
  tier: number | null;
  adp: number | null;
  last_season_points: number | null;
  proj_points: number | null;
  bye_week: number | null;
  injury_status: string | null;
}

/** Bye weeks: an NFL team's bye is a scheduled week in which it has no game. */
async function byeWeekByNflTeam(db: EngineDb, season: number): Promise<Map<string, number>> {
  const games = await db
    .select({ week: nflGames.week, home: nflGames.home, away: nflGames.away })
    .from(nflGames)
    .where(eq(nflGames.season, season));
  if (games.length === 0) return new Map();
  const weeks = [...new Set(games.map((g) => g.week))].sort((a, b) => a - b);
  const playing = new Map<number, Set<string>>();
  const allTeams = new Set<string>();
  for (const g of games) {
    let set = playing.get(g.week);
    if (!set) {
      set = new Set<string>();
      playing.set(g.week, set);
    }
    set.add(g.home);
    set.add(g.away);
    allTeams.add(g.home);
    allTeams.add(g.away);
  }
  const byes = new Map<string, number>();
  for (const team of allTeams) {
    for (const w of weeks) {
      if (!playing.get(w)?.has(team)) {
        byes.set(team, w);
        break;
      }
    }
  }
  return byes;
}

/**
 * Every undrafted, active, draftable player with the §10.3 board columns.
 * "Undrafted" means no `draft_picks` row and no `roster_entries` row.
 */
export async function availableDraftPlayers(db: EngineDb, season: number): Promise<DraftBoardPlayer[]> {
  const [taken, rosterRows, rankRows, lastSeason, proj, byes] = await Promise.all([
    db.select({ playerId: draftPicks.playerId }).from(draftPicks),
    db.select({ playerId: rosterEntries.playerId }).from(rosterEntries),
    db
      .select({
        playerId: rankings.playerId,
        rank: rankings.rank,
        posRank: rankings.posRank,
        tier: rankings.tier,
        adp: rankings.adp,
      })
      .from(rankings)
      .where(and(eq(rankings.set, "draft"), eq(rankings.week, 0))),
    // Prefer the week-0 season-total row (ingest.season_stats) and fall back
    // to summing weekly rows, so the two shapes never double-count.
    db
      .select({
        playerId: playerWeekStats.playerId,
        points: sql<number>`coalesce(sum(${playerWeekStats.ptsPpr}) filter (where ${playerWeekStats.week} = 0), sum(coalesce(${playerWeekStats.ptsPpr}, 0)) filter (where ${playerWeekStats.week} > 0), 0)`.mapWith(Number),
      })
      .from(playerWeekStats)
      .where(eq(playerWeekStats.season, season - 1))
      .groupBy(playerWeekStats.playerId),
    db
      .select({ playerId: playerWeekProj.playerId, proj: playerWeekProj.projPtsPpr })
      .from(playerWeekProj)
      .where(and(eq(playerWeekProj.season, season), eq(playerWeekProj.week, 0))),
    byeWeekByNflTeam(db, season),
  ]);

  const unavailable = new Set<string>([...taken.map((t) => t.playerId), ...rosterRows.map((r) => r.playerId)]);
  const rankBy = new Map(rankRows.map((r) => [r.playerId, r]));
  const lastBy = new Map(lastSeason.map((r) => [r.playerId, r.points]));
  const projBy = new Map(proj.map((r) => [r.playerId, r.proj]));

  const pool = await db
    .select({
      playerId: players.playerId,
      fullName: players.fullName,
      position: players.position,
      fantasyPositions: players.fantasyPositions,
      nflTeam: players.nflTeam,
      status: players.status,
      injuryStatus: players.injuryStatus,
    })
    .from(players)
    .where(and(eq(players.active, true), inArray(players.position, DRAFTABLE_POSITIONS)));

  return pool
    .filter((p) => !unavailable.has(p.playerId))
    .map((p) => {
      const r = rankBy.get(p.playerId);
      return {
        player_id: p.playerId,
        name: p.fullName,
        position: p.position,
        fantasy_positions: p.fantasyPositions,
        nfl_team: p.nflTeam,
        rank: r?.rank ?? null,
        pos_rank: r?.posRank ?? null,
        tier: r?.tier ?? null,
        adp: r?.adp ?? null,
        last_season_points: lastBy.get(p.playerId) ?? null,
        proj_points: projBy.get(p.playerId) ?? null,
        bye_week: p.nflTeam ? (byes.get(p.nflTeam) ?? null) : null,
        injury_status: p.injuryStatus ?? p.status ?? null,
      };
    });
}

/* -------------------------------------------------------------------------- */
/* Auto-pick (§10.4)                                                          */
/* -------------------------------------------------------------------------- */

function byRankThenName(a: DraftBoardPlayer, b: DraftBoardPlayer): number {
  const ar = a.rank ?? Number.POSITIVE_INFINITY;
  const br = b.rank ?? Number.POSITIVE_INFINITY;
  if (ar !== br) return ar - br;
  return a.player_id.localeCompare(b.player_id);
}

function byNumberDesc(key: "last_season_points" | "proj_points") {
  return (a: DraftBoardPlayer, b: DraftBoardPlayer): number => {
    const av = a[key] ?? Number.NEGATIVE_INFINITY;
    const bv = b[key] ?? Number.NEGATIVE_INFINITY;
    if (av !== bv) return bv - av;
    return a.player_id.localeCompare(b.player_id);
  };
}

/**
 * §10.4 auto-pick choice: the highest-ranked available player that passes both
 * roster rules; if no ranked player qualifies, the best by last-season points;
 * then the best preseason projection; then any eligible player.
 * Returns null only when nothing at all can legally be drafted.
 *
 * Exported for the draft workflow (§10.2), which calls it when a pick clock
 * expires or a session ends without a pick.
 */
export async function autoPickCandidate(
  db: EngineDb,
  teamId: number,
  pickNo: number,
): Promise<DraftBoardPlayer | null> {
  const settings = await getSettings(db);
  const roster = await db
    .select({ position: players.position, fantasyPositions: players.fantasyPositions })
    .from(rosterEntries)
    .innerJoin(players, eq(players.playerId, rosterEntries.playerId))
    .where(eq(rosterEntries.teamId, teamId));

  const teamCount = (await db.select({ order: draft.order }).from(draft).where(eq(draft.id, 1)))[0]?.order?.length ?? 12;
  const round = teamCount > 0 ? Math.ceil(pickNo / teamCount) : 1;
  const roundsRemainingAfter = Math.max(0, settings.draftRounds - round);

  const pool = await availableDraftPlayers(db, settings.season);
  const passes = (p: DraftBoardPlayer): boolean =>
    checkDraftRosterRules({
      settings,
      roster,
      candidate: { position: p.position, fantasyPositions: p.fantasy_positions },
      roundsRemainingAfter,
    }).ok;

  const legal = pool.filter(passes);
  if (legal.length === 0) return null;

  const ranked = legal.filter((p) => p.rank !== null).sort(byRankThenName);
  if (ranked.length > 0) return ranked[0]!;

  const byLast = legal.filter((p) => p.last_season_points !== null).sort(byNumberDesc("last_season_points"));
  if (byLast.length > 0) return byLast[0]!;

  const byProj = legal.filter((p) => p.proj_points !== null).sort(byNumberDesc("proj_points"));
  if (byProj.length > 0) return byProj[0]!;

  return [...legal].sort((a, b) => a.player_id.localeCompare(b.player_id))[0]!;
}

/* -------------------------------------------------------------------------- */
/* get_draft_state                                                            */
/* -------------------------------------------------------------------------- */

export const getDraftStateTool = defineTool({
  name: "get_draft_state",
  description:
    "The draft right now: the full order, the current round and pick, who is on the clock, the picks you " +
    "have made, how many picks until your next turn, the last 12 picks league-wide, and the starting slots " +
    "your roster still needs to fill.",
  schema: z.object({}),
  execute: async (_args, ctx) => {
    const settings = await getSettings(ctx.db);
    const row = (await ctx.db.select().from(draft).where(eq(draft.id, 1)))[0];
    if (!row) return toolFailure("not_found", "the draft has not been set up yet");
    const order = row.order ?? [];
    const currentPick = row.currentPick ?? null;
    const here = currentPick !== null ? snakePosition(order, currentPick) : null;

    const allPicks = await ctx.db
      .select({
        pickNo: draftPicks.pickNo,
        round: draftPicks.round,
        teamId: draftPicks.teamId,
        playerId: draftPicks.playerId,
        madeBy: draftPicks.madeBy,
        reason: draftPicks.reason,
        name: players.fullName,
        position: players.position,
        nflTeam: players.nflTeam,
      })
      .from(draftPicks)
      .innerJoin(players, eq(players.playerId, draftPicks.playerId))
      .orderBy(draftPicks.pickNo);

    const asRow = (p: (typeof allPicks)[number]) => ({
      pick_no: p.pickNo,
      round: p.round,
      team_id: p.teamId,
      player_id: p.playerId,
      name: p.name,
      position: p.position,
      nfl_team: p.nflTeam,
      made_by: p.madeBy,
      reason: p.reason,
    });

    // Picks until my next turn: 0 when I am on the clock now.
    let picksUntilMyTurn: number | null = null;
    let myNextPick: number | null = null;
    if (ctx.teamId !== null && currentPick !== null && order.length > 0) {
      const lastPick = order.length * settings.draftRounds;
      for (let p = currentPick; p <= lastPick; p++) {
        if (snakePosition(order, p)?.teamId === ctx.teamId) {
          myNextPick = p;
          picksUntilMyTurn = p - currentPick;
          break;
        }
      }
    }

    const myRoster =
      ctx.teamId === null
        ? []
        : await ctx.db
            .select({ position: players.position, fantasyPositions: players.fantasyPositions })
            .from(rosterEntries)
            .innerJoin(players, eq(players.playerId, rosterEntries.playerId))
            .where(eq(rosterEntries.teamId, ctx.teamId));

    return {
      ok: true,
      status: row.status,
      rounds: settings.draftRounds,
      teams: order.length,
      order,
      round: here?.round ?? null,
      pick_no: currentPick,
      slot_in_round: here?.slotInRound ?? null,
      on_the_clock_team_id: here?.teamId ?? null,
      my_team_id: ctx.teamId,
      is_my_pick: here !== null && here.teamId === ctx.teamId,
      clock_ends_at: row.clockEndsAt?.toISOString() ?? null,
      my_picks: allPicks.filter((p) => p.teamId === ctx.teamId).map(asRow),
      my_next_pick_no: myNextPick,
      picks_until_my_turn: picksUntilMyTurn,
      last_picks: allPicks.slice(-RECENT_PICKS).map(asRow),
      my_roster_needs: unfilledStartingSlots(requiredStartingSlots(settings), myRoster),
    };
  },
});

/* -------------------------------------------------------------------------- */
/* get_available_players                                                      */
/* -------------------------------------------------------------------------- */

const getAvailablePlayersSchema = z.object({
  position: z.enum(["QB", "RB", "WR", "TE", "K", "DST", "DEF", "FLEX"]).optional(),
  limit: z.number().int().min(1).max(MAX_AVAILABLE_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  sort: z.enum(["rank", "last_season", "proj"]).optional(),
});

export const getAvailablePlayersTool = defineTool({
  name: "get_available_players",
  description:
    "Undrafted players with consensus rank, position rank, tier and ADP, last-season fantasy points, this " +
    `season's projection when we have one, bye week and injury status. limit is at most ` +
    `${MAX_AVAILABLE_LIMIT}; use offset to page. sort is 'rank' (default), 'last_season' or 'proj'. ` +
    "position filters to QB, RB, WR, TE, K, DST or FLEX (RB/WR/TE).",
  schema: getAvailablePlayersSchema,
  execute: async (args, ctx) => {
    const settings = await getSettings(ctx.db);
    // Week 0 is the season-long projection board behind `proj_points` (§10.3);
    // the player feed carries the injury column next to it.
    await Promise.all([ctx.refreshProjections?.(settings.season, 0), ctx.refreshPlayerFeed?.()]);
    let pool = await availableDraftPlayers(ctx.db, settings.season);

    if (args.position) {
      const wanted =
        args.position === "FLEX"
          ? ["RB", "WR", "TE"]
          : args.position === "DST"
            ? ["DEF"]
            : [args.position];
      pool = pool.filter((p) => {
        const positions =
          p.fantasy_positions && p.fantasy_positions.length > 0
            ? p.fantasy_positions
            : p.position
              ? [p.position]
              : [];
        return wanted.some((w) => positions.includes(w));
      });
    }

    const sort = args.sort ?? "rank";
    pool.sort(
      sort === "last_season"
        ? byNumberDesc("last_season_points")
        : sort === "proj"
          ? byNumberDesc("proj_points")
          : byRankThenName,
    );

    return {
      ok: true,
      ...pageRows(pool, args.offset ?? 0, args.limit ?? MAX_AVAILABLE_LIMIT, { sort }),
    };
  },
});

/* -------------------------------------------------------------------------- */
/* make_pick                                                                  */
/* -------------------------------------------------------------------------- */

const makePickSchema = z.object({
  player_id: z.string().min(1),
  /*
   * The limit is stated three times on purpose — here, in the tool
   * description, and in the draft brief. Every invalid tool call in the 2026
   * draft was this one field and nothing else: ten rejections, no rule
   * violations. GLM-5.3 hit it seven times in fourteen picks, and could not
   * learn from any of them, because a pick is a fresh session and the only
   * thing that carries across is the scratchpad. The default rejection did name
   * the field — the runner prefixes the Zod issue path, so the model read
   * "make_pick: reason Too big: expected string to have <=200 characters" — but
   * it never said that resubmitting a shorter reason is the fix, and on a
   * 180-second clock the retry costs a model step the agent may not have.
   */
  reason: z
    .string()
    .min(1)
    .max(
      MAX_PICK_REASON_CHARS,
      `the reason must be at most ${MAX_PICK_REASON_CHARS} characters; shorten it to one line and call make_pick again`,
    ),
});

/**
 * Ending tool (§8.2 step 4): a successful pick finishes the draft session, and
 * the reason becomes the decision log for the pick.
 */
export const makePickTool = defineTool({
  name: "make_pick",
  description:
    `Draft a player. Give a one-line reason (at most ${MAX_PICK_REASON_CHARS} characters) — it is public ` +
    "and becomes your decision log for this pick. The player joins your bench. This ends the session, so " +
    "call it once you have decided.",
  schema: makePickSchema,
  ending: true,
  execute: async (args, ctx): Promise<ToolResult> => {
    if (ctx.teamId === null) {
      return toolFailure("wrong_session_kind", "make_pick needs a team; reporter sessions do not have one");
    }
    const teamId = ctx.teamId;
    const sessionPickNo = ctx.sessionContext["pick_no"];
    if (typeof sessionPickNo !== "number") {
      return toolFailure(
        "wrong_session_kind",
        "make_pick is only available in a draft_pick session (this session has no pick number)",
      );
    }

    return ctx.db.transaction(async (tx): Promise<ToolResult> => {
      const settings = await getSettings(tx);
      // Locked for the pick: an auto-pick firing on the same clock expiry
      // would otherwise collide on the draft_picks primary key and throw,
      // instead of one of the two simply finding the pick already made.
      const row = (await tx.select().from(draft).where(eq(draft.id, 1)).for("update"))[0];
      if (!row) return toolFailure("draft_not_running", "the draft has not been set up yet");
      if (row.status !== "running") {
        return toolFailure("draft_not_running", `the draft is '${row.status}', not running`, "wait for the draft to resume");
      }
      const order = row.order ?? [];
      const currentPick = row.currentPick;
      if (currentPick === null || sessionPickNo !== currentPick) {
        return toolFailure(
          "not_your_pick",
          `this session is for pick ${sessionPickNo}, but the draft is on pick ${currentPick ?? "none"}`,
          "your pick has already been made or the clock moved on",
        );
      }
      const here = snakePosition(order, currentPick);
      if (!here) return toolFailure("draft_not_running", `pick ${currentPick} is not in the draft order`);
      if (here.teamId !== teamId) {
        return toolFailure(
          "not_your_pick",
          `pick ${currentPick} belongs to team ${here.teamId}, not team ${teamId}`,
        );
      }

      const player = (
        await tx
          .select({
            playerId: players.playerId,
            fullName: players.fullName,
            position: players.position,
            fantasyPositions: players.fantasyPositions,
            nflTeam: players.nflTeam,
          })
          .from(players)
          .where(eq(players.playerId, args.player_id))
      )[0];
      if (!player) {
        return toolFailure("not_found", `no player with id ${args.player_id}`, "use get_available_players for valid ids");
      }

      const alreadyPicked = await tx
        .select({ pickNo: draftPicks.pickNo, teamId: draftPicks.teamId })
        .from(draftPicks)
        .where(eq(draftPicks.playerId, args.player_id));
      const alreadyRostered = await tx
        .select({ teamId: rosterEntries.teamId })
        .from(rosterEntries)
        .where(eq(rosterEntries.playerId, args.player_id));
      if (alreadyPicked.length > 0 || alreadyRostered.length > 0) {
        const by = alreadyPicked[0]?.teamId ?? alreadyRostered[0]?.teamId;
        return toolFailure(
          "already_drafted",
          `${player.fullName} was already drafted by team ${by}`,
          "call get_available_players again — the board moved",
        );
      }

      const roster = await tx
        .select({ position: players.position, fantasyPositions: players.fantasyPositions })
        .from(rosterEntries)
        .innerJoin(players, eq(players.playerId, rosterEntries.playerId))
        .where(eq(rosterEntries.teamId, teamId));

      const rules = checkDraftRosterRules({
        settings,
        roster,
        candidate: { position: player.position, fantasyPositions: player.fantasyPositions },
        roundsRemainingAfter: Math.max(0, settings.draftRounds - here.round),
      });
      if (!rules.ok) return toolFailure(rules.error, rules.message, rules.hint);

      const pickedAt = ctx.clock.now();
      await tx.insert(draftPicks).values({
        pickNo: currentPick,
        round: here.round,
        slotInRound: here.slotInRound,
        teamId,
        playerId: player.playerId,
        madeBy: "agent",
        reason: args.reason,
        pickedAt,
      });
      await tx.insert(rosterEntries).values({
        teamId,
        playerId: player.playerId,
        acquiredVia: "draft",
        acquiredAt: pickedAt,
      });
      // Draft-time slotting (commissioner, 2026-08-29): fill the first open
      // eligible starting slot; bench only when none is open. §7.8's
      // arrive-on-the-bench rule still governs waivers and free agency.
      await autofillDraftLineupSlot(
        tx,
        teamId,
        { playerId: player.playerId, position: player.position, fantasyPositions: player.fantasyPositions },
        settings.currentWeek,
      );
      await recordTransaction(tx, {
        type: "draft_pick",
        week: null,
        teamIds: [teamId],
        payload: {
          pick_no: currentPick,
          round: here.round,
          slot_in_round: here.slotInRound,
          player_id: player.playerId,
          name: player.fullName,
          position: player.position,
          nfl_team: player.nflTeam,
          made_by: "agent",
          reason: args.reason,
        },
      });

      return {
        ok: true,
        pick_no: currentPick,
        round: here.round,
        player_id: player.playerId,
        name: player.fullName,
        position: player.position,
        nfl_team: player.nflTeam,
        reason: args.reason,
      };
    });
  },
});

/* -------------------------------------------------------------------------- */

/** Every draft tool (§8.4 table 4), in table order. */
export const DRAFT_TOOLS: LeagueTool[] = [
  getDraftStateTool,
  getAvailablePlayersTool,
  makePickTool,
] as unknown as LeagueTool[];
