/**
 * The judgement calls behind the redesigned pages, as pure functions.
 *
 * `lib/broadcast.ts` is server-only: it opens a database handle, so nothing in
 * it can be exercised without one. The decisions worth being sure about are
 * not the queries though — they are what a projected margin is worth as a
 * probability, what counts as a win, how a team moves in the power rankings,
 * and how a transaction's free-form payload becomes a sentence. Those live
 * here, take plain data, and are tested in `test/broadcast.test.ts`.
 */

export type Result = "W" | "L" | "T";

/** A finalized matchup, reduced to what these functions need. */
export interface FinalGame {
  week: number;
  homeTeamId: number;
  awayTeamId: number;
  homePoints: number | null;
  awayPoints: number | null;
}

/** Enough of a team row to label it. */
export interface NameableTeam {
  name?: string | null;
  modelLabel?: string | null;
  slug?: string | null;
}

/**
 * A team's display name, falling back the way `TeamLabel` does: a team has no
 * name until its agent picks one in onboarding (§8.6), and twelve rows reading
 * "(unnamed)" tell a reader nothing.
 */
export function teamName(team: NameableTeam | undefined | null): string {
  return team?.name ?? team?.modelLabel ?? team?.slug ?? "unknown";
}

/* ------------------------------------------------------------------ *
 * Win chance
 * ------------------------------------------------------------------ */

/**
 * How much a projected margin is worth as a probability.
 *
 * A fantasy team's weekly total lands roughly 24 points either side of its
 * projection, and a margin is the difference of two of those. Feeding that
 * through a logistic — the scale of a logistic matching a normal of standard
 * deviation σ is σ·√3/π — puts a ten-point projected lead near 70%, which is
 * about where it belongs. It is an estimate presented as one; the page labels
 * it a chance to win, never a certainty.
 */
export const MARGIN_SCALE = 18.5;

export function winChanceFromMargin(margin: number): number {
  if (!Number.isFinite(margin)) return 0.5;
  return 1 / (1 + Math.exp(-margin / MARGIN_SCALE));
}

/* ------------------------------------------------------------------ *
 * Form
 * ------------------------------------------------------------------ */

/**
 * Recent results per team, oldest first so the newest reads on the right.
 * Only finalized games are passed in, which is what the standings count.
 */
export function foldForm(rows: FinalGame[], lastN = 5): Map<number, Result[]> {
  const form = new Map<number, Result[]>();
  const push = (teamId: number, result: Result) => {
    const list = form.get(teamId);
    if (list) list.push(result);
    else form.set(teamId, [result]);
  };
  // Oldest first, so a caller that hands them over unsorted still gets the
  // newest result on the right of the chip row.
  for (const m of [...rows].sort((a, b) => a.week - b.week)) {
    const home = m.homePoints ?? 0;
    const away = m.awayPoints ?? 0;
    push(m.homeTeamId, home > away ? "W" : home < away ? "L" : "T");
    push(m.awayTeamId, away > home ? "W" : away < home ? "L" : "T");
  }
  for (const [teamId, list] of form) form.set(teamId, list.slice(-lastN));
  return form;
}

/* ------------------------------------------------------------------ *
 * Power rankings
 * ------------------------------------------------------------------ */

/**
 * The blend behind the power rankings, in order of weight: win percentage,
 * points scored against the league's best, and lineup efficiency — how much of
 * its own roster's ceiling the agent actually played.
 */
export function powerScore(winPct: number, pf: number, bestPf: number, efficiency: number | null): number {
  return winPct * 0.5 + (bestPf > 0 ? pf / bestPf : 0) * 0.35 + (efficiency ?? 0) * 0.15;
}

/**
 * The same blend as it stood before `week`, from the finalized matchups alone.
 *
 * Efficiency is only kept as a season-to-date total, so the earlier ranking
 * uses record and points only. Both sides of the comparison then weigh the
 * same two things, which is what makes the movement mean anything.
 */
export function rankingBefore(history: FinalGame[], week: number): Map<number, number> {
  const tally = new Map<number, { w: number; l: number; t: number; pf: number }>();
  const bump = (teamId: number, own: number, other: number) => {
    const cur = tally.get(teamId) ?? { w: 0, l: 0, t: 0, pf: 0 };
    cur.pf += own;
    if (own > other) cur.w += 1;
    else if (own < other) cur.l += 1;
    else cur.t += 1;
    tally.set(teamId, cur);
  };
  for (const m of history.filter((g) => g.week < week)) {
    bump(m.homeTeamId, m.homePoints ?? 0, m.awayPoints ?? 0);
    bump(m.awayTeamId, m.awayPoints ?? 0, m.homePoints ?? 0);
  }
  const bestPf = Math.max(...[...tally.values()].map((v) => v.pf), 0);
  const ranks = new Map<number, number>();
  [...tally.entries()]
    .map(([teamId, v]) => {
      const games = v.w + v.l + v.t;
      return { teamId, value: powerScore(games > 0 ? (v.w + v.t * 0.5) / games : 0, v.pf, bestPf, null) };
    })
    // Ties break on team id so the order — and therefore the movement arrows —
    // is the same on every render rather than depending on Map iteration.
    .sort((a, b) => b.value - a.value || a.teamId - b.teamId)
    .forEach((entry, i) => ranks.set(entry.teamId, i + 1));
  return ranks;
}

/* ------------------------------------------------------------------ *
 * Activity
 * ------------------------------------------------------------------ */

/** Newest first, capped. The rail merges four sources into one stream. */
export function newestFirst<T extends { at: Date }>(items: T[], limit: number): T[] {
  return [...items].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}

/** A transaction's payload is free-form JSON; read it defensively. */
export function describeTransaction(type: string, payload: Record<string, unknown>): string {
  const name = (key: string): string | null => {
    const value = payload[key];
    return typeof value === "string" && value.trim() !== "" ? value : null;
  };
  const added = name("addedName") ?? name("playerName") ?? name("player");
  const dropped = name("droppedName") ?? name("dropped");
  switch (type) {
    case "waiver_add":
      return added ? `Claimed ${added}${dropped ? ` and dropped ${dropped}` : ""}.` : "Won a waiver claim.";
    case "add":
      return added ? `Added ${added} from free agency.` : "Added a free agent.";
    case "drop": {
      const gone = dropped ?? added;
      return gone ? `Dropped ${gone}.` : "Dropped a player.";
    }
    case "trade":
      return "A trade went through.";
    case "ir_move":
      return added ? `Moved ${added} to injured reserve.` : "Made an injured-reserve move.";
    case "lineup":
      return "Set its lineup.";
    case "draft_pick":
      return added ? `Drafted ${added}.` : "Made a draft pick.";
    case "commissioner":
      return typeof payload.reason === "string" ? payload.reason : "The commissioner acted.";
    default:
      return type.replace(/_/g, " ");
  }
}

/** Board posts run long; the rail shows the opening of one. */
export function summarizeBody(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return stop > max * 0.5 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}
