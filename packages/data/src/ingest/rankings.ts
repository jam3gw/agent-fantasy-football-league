/**
 * Rankings ingest (SPEC §5.7). The engine pulls the draft board itself —
 * nothing is uploaded.
 *
 * The source is Sleeper's season projection feed, which carries both average
 * draft position and projected points in one unauthenticated call. It replaced
 * FantasyPros on 2026-08-29 for two reasons: the free FantasyPros tier capped
 * every response at 10 rows, and — the durable one — Sleeper stopped populating
 * `yahoo_id`/`espn_id` for players who entered the league from about 2021 on.
 * 144 of the top 200 carry neither, so any external source had to be joined by
 * fuzzy name matching for most of the draft board. Sleeper's own `player_id` is
 * already our canonical id, so there is no mapping step here and no unmatched
 * list to resolve before the draft.
 *
 * Derivations, all from real numbers rather than invented ones:
 *   rank     ordering by ADP (draft) or projected points (weekly, ros)
 *   pos_rank that ordering restricted to the player's position — "RB7"
 *   adp      Sleeper's PPR ADP, verbatim, draft set only
 *   tier     a cliff in projected points within a position (see assignTiers)
 */
import type { Clock } from "@league/shared";
import type { EngineDb } from "@league/engine";
import { health, rankings } from "@league/engine";
import type { SleeperStatsEntry } from "../sleeper.ts";
import { fetchSeasonProjections, fetchWeekProjections } from "../sleeper.ts";

export type RankingSet = "draft" | "weekly" | "ros";

/** Sleeper writes 999 into an ADP field it has no value for. */
const ADP_UNSET = 999;

/**
 * A tier boundary is a drop in projected points larger than this multiple of
 * the position's median drop. Measured on the 2026 board, the median gap runs
 * 1.5–2.8 points while real cliffs run 26–50, so the rule is not sensitive to
 * the exact multiple.
 */
const TIER_CLIFF_MULTIPLE = 3;

export interface RankingsIngestResult {
  set: RankingSet;
  week: number;
  /** Rows seen per source call, for /admin/rankings. */
  sourceCounts: Record<string, number>;
  ranked: number;
  /** The draft cannot start below the settings threshold (default 200). */
  distinctRanked: number;
}

interface Candidate {
  playerId: string;
  position: string | null;
  /** The value the set is ordered by: ADP ascending, or points descending. */
  order: number;
  adp: number | null;
  points: number | null;
}

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function positionOf(entry: SleeperStatsEntry): string | null {
  const p = entry.player?.position;
  if (typeof p === "string" && p) return p;
  const fp = entry.player?.fantasy_positions;
  return Array.isArray(fp) && typeof fp[0] === "string" ? fp[0] : null;
}

/**
 * Group by position, order by projected points, and start a new tier wherever
 * the drop to the next player is an outlier for that position. A player with no
 * projection gets no tier: an invented one would read as authoritative.
 */
export function assignTiers(rows: Array<{ playerId: string; position: string | null; points: number | null }>): Map<
  string,
  number
> {
  const tiers = new Map<string, number>();
  const byPosition = new Map<string, Array<{ playerId: string; points: number }>>();

  for (const r of rows) {
    if (r.position === null || r.points === null) continue;
    const bucket = byPosition.get(r.position) ?? [];
    bucket.push({ playerId: r.playerId, points: r.points });
    byPosition.set(r.position, bucket);
  }

  for (const bucket of byPosition.values()) {
    bucket.sort((a, b) => b.points - a.points);
    const gaps: number[] = [];
    for (let i = 0; i < bucket.length - 1; i++) gaps.push(bucket[i]!.points - bucket[i + 1]!.points);
    if (gaps.length === 0) {
      if (bucket[0]) tiers.set(bucket[0].playerId, 1);
      continue;
    }
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const cliff = median * TIER_CLIFF_MULTIPLE;

    let tier = 1;
    tiers.set(bucket[0]!.playerId, tier);
    for (let i = 1; i < bucket.length; i++) {
      // A zero median (every projection identical) must not make every gap a
      // cliff, so a boundary needs a strictly positive drop as well.
      const gap = bucket[i - 1]!.points - bucket[i]!.points;
      if (gap > cliff && gap > 0) tier++;
      tiers.set(bucket[i]!.playerId, tier);
    }
  }
  return tiers;
}

