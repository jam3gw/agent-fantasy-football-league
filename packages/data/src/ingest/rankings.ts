/**
 * FantasyPros rankings ingest (SPEC §5.7). The engine pulls the draft board
 * itself — nothing is uploaded. Per run: the id-map call, the PPR overall
 * consensus call, and six per-position calls; in season the weekly set plus
 * one rest-of-season call.
 *
 * Merge rule (§5.7): `rank` = PPR overall ECR when present, else `rank_ecr`
 * from the players call, else unranked. `pos_rank` and `tier` come from the
 * position calls; `adp` from the players call.
 */
import { eq, sql } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "@league/engine";
import { fpPlayerMap, health, players, rankings, rankingsUnmatched } from "@league/engine";
import type { FpConfig } from "../fantasypros.ts";
import { fpRequest } from "../fantasypros.ts";
import type { FpPlayer, MatchIndex, SleeperCandidate } from "../playerMatch.ts";
import { buildMatchIndex, matchFpPlayer } from "../playerMatch.ts";

export type RankingSet = "draft" | "weekly" | "ros";

export const FP_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;

/** One row of a FantasyPros consensus-rankings response. */
export interface FpRankingRow {
  player_id?: string | number;
  player_name?: string;
  player_team_id?: string;
  player_position_id?: string;
  player_yahoo_id?: string | number | null;
  player_bye_week?: string | number | null;
  player_owned_avg?: number | null;
  rank_ecr?: number | null;
  pos_rank?: string | null;
  tier?: number | null;
  player_ecr_delta?: number | null;
}

/** One row of the /nfl/players id-map response. */
export interface FpPlayersRow {
  player_id?: string | number;
  fpid?: string | number;
  name?: string;
  player_name?: string;
  team_id?: string;
  player_team_id?: string;
  position_id?: string;
  player_position_id?: string;
  yahoo_id?: string | number | null;
  espn_id?: string | number | null;
  rank_ecr?: number | null;
  rank_adp?: number | null;
}

export interface RankingsIngestResult {
  set: RankingSet;
  week: number;
  /** Rows returned per call, for the admin page and truncation checks (§5.7). */
  sourceCounts: Record<string, number>;
  ranked: number;
  unmatched: number;
  /** The draft cannot start below the settings threshold (default 200). */
  distinctRanked: number;
}

interface MergedRanking {
  fpPlayerId: string;
  rank: number | null;
  posRank: string | null;
  tier: number | null;
  adp: number | null;
  ecrDelta: number | null;
}

