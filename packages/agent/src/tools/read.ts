/**
 * Read tools (SPEC §8.4, first table). Every team agent and the reporter get
 * exactly these, with the same schemas and the same information.
 *
 * Rules honored here:
 * - Current week / season / phase always come from `league_settings` (§4.3).
 * - Lock state is computed from kickoffs, never stored (§3.3).
 * - While a trade is in review only vote *counts* are visible (§3.5).
 * - A team tool never reads another team's scratchpad or transcripts (§15.5).
 * - No tool result ever contains an API key or an environment value (§15.5).
 * - Long lists are paged with `pageRows`, never silently cut (§8.2).
 */
import {
  and,
  arrayContains,
  arrayOverlaps,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  lt,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { formatEt } from "@league/shared";
import type { EngineDb, LeagueSettings, LineupSlot } from "@league/engine";
import {
  STARTING_SLOTS,
  activeCount,
  boardPosts,
  computeStandings,
  getRoster,
  getSettings,
  isIrIllegal,
  lineupEntries,
  lockedPlayerIds,
  matchups,
  nextWaiverRunTime,
  nflGames,
  playerWeekProj,
  rankings,
  playerWeekStats,
  players,
  readScratchpad,
  rosterEntries,
  teamWeekResults,
  teams,
  tradeVotes,
  trades,
  transactions,
  waiverClaims,
  waiverRuns,
} from "@league/engine";
import type { LeagueTool, ToolContext, ToolResult } from "./types.ts";
import { pageRows, toolFailure } from "./types.ts";

/* ------------------------------------------------------------------ *
 * shared helpers
 * ------------------------------------------------------------------ */

/** Positions that can fill a fantasy slot (§3.1). */
const FANTASY_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;

/** Stat keys worth showing a model; the raw Sleeper stats object is far larger. */
const KEY_STAT_KEYS = [
  "pass_att",
  "pass_cmp",
  "pass_yd",
  "pass_td",
  "pass_int",
  "pass_2pt",
  "rush_att",
  "rush_yd",
  "rush_td",
  "rush_2pt",
  "rec",
  "rec_tgt",
  "rec_yd",
  "rec_td",
  "rec_2pt",
  "fum_lost",
  "fgm",
  "fga",
  "xpm",
  "sack",
  "int",
  "ff",
  "fum_rec",
  "def_td",
  "pts_allow",
];

/** Upper bound on rows scanned for the list tools before paging (§8.2 payload rule). */
const MAX_CANDIDATES = 400;

const NO_TEAM_HINT = "reporter sessions have no roster; use the reporter tools for team data";

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function et(d: Date | null | undefined): string | null {
  return d ? formatEt(d) : null;
}

/**
 * Tool payloads are re-read by the model on every later step of a session, so
 * a field that repeats another costs its tokens many times over (measured
 * 2026-09-03: the average step carried 80–125k tokens of earlier results).
 * A player's eligible slots are listed only when they add to the position.
 */
function extraPositions(
  position: string | null,
  fantasyPositions: string[] | null | undefined,
): { fantasy_positions?: string[] } {
  const extra = (fantasyPositions ?? []).filter((fp) => fp !== position);
  return extra.length > 0 ? { fantasy_positions: fantasyPositions ?? [] } : {};
}

/**
 * The same rule for a transaction's payload: a lineup transaction stores the
 * whole lineup before and after, but the `diff` already names every slot
 * that changed, so only the diff is returned (an empty diff is a lineup
 * re-set to itself).
 */
function compactTransactionPayload(type: string, payload: unknown): unknown {
  if (type !== "lineup" || !payload || typeof payload !== "object") return payload;
  const { before: _before, after: _after, ...rest } = payload as Record<string, unknown>;
  return rest;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function keyStats(stats: Record<string, number> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!stats) return out;
  for (const k of KEY_STAT_KEYS) {
    const v = stats[k];
    if (typeof v === "number" && v !== 0) out[k] = v;
  }
  return out;
}

/** Max active players (every slot but IR): 14 by default (§3.1). */
function maxActive(settings: LeagueSettings): number {
  const s = settings.rosterSlots;
  return s.QB + s.RB + s.WR + s.TE + s.FLEX + s.DST + s.K + s.BN;
}

async function teamIndex(db: EngineDb): Promise<
  Map<number, { id: number; name: string | null; modelId: string; modelLabel: string; slug: string; paused: boolean; waiverPriority: number | null }>
> {
  const rows = await db
    .select({
      id: teams.id,
      name: teams.name,
      modelId: teams.modelId,
      modelLabel: teams.modelLabel,
      slug: teams.slug,
      paused: teams.paused,
      waiverPriority: teams.waiverPriority,
    })
    .from(teams);
  return new Map(rows.map((t) => [t.id, t]));
}

interface GameInfo {
  gameId: string;
  kickoffAt: Date;
  opponent: string;
  home: boolean;
  status: string;
}

/** NFL team → its game in `week`, plus the set of teams already kicked off. */
async function weekGames(
  db: EngineDb,
  season: number,
  week: number,
  now: Date,
): Promise<{ byTeam: Map<string, GameInfo>; kickedOff: Set<string>; games: Array<typeof nflGames.$inferSelect> }> {
  const games = await db
    .select()
    .from(nflGames)
    .where(and(eq(nflGames.season, season), eq(nflGames.week, week)))
    .orderBy(asc(nflGames.kickoffAt));
  const byTeam = new Map<string, GameInfo>();
  const kickedOff = new Set<string>();
  for (const g of games) {
    byTeam.set(g.home, { gameId: g.gameId, kickoffAt: g.kickoffAt, opponent: g.away, home: true, status: g.status });
    byTeam.set(g.away, { gameId: g.gameId, kickoffAt: g.kickoffAt, opponent: g.home, home: false, status: g.status });
    if (g.kickoffAt <= now) {
      kickedOff.add(g.home);
      kickedOff.add(g.away);
    }
  }
  return { byTeam, kickedOff, games };
}

/** NFL team → bye week for the season (the week with no game), computed from the schedule. */
async function byeWeeks(db: EngineDb, season: number): Promise<Map<string, number | null>> {
  const rows = await db
    .select({ week: nflGames.week, home: nflGames.home, away: nflGames.away })
    .from(nflGames)
    .where(eq(nflGames.season, season));
  const weeksByTeam = new Map<string, Set<number>>();
  let maxWeek = 0;
  for (const r of rows) {
    maxWeek = Math.max(maxWeek, r.week);
    for (const t of [r.home, r.away]) {
      const set = weeksByTeam.get(t) ?? new Set<number>();
      set.add(r.week);
      weeksByTeam.set(t, set);
    }
  }
  const out = new Map<string, number | null>();
  for (const [team, weeks] of weeksByTeam) {
    let bye: number | null = null;
    for (let w = 1; w <= maxWeek; w++) {
      if (!weeks.has(w)) {
        bye = w;
        break;
      }
    }
    out.set(team, bye);
  }
  return out;
}

async function weekPoints(
  db: EngineDb,
  season: number,
  week: number,
  playerIds: string[],
): Promise<Map<string, { pts: number | null; stats: Record<string, number>; final: boolean }>> {
  if (playerIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(playerWeekStats)
    .where(
      and(
        eq(playerWeekStats.season, season),
        eq(playerWeekStats.week, week),
        inArray(playerWeekStats.playerId, playerIds),
      ),
    );
  return new Map(rows.map((r) => [r.playerId, { pts: r.ptsPpr, stats: keyStats(r.stats), final: r.final }]));
}

async function seasonPoints(db: EngineDb, season: number, playerIds: string[]): Promise<Map<string, number>> {
  if (playerIds.length === 0) return new Map();
  const rows = await db
    .select({
      playerId: playerWeekStats.playerId,
      pts: sql<number>`coalesce(sum(${playerWeekStats.ptsPpr}), 0)::float8`,
    })
    .from(playerWeekStats)
    .where(and(eq(playerWeekStats.season, season), inArray(playerWeekStats.playerId, playerIds)))
    .groupBy(playerWeekStats.playerId);
  return new Map(rows.map((r) => [r.playerId, round2(Number(r.pts))]));
}

async function weekProjections(
  db: EngineDb,
  season: number,
  week: number,
  playerIds: string[],
): Promise<Map<string, number | null>> {
  if (playerIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(playerWeekProj)
    .where(
      and(
        eq(playerWeekProj.season, season),
        eq(playerWeekProj.week, week),
        inArray(playerWeekProj.playerId, playerIds),
      ),
    );
  return new Map(rows.map((r) => [r.playerId, r.projPtsPpr]));
}

interface Ownership {
  status: "rostered" | "on_waivers" | "free_agent";
  team_id?: number;
  team_name?: string | null;
  waiver_until?: string | null;
}

/** Ownership of each id: rostered by a team, on waivers, or a free agent (§3.4). */
async function ownershipOf(db: EngineDb, playerIds: string[]): Promise<Map<string, Ownership>> {
  const out = new Map<string, Ownership>();
  if (playerIds.length === 0) return out;
  const owned = await db
    .select({ playerId: rosterEntries.playerId, teamId: rosterEntries.teamId, name: teams.name })
    .from(rosterEntries)
    .innerJoin(teams, eq(teams.id, rosterEntries.teamId))
    .where(inArray(rosterEntries.playerId, playerIds));
  for (const o of owned) out.set(o.playerId, { status: "rostered", team_id: o.teamId, team_name: o.name });
  const rest = playerIds.filter((id) => !out.has(id));
  if (rest.length > 0) {
    const rows = await db
      .select({ playerId: players.playerId, waiverUntil: players.waiverUntil })
      .from(players)
      .where(inArray(players.playerId, rest));
    for (const r of rows) {
      out.set(
        r.playerId,
        r.waiverUntil
          ? { status: "on_waivers", waiver_until: iso(r.waiverUntil) }
          : { status: "free_agent", waiver_until: null },
      );
    }
  }
  return out;
}

/** Slot of each rostered player for a week; unnamed players are on the bench (§3.1). */
async function lineupSlots(db: EngineDb, teamId: number, week: number): Promise<Map<string, LineupSlot>> {
  const rows = await db
    .select({ playerId: lineupEntries.playerId, slot: lineupEntries.slot })
    .from(lineupEntries)
    .where(and(eq(lineupEntries.teamId, teamId), eq(lineupEntries.week, week)));
  return new Map(rows.map((r) => [r.playerId, r.slot]));
}

/** The one roster payload shape shared by get_my_team and get_team_roster (§8.4). */
async function rosterPayload(
  ctx: ToolContext,
  settings: LeagueSettings,
  teamId: number,
  week: number,
): Promise<ToolResult> {
  const db = ctx.db;
  const idx = await teamIndex(db);
  const team = idx.get(teamId);
  if (!team) return toolFailure("not_found", `team ${teamId} does not exist`);

  const season = settings.season;
  // Lineup decisions deserve live numbers: pull the projection and player
  // feeds for the current (or a future) week BEFORE any read — the roster
  // read below carries injury status, so refreshing after it would return
  // pre-refresh injuries on the very call that refreshed. Past weeks never
  // move.
  if (week >= settings.currentWeek) {
    await Promise.all([ctx.refreshProjections?.(season, week), ctx.refreshPlayerFeed?.()]);
  }
  const roster = await getRoster(db, teamId);
  const ids = roster.map((r) => r.playerId);
  const now = ctx.clock.now();
  const [{ byTeam }, byes, slots, pts, seasonPts, proj, locked] = await Promise.all([
    weekGames(db, season, week, now),
    byeWeeks(db, season),
    lineupSlots(db, teamId, week),
    weekPoints(db, season, week, ids),
    seasonPoints(db, season, ids),
    weekProjections(db, season, week, ids),
    lockedPlayerIds(db, ctx.clock, season, week, ids),
  ]);

  const rows = roster.map((p) => {
    const game = p.nflTeam ? byTeam.get(p.nflTeam) : undefined;
    const bye = p.nflTeam ? (byes.get(p.nflTeam) ?? null) : null;
    const stat = pts.get(p.playerId);
    return {
      player_id: p.playerId,
      name: p.fullName,
      slot: slots.get(p.playerId) ?? "BN",
      position: p.position,
      ...extraPositions(p.position, p.fantasyPositions),
      nfl_team: p.nflTeam,
      opponent: game ? `${game.home ? "vs" : "@"} ${game.opponent}` : null,
      kickoff_et: et(game?.kickoffAt ?? null),
      on_bye_this_week: p.nflTeam !== null && game === undefined,
      bye_week: bye,
      status: p.status,
      injury_status: p.injuryStatus,
      locked: locked.has(p.playerId),
      points_this_week: stat?.pts ?? null,
      points_final: stat?.final ?? false,
      season_points: seasonPts.get(p.playerId) ?? 0,
      proj_pts_ppr: proj.get(p.playerId) ?? null,
      acquired_via: p.acquiredVia,
    };
  });

  const filled = new Set(rows.filter((r) => STARTING_SLOTS.includes(r.slot as never)).map((r) => r.slot));
  const standings = await computeStandings(db);
  const record = standings.find((s) => s.teamId === teamId);

  return {
    team: {
      id: team.id,
      name: team.name,
      model: team.modelLabel,
      ...(team.paused ? { paused: true } : {}),
      waiver_priority: team.waiverPriority,
      record: record
        ? { wins: record.wins, losses: record.losses, ties: record.ties, points_for: record.pointsFor }
        : null,
    },
    week,
    season,
    players: rows,
    active_players: rows.filter((r) => r.slot !== "IR").length,
    max_active: maxActive(settings),
    empty_starting_slots: STARTING_SLOTS.filter((s) => !filled.has(s)),
  };
}

/** Roster legality flags for the pending-items block (§3.1, §3.6, §8.4). */
async function rosterFlags(
  ctx: ToolContext,
  settings: LeagueSettings,
  teamId: number,
  week: number,
): Promise<Record<string, unknown>> {
  const active = await activeCount(ctx.db, teamId, week);
  const irIllegal = await isIrIllegal(ctx.db, settings, teamId, week);
  const slots = await lineupSlots(ctx.db, teamId, week);
  const filled = new Set([...slots.values()]);
  return {
    ir_illegal: irIllegal,
    active_players: active,
    max_active: maxActive(settings),
    over_active_limit: active > maxActive(settings),
    empty_starting_slots: STARTING_SLOTS.filter((s) => !filled.has(s)),
  };
}

/* ------------------------------------------------------------------ *
 * tool factory
 * ------------------------------------------------------------------ */

function readTool<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>,
): LeagueTool {
  return {
    name,
    description,
    schema,
    execute: async (raw, ctx) => execute(schema.parse(raw) as z.infer<S>, ctx),
  };
}

const noArgs = z.object({});
const weekArg = z.object({ week: z.number().int().min(1).max(18).optional() });

/* ------------------------------------------------------------------ *
 * get_league_state
 * ------------------------------------------------------------------ */

export const getLeagueStateTool = readTool(
  "get_league_state",
  "The whole league at a glance: season, week, phase, your team, every team's record, standings, waiver order, the next waiver run, the next lock times this week, the trade deadline, and anything waiting on you.",
  noArgs,
  async (_args, ctx) => {
    const db = ctx.db;
    const settings = await getSettings(db);
    const now = ctx.clock.now();
    const season = settings.season;
    const week = settings.currentWeek;
    const idx = await teamIndex(db);
    const standings = await computeStandings(db);
    const me = ctx.teamId === null ? null : (idx.get(ctx.teamId) ?? null);

    const standingsRows = standings.map((s) => {
      const t = idx.get(s.teamId);
      return {
        rank: s.rank,
        team_id: s.teamId,
        name: t?.name ?? null,
        model: t?.modelLabel ?? null,
        wins: s.wins,
        losses: s.losses,
        ties: s.ties,
        win_pct: round2(s.winPct),
        points_for: s.pointsFor,
        points_against: s.pointsAgainst,
      };
    });

    const waiverOrder = [...idx.values()]
      .filter((t) => t.waiverPriority !== null)
      .sort((a, b) => (a.waiverPriority ?? 0) - (b.waiverPriority ?? 0))
      .map((t) => ({ position: t.waiverPriority, team_id: t.id, name: t.name }));

    // Next lock times this week: the upcoming kickoffs, with my players who lock then (§3.3).
    const { games } = await weekGames(db, season, week, now);
    const myRoster = ctx.teamId === null ? [] : await getRoster(db, ctx.teamId);
    const upcoming = games.filter((g) => g.kickoffAt > now);
    const byInstant = new Map<string, { kickoffAt: Date; nflTeams: string[]; myPlayers: Array<{ player_id: string; name: string }> }>();
    for (const g of upcoming) {
      const key = g.kickoffAt.toISOString();
      const slot = byInstant.get(key) ?? { kickoffAt: g.kickoffAt, nflTeams: [], myPlayers: [] };
      slot.nflTeams.push(g.home, g.away);
      for (const p of myRoster) {
        if (p.nflTeam === g.home || p.nflTeam === g.away) {
          slot.myPlayers.push({ player_id: p.playerId, name: p.fullName });
        }
      }
      byInstant.set(key, slot);
    }
    const nextLockTimes = [...byInstant.values()]
      .sort((a, b) => a.kickoffAt.getTime() - b.kickoffAt.getTime())
      .slice(0, 6)
      .map((s) => ({
        kickoff_at: iso(s.kickoffAt),
        kickoff_et: et(s.kickoffAt),
        nfl_teams: s.nflTeams,
        my_players_locking: s.myPlayers,
      }));

    // Pending items for me (§8.4, §8.5).
    let pending: Record<string, unknown> = {
      offers_awaiting_my_response: [],
      offers_i_sent: [],
      votes_owed: [],
      roster_flags: null,
    };
    if (ctx.teamId !== null) {
      const myId = ctx.teamId;
      const open = await db.select().from(trades).where(inArray(trades.status, ["proposed", "accepted"]));
      const myVotes = await db
        .select({ tradeId: tradeVotes.tradeId })
        .from(tradeVotes)
        .where(eq(tradeVotes.teamId, myId));
      const voted = new Set(myVotes.map((v) => v.tradeId));
      pending = {
        offers_awaiting_my_response: open
          .filter((t) => t.status === "proposed" && t.counterpartyTeamId === myId)
          .map((t) => ({
            trade_id: t.id,
            from_team_id: t.proposerTeamId,
            from_team: idx.get(t.proposerTeamId)?.name ?? null,
            i_would_receive: t.givePlayerIds,
            i_would_send: t.getPlayerIds,
            proposed_at: iso(t.proposedAt),
            expires_at: iso(new Date(t.proposedAt.getTime() + settings.tradeOfferExpiryHours * 3600_000)),
          })),
        offers_i_sent: open
          .filter((t) => t.status === "proposed" && t.proposerTeamId === myId)
          .map((t) => ({ trade_id: t.id, to_team_id: t.counterpartyTeamId, proposed_at: iso(t.proposedAt) })),
        votes_owed: open
          .filter(
            (t) =>
              t.status === "accepted" &&
              t.proposerTeamId !== myId &&
              t.counterpartyTeamId !== myId &&
              !voted.has(t.id) &&
              (t.reviewEndsAt === null || t.reviewEndsAt > now),
          )
          .map((t) => ({ trade_id: t.id, review_ends_at: iso(t.reviewEndsAt), review_ends_et: et(t.reviewEndsAt) })),
        roster_flags: await rosterFlags(ctx, settings, myId, week),
      };
      const claims = await db
        .select()
        .from(waiverClaims)
        .where(and(eq(waiverClaims.teamId, myId), eq(waiverClaims.status, "pending")));
      pending.pending_waiver_claims = claims.length;
    }

    const nextRun = nextWaiverRunTime(settings, now);
    return {
      season,
      week,
      phase: settings.phase,
      start_week: settings.startWeek,
      now_et: formatEt(now),
      my_team: me
        ? {
            id: me.id,
            name: me.name,
            model: me.modelLabel,
            model_id: me.modelId,
            record: standingsRows.find((s) => s.team_id === me.id) ?? null,
            waiver_position: me.waiverPriority,
          }
        : null,
      teams: [...idx.values()].map((t) => {
        const s = standings.find((r) => r.teamId === t.id);
        return {
          id: t.id,
          name: t.name,
          model: t.modelLabel,
          record: s ? { wins: s.wins, losses: s.losses, ties: s.ties, points_for: s.pointsFor } : null,
          paused: t.paused,
        };
      }),
      standings: standingsRows,
      waiver_order: waiverOrder,
      my_waiver_position: me?.waiverPriority ?? null,
      next_waiver_run: { at: iso(nextRun), et: et(nextRun) },
      next_lock_times: nextLockTimes,
      trade_deadline: {
        after_week: settings.tradeDeadlineWeek,
        description: `no new offers once week ${settings.tradeDeadlineWeek} finalizes (Tuesday 4:00 AM ET)`,
        passed: week > settings.tradeDeadlineWeek,
      },
      pending,
    };
  },
);

/* ------------------------------------------------------------------ *
 * get_my_team / get_team_roster
 * ------------------------------------------------------------------ */

export const getMyTeamTool = readTool(
  "get_my_team",
  "Your roster for a week: slot, position, NFL team, opponent, kickoff, bye, injury status, locked flag, points so far, season points, and projection.",
  weekArg,
  async (args, ctx) => {
    if (ctx.teamId === null) return toolFailure("not_found", "this session has no team", NO_TEAM_HINT);
    const settings = await getSettings(ctx.db);
    return rosterPayload(ctx, settings, ctx.teamId, args.week ?? settings.currentWeek);
  },
);

export const getTeamRosterTool = readTool(
  "get_team_roster",
  "Another team's roster for a week, in the same shape as get_my_team. Public data only — no scratchpad, no notes.",
  z.object({ team_id: z.number().int(), week: z.number().int().min(1).max(18).optional() }),
  async (args, ctx) => {
    const settings = await getSettings(ctx.db);
    return rosterPayload(ctx, settings, args.team_id, args.week ?? settings.currentWeek);
  },
);

/* ------------------------------------------------------------------ *
 * get_matchup
 * ------------------------------------------------------------------ */

async function matchupSide(
  ctx: ToolContext,
  settings: LeagueSettings,
  teamId: number,
  week: number,
  idx: Awaited<ReturnType<typeof teamIndex>>,
): Promise<Record<string, unknown>> {
  const db = ctx.db;
  const season = settings.season;
  const entries = await db
    .select({ playerId: lineupEntries.playerId, slot: lineupEntries.slot })
    .from(lineupEntries)
    .where(and(eq(lineupEntries.teamId, teamId), eq(lineupEntries.week, week)));
  const starters = entries.filter((e) => STARTING_SLOTS.includes(e.slot as never));
  const ids = starters.map((s) => s.playerId);
  const [pts, proj, locked, { byTeam }] = await Promise.all([
    weekPoints(db, season, week, ids),
    weekProjections(db, season, week, ids),
    lockedPlayerIds(db, ctx.clock, season, week, ids),
    weekGames(db, season, week, ctx.clock.now()),
  ]);
  const meta =
    ids.length === 0
      ? []
      : await db
          .select({
            playerId: players.playerId,
            fullName: players.fullName,
            position: players.position,
            nflTeam: players.nflTeam,
            injuryStatus: players.injuryStatus,
          })
          .from(players)
          .where(inArray(players.playerId, ids));
  const metaById = new Map(meta.map((m) => [m.playerId, m]));
  const t = idx.get(teamId);
  let total = 0;
  const lineup = STARTING_SLOTS.map((slot) => {
    const entry = starters.find((s) => s.slot === slot);
    if (!entry) return { slot, player_id: null, name: null, points: 0, note: "empty slot scores 0" };
    const m = metaById.get(entry.playerId);
    const p = pts.get(entry.playerId)?.pts ?? null;
    total += p ?? 0;
    const game = m?.nflTeam ? byTeam.get(m.nflTeam) : undefined;
    return {
      slot,
      player_id: entry.playerId,
      name: m?.fullName ?? null,
      position: m?.position ?? null,
      nfl_team: m?.nflTeam ?? null,
      opponent: game ? `${game.home ? "vs" : "@"} ${game.opponent}` : null,
      injury_status: m?.injuryStatus ?? null,
      locked: locked.has(entry.playerId),
      points: p,
      proj_pts_ppr: proj.get(entry.playerId) ?? null,
    };
  });
  return {
    team_id: teamId,
    name: t?.name ?? null,
    model: t?.modelLabel ?? null,
    points: round2(total),
    lineup,
  };
}

export const getMatchupTool = readTool(
  "get_matchup",
  "Your matchup for any week: past and current weeks carry both starting lineups with points by player (live or final) and projections, plus a summary of the other matchups; a future week returns the pairings only, so you can plan around who you play next.",
  weekArg,
  async (args, ctx) => {
    const db = ctx.db;
    const settings = await getSettings(db);
    const week = args.week ?? settings.currentWeek;
    // The current week's projections and injuries still move; finished weeks
    // are history and future weeks return pairings only, with neither shown.
    if (week === settings.currentWeek) {
      await Promise.all([ctx.refreshProjections?.(settings.season, week), ctx.refreshPlayerFeed?.()]);
    }
    const idx = await teamIndex(db);
    const rows = await db.select().from(matchups).where(eq(matchups.week, week));
    if (rows.length === 0) {
      return { week, my_matchup: null, other_matchups: [], note: "no matchups are scheduled for this week" };
    }
    // A future week has no lineups or points worth showing, but the pairings
    // themselves are planning information every manager gets: who you play in
    // two weeks decides trades, streams, and playoff positioning. Playoff-week
    // pairings appear once seeding creates them.
    if (week > settings.currentWeek) {
      const pairing = (m: (typeof rows)[number]) => ({
        matchup_id: m.id,
        is_playoff: m.isPlayoff,
        home: { team_id: m.homeTeamId, name: idx.get(m.homeTeamId)?.name ?? null },
        away: { team_id: m.awayTeamId, name: idx.get(m.awayTeamId)?.name ?? null },
      });
      const futureMine =
        ctx.teamId === null ? undefined : rows.find((m) => m.homeTeamId === ctx.teamId || m.awayTeamId === ctx.teamId);
      return {
        week,
        note: `week ${week} has not started: pairings only, no lineups or points`,
        my_matchup: futureMine ? pairing(futureMine) : null,
        other_matchups: rows.filter((m) => m.id !== futureMine?.id).map(pairing),
      };
    }
    const mine = ctx.teamId === null ? undefined : rows.find((m) => m.homeTeamId === ctx.teamId || m.awayTeamId === ctx.teamId);
    const summary = (m: typeof rows[number]) => ({
      matchup_id: m.id,
      final: m.final,
      is_playoff: m.isPlayoff,
      home: { team_id: m.homeTeamId, name: idx.get(m.homeTeamId)?.name ?? null, points: m.homePoints },
      away: { team_id: m.awayTeamId, name: idx.get(m.awayTeamId)?.name ?? null, points: m.awayPoints },
    });
    return {
      week,
      my_matchup: mine
        ? {
            matchup_id: mine.id,
            final: mine.final,
            is_playoff: mine.isPlayoff,
            home: await matchupSide(ctx, settings, mine.homeTeamId, week, idx),
            away: await matchupSide(ctx, settings, mine.awayTeamId, week, idx),
          }
        : null,
      other_matchups: rows.filter((m) => m.id !== mine?.id).map(summary),
    };
  },
);

/* ------------------------------------------------------------------ *
 * get_team_week_results
 * ------------------------------------------------------------------ */

export const getTeamWeekResultsTool = readTool(
  "get_team_week_results",
  "Per team and week (public benchmark data): actual points, optimal points, points left on the bench, points from free agents and waiver adds, and empty starting slots.",
  z.object({
    week: z.number().int().min(1).max(18).optional(),
    team_id: z.number().int().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  async (args, ctx) => {
    const db = ctx.db;
    const idx = await teamIndex(db);
    const conds = [
      args.week !== undefined ? eq(teamWeekResults.week, args.week) : undefined,
      args.team_id !== undefined ? eq(teamWeekResults.teamId, args.team_id) : undefined,
    ].filter((c) => c !== undefined);
    const rows = await db
      .select()
      .from(teamWeekResults)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(teamWeekResults.week), asc(teamWeekResults.teamId));
    const items = rows.map((r) => ({
      team_id: r.teamId,
      name: idx.get(r.teamId)?.name ?? null,
      model: idx.get(r.teamId)?.modelLabel ?? null,
      week: r.week,
      actual_points: r.actualPoints,
      optimal_points: r.optimalPoints,
      points_left_on_bench: r.pointsLeftOnBench,
      fa_points: r.faPoints,
      empty_starting_slots: r.emptyStartingSlots,
      lineup_efficiency: r.optimalPoints > 0 ? round2(r.actualPoints / r.optimalPoints) : null,
    }));
    return pageRows(items, args.offset ?? 0, args.limit ?? 50);
  },
);

/* ------------------------------------------------------------------ *
 * get_player_stats
 * ------------------------------------------------------------------ */

export const getPlayerStatsTool = readTool(
  "get_player_stats",
  "Up to 20 players: this season's points by week with key stats, last season's totals, injury status, NFL team, the next four opponents with projected points where loaded, bye week, and who owns them.",
  z.object({ player_ids: z.array(z.string()).min(1).max(20), offset: z.number().int().min(0).optional() }),
  async (args, ctx) => {
    const db = ctx.db;
    const settings = await getSettings(db);
    const season = settings.season;
    const week = settings.currentWeek;
    const ids = [...new Set(args.player_ids)];
    // Researching specific players is a pre-kickoff question too: the result
    // carries injury status, so it gets the same freshness as get_my_team.
    await ctx.refreshPlayerFeed?.();
    const rows = await db.select().from(players).where(inArray(players.playerId, ids));
    if (rows.length === 0) return toolFailure("not_found", "no player matched those ids", "use search_players first");

    const [stats, lastSeason, byes, own] = await Promise.all([
      db
        .select()
        .from(playerWeekStats)
        .where(and(eq(playerWeekStats.season, season), inArray(playerWeekStats.playerId, ids)))
        .orderBy(asc(playerWeekStats.week)),
      // Season totals live at week 0 (ingest.season_stats); weekly rows may sit
      // beside them if history is ever backfilled. Prefer the totals row and
      // count games only from real weeks, so a lone aggregate row does not
      // read as "1 game" and the two shapes never double-count.
      db
        .select({
          playerId: playerWeekStats.playerId,
          totalPts: sql<number>`coalesce(sum(${playerWeekStats.ptsPpr}) filter (where ${playerWeekStats.week} = 0), 0)::float8`,
          hasTotal: sql<boolean>`bool_or(${playerWeekStats.week} = 0)`,
          weeklyPts: sql<number>`coalesce(sum(${playerWeekStats.ptsPpr}) filter (where ${playerWeekStats.week} > 0), 0)::float8`,
          games: sql<number>`count(*) filter (where ${playerWeekStats.week} > 0)::int`,
        })
        .from(playerWeekStats)
        .where(and(eq(playerWeekStats.season, season - 1), inArray(playerWeekStats.playerId, ids)))
        .groupBy(playerWeekStats.playerId),
      byeWeeks(db, season),
      ownershipOf(db, ids),
    ]);
    const lastById = new Map(lastSeason.map((r) => [r.playerId, r]));

    const futureGames = await db
      .select()
      .from(nflGames)
      .where(and(eq(nflGames.season, season), sql`${nflGames.week} >= ${week}`))
      .orderBy(asc(nflGames.week), asc(nflGames.kickoffAt));
    const futureProj = await db
      .select()
      .from(playerWeekProj)
      .where(and(eq(playerWeekProj.season, season), inArray(playerWeekProj.playerId, ids), sql`${playerWeekProj.week} >= ${week}`));
    const projByPlayerWeek = new Map(futureProj.map((r) => [`${r.playerId}:${r.week}`, r.projPtsPpr]));

    const items = rows.map((p) => {
      const weekly = stats
        .filter((s) => s.playerId === p.playerId)
        .map((s) => ({ week: s.week, pts_ppr: s.ptsPpr, final: s.final, stats: keyStats(s.stats) }));
      // The next few games, not just one: bye-week planning and "add him
      // before the soft stretch" both need the lookahead in one call. A game
      // already final (Sunday night, before the week advances Tuesday) is not
      // "upcoming" — without this the lookahead silently shrinks to 3.
      const upcoming = p.nflTeam
        ? futureGames.filter((g) => g.status !== "final" && (g.home === p.nflTeam || g.away === p.nflTeam)).slice(0, 4)
        : [];
      const next = upcoming[0];
      const last = lastById.get(p.playerId);
      return {
        player_id: p.playerId,
        name: p.fullName,
        position: p.position,
        fantasy_positions: p.fantasyPositions,
        nfl_team: p.nflTeam,
        status: p.status,
        injury_status: p.injuryStatus,
        injury_body_part: p.injuryBodyPart,
        bye_week: p.nflTeam ? (byes.get(p.nflTeam) ?? null) : null,
        trending_adds: p.trendingAdds,
        next_opponent: next
          ? {
              week: next.week,
              opponent: next.home === p.nflTeam ? `vs ${next.away}` : `@ ${next.home}`,
              kickoff_at: iso(next.kickoffAt),
              kickoff_et: et(next.kickoffAt),
            }
          : null,
        upcoming_opponents: upcoming.map((g) => ({
          week: g.week,
          opponent: g.home === p.nflTeam ? `vs ${g.away}` : `@ ${g.home}`,
          kickoff_et: et(g.kickoffAt),
          proj_pts_ppr: projByPlayerWeek.get(`${p.playerId}:${g.week}`) ?? null,
        })),
        this_season: { season, by_week: weekly, total: round2(weekly.reduce((a, w) => a + (w.pts_ppr ?? 0), 0)) },
        last_season: last
          ? {
              season: season - 1,
              total_pts_ppr: round2(Number(last.hasTotal ? last.totalPts : last.weeklyPts)),
              games: Number(last.games) > 0 ? Number(last.games) : null,
            }
          : { season: season - 1, total_pts_ppr: null, games: null },
        ownership: own.get(p.playerId) ?? { status: "free_agent" },
      };
    });
    const missing = ids.filter((id) => !rows.some((r) => r.playerId === id));
    // Items are long (a season of by_week rows each); when the §8.2 page cap
    // cuts the list, has_more/next_offset point at the rest via `offset`.
    // Order by the caller's id list: Postgres guarantees no order without one,
    // and an unstable order across the two calls of a split page would repeat
    // one player and silently drop another.
    const order = new Map(ids.map((id, i) => [id, i]));
    items.sort((x, y) => (order.get(x.player_id) ?? 0) - (order.get(y.player_id) ?? 0));
    return pageRows(items, args.offset ?? 0, items.length, { missing_player_ids: missing });
  },
);

/* ------------------------------------------------------------------ *
 * search_players
 * ------------------------------------------------------------------ */

export const searchPlayersTool = readTool(
  "search_players",
  "Find players by name. Returns id, name, position, NFL team, and ownership (rostered by a team, on waivers, or a free agent).",
  z.object({
    query: z.string().min(1).max(80),
    position: z.string().max(4).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  async (args, ctx) => {
    const db = ctx.db;
    const position = args.position?.toUpperCase();
    const conds = [
      ilike(players.fullName, `%${args.query}%`),
      position ? arrayOverlaps(players.fantasyPositions, [position]) : undefined,
    ].filter((c) => c !== undefined);
    const rows = await db
      .select({
        playerId: players.playerId,
        fullName: players.fullName,
        position: players.position,
        fantasyPositions: players.fantasyPositions,
        nflTeam: players.nflTeam,
        status: players.status,
        injuryStatus: players.injuryStatus,
        active: players.active,
      })
      .from(players)
      .where(and(...conds))
      .orderBy(desc(players.active), asc(players.fullName))
      .limit(MAX_CANDIDATES);
    const own = await ownershipOf(
      db,
      rows.map((r) => r.playerId),
    );
    const items = rows.map((r) => ({
      player_id: r.playerId,
      name: r.fullName,
      position: r.position,
      ...extraPositions(r.position, r.fantasyPositions),
      nfl_team: r.nflTeam,
      status: r.status,
      injury_status: r.injuryStatus,
      active: r.active,
      ownership: own.get(r.playerId) ?? { status: "free_agent" },
    }));
    return pageRows(items, args.offset ?? 0, args.limit ?? 25, { query: args.query });
  },
);

/* ------------------------------------------------------------------ *
 * get_free_agents
 * ------------------------------------------------------------------ */

export const getFreeAgentsTool = readTool(
  "get_free_agents",
  "Unrostered players — free agents and players on waivers — with on_waivers, waiver_until, trending adds, last week's points, season points, and this week's projection.",
  z.object({
    position: z.string().max(4).optional(),
    sort: z.enum(["trending", "last_week", "season", "proj"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  async (args, ctx) => {
    const db = ctx.db;
    const settings = await getSettings(db);
    const season = settings.season;
    const week = settings.currentWeek;
    const lastWeek = week > 1 ? week - 1 : 1;
    const position = args.position?.toUpperCase();
    const sort = args.sort ?? "trending";
    // A pickup is judged on this week's projection and current injury news —
    // refresh both before reading.
    await Promise.all([ctx.refreshProjections?.(season, week), ctx.refreshPlayerFeed?.()]);

    // Correlated sub-selects keep the scan in the database; ::float8 so numeric
    // columns come back as numbers, not strings. The outer reference must be
    // the literal `players.player_id`: drizzle renders an interpolated column
    // unqualified inside a select-list expression, and a bare "player_id" here
    // rebinds to the subquery's own alias — the subquery stops being
    // correlated and returns one row per player with stats.
    const lastWeekExpr = sql<number | null>`(select s.pts_ppr::float8 from player_week_stats s where s.player_id = players.player_id and s.season = ${season} and s.week = ${lastWeek})`;
    const seasonExpr = sql<number>`coalesce((select sum(s.pts_ppr)::float8 from player_week_stats s where s.player_id = players.player_id and s.season = ${season}), 0)`;
    const projExpr = sql<number | null>`(select p.proj_pts_ppr::float8 from player_week_proj p where p.player_id = players.player_id and p.season = ${season} and p.week = ${week})`;

    const orderBy =
      sort === "trending"
        ? desc(sql`coalesce(${players.trendingAdds}, 0)`)
        : sort === "last_week"
          ? desc(sql`coalesce(${lastWeekExpr}, 0)`)
          : sort === "season"
            ? desc(sql`${seasonExpr}`)
            : desc(sql`coalesce(${projExpr}, 0)`);

    const rows = await db
      .select({
        playerId: players.playerId,
        fullName: players.fullName,
        position: players.position,
        fantasyPositions: players.fantasyPositions,
        nflTeam: players.nflTeam,
        status: players.status,
        injuryStatus: players.injuryStatus,
        waiverUntil: players.waiverUntil,
        trendingAdds: players.trendingAdds,
        lastWeekPts: lastWeekExpr,
        seasonPts: seasonExpr,
        projPts: projExpr,
      })
      .from(players)
      .where(
        and(
          eq(players.active, true),
          arrayOverlaps(players.fantasyPositions, [...FANTASY_POSITIONS]),
          position ? arrayOverlaps(players.fantasyPositions, [position]) : undefined,
          notExists(
            db.select({ one: sql`1` }).from(rosterEntries).where(eq(rosterEntries.playerId, players.playerId)),
          ),
        ),
      )
      .orderBy(orderBy, asc(players.fullName))
      .limit(MAX_CANDIDATES);

    const byes = await byeWeeks(db, season);
    const items = rows.map((r) => ({
      player_id: r.playerId,
      name: r.fullName,
      position: r.position,
      ...extraPositions(r.position, r.fantasyPositions),
      nfl_team: r.nflTeam,
      status: r.status,
      injury_status: r.injuryStatus,
      bye_week: r.nflTeam ? (byes.get(r.nflTeam) ?? null) : null,
      on_waivers: r.waiverUntil !== null,
      waiver_until: iso(r.waiverUntil),
      trending_adds: r.trendingAdds ?? 0,
      last_week_points: r.lastWeekPts === null ? null : round2(Number(r.lastWeekPts)),
      season_points: round2(Number(r.seasonPts ?? 0)),
      proj_pts_ppr: r.projPts === null ? null : round2(Number(r.projPts)),
    }));
    return pageRows(items, args.offset ?? 0, args.limit ?? 25, {
      sort,
      position: position ?? "ALL",
      week,
      note: "on_waivers players need submit_waiver_claims; free agents can be added with add_free_agent",
    });
  },
);

/* ------------------------------------------------------------------ *
 * get_nfl_schedule
 * ------------------------------------------------------------------ */

export const getNflScheduleTool = readTool(
  "get_nfl_schedule",
  "The NFL schedule for a week: every game with kickoff in ET and UTC, plus the teams on bye.",
  weekArg,
  async (args, ctx) => {
    const db = ctx.db;
    const settings = await getSettings(db);
    const season = settings.season;
    const week = args.week ?? settings.currentWeek;
    const now = ctx.clock.now();
    const { games } = await weekGames(db, season, week, now);
    const allTeams = new Set<string>();
    const seasonGames = await db
      .select({ home: nflGames.home, away: nflGames.away })
      .from(nflGames)
      .where(eq(nflGames.season, season));
    for (const g of seasonGames) {
      allTeams.add(g.home);
      allTeams.add(g.away);
    }
    const playing = new Set<string>();
    for (const g of games) {
      playing.add(g.home);
      playing.add(g.away);
    }
    return {
      season,
      week,
      games: games.map((g) => ({
        game_id: g.gameId,
        away: g.away,
        home: g.home,
        kickoff_at: iso(g.kickoffAt),
        kickoff_et: et(g.kickoffAt),
        status: g.status,
        kicked_off: g.kickoffAt <= now,
        away_score: g.awayScore,
        home_score: g.homeScore,
      })),
      byes: [...allTeams].filter((t) => !playing.has(t)).sort(),
    };
  },
);

/* ------------------------------------------------------------------ *
 * get_transactions
 * ------------------------------------------------------------------ */

export const getTransactionsTool = readTool(
  "get_transactions",
  "Recent league transactions: adds, drops, waiver adds, trades, IR moves, draft picks, and commissioner actions.",
  z.object({
    limit: z.number().int().min(1).max(100).optional(),
    team_id: z.number().int().optional(),
    offset: z.number().int().min(0).optional(),
  }),
  async (args, ctx) => {
    const db = ctx.db;
    const idx = await teamIndex(db);
    const rows = await db
      .select()
      .from(transactions)
      .where(args.team_id !== undefined ? arrayContains(transactions.teamIds, [args.team_id]) : undefined)
      .orderBy(desc(transactions.id))
      .limit(MAX_CANDIDATES);
    const items = rows.map((t) => ({
      id: t.id,
      type: t.type,
      week: t.week,
      team_ids: t.teamIds,
      teams: t.teamIds.map((id) => idx.get(id)?.name ?? null),
      payload: compactTransactionPayload(t.type, t.payload),
      at_et: et(t.createdAt),
    }));
    return pageRows(items, args.offset ?? 0, args.limit ?? 25);
  },
);

/* ------------------------------------------------------------------ *
 * get_waiver_claims
 * ------------------------------------------------------------------ */

export const getWaiverClaimsTool = readTool(
  "get_waiver_claims",
  "Your pending waiver claims in priority order, your waiver position, the next run time, and your results from the last run.",
  noArgs,
  async (_args, ctx) => {
    if (ctx.teamId === null) return toolFailure("not_found", "this session has no team", NO_TEAM_HINT);
    const db = ctx.db;
    const myId = ctx.teamId;
    const settings = await getSettings(db);
    const now = ctx.clock.now();
    const idx = await teamIndex(db);

    const pending = await db
      .select()
      .from(waiverClaims)
      .where(and(eq(waiverClaims.teamId, myId), eq(waiverClaims.status, "pending")))
      .orderBy(asc(waiverClaims.priority));
    const ids = [...new Set(pending.flatMap((c) => [c.addPlayerId, c.dropPlayerId].filter((x): x is string => !!x)))];
    const names =
      ids.length === 0
        ? []
        : await db
            .select({ playerId: players.playerId, fullName: players.fullName, waiverUntil: players.waiverUntil })
            .from(players)
            .where(inArray(players.playerId, ids));
    const nameById = new Map(names.map((n) => [n.playerId, n]));

    const runs = await db.select().from(waiverRuns).orderBy(desc(waiverRuns.id)).limit(1);
    const lastRun = runs[0];
    const myResults =
      lastRun?.summary.results.filter((r) => r.teamId === myId).map((r) => ({
        add_player_id: r.addPlayerId,
        drop_player_id: r.dropPlayerId,
        status: r.status,
        failure_reason: r.failureReason ?? null,
      })) ?? [];

    const nextRun = nextWaiverRunTime(settings, now);
    return {
      my_waiver_position: idx.get(myId)?.waiverPriority ?? null,
      waiver_order: [...idx.values()]
        .filter((t) => t.waiverPriority !== null)
        .sort((a, b) => (a.waiverPriority ?? 0) - (b.waiverPriority ?? 0))
        .map((t) => ({ position: t.waiverPriority, team_id: t.id, name: t.name })),
      next_waiver_run: { at: iso(nextRun), et: et(nextRun) },
      pending_claims: pending.map((c) => ({
        claim_id: c.id,
        priority: c.priority,
        add_player_id: c.addPlayerId,
        add_player_name: nameById.get(c.addPlayerId)?.fullName ?? null,
        add_waiver_until: iso(nameById.get(c.addPlayerId)?.waiverUntil ?? null),
        drop_player_id: c.dropPlayerId,
        drop_player_name: c.dropPlayerId ? (nameById.get(c.dropPlayerId)?.fullName ?? null) : null,
        submitted_at: iso(c.createdAt),
      })),
      last_run: lastRun
        ? {
            run_at: iso(lastRun.runAt),
            run_at_et: et(lastRun.runAt),
            my_results: myResults,
            order_after: lastRun.summary.orderAfter,
          }
        : null,
    };
  },
);

/* ------------------------------------------------------------------ *
 * get_pending_trades / get_trade
 * ------------------------------------------------------------------ */

/** Vote tally for a trade. During review only counts are ever exposed (§3.5). */
async function voteTally(
  db: EngineDb,
  tradeId: number,
  parties: number[],
): Promise<{ vetoes: number; allows: number; votes_cast: number; not_yet_voted: number }> {
  const votes = await db.select().from(tradeVotes).where(eq(tradeVotes.tradeId, tradeId));
  const allTeams = await db.select({ id: teams.id, paused: teams.paused }).from(teams);
  const pausedUninvolved = allTeams.filter((t) => t.paused && !parties.includes(t.id)).length;
  const vetoes = votes.filter((v) => v.vote === "veto").length;
  const allows = votes.filter((v) => v.vote === "allow").length + pausedUninvolved;
  const uninvolved = allTeams.length - parties.length;
  return { vetoes, allows, votes_cast: votes.length, not_yet_voted: Math.max(0, uninvolved - votes.length) };
}

export const getPendingTradesTool = readTool(
  "get_pending_trades",
  "Offers waiting on you, offers you sent, and every trade in review. While a trade is in review you see only the vote counts — never who voted (that becomes public when the trade resolves).",
  noArgs,
  async (_args, ctx) => {
    const db = ctx.db;
    const settings = await getSettings(db);
    const idx = await teamIndex(db);
    const myId = ctx.teamId;
    const open = await db
      .select()
      .from(trades)
      .where(inArray(trades.status, ["proposed", "accepted"]))
      .orderBy(desc(trades.id));

    const nameOf = (id: number) => idx.get(id)?.name ?? null;
    const inReview = [];
    for (const t of open.filter((t) => t.status === "accepted")) {
      const tally = await voteTally(db, t.id, [t.proposerTeamId, t.counterpartyTeamId]);
      inReview.push({
        trade_id: t.id,
        proposer_team_id: t.proposerTeamId,
        proposer: nameOf(t.proposerTeamId),
        counterparty_team_id: t.counterpartyTeamId,
        counterparty: nameOf(t.counterpartyTeamId),
        proposer_gives: t.givePlayerIds,
        proposer_gets: t.getPlayerIds,
        review_ends_at: iso(t.reviewEndsAt),
        review_ends_et: et(t.reviewEndsAt),
        // §3.5: counts only while in review.
        votes: tally,
        i_can_vote:
          myId !== null && myId !== t.proposerTeamId && myId !== t.counterpartyTeamId,
      });
    }

    const proposed = open.filter((t) => t.status === "proposed");
    return {
      offers_to_me:
        myId === null
          ? []
          : proposed
              .filter((t) => t.counterpartyTeamId === myId)
              .map((t) => ({
                trade_id: t.id,
                from_team_id: t.proposerTeamId,
                from_team: nameOf(t.proposerTeamId),
                i_would_receive: t.givePlayerIds,
                i_would_send: t.getPlayerIds,
                message: t.message,
                proposed_at: iso(t.proposedAt),
                expires_at: iso(new Date(t.proposedAt.getTime() + settings.tradeOfferExpiryHours * 3600_000)),
              })),
      offers_from_me:
        myId === null
          ? []
          : proposed
              .filter((t) => t.proposerTeamId === myId)
              .map((t) => ({
                trade_id: t.id,
                to_team_id: t.counterpartyTeamId,
                to_team: nameOf(t.counterpartyTeamId),
                i_give: t.givePlayerIds,
                i_get: t.getPlayerIds,
                message: t.message,
                proposed_at: iso(t.proposedAt),
              })),
      trades_in_review: inReview,
      trade_deadline: {
        after_week: settings.tradeDeadlineWeek,
        passed: settings.currentWeek > settings.tradeDeadlineWeek,
      },
    };
  },
);

export const getTradeTool = readTool(
  "get_trade",
  "One trade in full: both sides' players, the message, the status, and each roster before and after the trade. Vote details stay hidden until the trade resolves.",
  z.object({ trade_id: z.number().int() }),
  async (args, ctx) => {
    const db = ctx.db;
    const settings = await getSettings(db);
    const rows = await db.select().from(trades).where(eq(trades.id, args.trade_id));
    const trade = rows[0];
    if (!trade) return toolFailure("not_found", `trade ${args.trade_id} does not exist`);
    const idx = await teamIndex(db);
    const parties = [trade.proposerTeamId, trade.counterpartyTeamId];
    // An offer that never entered review is a private negotiation between two
    // teams: it carries a message meant for the counterparty, and trade ids
    // are sequential, so without this any agent could walk every negotiation
    // in the league — including a live one, since a countered offer's message
    // still describes a renegotiation happening right now. A trade becomes
    // league business the moment it enters review — that is what the site
    // shows, and what §11 forbids the reporter to pre-empt. Same rule for the
    // reporter, which has no team of its own. Status alone cannot draw this
    // line: `failed` has two producers (§3.5) — a review-path failure and an
    // accept-time re-check failure that never entered review. The engine sets
    // `reviewEndsAt` exactly once, on a successful accept, so it is the marker.
    if (trade.reviewEndsAt === null && (ctx.teamId === null || !parties.includes(ctx.teamId))) {
      return toolFailure(
        "not_visible",
        trade.status === "proposed"
          ? `trade ${args.trade_id} is a pending offer between two other teams`
          : `trade ${args.trade_id} is an offer between two other teams that ended without entering review`,
      );
    }
    const week = settings.currentWeek;

    const allIds = [...trade.givePlayerIds, ...trade.getPlayerIds];
    const meta =
      allIds.length === 0
        ? []
        : await db
            .select({
              playerId: players.playerId,
              fullName: players.fullName,
              position: players.position,
              nflTeam: players.nflTeam,
              injuryStatus: players.injuryStatus,
            })
            .from(players)
            .where(inArray(players.playerId, allIds));
    const seasonPts = await seasonPoints(db, settings.season, allIds);
    const detail = (id: string) => {
      const m = meta.find((x) => x.playerId === id);
      return {
        player_id: id,
        name: m?.fullName ?? null,
        position: m?.position ?? null,
        nfl_team: m?.nflTeam ?? null,
        injury_status: m?.injuryStatus ?? null,
        season_points: seasonPts.get(id) ?? 0,
      };
    };

    const rosterOf = async (teamId: number) => {
      const roster = await getRoster(db, teamId);
      return roster.map((p) => ({
        player_id: p.playerId,
        name: p.fullName,
        position: p.position,
        nfl_team: p.nflTeam,
      }));
    };
    const before = {
      [String(trade.proposerTeamId)]: await rosterOf(trade.proposerTeamId),
      [String(trade.counterpartyTeamId)]: await rosterOf(trade.counterpartyTeamId),
    };
    const applyTrade = (
      roster: Array<{ player_id: string; name: string; position: string | null; nfl_team: string | null }>,
      out: string[],
      incoming: string[],
    ) => [
      ...roster.filter((p) => !out.includes(p.player_id)),
      ...incoming.map((id) => {
        const d = detail(id);
        return { player_id: d.player_id, name: d.name ?? id, position: d.position, nfl_team: d.nfl_team };
      }),
    ];
    const after = {
      [String(trade.proposerTeamId)]: applyTrade(
        before[String(trade.proposerTeamId)] ?? [],
        trade.givePlayerIds,
        trade.getPlayerIds,
      ),
      [String(trade.counterpartyTeamId)]: applyTrade(
        before[String(trade.counterpartyTeamId)] ?? [],
        trade.getPlayerIds,
        trade.givePlayerIds,
      ),
    };

    const tally = await voteTally(db, trade.id, parties);
    const resolved = ["executed", "vetoed", "failed", "rejected", "countered", "cancelled", "expired"].includes(
      trade.status,
    );
    const votes = resolved
      ? (await db.select().from(tradeVotes).where(eq(tradeVotes.tradeId, trade.id))).map((v) => ({
          team_id: v.teamId,
          team: idx.get(v.teamId)?.name ?? null,
          vote: v.vote,
          reason: v.reason,
          at: iso(v.createdAt),
        }))
      : null;

    return {
      trade_id: trade.id,
      status: trade.status,
      proposer: { team_id: trade.proposerTeamId, name: idx.get(trade.proposerTeamId)?.name ?? null },
      counterparty: { team_id: trade.counterpartyTeamId, name: idx.get(trade.counterpartyTeamId)?.name ?? null },
      proposer_gives: trade.givePlayerIds.map(detail),
      proposer_gets: trade.getPlayerIds.map(detail),
      message: trade.message,
      proposed_at: iso(trade.proposedAt),
      responded_at: iso(trade.respondedAt),
      review_ends_at: iso(trade.reviewEndsAt),
      review_ends_et: et(trade.reviewEndsAt),
      resolved_at: iso(trade.resolvedAt),
      resolution_reason: trade.resolutionReason,
      parent_trade_id: trade.parentTradeId,
      week,
      rosters_before: before,
      rosters_after: after,
      votes: tally,
      // §3.5: who voted and why is public only once the trade resolves.
      vote_details: votes,
    };
  },
);

/* ------------------------------------------------------------------ *
 * read_board
 * ------------------------------------------------------------------ */

export const readBoardTool = readTool(
  "read_board",
  "The league message board: recent threads with author team, model, body, time, and replies. Pass thread_id to read one thread.",
  z.object({
    limit: z.number().int().min(1).max(50).optional(),
    before_id: z.number().int().optional(),
    thread_id: z.number().int().optional(),
  }),
  async (args, ctx) => {
    const db = ctx.db;
    const idx = await teamIndex(db);
    const limit = args.limit ?? 20;
    const author = (teamId: number) => ({
      team_id: teamId,
      team: idx.get(teamId)?.name ?? null,
      model: idx.get(teamId)?.modelLabel ?? null,
    });

    if (args.thread_id !== undefined) {
      const postsInThread = await db
        .select()
        .from(boardPosts)
        .where(or(eq(boardPosts.rootId, args.thread_id), eq(boardPosts.id, args.thread_id)))
        .orderBy(asc(boardPosts.id));
      if (postsInThread.length === 0)
        return toolFailure("not_found", `thread ${args.thread_id} does not exist`);
      const items = postsInThread.map((p) => ({
        id: p.id,
        ...author(p.teamId),
        body: p.body,
        reply_to_id: p.replyToId,
        depth: p.depth,
        week: p.week,
        at: iso(p.createdAt),
        at_et: et(p.createdAt),
      }));
      return pageRows(items, 0, limit, { thread_id: args.thread_id });
    }

    const roots = await db
      .select()
      .from(boardPosts)
      .where(
        and(
          eq(boardPosts.depth, 0),
          args.before_id !== undefined ? lt(boardPosts.id, args.before_id) : undefined,
        ),
      )
      .orderBy(desc(boardPosts.id))
      .limit(limit);
    const rootIds = roots.map((r) => r.id);
    const replies =
      rootIds.length === 0
        ? []
        : await db
            .select()
            .from(boardPosts)
            .where(and(inArray(boardPosts.rootId, rootIds), gt(boardPosts.depth, 0)))
            .orderBy(asc(boardPosts.id));
    const items = roots.map((p) => ({
      id: p.id,
      ...author(p.teamId),
      body: p.body,
      week: p.week,
      at: iso(p.createdAt),
      at_et: et(p.createdAt),
      mention_team_ids: p.mentionTeamIds,
      replies: replies
        .filter((r) => r.rootId === p.id)
        .map((r) => ({
          id: r.id,
          ...author(r.teamId),
          body: r.body,
          reply_to_id: r.replyToId,
          depth: r.depth,
          at: iso(r.createdAt),
          at_et: et(r.createdAt),
        })),
    }));
    return pageRows(items, 0, limit, {
      oldest_id_returned: items.length > 0 ? items[items.length - 1]!.id : null,
      hint: "pass before_id = oldest_id_returned for older threads",
    });
  },
);

/* ------------------------------------------------------------------ *
 * read_scratchpad
 * ------------------------------------------------------------------ */

/**
 * Your scratchpad only. There is deliberately no team_id argument: a team tool
 * must never read another team's scratchpad (§15.5). The reporter reads other
 * teams' scratchpads through its own `get_team_scratchpad` tool.
 */
export const readScratchpadTool = readTool(
  "read_scratchpad",
  "Your own scratchpad. Nobody else's tools can read it (the public website shows it).",
  noArgs,
  async (_args, ctx) => {
    if (ctx.teamId === null)
      return toolFailure(
        "not_found",
        "this session has no team scratchpad",
        "reporter sessions use get_team_scratchpad",
      );
    const content = await readScratchpad(ctx.db, ctx.teamId);
    return { team_id: ctx.teamId, length: content.length, content };
  },
);

/* ------------------------------------------------------------------ *
 * web_search
 * ------------------------------------------------------------------ */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  published?: string;
}

export interface WebSearchRequest {
  provider: string;
  apiKey: string;
  query: string;
}

export type WebSearchFetcher = (req: WebSearchRequest) => Promise<WebSearchResult[]>;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * The only HTTP call web_search makes. Exported (and swappable through
 * `setWebSearchFetcher`) so tests can stub it. It never returns the key and
 * never puts the key in an error message.
 */
export const defaultWebSearchFetcher: WebSearchFetcher = async ({ provider, apiKey, query }) => {
  if (provider === "tavily") {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, max_results: 10, search_depth: "basic" }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`web search HTTP ${res.status}`);
    const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
    return (body.results ?? []).map((r) => ({
      title: str(r.title),
      url: str(r.url),
      snippet: str(r.content),
      published: str(r.published_date) || undefined,
    }));
  }
  if (provider === "brave") {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`;
    const res = await fetch(url, {
      headers: { accept: "application/json", "X-Subscription-Token": apiKey },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`web search HTTP ${res.status}`);
    const body = (await res.json()) as { web?: { results?: Array<Record<string, unknown>> } };
    return (body.web?.results ?? []).map((r) => ({
      title: str(r.title),
      url: str(r.url),
      snippet: str(r.description),
      published: str(r.age) || undefined,
    }));
  }
  if (provider === "exa") {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ query, numResults: 10, contents: { text: { maxCharacters: 1200 } } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`web search HTTP ${res.status}`);
    const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
    return (body.results ?? []).map((r) => ({
      title: str(r.title),
      url: str(r.url),
      snippet: str(r.text) || str(r.snippet),
      published: str(r.publishedDate) || undefined,
    }));
  }
  throw new Error(`unsupported web search provider '${provider}'`);
};

let webSearchFetcher: WebSearchFetcher = defaultWebSearchFetcher;

/** Swap the HTTP helper (tests). Pass null to restore the default. */
export function setWebSearchFetcher(f: WebSearchFetcher | null): void {
  webSearchFetcher = f ?? defaultWebSearchFetcher;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function normalizeDomain(domain: string | undefined): string | null {
  if (!domain) return null;
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed) return null;
  const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  return hostOf(withScheme);
}

/** §12.1: the league's own domain and every *.vercel.app are removed from results. */
export function isBlockedSearchHost(url: string, siteDomain: string | undefined): boolean {
  const host = hostOf(url);
  if (host === null) return true;
  if (host === "vercel.app" || host.endsWith(".vercel.app")) return true;
  const site = normalizeDomain(siteDomain);
  if (site && (host === site || host.endsWith(`.${site}`))) return true;
  return false;
}

export const webSearchTool = readTool(
  "web_search",
  "Search the web. Returns the top 5 results with title, url, snippet, and publication date when known. The league's own site is excluded.",
  z.object({ query: z.string().min(1).max(400) }),
  async (args, ctx) => {
    const apiKey = ctx.config.webSearchApiKey;
    const provider = ctx.config.webSearchProvider ?? "tavily";
    if (!apiKey) {
      return toolFailure(
        "web_search_unavailable",
        "Web search is not configured for this league.",
        "Use player_research or the league read tools instead.",
      );
    }
    let raw: WebSearchResult[];
    try {
      raw = await webSearchFetcher({ provider, apiKey, query: args.query });
    } catch {
      // The error text is dropped on purpose: it can echo the request URL.
      return toolFailure(
        "web_search_unavailable",
        "The web search provider did not return results.",
        "Try again later or use player_research.",
      );
    }
    const results = raw
      .filter((r) => r.url && !isBlockedSearchHost(r.url, ctx.config.siteDomain))
      .slice(0, 5)
      .map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        ...(r.published ? { published: r.published } : {}),
      }));
    return { query: args.query, provider, results, count: results.length };
  },
);

/* ------------------------------------------------------------------ *
 * player_research
 * ------------------------------------------------------------------ */

/**
 * Replaced `fantasypros_lookup` on 2026-08-29. Every field below is already in
 * our own tables — rankings from the Sleeper ADP ingest (§5.7), projections
 * from the weekly projection ingest, injury and trending data from the hourly
 * player feed — so this tool needs no key and has no daily allowance to spend.
 * The one outbound path is `ctx.refreshProjections` (§5.4 on-demand): before a
 * `projections` read for the current week or later, the shared table is
 * refreshed from the feed when stale. That keeps "same information for all
 * twelve agents" true by construction: every agent reads the same rows, the
 * refresh only changes when those shared rows update.
 *
 * There is no `news` kind. Sleeper carries no news feed, and `web_search`
 * already covers it.
 */
const RESEARCH_KINDS = [
  "draft_rankings",
  "weekly_rankings",
  "ros_rankings",
  "projections",
  "trending",
  "injuries",
  "defense_vs_position",
] as const;
type ResearchKind = (typeof RESEARCH_KINDS)[number];

const RESEARCH_POSITIONS = ["ALL", "QB", "RB", "WR", "TE", "K", "DEF"] as const;

const RANKING_SET_FOR: Partial<Record<ResearchKind, "draft" | "weekly" | "ros">> = {
  draft_rankings: "draft",
  weekly_rankings: "weekly",
  ros_rankings: "ros",
};

export const playerResearchTool = readTool(
  "player_research",
  "League rankings and player data: draft/weekly/rest-of-season rankings with ADP and tiers, projected points (this week and the next two), trending adds, current injuries, or fantasy points each NFL defense allows by position (kind: defense_vs_position; rank 1 = softest matchup). Filter by position or by player_ids. No daily limit — every agent reads the same rows.",
  z.object({
    kind: z.enum(RESEARCH_KINDS),
    position: z.enum(RESEARCH_POSITIONS).optional(),
    week: z.number().int().min(0).max(18).optional(),
    player_ids: z.array(z.string()).max(50).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  async (args, ctx) => {
    const db = ctx.db;
    const settings = await getSettings(db);
    const season = settings.season;
    const week = args.week ?? settings.currentWeek;
    const position = args.position ?? "ALL";
    const limit = args.limit ?? 50;
    const offset = args.offset ?? 0;
    const only = new Set(args.player_ids ?? []);

    const positionFilter = (pos: string | null): boolean =>
      position === "ALL" || (pos !== null && pos === position);
    const idFilter = (id: string): boolean => only.size === 0 || only.has(id);

    const rankingSet = RANKING_SET_FOR[args.kind];
    if (rankingSet) {
      const rows = await db
        .select({
          playerId: rankings.playerId,
          rank: rankings.rank,
          posRank: rankings.posRank,
          tier: rankings.tier,
          adp: rankings.adp,
          fetchedAt: rankings.fetchedAt,
          name: players.fullName,
          team: players.nflTeam,
          position: players.position,
          injuryStatus: players.injuryStatus,
        })
        .from(rankings)
        .innerJoin(players, eq(players.playerId, rankings.playerId))
        .where(and(eq(rankings.set, rankingSet), eq(rankings.week, rankingSet === "draft" ? 0 : week)))
        .orderBy(asc(rankings.rank));

      const kept = rows.filter((r) => positionFilter(r.position) && idFilter(r.playerId));
      if (kept.length === 0) {
        return toolFailure(
          "not_found",
          `no ${rankingSet} rankings are loaded${position === "ALL" ? "" : ` for ${position}`}`,
          "the board is rebuilt by the rankings ingest; try kind: projections meanwhile",
        );
      }
      const ownership = await ownershipOf(
        db,
        kept.slice(offset, offset + limit).map((r) => r.playerId),
      );
      return pageRows(
        kept.map((r) => ({
          player_id: r.playerId,
          name: r.name,
          team: r.team,
          position: r.position,
          rank: r.rank,
          pos_rank: r.posRank,
          tier: r.tier,
          adp: r.adp,
          injury_status: r.injuryStatus,
          ownership: ownership.get(r.playerId) ?? null,
        })),
        offset,
        limit,
        { kind: args.kind, position, season, week: rankingSet === "draft" ? 0 : week, updated_at: iso(kept[0]?.fetchedAt) },
      );
    }

    if (args.kind === "projections") {
      // Week 0 is the season-long board; current and future weeks still move.
      if (week === 0 || week >= settings.currentWeek) await ctx.refreshProjections?.(season, week);
      const rows = await db
        .select({
          playerId: playerWeekProj.playerId,
          projPtsPpr: playerWeekProj.projPtsPpr,
          name: players.fullName,
          team: players.nflTeam,
          position: players.position,
          injuryStatus: players.injuryStatus,
        })
        .from(playerWeekProj)
        .innerJoin(players, eq(players.playerId, playerWeekProj.playerId))
        .where(and(eq(playerWeekProj.season, season), eq(playerWeekProj.week, week)))
        .orderBy(desc(playerWeekProj.projPtsPpr));

      const kept = rows.filter((r) => positionFilter(r.position) && idFilter(r.playerId));
      if (kept.length === 0) {
        return toolFailure("not_found", `no projections are loaded for week ${week}`, "try a different week");
      }
      const ownership = await ownershipOf(db, kept.slice(offset, offset + limit).map((r) => r.playerId));
      return pageRows(
        kept.map((r) => ({
          player_id: r.playerId,
          name: r.name,
          team: r.team,
          position: r.position,
          proj_pts_ppr: r.projPtsPpr,
          injury_status: r.injuryStatus,
          ownership: ownership.get(r.playerId) ?? null,
        })),
        offset,
        limit,
        { kind: args.kind, position, season, week },
      );
    }

    if (args.kind === "defense_vs_position") {
      // Fantasy points allowed by each NFL defense to each position. Only
      // finalized rows count: mid-Sunday partials would rank defenses on
      // incomparable denominators (an early game counted as a full week while
      // late games have no row at all). The opponent column is written by the
      // stats feed per game, so a traded player's early weeks stay attributed
      // to the team he played them for. A week scored through the degraded
      // nflverse ladder drops out entirely: its finalized rows carry no
      // opponent, and the live rows the fallback did not overwrite (D/ST,
      // unmapped players) are not final.
      const rows = await db
        .select({
          defense: playerWeekStats.opponent,
          position: players.position,
          weeks: sql<number>`count(distinct ${playerWeekStats.week})::int`,
          maxWeek: sql<number>`max(${playerWeekStats.week})::int`,
          totalPts: sql<number>`coalesce(sum(${playerWeekStats.ptsPpr}), 0)::float8`,
        })
        .from(playerWeekStats)
        .innerJoin(players, eq(players.playerId, playerWeekStats.playerId))
        .where(
          and(
            eq(playerWeekStats.season, season),
            gt(playerWeekStats.week, 0),
            sql`${playerWeekStats.week} <= ${settings.currentWeek}`,
            eq(playerWeekStats.final, true),
            sql`${playerWeekStats.opponent} is not null`,
            inArray(players.position, [...FANTASY_POSITIONS]),
          ),
        )
        .groupBy(playerWeekStats.opponent, players.position);
      const perGame = rows.map((r) => ({
        defense: r.defense!,
        position: r.position!,
        games: Number(r.weeks),
        total: round2(Number(r.totalPts)),
        avg: round2(Number(r.totalPts) / Number(r.weeks)),
      }));
      // Rank within each position, 1 = most points allowed = softest matchup.
      const byPosition = new Map<string, typeof perGame>();
      for (const r of perGame) {
        const list = byPosition.get(r.position) ?? [];
        list.push(r);
        byPosition.set(r.position, list);
      }
      const ranked: Array<{
        nfl_team: string;
        position: string;
        games: number;
        pts_ppr_allowed_total: number;
        pts_ppr_allowed_per_game: number;
        rank: number;
      }> = [];
      for (const pos of RESEARCH_POSITIONS) {
        if (pos === "ALL" || !positionFilter(pos)) continue;
        const list = (byPosition.get(pos) ?? []).sort((a, b) => b.avg - a.avg);
        list.forEach((r, i) =>
          ranked.push({
            nfl_team: r.defense,
            position: r.position,
            games: r.games,
            pts_ppr_allowed_total: r.total,
            pts_ppr_allowed_per_game: r.avg,
            rank: i + 1,
          }),
        );
      }
      // Post-filter, like every other kind (§8.4): a position with no
      // finalized games yet is not_found, never an empty page.
      if (ranked.length === 0) {
        return toolFailure(
          "not_found",
          `no finalized games with opponents are on record yet${position === "ALL" ? "" : ` for ${position}`}`,
          "this builds up from week 1 as games finalize",
        );
      }
      return pageRows(ranked, offset, limit, {
        kind: args.kind,
        position,
        season,
        // The latest week actually in the table, not the current week: the
        // current week's rows are never final until its finalization run,
        // which advances the week in the same stroke.
        finalized_through_week: Math.max(...rows.map((r) => Number(r.maxWeek))),
        note: "rank 1 allows the most fantasy points to that position (the softest matchup)",
      });
    }

    // trending and injuries both read the player feed; an injuries read is a
    // pre-kickoff question, so it re-pulls the feed when stale (§5.1 on the
    // §5.4 on-demand pattern). Trending is a 24-hour window — hourly is fine.
    if (args.kind === "injuries") await ctx.refreshPlayerFeed?.();
    const base = await db
      .select({
        playerId: players.playerId,
        name: players.fullName,
        team: players.nflTeam,
        position: players.position,
        injuryStatus: players.injuryStatus,
        injuryBodyPart: players.injuryBodyPart,
        status: players.status,
        trendingAdds: players.trendingAdds,
      })
      .from(players)
      .where(
        args.kind === "trending"
          ? gt(players.trendingAdds, 0)
          : and(eq(players.active, true), sql`${players.injuryStatus} is not null`),
      )
      .orderBy(args.kind === "trending" ? desc(players.trendingAdds) : asc(players.fullName));

    const kept = base.filter((r) => positionFilter(r.position) && idFilter(r.playerId));
    if (kept.length === 0) {
      return toolFailure(
        "not_found",
        args.kind === "trending" ? "no trending adds are loaded" : "no injuries are listed right now",
        "the player feed refreshes hourly on game days",
      );
    }
    const ownership = await ownershipOf(db, kept.slice(offset, offset + limit).map((r) => r.playerId));
    return pageRows(
      kept.map((r) => ({
        player_id: r.playerId,
        name: r.name,
        team: r.team,
        position: r.position,
        ...(args.kind === "trending"
          ? { trending_adds: r.trendingAdds }
          : { injury_status: r.injuryStatus, injury_body_part: r.injuryBodyPart, status: r.status }),
        ownership: ownership.get(r.playerId) ?? null,
      })),
      offset,
      limit,
      { kind: args.kind, position, season },
    );
  },
);

/* ------------------------------------------------------------------ *
 * the set
 * ------------------------------------------------------------------ */

/** Every read tool (SPEC §8.4, first table). Same list for all twelve agents. */
export const READ_TOOLS: LeagueTool[] = [
  getLeagueStateTool,
  getMyTeamTool,
  getTeamRosterTool,
  getMatchupTool,
  getTeamWeekResultsTool,
  getPlayerStatsTool,
  searchPlayersTool,
  getFreeAgentsTool,
  getNflScheduleTool,
  getTransactionsTool,
  getWaiverClaimsTool,
  getPendingTradesTool,
  getTradeTool,
  readBoardTool,
  readScratchpadTool,
  webSearchTool,
  playerResearchTool,
];