function toCandidates(entries: SleeperStatsEntry[], set: RankingSet): Candidate[] {
  const out: Candidate[] = [];
  for (const e of entries) {
    const playerId = typeof e.player_id === "string" ? e.player_id : null;
    if (!playerId) continue;
    const stats = e.stats ?? {};
    const points = asNumber(stats["pts_ppr"]);
    const rawAdp = asNumber(stats["adp_ppr"]);
    const adp = rawAdp !== null && rawAdp > 0 && rawAdp < ADP_UNSET ? rawAdp : null;

    // The draft board is ordered the way people actually draft; the in-season
    // sets are ordered by what the player is projected to score.
    const order = set === "draft" ? adp : points === null ? null : -points;
    if (order === null) continue;

    out.push({ playerId, position: positionOf(e), order, adp, points });
  }
  // Ascending: ADP already reads that way, points were negated above.
  out.sort((a, b) => a.order - b.order || a.playerId.localeCompare(b.playerId));
  return out;
}

/**
 * Pull one ranking set and store it. `week` 0 with set `draft` is the preseason
 * board; in season pass the current week for the weekly set.
 */
export async function ingestRankings(
  db: EngineDb,
  clock: Clock,
  opts: { season: number; set: RankingSet; week: number },
): Promise<RankingsIngestResult> {
  const { season, set, week } = opts;
  const storedWeek = set === "draft" ? 0 : week;
  const sourceCounts: Record<string, number> = {};

  let entries: SleeperStatsEntry[];
  if (set === "weekly") {
    entries = (await fetchWeekProjections(season, week, { db })) ?? [];
    sourceCounts["week_projections"] = entries.length;
  } else {
    entries = await fetchSeasonProjections(season, { db });
    sourceCounts["season_projections"] = entries.length;
  }

  const candidates = toCandidates(entries, set);
  sourceCounts["ranked"] = candidates.length;

  const tiers = assignTiers(candidates);
  const positionCounts = new Map<string, number>();
  const now = clock.now();

  const values = candidates.map((c, i) => {
    let posRank: string | null = null;
    if (c.position) {
      const n = (positionCounts.get(c.position) ?? 0) + 1;
      positionCounts.set(c.position, n);
      posRank = `${c.position}${n}`;
    }
    return {
      playerId: c.playerId,
      set,
      week: storedWeek,
      rank: i + 1,
      posRank,
      tier: tiers.get(c.playerId) ?? null,
      adp: set === "draft" ? c.adp : null,
      ecrDelta: null,
      sourceCounts,
      fetchedAt: now,
    };
  });

  await db.transaction(async (tx) => {
    for (const v of values) {
      await tx
        .insert(rankings)
        .values(v)
        .onConflictDoUpdate({ target: [rankings.playerId, rankings.set, rankings.week], set: v });
    }
  });

  await recordHealth(db, clock, set, values.length);

  return {
    set,
    week: storedWeek,
    sourceCounts,
    ranked: values.length,
    distinctRanked: new Set(values.map((v) => v.playerId)).size,
  };
}

/**
 * One health row per run. A pull that returns too few players to draft from is
 * an error rather than a quiet success: §5.7's gate would otherwise block the
 * draft with a working feed and nothing on the health page to explain it.
 */
async function recordHealth(db: EngineDb, clock: Clock, set: RankingSet, ranked: number): Promise<void> {
  const at = clock.now();
  const tooFew = set === "draft" && ranked < 200;
  const message = tooFew
    ? `The Sleeper projection feed returned only ${ranked} ranked players for the draft board; §5.7's gate needs 200. ` +
      "The feed is reachable, so this is a shape change upstream rather than a missing key."
    : null;

  await db
    .insert(health)
    .values({
      key: "rankings",
      lastSuccessAt: at,
      ...(message ? { lastError: message, lastErrorAt: at } : {}),
    })
    .onConflictDoUpdate({
      target: health.key,
      set: message ? { lastSuccessAt: at, lastError: message, lastErrorAt: at } : { lastSuccessAt: at },
    });
}