function asString(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Build the Sleeper-side match index from the players table. */
export async function loadMatchIndex(db: EngineDb): Promise<MatchIndex> {
  const rows = await db
    .select({
      playerId: players.playerId,
      fullName: players.fullName,
      position: players.position,
      nflTeam: players.nflTeam,
      yahooId: players.yahooId,
      espnId: players.espnId,
    })
    .from(players);
  return buildMatchIndex(rows as SleeperCandidate[]);
}

/**
 * Record what FantasyPros said about its own limits, under the `fp.rankings`
 * health key. An error only when the plan makes the draft gate unreachable —
 * otherwise a plain success, so the row doubles as "the rankings pull worked".
 */
async function recordTruncation(db: EngineDb, clock: Clock, body: unknown): Promise<void> {
  const meta = (body ?? {}) as { tier?: unknown; limit?: unknown; count?: unknown };
  const limit = Number(meta.limit);
  const count = Number(meta.count);
  const tier = typeof meta.tier === "string" ? meta.tier : "unknown";
  const at = clock.now();
  const truncated = Number.isFinite(limit) && Number.isFinite(count) && limit < count;

  const message = truncated
    ? `FantasyPros is on the '${tier}' plan, which returns at most ${limit} players per request ` +
      `out of ${count} available. Every request is capped the same way, so the per-position calls ` +
      `cannot get past it either: about ${limit * 7} ranked players is the ceiling, and §5.7's draft ` +
      `gate needs 200. The draft cannot start until the FantasyPros plan is upgraded.`
    : null;

  await db
    .insert(health)
    .values({
      key: "fp.rankings",
      lastSuccessAt: at,
      ...(message ? { lastError: message, lastErrorAt: at } : {}),
    })
    .onConflictDoUpdate({
      target: health.key,
      set: message ? { lastSuccessAt: at, lastError: message, lastErrorAt: at } : { lastSuccessAt: at },
    });
}

/**
 * Pull one ranking set and store it. `week` 0 with set `draft` is the
 * preseason board; in season pass the current week for the weekly set.
 */
export async function ingestFpRankings(
  db: EngineDb,
  clock: Clock,
  cfg: FpConfig,
  opts: { season: number; set: RankingSet; week: number },
): Promise<RankingsIngestResult> {
  const { season, set, week } = opts;
  const sourceCounts: Record<string, number> = {};
  const index = await loadMatchIndex(db);

  // Call 1 — the id map, which also carries rank_ecr and ADP.
  const playersRes = await fpRequest(db, clock, cfg, { kind: "engine" }, "/nfl/players", {
    external_ids: "yahoo:espn",
    ecr: "included",
    show: "pos_rank",
  });
  const merged = new Map<string, MergedRanking>();
  const fpMeta = new Map<string, FpPlayer>();

  if (playersRes.ok) {
    const body = playersRes.body as { players?: FpPlayersRow[] };
    const rows = body.players ?? [];
    sourceCounts["players"] = rows.length;
    for (const r of rows) {
      const fpId = asString(r.player_id ?? r.fpid);
      if (!fpId) continue;
      fpMeta.set(fpId, {
        fpPlayerId: fpId,
        name: r.name ?? r.player_name ?? "",
        position: r.position_id ?? r.player_position_id ?? null,
        team: r.team_id ?? r.player_team_id ?? null,
        yahooId: asString(r.yahoo_id),
        espnId: asString(r.espn_id),
      });
      merged.set(fpId, {
        fpPlayerId: fpId,
        rank: asNumber(r.rank_ecr),
        posRank: null,
        tier: null,
        adp: asNumber(r.rank_adp),
        ecrDelta: null,
      });
    }
  }

  // Call 2 — PPR overall consensus (authoritative rank, plus tier).
  const overallParams: Record<string, string | number> = { position: "ALL", scoring: "PPR" };
  if (set === "ros") overallParams.type = "ROS";
  else overallParams.week = set === "draft" ? 0 : week;
  const overallRes = await fpRequest(
    db,
    clock,
    cfg,
    { kind: "engine" },
    `/nfl/${season}/consensus-rankings`,
    overallParams,
  );
  if (overallRes.ok) {
    const body = overallRes.body as { players?: FpRankingRow[] };
    const rows = body.players ?? [];
    sourceCounts["overall"] = rows.length;
    // FantasyPros states its own truncation in the response: `tier`, the
    // per-response `limit`, and `count`, the number actually available. On the
    // free tier that is limit 10 against a count in the hundreds, and no number
    // of per-position calls can get past it — so §5.7's 200-player gate is
    // simply unreachable until the plan changes. Recording it turns "68 ranked,
    // need 200" with a working key and no errors into something a person can
    // act on.
    await recordTruncation(db, clock, overallRes.body);
    for (const r of rows) {
      const fpId = asString(r.player_id);
      if (!fpId) continue;
      upsertMerged(merged, fpMeta, fpId, r, { rankFromOverall: true });
    }
  }

  // Calls 3–8 — per position, which go deeper than a truncated overall list.
  for (const position of FP_POSITIONS) {
    const params: Record<string, string | number> = { position, scoring: "PPR" };
    if (set === "ros") params.type = "ROS";
    else params.week = set === "draft" ? 0 : week;
    const res = await fpRequest(db, clock, cfg, { kind: "engine" }, `/nfl/${season}/consensus-rankings`, params);
    if (!res.ok) continue;
    const body = res.body as { players?: FpRankingRow[] };
    const rows = body.players ?? [];
    sourceCounts[position] = rows.length;
    for (const r of rows) {
      const fpId = asString(r.player_id);
      if (!fpId) continue;
      upsertMerged(merged, fpMeta, fpId, r, { rankFromOverall: false });
    }
  }

  // Resolve to Sleeper ids and store.
  const now = clock.now();
  let ranked = 0;
  let unmatched = 0;
  const seenPlayerIds = new Set<string>();

  await db.transaction(async (tx) => {
    for (const [fpId, m] of merged) {
      const meta = fpMeta.get(fpId);
      const existing = (await tx.select().from(fpPlayerMap).where(eq(fpPlayerMap.fpPlayerId, fpId)))[0];
      let playerId = existing?.playerId ?? null;
      let matchedBy = existing?.matchedBy ?? null;

      // A name match is re-checked once ids arrive (Appendix B).
      const shouldRematch = !playerId || matchedBy === "name";
      if (shouldRematch && meta) {
        const hit = matchFpPlayer(meta, index);
        if (hit && (!playerId || hit.matchedBy !== "name")) {
          playerId = hit.playerId;
          matchedBy = hit.matchedBy;
          await tx
            .insert(fpPlayerMap)
            .values({ fpPlayerId: fpId, playerId: hit.playerId, matchedBy: hit.matchedBy, updatedAt: now })
            .onConflictDoUpdate({
              target: fpPlayerMap.fpPlayerId,
              set: { playerId: hit.playerId, matchedBy: hit.matchedBy, updatedAt: now },
            });
        }
      }

      if (!playerId) {
        unmatched++;
        if (meta) {
          const already = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(rankingsUnmatched)
            .where(eq(rankingsUnmatched.fpPlayerId, fpId));
          if ((already[0]?.n ?? 0) === 0) {
            await tx.insert(rankingsUnmatched).values({
              fpPlayerId: fpId,
              fpName: meta.name,
              fpTeam: meta.team,
              fpPosition: meta.position,
              raw: { ...meta },
            });
          }
        }
        continue;
      }

      const values = {
        playerId,
        fpPlayerId: fpId,
        set,
        week: set === "draft" ? 0 : week,
        rank: m.rank,
        posRank: m.posRank,
        tier: m.tier,
        adp: m.adp,
        ecrDelta: m.ecrDelta,
        sourceCounts,
        fetchedAt: now,
      };
      await tx
        .insert(rankings)
        .values(values)
        .onConflictDoUpdate({
          target: [rankings.playerId, rankings.set, rankings.week],
          set: values,
        });
      if (m.rank !== null) {
        ranked++;
        seenPlayerIds.add(playerId);
      }
    }
  });

  return {
    set,
    week: set === "draft" ? 0 : week,
    sourceCounts,
    ranked,
    unmatched,
    distinctRanked: seenPlayerIds.size,
  };
}

function upsertMerged(
  merged: Map<string, MergedRanking>,
  fpMeta: Map<string, FpPlayer>,
  fpId: string,
  r: FpRankingRow,
  opts: { rankFromOverall: boolean },
): void {
  const current = merged.get(fpId) ?? {
    fpPlayerId: fpId,
    rank: null,
    posRank: null,
    tier: null,
    adp: null,
    ecrDelta: null,
  };
  // Overall PPR ECR wins; otherwise keep whatever rank we already had (§5.7).
  if (opts.rankFromOverall) {
    const rank = asNumber(r.rank_ecr);
    if (rank !== null) current.rank = rank;
  } else if (current.rank === null) {
    const rank = asNumber(r.rank_ecr);
    if (rank !== null) current.rank = rank;
  }
  if (r.pos_rank) current.posRank = String(r.pos_rank);
  const tier = asNumber(r.tier);
  if (tier !== null) current.tier = tier;
  const delta = asNumber(r.player_ecr_delta);
  if (delta !== null) current.ecrDelta = delta;
  merged.set(fpId, current);

  if (!fpMeta.has(fpId) && r.player_name) {
    fpMeta.set(fpId, {
      fpPlayerId: fpId,
      name: r.player_name,
      position: r.player_position_id ?? null,
      team: r.player_team_id ?? null,
      yahooId: asString(r.player_yahoo_id),
      espnId: null,
    });
  }
}
