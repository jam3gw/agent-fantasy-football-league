/**
 * Matchup odds, the database part (SPEC §11.1): load one week's matchups from
 * league tables, run the four methods, write the run in one transaction, and
 * read runs and the season scoreboard back for the site and the reporter.
 *
 * Jev is injected as a `JevAsk`, so this file makes no network call itself.
 */
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "./db/index.ts";
import type { OddsMethod, OddsSnapshot, StartingSlot } from "./db/schema.ts";
import {
  health,
  lineupEntries,
  matchupOdds,
  matchups,
  nflGames,
  oddsRuns,
  playerPlayOdds,
  playerWeekProj,
  playerWeekStats,
  players,
  rosterEntries,
  teamWeekResults,
} from "./db/schema.ts";
import type { GameState, JevAsk, OddsMatchup, OddsPlayer, OddsStarter, OddsTeam, TeamForm } from "./odds.ts";
import {
  JEV_USD_PER_M_INPUT,
  ODDS_WEIGHTS,
  brier,
  hitRate,
  jevMatchupRequest,
  jevPlayRequest,
  modelOdds,
  needsPlayCall,
  rulePlayProb,
} from "./odds.ts";
import { STARTING_SLOTS } from "./roster.ts";

/** How many Jev requests are in flight at once (the API allows 1,200 a minute). */
const JEV_CONCURRENCY = 4;
/**
 * The whole Jev phase must finish inside this, well short of a workflow
 * step's 800 s, so a slow Jev can never stop the baseline and the rule from
 * being stored (§11.1). Running out of time is a Jev failure.
 */
export const JEV_PHASE_DEADLINE_MS = 300_000;

