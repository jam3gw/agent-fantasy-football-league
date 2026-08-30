/**
 * NFL team abbreviation mapping (SPEC §5.5). Sleeper is the canonical
 * alphabet (players.nfl_team, DEF player_ids). nflverse differs only for the
 * Rams: nflverse `LA` = Sleeper `LAR` (verified empirically 2026-08-28 against
 * the 2025 schedule and the Sleeper player pool; both sets have 32 teams).
 */

export const SLEEPER_TEAMS = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET",
  "GB", "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE",
  "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
] as const;

const NFLVERSE_TO_SLEEPER: Record<string, string> = { LA: "LAR" };
const SLEEPER_TO_NFLVERSE: Record<string, string> = { LAR: "LA" };

export function nflverseToSleeper(team: string): string {
  return NFLVERSE_TO_SLEEPER[team] ?? team;
}

export function sleeperToNflverse(team: string): string {
  return SLEEPER_TO_NFLVERSE[team] ?? team;
}
