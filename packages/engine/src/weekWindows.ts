/**
 * Kickoff windows (§9.2) and the lineup-check lead time (§9.2 step 3).
 *
 * Pure: shared by the scheduler that books `lineup_check` sessions and by the
 * context snapshot that tells an agent when those checks will run (§8.5), so
 * both compute the same windows from the same games.
 */

/** Games whose kickoffs are within 30 minutes of each other are one window (§9.2). */
export const WINDOW_TOLERANCE_MS = 30 * 60_000;
/** A `lineup_check` runs this long before its window's first kickoff. */
export const LINEUP_CHECK_LEAD_MS = 90 * 60_000;

export interface GameWindow {
  /** The earliest kickoff in the window; also the window's key. */
  key: Date;
  nflTeams: string[];
}

/** Group a week's kickoffs into windows. */
export function groupKickoffWindows(
  games: Array<{ kickoffAt: Date; home: string; away: string }>,
): GameWindow[] {
  const sorted = [...games].sort((a, b) => a.kickoffAt.getTime() - b.kickoffAt.getTime());
  const windows: GameWindow[] = [];
  for (const game of sorted) {
    const current = windows[windows.length - 1];
    if (current && game.kickoffAt.getTime() - current.key.getTime() <= WINDOW_TOLERANCE_MS) {
      current.nflTeams.push(game.home, game.away);
    } else {
      windows.push({ key: game.kickoffAt, nflTeams: [game.home, game.away] });
    }
  }
  return windows;
}

/** When the league's `lineup_check` for a window runs. */
export function lineupCheckDueAt(window: GameWindow): Date {
  return new Date(window.key.getTime() - LINEUP_CHECK_LEAD_MS);
}