/** Load the week's matchups with everything the four methods read (§11.1 inputs). */
export async function loadOddsMatchups(
  db: EngineDb,
  season: number,
  week: number,
  now: Date,
): Promise<OddsMatchup[]> {
  const weekMatchups = await db.select().from(matchups).where(eq(matchups.week, week)).orderBy(matchups.id);
  if (weekMatchups.length === 0) return [];
  const teamIds = [...new Set(weekMatchups.flatMap((m) => [m.homeTeamId, m.awayTeamId]))];

  const entries = await db
    .select({ teamId: lineupEntries.teamId, playerId: lineupEntries.playerId, slot: lineupEntries.slot })
    .from(lineupEntries)
    .where(and(eq(lineupEntries.week, week), inArray(lineupEntries.teamId, teamIds)));
  const roster = await db
    .select({ teamId: rosterEntries.teamId, playerId: rosterEntries.playerId })
    .from(rosterEntries)
    .where(inArray(rosterEntries.teamId, teamIds));

  const allIds = [...new Set([...entries.map((e) => e.playerId), ...roster.map((r) => r.playerId)])];
  const playerRows = allIds.length ? await db.select().from(players).where(inArray(players.playerId, allIds)) : [];
  const byId = new Map(playerRows.map((p) => [p.playerId, p]));

  const projRows = allIds.length
    ? await db
        .select({ playerId: playerWeekProj.playerId, proj: playerWeekProj.projPtsPpr })
        .from(playerWeekProj)
        .where(and(eq(playerWeekProj.season, season), eq(playerWeekProj.week, week), inArray(playerWeekProj.playerId, allIds)))
    : [];
  const proj = new Map(projRows.map((r) => [r.playerId, r.proj ?? 0]));

  const statRows = allIds.length
    ? await db
        .select({ playerId: playerWeekStats.playerId, week: playerWeekStats.week, pts: playerWeekStats.ptsPpr, final: playerWeekStats.final })
        .from(playerWeekStats)
        .where(
          and(
            eq(playerWeekStats.season, season),
            inArray(playerWeekStats.playerId, allIds),
            // Week 0 holds last season's totals (§5); this season's weeks only.
            lt(playerWeekStats.week, week + 1),
          ),
        )
    : [];
  const pointsNow = new Map<string, number>();
  const history = new Map<string, Array<{ week: number; pts: number }>>();
  for (const r of statRows) {
    if (r.week === week) pointsNow.set(r.playerId, r.pts ?? 0);
    else if (r.week >= 1 && r.final) {
      const list = history.get(r.playerId) ?? [];
      list.push({ week: r.week, pts: r.pts ?? 0 });
      history.set(r.playerId, list);
    }
  }
  const avgLast3 = (id: string): number | null => {
    const list = (history.get(id) ?? []).sort((a, b) => b.week - a.week).slice(0, 3);
    return list.length ? list.reduce((s, x) => s + x.pts, 0) / list.length : null;
  };

  const games = await db.select().from(nflGames).where(and(eq(nflGames.season, season), eq(nflGames.week, week)));
  const gameOf = new Map<string, (typeof games)[number]>();
  for (const g of games) {
    gameOf.set(g.home, g);
    gameOf.set(g.away, g);
  }

  const toPlayer = (playerId: string): OddsPlayer => {
    const p = byId.get(playerId);
    const nflTeam = p?.nflTeam ?? null;
    const g = nflTeam ? gameOf.get(nflTeam) : undefined;
    let gameState: GameState = "none";
    if (g) gameState = g.status === "final" ? "final" : g.kickoffAt.getTime() <= now.getTime() ? "in_progress" : "not_started";
    return {
      playerId,
      name: p?.fullName ?? playerId,
      position: p?.position ?? null,
      fantasyPositions: p?.fantasyPositions ?? null,
      nflTeam,
      opponent: g && nflTeam ? (g.home === nflTeam ? g.away : g.home) : null,
      kickoffAt: g?.kickoffAt ?? null,
      gameState,
      proj: proj.get(playerId) ?? 0,
      points: gameState === "in_progress" || gameState === "final" ? (pointsNow.get(playerId) ?? 0) : null,
      injuryStatus: p?.injuryStatus ?? null,
      injuryBodyPart: p?.injuryBodyPart ?? null,
      status: p?.status ?? null,
      avgLast3: avgLast3(playerId),
    };
  };

  const forms = await teamForms(db, week, teamIds);

  const buildTeam = (teamId: number): OddsTeam => {
    const mine = entries.filter((e) => e.teamId === teamId);
    const starters: OddsStarter[] = mine
      .filter((e) => e.slot !== "IR")
      .map((e) => ({ ...toPlayer(e.playerId), slot: e.slot as StartingSlot }));
    const filled = new Set(starters.map((s) => s.slot));
    const inLineup = new Set(mine.map((e) => e.playerId));
    return {
      teamId,
      starters,
      emptySlots: STARTING_SLOTS.filter((s) => !filled.has(s)),
      bench: roster.filter((r) => r.teamId === teamId && !inLineup.has(r.playerId)).map((r) => toPlayer(r.playerId)),
      form: forms.get(teamId)!,
    };
  };

  return weekMatchups.map((m) => ({
    matchupId: m.id,
    week,
    isPlayoff: m.isPlayoff,
    home: buildTeam(m.homeTeamId),
    away: buildTeam(m.awayTeamId),
  }));
}

