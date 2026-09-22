/**
 * Matchup odds, the pure part (SPEC §11.1). Four methods give each matchup a
 * home-win probability; this file holds the math and the Jev question
 * builders, and touches no database and no network.
 *
 * The expected-points model is shared by `baseline`, `rule` and
 * `jev_composite`: they differ only in `p`, the chance each starter plays.
 * `jev_direct` asks Jev the whole question and does none of this math.
 */
import { formatEt } from "@league/shared";
import type { OddsMethod, StartingSlot } from "./db/schema.ts";
import { STARTING_SLOTS, eligibleForSlot } from "./roster.ts";

/** Pinned: an alias moves mid-season and the scoreboard compares one model. */
export const JEV_MODEL = "jev-1.13.0";
/** Jev bills input tokens only (docs.typesafe.ai/models, read 2026-09-22). */
export const JEV_USD_PER_M_INPUT = 0.042;

/**
 * The fixed injury rule (§11.1). Statuses are matched case-insensitively
 * against Sleeper's `injury_status`, then its `status` for the long forms.
 */
export const RULE_PLAY_PROB: Record<string, number> = {
  questionable: 0.8,
  doubtful: 0.2,
  out: 0,
  ir: 0,
  pup: 0,
  nfi: 0,
  sus: 0,
  "injured reserve": 0,
  "physically unable to perform": 0,
  "non football injury": 0,
  suspended: 0,
};

/** Weekly score spread as a share of the projection, by position. */
export const POSITION_CV: Record<string, number> = {
  QB: 0.35,
  RB: 0.5,
  WR: 0.55,
  TE: 0.6,
  K: 0.45,
  DEF: 0.6,
};
const DEFAULT_CV = 0.55;

/** What each run records as the weights it used. */
export const ODDS_WEIGHTS = { rulePlayProb: RULE_PLAY_PROB, positionCv: POSITION_CV, defaultCv: DEFAULT_CV };

export type GameState = "none" | "not_started" | "in_progress" | "final";

export interface OddsPlayer {
  playerId: string;
  name: string;
  position: string | null;
  fantasyPositions: string[] | null;
  nflTeam: string | null;
  opponent: string | null;
  kickoffAt: Date | null;
  gameState: GameState;
  /** This week's projection; 0 when none is loaded. */
  proj: number;
  /** Points so far this week, when the game has started. */
  points: number | null;
  injuryStatus: string | null;
  injuryBodyPart: string | null;
  status: string | null;
  /** Average over the player's last three finalized weeks this season. */
  avgLast3: number | null;
}

export interface OddsStarter extends OddsPlayer {
  slot: StartingSlot;
}

export interface TeamForm {
  wins: number;
  losses: number;
  ties: number;
  avgPoints: number | null;
  avgPointsLast3: number | null;
  avgPointsLeftOnBench: number | null;
  emptyStartingSlotsSeason: number;
}

export interface OddsTeam {
  teamId: number;
  starters: OddsStarter[];
  emptySlots: StartingSlot[];
  bench: OddsPlayer[];
  form: TeamForm;
}

export interface OddsMatchup {
  matchupId: number;
  week: number;
  isPlayoff: boolean;
  home: OddsTeam;
  away: OddsTeam;
}

/** The fixed rule's chance that a player with this status plays. */
export function rulePlayProb(injuryStatus: string | null, status: string | null): number {
  for (const s of [injuryStatus, status]) {
    if (!s) continue;
    const p = RULE_PLAY_PROB[s.trim().toLowerCase()];
    if (p !== undefined) return p;
  }
  return 1;
}

/**
 * A starter whose playing is still in doubt: he has an injury tag and his
 * game has not started. These are the players the rule and Jev disagree on;
 * everyone else plays with p = 1 (or 0 on a bye) in every method.
 */
export function needsPlayCall(s: OddsPlayer): boolean {
  return s.gameState === "not_started" && !!s.injuryStatus;
}

function cv(position: string | null): number {
  return (position ? POSITION_CV[position] : undefined) ?? DEFAULT_CV;
}

export interface StarterExpectation {
  playerId: string;
  slot: StartingSlot;
  p: number;
  expected: number;
  variance: number;
  backupPlayerId: string | null;
}

export interface TeamExpectation {
  expected: number;
  variance: number;
  starters: StarterExpectation[];
}

/**
 * Expected points and variance for one team (§11.1).
 *
 * `playProb` answers only for starters that `needsPlayCall`; the rest are
 * fixed here. `backups` off is the baseline: projections as they stand.
 */
