/** nflverse schedule (SPEC §5.5) and weekly stats audit (§5.6). */
import { zonedTimeToUtc } from "@league/shared";
import type { EngineDb } from "@league/engine";
import { parseCsv } from "./csv.ts";
import { fetchWithRetry } from "./http.ts";
import { nflverseToSleeper } from "./teamAbbrev.ts";

export const SCHEDULE_URL = "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv";

export interface NflverseGame {
  gameId: string;
  season: number;
  week: number;
  gameType: string;
  kickoffAt: Date;
  /** Sleeper abbreviations. */
  home: string;
  away: string;
  homeScore: number | null;
  awayScore: number | null;
  /** true when nflverse has a result (final). */
  final: boolean;
}

/** Parse games.csv rows into games with UTC kickoffs and Sleeper team codes. */
export function parseGames(csvText: string, season?: number): NflverseGame[] {
  const out: NflverseGame[] = [];
  for (const r of parseCsv(csvText)) {
    if (!r.game_id || !r.gameday) continue;
    const s = Number(r.season);
    if (season !== undefined && s !== season) continue;
    const [y, m, d] = r.gameday!.split("-").map(Number);
    const [hh, mm] = (r.gametime || "13:00").split(":").map(Number);
    out.push({
      gameId: r.game_id!,
      season: s,
      week: Number(r.week),
      gameType: r.game_type ?? "REG",
      kickoffAt: zonedTimeToUtc(y!, m!, d!, hh ?? 13, mm ?? 0),
      home: nflverseToSleeper(r.home_team!),
      away: nflverseToSleeper(r.away_team!),
      homeScore: r.home_score === "" || r.home_score === undefined ? null : Number(r.home_score),
      awayScore: r.away_score === "" || r.away_score === undefined ? null : Number(r.away_score),
      final: r.result !== "" && r.result !== undefined,
    });
  }
  return out;
}

export async function fetchSchedule(opts: { db?: EngineDb } = {}): Promise<string> {
  return (await fetchWithRetry(SCHEDULE_URL, {
    ...opts,
    parse: "text",
    timeoutMs: 60_000,
    healthKey: "nflverse.schedule",
  })) as string;
}

/**
 * nflverse weekly player stats (§5.6) — the documented audit path, and the
 * last rung of the scoring ladder (§13.4). The release file naming changed
 * over time, so both known names are tried and the first that responds wins.
 */
export const NFLVERSE_STATS_URLS = (season: number): string[] => [
  `https://github.com/nflverse/nflverse-data/releases/download/player_stats/stats_player_week_${season}.csv`,
  `https://github.com/nflverse/nflverse-data/releases/download/player_stats/player_stats_${season}.csv`,
];

export interface NflverseWeeklyStat {
  gsisId: string;
  week: number;
  season: number;
  /** Sleeper-keyed stat object so it can be scored with scoring_settings. */
  stats: Record<string, number>;
}

/** nflverse column → Sleeper stat key, for the columns our scoring uses. */
const STAT_COLUMNS: Record<string, string> = {
  passing_yards: "pass_yd",
  passing_tds: "pass_td",
  passing_interceptions: "pass_int",
  interceptions: "pass_int",
  passing_2pt_conversions: "pass_2pt",
  rushing_yards: "rush_yd",
  rushing_tds: "rush_td",
  rushing_2pt_conversions: "rush_2pt",
  receptions: "rec",
  receiving_yards: "rec_yd",
  receiving_tds: "rec_td",
  receiving_2pt_conversions: "rec_2pt",
  rushing_fumbles_lost: "fum_lost",
  receiving_fumbles_lost: "fum_lost",
  sack_fumbles_lost: "fum_lost",
  // Kicking (§13.4). Without these every kicker scored 0 on a week finalized
  // from nflverse — a silent 8–12 point hole in nine of twelve lineups on the
  // one path taken when both Sleeper and FantasyPros are unavailable.
  pat_made: "xpm",
  pat_missed: "xpmiss",
  fg_made_0_19: "fgm_0_19",
  fg_made_20_29: "fgm_20_29",
  fg_made_30_39: "fgm_30_39",
  fg_made_40_49: "fgm_40_49",
  // Sleeper's scoring has one bucket from 50 yards up; nflverse splits it.
  fg_made_50_59: "fgm_50p",
  fg_made_60_: "fgm_50p",
  fg_missed: "fgmiss",
};

/**
 * The distance buckets above are only in the newer release files. When a file
 * has plain `fg_made` and no buckets, credit each make at the 30–39 rate —
 * the value Sleeper gives every field goal under 40 yards, and the modal
 * distance. It under-credits long kicks by 1–2 points each. That is the price
 * of the last rung of the ladder being reachable at all, and the week records
 * its source so the approximation is never invisible.
 */
const FG_BUCKET_COLUMNS = Object.keys(STAT_COLUMNS).filter((c) => c.startsWith("fg_made_"));
const FG_FALLBACK_KEY = "fgm_30_39";

export function parseNflverseWeeklyStats(csvText: string, season: number): NflverseWeeklyStat[] {
  const out: NflverseWeeklyStat[] = [];
  for (const r of parseCsv(csvText)) {
    const gsisId = r.player_id ?? r.gsis_id ?? "";
    if (!gsisId) continue;
    if (r.season && Number(r.season) !== season) continue;
    if (r.season_type && r.season_type !== "REG") continue;
    const stats: Record<string, number> = {};
    for (const [column, key] of Object.entries(STAT_COLUMNS)) {
      const raw = r[column];
      if (raw === undefined || raw === "" || raw === "NA") continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n === 0) continue;
      stats[key] = (stats[key] ?? 0) + n;
    }
    if (!FG_BUCKET_COLUMNS.some((c) => c in r)) {
      const made = Number(r.fg_made);
      if (Number.isFinite(made) && made > 0) stats[FG_FALLBACK_KEY] = (stats[FG_FALLBACK_KEY] ?? 0) + made;
    }
    out.push({ gsisId, week: Number(r.week), season, stats });
  }
  return out;
}

export async function fetchNflverseWeeklyStats(
  season: number,
  opts: { db?: EngineDb } = {},
): Promise<NflverseWeeklyStat[]> {
  let lastError: unknown;
  for (const url of NFLVERSE_STATS_URLS(season)) {
    try {
      const text = (await fetchWithRetry(url, {
        ...opts,
        parse: "text",
        timeoutMs: 60_000,
        retries: 1,
        healthKey: "nflverse.player_stats",
      })) as string;
      return parseNflverseWeeklyStats(text, season);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("nflverse weekly stats unavailable");
}