/** Team form from finalized weeks before `week`. */
async function teamForms(db: EngineDb, week: number, teamIds: number[]): Promise<Map<number, TeamForm>> {
  const past = await db.select().from(matchups).where(and(lt(matchups.week, week), eq(matchups.final, true)));
  const results = await db
    .select()
    .from(teamWeekResults)
    .where(and(lt(teamWeekResults.week, week), inArray(teamWeekResults.teamId, teamIds)));
  const out = new Map<number, TeamForm>();
  for (const teamId of teamIds) {
    const games = past
      .filter((m) => m.homeTeamId === teamId || m.awayTeamId === teamId)
      .map((m) => {
        const mine = m.homeTeamId === teamId ? m.homePoints : m.awayPoints;
        const theirs = m.homeTeamId === teamId ? m.awayPoints : m.homePoints;
        return { week: m.week, mine: mine ?? 0, theirs: theirs ?? 0 };
      })
      .sort((a, b) => b.week - a.week);
    const mineRes = results.filter((r) => r.teamId === teamId);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
    out.set(teamId, {
      wins: games.filter((g) => g.mine > g.theirs).length,
      losses: games.filter((g) => g.mine < g.theirs).length,
      ties: games.filter((g) => g.mine === g.theirs).length,
      avgPoints: avg(games.map((g) => g.mine)),
      avgPointsLast3: avg(games.slice(0, 3).map((g) => g.mine)),
      avgPointsLeftOnBench: avg(mineRes.map((r) => r.pointsLeftOnBench)),
      emptyStartingSlotsSeason: mineRes.reduce((s, r) => s + r.emptyStartingSlots, 0),
    });
  }
  return out;
}

/**
 * Run `fn` over `items` with at most `limit` in flight. After the first
 * failure no new item starts, and the calls already in flight are waited for
 * before the failure is thrown, so every billed call has landed (and been
 * counted) by the time the caller writes the run.
 */
async function mapLimited<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (failure === null && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== null) throw (failure as { error: unknown }).error;
  return out;
}

/** A Jev probability must be a number in [0, 1]; anything else fails the Jev phase. */
function prob01(x: unknown, what: string): number {
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 1) {
    throw new Error(`jev: ${what} is not a probability in [0, 1]: ${String(x)}`);
  }
  return x;
}

export interface OddsRunResult {
  runId: number | null;
  /** True when a run for this season, week and snapshot already existed. */
  existed: boolean;
  status: "succeeded" | "partial" | "no_matchups";
  jevError: string | null;
  matchups: number;
}

/**
 * `odds.run` (§11.1). Jev is asked before the transaction; the run and every
 * method's rows are written in one. A Jev failure drops both Jev methods for
 * the whole run, never for part of it.
 */