export function teamExpectation(
  team: OddsTeam,
  playProb: (s: OddsStarter) => number,
  opts: { backups: boolean },
): TeamExpectation {
  // Healthy bench players whose game is still ahead: the manager can still
  // start one of them in place of a starter who sits.
  const pool = team.bench
    .filter((b) => b.gameState === "not_started" && !b.injuryStatus)
    .sort((a, b) => b.proj - a.proj || a.playerId.localeCompare(b.playerId));
  const usedBackups = new Set<string>();

  const ordered = [...team.starters].sort(
    (a, b) => STARTING_SLOTS.indexOf(a.slot) - STARTING_SLOTS.indexOf(b.slot),
  );
  const out: StarterExpectation[] = [];
  let expected = 0;
  let variance = 0;
  for (const s of ordered) {
    const sigma = cv(s.position) * Math.max(0, s.proj);
    let row: StarterExpectation;
    if (s.gameState === "final") {
      row = { playerId: s.playerId, slot: s.slot, p: 1, expected: s.points ?? 0, variance: 0, backupPlayerId: null };
    } else if (s.gameState === "in_progress") {
      row = {
        playerId: s.playerId,
        slot: s.slot,
        p: 1,
        expected: Math.max(s.points ?? 0, s.proj),
        variance: sigma ** 2,
        backupPlayerId: null,
      };
    } else {
      // No game (bye, no team) is a certain zero; the rule and Jev methods
      // still let the manager swap in a backup, the baseline does not.
      const p = s.gameState === "none" ? 0 : needsPlayCall(s) ? clamp01(playProb(s)) : 1;
      let backup: OddsPlayer | undefined;
      if (opts.backups && p < 1) {
        backup = pool.find((b) => !usedBackups.has(b.playerId) && eligibleForSlot(s.slot, b.fantasyPositions));
        if (backup) usedBackups.add(backup.playerId);
      }
      const bProj = backup ? Math.max(0, backup.proj) : 0;
      const bSigma = backup ? cv(backup.position) * bProj : 0;
      const proj = s.gameState === "none" ? 0 : Math.max(0, s.proj);
      const pEff = opts.backups ? p : s.gameState === "none" ? 0 : 1;
      row = {
        playerId: s.playerId,
        slot: s.slot,
        p: pEff,
        expected: pEff * proj + (1 - pEff) * bProj,
        variance: pEff * sigma ** 2 + (1 - pEff) * bSigma ** 2 + pEff * (1 - pEff) * (proj - bProj) ** 2,
        backupPlayerId: backup?.playerId ?? null,
      };
    }
    out.push(row);
    expected += row.expected;
    variance += row.variance;
  }
  return { expected, variance, starters: out };
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26; error below 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** P(home scores more), from two independent normal totals. */
export function homeWinProbability(home: TeamExpectation, away: TeamExpectation): number {
  const diff = home.expected - away.expected;
  const sd = Math.sqrt(home.variance + away.variance);
  if (sd === 0) return diff > 0 ? 1 : diff < 0 ? 0 : 0.5;
  return normalCdf(diff / sd);
}

export interface ModelOdds {
  method: Exclude<OddsMethod, "jev_direct">;
  homeWinProb: number;
  home: TeamExpectation;
  away: TeamExpectation;
}

/** One of the three model-based methods for a matchup. */
export function modelOdds(
  m: OddsMatchup,
  method: ModelOdds["method"],
  jevPlayProb?: ReadonlyMap<string, number>,
): ModelOdds {
  const p = (s: OddsStarter): number => {
    if (method === "rule") return rulePlayProb(s.injuryStatus, s.status);
    if (method === "jev_composite") {
      const v = jevPlayProb?.get(s.playerId);
      if (v === undefined) throw new Error(`no Jev play call for ${s.playerId}`);
      return v;
    }
    return 1;
  };
  const backups = method !== "baseline";
  const home = teamExpectation(m.home, p, { backups });
  const away = teamExpectation(m.away, p, { backups });
  return { method, homeWinProb: homeWinProbability(home, away), home, away };
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** "about 3 days": Jev reads dates as text, so the code does the arithmetic (§11.1). */
export function timeUntil(from: Date, to: Date): string {
  const hours = (to.getTime() - from.getTime()) / 3_600_000;
  if (hours < 0) return "already started";
  if (hours < 1) return "less than an hour";
  if (hours < 36) return `about ${Math.round(hours)} hours`;
  return `about ${Math.round(hours / 24)} days`;
}

// ---------------------------------------------------------------------------
// Jev requests. The shapes follow the TypeSafe API (docs.typesafe.ai/api).

export type JevQuestion =
  | { type: "noul"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> };

export interface JevRequest {
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
}

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };

export interface JevReply {
  model: string;
  answers: Record<string, JevAnswer>;
  inputTokens: number;
}

/** The engine's view of Jev: one request in, one reply out. `packages/data` implements it. */
export type JevAsk = (req: JevRequest) => Promise<JevReply>;

/** Design B: one yes/no question about one injured starter, with only his facts as state. */
export function jevPlayRequest(s: OddsStarter, now: Date): JevRequest {
  return {
    state: {
      snapshot_taken: formatEt(now),
      player: {
        name: s.name,
        position: s.position,
        nfl_team: s.nflTeam,
        opponent: s.opponent,
        game_kickoff: s.kickoffAt ? formatEt(s.kickoffAt) : null,
        time_until_kickoff: s.kickoffAt ? timeUntil(now, s.kickoffAt) : null,
        injury_status: s.injuryStatus,
        injury_body_part: s.injuryBodyPart,
        roster_status: s.status,
      },
    },
    questions: {
      plays: {
        type: "noul",
        instructions: "Will `player` be active and play in this NFL game?",
        criteria: {
          true: "He is active on game day and plays at least one snap.",
          false: "He is inactive, ruled out, placed on a reserve list, or does not play.",
        },
      },
    },
  };
}

function gameText(s: OddsPlayer): string {
  return s.gameState === "none"
    ? "no game this week"
    : s.gameState === "not_started"
      ? "not started"
      : s.gameState === "in_progress"
        ? "in progress"
        : "final";
}

function teamState(team: OddsTeam, now: Date) {
  const f = team.form;
  const atRisk = team.starters
    .filter((s) => s.gameState === "none" || (s.gameState === "not_started" && rulePlayProb(s.injuryStatus, s.status) < 0.5))
    .reduce((sum, s) => sum + Math.max(0, s.proj), 0);
  // The best healthy bench player at each position: who could step in.
  const bestBench = new Map<string, OddsPlayer>();
  for (const b of [...team.bench].sort((a, c) => c.proj - a.proj)) {
    const pos = b.position ?? "?";
    if (!bestBench.has(pos)) bestBench.set(pos, b);
  }
  return {
    record: `${f.wins}-${f.losses}-${f.ties}`,
    average_points: f.avgPoints === null ? null : round1(f.avgPoints),
    average_points_last_3_weeks: f.avgPointsLast3 === null ? null : round1(f.avgPointsLast3),
    average_points_left_on_bench: f.avgPointsLeftOnBench === null ? null : round1(f.avgPointsLeftOnBench),
    empty_starting_slots_this_season: f.emptyStartingSlotsSeason,
    empty_starting_slots_this_week: team.emptySlots.length,
    projected_starter_total: round1(team.starters.reduce((sum, s) => sum + (s.gameState === "none" ? 0 : Math.max(0, s.proj)), 0)),
    projected_points_from_starters_out_doubtful_or_on_bye: round1(atRisk),
    starters: [...team.starters]
      .sort((a, b) => STARTING_SLOTS.indexOf(a.slot) - STARTING_SLOTS.indexOf(b.slot))
      .map((s) => ({
        slot: s.slot,
        name: s.name,
        position: s.position,
        nfl_team: s.nflTeam,
        opponent: s.opponent,
        kickoff: s.kickoffAt ? formatEt(s.kickoffAt) : null,
        time_until_kickoff: s.kickoffAt && s.gameState === "not_started" ? timeUntil(now, s.kickoffAt) : null,
        game: gameText(s),
        projected_points: round1(s.proj),
        points_so_far: s.gameState === "in_progress" || s.gameState === "final" ? round1(s.points ?? 0) : null,
        injury_status: s.injuryStatus,
        injury_body_part: s.injuryBodyPart,
        average_points_last_3_weeks: s.avgLast3 === null ? null : round1(s.avgLast3),
      })),
    best_bench: [...bestBench.values()].map((b) => ({
      name: b.name,
      position: b.position,
      projected_points: round1(b.proj),
      injury_status: b.injuryStatus,
      game: gameText(b),
    })),
  };
}

/**
 * Design A: one Choice per matchup. The state is both teams, keyed `home`
 * and `away` — no team names, no model ids — plus the sums the code did.
 */
export function jevMatchupRequest(m: OddsMatchup, now: Date): JevRequest {
  const home = teamState(m.home, now);
  const away = teamState(m.away, now);
  return {
    state: {
      snapshot_taken: formatEt(now),
      week: m.week,
      playoff_game: m.isPlayoff,
      scoring: "PPR fantasy points; nine starters each (QB, 2 RB, 2 WR, TE, FLEX, DST, K); an empty slot scores 0",
      projected_margin_home_minus_away: round1(home.projected_starter_total - away.projected_starter_total),
      home,
      away,
    },
    questions: {
      winner: {
        type: "choice",
        instructions: "Which fantasy team will score more points this week?",
        criteria: {
          home: "The team in `home` scores more points.",
          away: "The team in `away` scores more points.",
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Scoring (§11.1): computed on read, never stored.

/** Brier score of probability forecasts against 0/1 (or 0.5) outcomes. */
export function brier(pairs: ReadonlyArray<{ p: number; outcome: number }>): number | null {
  if (pairs.length === 0) return null;
  return pairs.reduce((sum, x) => sum + (x.p - x.outcome) ** 2, 0) / pairs.length;
}

/** Share of forecasts on the right side of 0.5; a 0.5 forecast or a tie counts half. */
export function hitRate(pairs: ReadonlyArray<{ p: number; outcome: number }>): number | null {
  if (pairs.length === 0) return null;
  const hits = pairs.reduce((sum, x) => {
    if (x.outcome === 0.5 || x.p === 0.5) return sum + 0.5;
    return sum + ((x.p > 0.5) === (x.outcome === 1) ? 1 : 0);
  }, 0);
  return hits / pairs.length;
}
