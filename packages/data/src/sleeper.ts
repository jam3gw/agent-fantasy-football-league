/** Sleeper API clients (SPEC §5.1–5.4). Documented endpoints on api.sleeper.app; undocumented stats/projections on api.sleeper.com. */
import type { EngineDb } from "@league/engine";
import { fetchWithRetry } from "./http.ts";

const APP = "https://api.sleeper.app/v1";
const STATS = "https://api.sleeper.com";

export const FANTASY_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;

function positionsQuery(): string {
  return FANTASY_POSITIONS.map((p) => `position[]=${p}`).join("&");
}

export interface SleeperPlayerRaw {
  player_id?: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  position?: string | null;
  fantasy_positions?: string[] | null;
  team?: string | null;
  status?: string | null;
  injury_status?: string | null;
  injury_body_part?: string | null;
  active?: boolean;
  depth_chart_order?: number | null;
  number?: number | null;
  years_exp?: number | null;
  gsis_id?: string | null;
  espn_id?: number | string | null;
  yahoo_id?: number | string | null;
  [k: string]: unknown;
}

export interface SleeperStatsEntry {
  player_id: string;
  season: string | number;
  week?: number | null;
  team?: string | null;
  opponent?: string | null;
  game_id?: string | null;
  updated_at?: number | null;
  last_modified?: number | null;
  stats: Record<string, number>;
  player?: { position?: string | null; fantasy_positions?: string[] | null } | null;
  [k: string]: unknown;
}

export interface SleeperClientOptions {
  db?: EngineDb;
  timeoutMs?: number;
}

export async function fetchNflState(opts: SleeperClientOptions = {}): Promise<Record<string, unknown>> {
  return (await fetchWithRetry(`${APP}/state/nfl`, { ...opts, healthKey: "sleeper.state" })) as Record<string, unknown>;
}

/** §5.1 — the full ~5MB player map, keyed by player_id. */
export async function fetchAllPlayers(opts: SleeperClientOptions = {}): Promise<Record<string, SleeperPlayerRaw>> {
  return (await fetchWithRetry(`${APP}/players/nfl`, {
    ...opts,
    timeoutMs: opts.timeoutMs ?? 120_000,
    healthKey: "sleeper.players",
  })) as Record<string, SleeperPlayerRaw>;
}

/** §5.2 — trending adds over the last 24 h. */
export async function fetchTrendingAdds(
  opts: SleeperClientOptions = {},
): Promise<Array<{ player_id: string; count: number }>> {
  return (await fetchWithRetry(`${APP}/players/nfl/trending/add?lookback_hours=24&limit=100`, {
    ...opts,
    healthKey: "sleeper.trending",
  })) as Array<{ player_id: string; count: number }>;
}

/** §5.3 — weekly stats (undocumented). */
export async function fetchWeekStats(
  season: number,
  week: number,
  opts: SleeperClientOptions = {},
): Promise<SleeperStatsEntry[]> {
  const url = `${STATS}/stats/nfl/${season}/${week}?season_type=regular&${positionsQuery()}`;
  return (await fetchWithRetry(url, { ...opts, healthKey: "sleeper.stats" })) as SleeperStatsEntry[];
}

/** §5.3 — season totals (draft board last-season stats). */
export async function fetchSeasonStats(season: number, opts: SleeperClientOptions = {}): Promise<SleeperStatsEntry[]> {
  const url = `${STATS}/stats/nfl/${season}?season_type=regular&${positionsQuery()}`;
  return (await fetchWithRetry(url, { ...opts, healthKey: "sleeper.stats_season" })) as SleeperStatsEntry[];
}

/**
 * §5.7 — season-long projections carrying ADP. One call, no key, no quota.
 * `order_by=adp_ppr` asks Sleeper for the draft ordering directly; every row
 * also carries `pts_ppr` season projections, which is where tiers come from.
 * Rows are keyed by Sleeper `player_id`, which is already our canonical id,
 * so nothing here needs a player-id mapping.
 */
export async function fetchSeasonProjections(
  season: number,
  opts: SleeperClientOptions = {},
): Promise<SleeperStatsEntry[]> {
  const url = `${STATS}/projections/nfl/${season}?season_type=regular&${positionsQuery()}&order_by=adp_ppr`;
  return (await fetchWithRetry(url, {
    ...opts,
    timeoutMs: opts.timeoutMs ?? 60_000,
    healthKey: "sleeper.season_projections",
  })) as SleeperStatsEntry[];
}

/** §5.4 — weekly projections (undocumented, optional; do not fail the caller). */
export async function fetchWeekProjections(
  season: number,
  week: number,
  opts: SleeperClientOptions = {},
): Promise<SleeperStatsEntry[] | null> {
  try {
    const url = `${STATS}/projections/nfl/${season}/${week}?season_type=regular&${positionsQuery()}`;
    return (await fetchWithRetry(url, { ...opts, healthKey: "sleeper.projections" })) as SleeperStatsEntry[];
  } catch {
    return null;
  }
}