export async function runMatchupOdds(
  db: EngineDb,
  clock: Clock,
  args: { season: number; week: number; snapshot: OddsSnapshot; jev: JevAsk | null; jevDeadlineMs?: number },
): Promise<OddsRunResult> {
  const { season, week, snapshot } = args;
  const existing = await db
    .select({ id: oddsRuns.id, status: oddsRuns.status, jevError: oddsRuns.jevError })
    .from(oddsRuns)
    .where(and(eq(oddsRuns.season, season), eq(oddsRuns.week, week), eq(oddsRuns.snapshot, snapshot)));
  if (existing[0]) {
    return { runId: existing[0].id, existed: true, status: existing[0].status, jevError: existing[0].jevError, matchups: 0 };
  }

  const now = clock.now();
  const weekMatchups = await loadOddsMatchups(db, season, week, now);
  if (weekMatchups.length === 0) {
    return { runId: null, existed: false, status: "no_matchups", jevError: null, matchups: 0 };
  }

  // No projections for the week would store a week of coin flips that a
  // repeat run could never replace. Fail the job instead; it can be re-booked
  // once `ingest.projections` has run.
  const anyProj = await db
    .select({ playerId: playerWeekProj.playerId })
    .from(playerWeekProj)
    .where(and(eq(playerWeekProj.season, season), eq(playerWeekProj.week, week)))
    .limit(1);
  if (anyProj.length === 0) {
    throw new Error(`odds.run: no projections loaded for week ${week}; run ingest.projections, then book odds.run again`);
  }

  const doubtful: OddsStarter[] = weekMatchups.flatMap((m) => [...m.home.starters, ...m.away.starters].filter(needsPlayCall));

  let jevError: string | null = args.jev ? null : "no_key: AI_GATEWAY_API_KEY is not set";
  let jevModel: string | null = null;
  let jevTokens = 0;
  let jevCost = 0;
  const jevPlay = new Map<string, number>();
  const jevPlayRequests = new Map<string, unknown>();
  const jevDirect = new Map<number, { homeWinProb: number; confidence: number | null; state: unknown }>();
  if (args.jev) {
    // Count tokens as each reply lands: a later failure still leaves the calls
    // that succeeded billed, and the run records what was spent (§11.1).
    const inner = args.jev;
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error("jev: the Jev phase ran past its deadline")),
      args.jevDeadlineMs ?? JEV_PHASE_DEADLINE_MS,
    );
    const jev: JevAsk = async (req) => {
      if (deadline.signal.aborted) throw deadline.signal.reason;
      const reply = await inner(req, { signal: deadline.signal });
      jevTokens += reply.inputTokens;
      jevCost += reply.costUsd ?? (reply.inputTokens * JEV_USD_PER_M_INPUT) / 1_000_000;
      jevModel = reply.model;
      return reply;
    };
    try {
      const plays = await mapLimited(doubtful, JEV_CONCURRENCY, async (s) => {
        const req = jevPlayRequest(s, now);
        const reply = await jev(req);
        const a = reply.answers.plays;
        if (a?.type !== "noul") throw new Error(`jev: no noul answer for ${s.playerId}`);
        return { s, req, reply, p: prob01(a.noul, `the play call for ${s.playerId}`) };
      });
      const directs = await mapLimited(weekMatchups, JEV_CONCURRENCY, async (m) => {
        const req = jevMatchupRequest(m, now);
        const reply = await jev(req);
        const a = reply.answers.winner;
        if (a?.type !== "choice") throw new Error(`jev: no choice answer for matchup ${m.matchupId}`);
        const p = prob01(a.probabilities.home, `the home probability for matchup ${m.matchupId}`);
        return { m, req, reply, p, confidence: a.confidence };
      });
      for (const x of plays) {
        jevPlay.set(x.s.playerId, x.p);
        jevPlayRequests.set(x.s.playerId, x.req.state);
      }
      for (const x of directs) {
        jevDirect.set(x.m.matchupId, { homeWinProb: x.p, confidence: x.confidence, state: x.req.state });
      }
    } catch (err) {
      jevError = String(err instanceof Error ? err.message : err).slice(0, 500);
      jevPlay.clear();
      jevDirect.clear();
    } finally {
      clearTimeout(timer);
    }
  }
  const withJev = jevError === null;

  const matchupRows: Array<typeof matchupOdds.$inferInsert> = [];
  const playerRows: Array<typeof playerPlayOdds.$inferInsert> = [];
  for (const m of weekMatchups) {
    const methods: Array<Exclude<OddsMethod, "jev_direct">> = withJev
      ? ["baseline", "rule", "jev_composite"]
      : ["baseline", "rule"];
    for (const method of methods) {
      const o = modelOdds(m, method, jevPlay);
      matchupRows.push({
        runId: 0,
        matchupId: m.matchupId,
        method,
        homeWinProb: round5(o.homeWinProb),
        homeExpected: round2(o.home.expected),
        awayExpected: round2(o.away.expected),
        detail: {
          home_sd: round2(Math.sqrt(o.home.variance)),
          away_sd: round2(Math.sqrt(o.away.variance)),
          starters: [...o.home.starters, ...o.away.starters]
            .filter((s) => s.p < 1)
            .map((s) => ({ player_id: s.playerId, p: round5(s.p), expected: round2(s.expected), backup: s.backupPlayerId })),
        },
      });
    }
    const d = jevDirect.get(m.matchupId);
    if (withJev && d) {
      matchupRows.push({
        runId: 0,
        matchupId: m.matchupId,
        method: "jev_direct",
        homeWinProb: round5(d.homeWinProb),
        homeExpected: null,
        awayExpected: null,
        detail: { confidence: d.confidence, state: d.state },
      });
    }
    for (const side of [m.home, m.away]) {
      for (const s of side.starters.filter(needsPlayCall)) {
        playerRows.push({
          runId: 0,
          playerId: s.playerId,
          teamId: side.teamId,
          matchupId: m.matchupId,
          injuryStatus: s.injuryStatus,
          ruleProb: round5(rulePlayProb(s.injuryStatus, s.status)),
          jevProb: withJev ? round5(jevPlay.get(s.playerId)!) : null,
          detail: withJev ? { state: jevPlayRequests.get(s.playerId) } : {},
        });
      }
    }
  }

  const runId = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(oddsRuns)
      .values({
        season,
        week,
        snapshot,
        status: withJev ? "succeeded" : "partial",
        jevModel: withJev ? jevModel : null,
        jevError,
        jevInputTokens: jevTokens,
        jevCostUsd: round6(jevCost),
        weights: ODDS_WEIGHTS,
        createdAt: now,
      })
      .onConflictDoNothing({ target: [oddsRuns.season, oddsRuns.week, oddsRuns.snapshot] })
      .returning({ id: oddsRuns.id });
    const id = inserted[0]?.id;
    if (id === undefined) return null; // a concurrent run won the race
    if (matchupRows.length) await tx.insert(matchupOdds).values(matchupRows.map((r) => ({ ...r, runId: id, createdAt: now })));
    if (playerRows.length) await tx.insert(playerPlayOdds).values(playerRows.map((r) => ({ ...r, runId: id, createdAt: now })));
    return id;
  });

  // The Jev health row: a missing key is a setting, not an outage.
  if (args.jev) {
    const set = withJev
      ? { lastSuccessAt: now }
      : { lastError: jevError, lastErrorAt: now };
    await db.insert(health).values({ key: "jev", ...set }).onConflictDoUpdate({ target: health.key, set });
  }

  if (runId === null) {
    const again = (
      await db
        .select({ id: oddsRuns.id, status: oddsRuns.status, jevError: oddsRuns.jevError })
        .from(oddsRuns)
        .where(and(eq(oddsRuns.season, season), eq(oddsRuns.week, week), eq(oddsRuns.snapshot, snapshot)))
    )[0]!;
    return { runId: again.id, existed: true, status: again.status, jevError: again.jevError, matchups: 0 };
  }
  return { runId, existed: false, status: withJev ? "succeeded" : "partial", jevError, matchups: weekMatchups.length };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const round5 = (x: number) => Math.round(x * 100_000) / 100_000;
