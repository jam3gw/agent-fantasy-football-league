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