const round6 = (x: number) => Math.round(x * 1_000_000) / 1_000_000;

// ---------------------------------------------------------------------------
// Reads.

export type OddsRunRow = typeof oddsRuns.$inferSelect;

export interface WeekOdds {
  run: OddsRunRow;
  matchups: Array<{
    matchupId: number;
    homeTeamId: number;
    awayTeamId: number;
    final: boolean;
    winnerTeamId: number | null;
    homePoints: number | null;
    awayPoints: number | null;
    methods: Partial<Record<OddsMethod, { homeWinProb: number; homeExpected: number | null; awayExpected: number | null; confidence: number | null }>>;
  }>;
  players: Array<{
    playerId: string;
    name: string;
    teamId: number;
    matchupId: number;
    injuryStatus: string | null;
    ruleProb: number;
    jevProb: number | null;
  }>;
}

/** The newest run for a week (Sunday over Thursday), with its matchups and play calls. */
export async function latestWeekOdds(db: EngineDb, season: number, week: number): Promise<WeekOdds | null> {
  const run = (
    await db
      .select()
      .from(oddsRuns)
      .where(and(eq(oddsRuns.season, season), eq(oddsRuns.week, week)))
      .orderBy(desc(oddsRuns.createdAt), desc(oddsRuns.id))
      .limit(1)
  )[0];
  if (!run) return null;
  const rows = await db.select().from(matchupOdds).where(eq(matchupOdds.runId, run.id));
  const mRows = await db.select().from(matchups).where(eq(matchups.week, week)).orderBy(matchups.id);
  const pRows = await db
    .select({
      playerId: playerPlayOdds.playerId,
      name: players.fullName,
      teamId: playerPlayOdds.teamId,
      matchupId: playerPlayOdds.matchupId,
      injuryStatus: playerPlayOdds.injuryStatus,
      ruleProb: playerPlayOdds.ruleProb,
      jevProb: playerPlayOdds.jevProb,
    })
    .from(playerPlayOdds)
    .leftJoin(players, eq(players.playerId, playerPlayOdds.playerId))
    .where(eq(playerPlayOdds.runId, run.id));
  return {
    run,
    matchups: mRows
      .filter((m) => rows.some((r) => r.matchupId === m.id))
      .map((m) => {
        const methods: WeekOdds["matchups"][number]["methods"] = {};
        for (const r of rows.filter((x) => x.matchupId === m.id)) {
          const confidence = typeof r.detail.confidence === "number" ? r.detail.confidence : null;
          methods[r.method] = { homeWinProb: r.homeWinProb, homeExpected: r.homeExpected, awayExpected: r.awayExpected, confidence };
        }
        return {
          matchupId: m.id,
          homeTeamId: m.homeTeamId,
          awayTeamId: m.awayTeamId,
          final: m.final,
          winnerTeamId: m.winnerTeamId,
          homePoints: m.homePoints,
          awayPoints: m.awayPoints,
          methods,
        };
      }),
    players: pRows.map((p) => ({ ...p, name: p.name ?? p.playerId })),
  };
}

export interface MethodScore {
  method: OddsMethod;
  snapshot: OddsSnapshot;
  n: number;
  brier: number | null;
  hitRate: number | null;
}

export interface OddsScoreboard {
  matchups: MethodScore[];
  /** Injured starters: the rule versus Jev on "did he play?", per snapshot, over the same players. */
  players: Array<{ snapshot: OddsSnapshot; n: number; ruleBrier: number | null; jevBrier: number | null }>;
  weeks: number[];
}

/**
 * 1 home scored more, 0 away scored more, 0.5 tie (§11.1). Points decide,
 * not `winner_team_id`: a playoff tie has a winner (the higher seed) but the
 * question every method answers is who scores more.
 */
export function matchupOutcome(m: { homePoints: number | null; awayPoints: number | null; winnerTeamId: number | null; homeTeamId: number }): number {
  if (m.homePoints !== null && m.awayPoints !== null) {
    return m.homePoints > m.awayPoints ? 1 : m.homePoints < m.awayPoints ? 0 : 0.5;
  }
  if (m.winnerTeamId !== null) return m.winnerTeamId === m.homeTeamId ? 1 : 0;
  return 0.5;
}

/** Did he play? `gp`, else `gms_active`; a final week with no row is "no". */
export function playedFromStats(stats: Record<string, number> | null | undefined): boolean {
  if (!stats) return false;
  const gp = stats.gp ?? stats.gms_active;
  return typeof gp === "number" && gp > 0;
}

/** The season scoreboard over finalized matchups (§11.1). Computed on every read. */
export async function oddsScoreboard(db: EngineDb, season: number): Promise<OddsScoreboard> {
  const runs = await db.select().from(oddsRuns).where(eq(oddsRuns.season, season));
  if (runs.length === 0) return { matchups: [], players: [], weeks: [] };
  const runIds = runs.map((r) => r.id);
  const runById = new Map(runs.map((r) => [r.id, r]));

  const odds = await db.select().from(matchupOdds).where(inArray(matchupOdds.runId, runIds));
  const finals = await db.select().from(matchups).where(eq(matchups.final, true));
  const finalById = new Map(finals.map((m) => [m.id, m]));

  const buckets = new Map<string, { method: OddsMethod; snapshot: OddsSnapshot; pairs: Array<{ p: number; outcome: number }> }>();
  const weeks = new Set<number>();
  for (const o of odds) {
    const m = finalById.get(o.matchupId);
    const run = runById.get(o.runId);
    if (!m || !run) continue;
    weeks.add(run.week);
    const key = `${o.method}|${run.snapshot}`;
    const b = buckets.get(key) ?? { method: o.method, snapshot: run.snapshot, pairs: [] };
    b.pairs.push({ p: o.homeWinProb, outcome: matchupOutcome(m) });
    buckets.set(key, b);
  }
  const order: OddsMethod[] = ["baseline", "rule", "jev_composite", "jev_direct"];
  const matchupScores: MethodScore[] = [...buckets.values()]
    .map((b) => ({ method: b.method, snapshot: b.snapshot, n: b.pairs.length, brier: brier(b.pairs), hitRate: hitRate(b.pairs) }))
    .sort((a, b) => a.snapshot.localeCompare(b.snapshot) * -1 || order.indexOf(a.method) - order.indexOf(b.method));

  // Play calls: only weeks whose matchups are all final, so "no row" means "did not play".
  const finalWeeks = new Set<number>();
  const allWeekMatchups = await db.select({ week: matchups.week, final: matchups.final }).from(matchups);
  for (const w of new Set(runs.map((r) => r.week))) {
    const ms = allWeekMatchups.filter((m) => m.week === w);
    if (ms.length > 0 && ms.every((m) => m.final)) finalWeeks.add(w);
  }
  const calls = await db.select().from(playerPlayOdds).where(inArray(playerPlayOdds.runId, runIds));
  const scoredCalls = calls.filter((c) => finalWeeks.has(runById.get(c.runId)!.week));
  const statKeys = [...new Set(scoredCalls.map((c) => c.playerId))];
  const stats = statKeys.length
    ? await db
        .select({ playerId: playerWeekStats.playerId, week: playerWeekStats.week, stats: playerWeekStats.stats, final: playerWeekStats.final })
        .from(playerWeekStats)
        .where(and(eq(playerWeekStats.season, season), inArray(playerWeekStats.playerId, statKeys)))
    : [];
  // Only a final row counts (§11.1); a week whose matchups are all final has final rows.
  const statOf = new Map(stats.filter((s) => s.final).map((s) => [`${s.playerId}|${s.week}`, s.stats]));
  const playerBuckets = new Map<OddsSnapshot, { rule: Array<{ p: number; outcome: number }>; jev: Array<{ p: number; outcome: number }> }>();
  for (const c of scoredCalls) {
    // Rule and Jev are compared over the same players: only calls Jev made.
    if (c.jevProb === null) continue;
    const run = runById.get(c.runId)!;
    const outcome = playedFromStats(statOf.get(`${c.playerId}|${run.week}`)) ? 1 : 0;
    const b = playerBuckets.get(run.snapshot) ?? { rule: [], jev: [] };
    b.rule.push({ p: c.ruleProb, outcome });
    b.jev.push({ p: c.jevProb, outcome });
    playerBuckets.set(run.snapshot, b);
  }
  const playerScores = [...playerBuckets.entries()]
    .map(([snapshot, b]) => ({ snapshot, n: b.rule.length, ruleBrier: brier(b.rule), jevBrier: brier(b.jev) }))
    .sort((a, b) => b.snapshot.localeCompare(a.snapshot));

  return { matchups: matchupScores, players: playerScores, weeks: [...weeks].sort((a, b) => a - b) };
}

/** Total Jev spend for a season (the `/spend` league line, §11.1). */
export async function jevSpend(db: EngineDb, season: number): Promise<{ runs: number; inputTokens: number; costUsd: number }> {
  const runs = await db
    .select({ tokens: oddsRuns.jevInputTokens, cost: oddsRuns.jevCostUsd })
    .from(oddsRuns)
    .where(eq(oddsRuns.season, season));
  return {
    runs: runs.length,
    inputTokens: runs.reduce((s, r) => s + r.tokens, 0),
    costUsd: runs.reduce((s, r) => s + r.cost, 0),
  };
}
