/** Sleeper players ingest (SPEC §5.1): upsert + injury-change events for rostered starters. */
import { eq, inArray } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "@league/engine";
import {
  STARTING_SLOTS,
  getSettings,
  handleEvent,
  health,
  lineupEntries,
  players,
} from "@league/engine";
import type { SleeperPlayerRaw } from "../sleeper.ts";
import { fetchAllPlayers } from "../sleeper.ts";

/** Statuses whose arrival triggers injury.changed for a starter (§5.1). */
export const INJURY_EVENT_STATUSES = ["Doubtful", "Out", "IR", "PUP", "NFI", "Sus"];

/**
 * Health key stamped (with Clock time) when a player-feed pull has been
 * APPLIED to the table — by the hourly job and the on-demand refresher alike.
 * Distinct from `sleeper.players`, which records only that a fetch succeeded:
 * freshness must mean "the data landed", or a failed write would read as
 * fresh and injuries would sit stale for a whole TTL.
 */
export const PLAYER_FEED_APPLIED_KEY = "players.applied";

async function stampFeedApplied(db: EngineDb, clock: Clock): Promise<void> {
  const at = clock.now();
  await db
    .insert(health)
    .values({ key: PLAYER_FEED_APPLIED_KEY, lastSuccessAt: at })
    .onConflictDoUpdate({ target: health.key, set: { lastSuccessAt: at } });
}

export interface InjuryChange {
  teamId: number;
  playerId: string;
  from: string | null;
  to: string;
}

export async function upsertPlayers(
  db: EngineDb,
  clock: Clock,
  raw: Record<string, SleeperPlayerRaw>,
): Promise<{ count: number; injuryChanges: InjuryChange[] }> {
  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    const week = settings.currentWeek;

    // starters: current-week lineup entries in starting slots
    const starterRows = await tx
      .select({ teamId: lineupEntries.teamId, playerId: lineupEntries.playerId, slot: lineupEntries.slot })
      .from(lineupEntries)
      .where(eq(lineupEntries.week, week));
    const starterTeam = new Map<string, number>();
    for (const r of starterRows) {
      if ((STARTING_SLOTS as readonly string[]).includes(r.slot)) starterTeam.set(r.playerId, r.teamId);
    }
    const starterIds = [...starterTeam.keys()];
    const before = new Map<string, string | null>();
    if (starterIds.length > 0) {
      const rows = await tx
        .select({ playerId: players.playerId, injuryStatus: players.injuryStatus })
        .from(players)
        .where(inArray(players.playerId, starterIds));
      for (const r of rows) before.set(r.playerId, r.injuryStatus);
    }

    let count = 0;
    for (const [playerId, p] of Object.entries(raw)) {
      const fullName =
        p.full_name ?? [p.first_name, p.last_name].filter(Boolean).join(" ") ?? playerId;
      const values = {
        playerId,
        fullName: fullName || playerId,
        firstName: p.first_name ?? null,
        lastName: p.last_name ?? null,
        position: p.position ?? null,
        fantasyPositions: p.fantasy_positions ?? null,
        nflTeam: p.team ?? null,
        status: p.status ?? null,
        injuryStatus: p.injury_status ?? null,
        injuryBodyPart: p.injury_body_part ?? null,
        active: p.active ?? false,
        depthChartOrder: p.depth_chart_order ?? null,
        number: typeof p.number === "number" ? p.number : null,
        yearsExp: p.years_exp ?? null,
        gsisId: p.gsis_id ? String(p.gsis_id) : null,
        espnId: p.espn_id != null ? String(p.espn_id) : null,
        yahooId: p.yahoo_id != null ? String(p.yahoo_id) : null,
        raw: p as Record<string, unknown>,
        updatedAt: clock.now(),
      };
      await tx
        .insert(players)
        .values(values)
        .onConflictDoUpdate({ target: players.playerId, set: { ...values, playerId: undefined } });
      count++;
    }

    const injuryChanges: InjuryChange[] = [];
    for (const [playerId, teamId] of starterTeam) {
      const after = raw[playerId]?.injury_status ?? null;
      const prev = before.get(playerId) ?? null;
      if (after && after !== prev && INJURY_EVENT_STATUSES.includes(after)) {
        injuryChanges.push({ teamId, playerId, from: prev, to: after });
        await handleEvent(tx, clock, {
          type: "injury.changed",
          teamId,
          playerId,
          status: after,
          week,
        });
      }
    }
    // Inside the transaction, so the freshness marker is atomic with the
    // write it certifies.
    await stampFeedApplied(tx as unknown as EngineDb, clock);
    return { count, injuryChanges };
  });
}

/* ------------------------------------------------------------------ *
 * On-demand player-feed refresh (§5.1, on the §5.4 on-demand pattern)
 * ------------------------------------------------------------------ */

/**
 * How stale the player feed may be before a tool read re-pulls it. Injury
 * designations land through Sunday morning and actives ~90 minutes before
 * kickoff, so an agent checking its lineup pre-kickoff sees data at most this
 * old — much tighter than the hourly `ingest.players` job alone.
 */
export const PLAYER_FEED_TTL_MS = 15 * 60_000;

/** How long a failed pull suppresses re-fetching (per process). */
export const PLAYER_FEED_MISS_TTL_MS = 5 * 60_000;

/** Single attempt, generous timeout — the feed is one ~5MB document. */
const FEED_FETCH_OPTS = { retries: 0, timeoutMs: 30_000 };

/**
 * More changed players than a tool call should write. A delta this large is a
 * roster-cut day or a first run after downtime — the hourly job's work, not a
 * read path's; game-day injury deltas are dozens of rows at most.
 */
export const MAX_ON_DEMAND_PLAYER_WRITES = 500;

export interface EnsureFreshPlayerFeedResult {
  /** deferred: the feed was fetched but the delta was too large for a tool call. */
  outcome: "fresh" | "refreshed" | "unavailable" | "deferred";
  /** Players actually written (rows whose lineup-relevant fields moved). */
  changed: number;
  /** injury.changed events emitted for rostered starters, as in the hourly job. */
  injuryChanges: number;
}

let inflightFeed: Promise<EnsureFreshPlayerFeedResult> | null = null;
let feedMissAt: number | null = null;

/** Test hook: clears the in-process inflight and miss state. */
export function resetPlayerFeedRefreshState(): void {
  inflightFeed = null;
  feedMissAt = null;
}

/**
 * Make the `players` table as fresh as Sleeper's feed allows, then return.
 *
 * Freshness is read from the PLAYER_FEED_APPLIED_KEY health row, which
 * `upsertPlayers` stamps (with Clock time) whenever a pull actually lands —
 * by the hourly job and by this refresher alike — so a tool read minutes
 * after the job ran is a single SELECT and done, and a failed write can
 * never masquerade as freshness.
 *
 * The full feed carries ~11k players, and upserting them all from inside a
 * tool call would take minutes — so this diffs against what is stored and
 * writes only players whose lineup-relevant fields moved (injury status and
 * body part, roster status, NFL team, active flag, depth-chart order) plus
 * players we have never seen. The write path is `upsertPlayers`, so starter
 * injury changes emit `injury.changed` exactly as the hourly job would —
 * just sooner. Never throws; concurrent callers share one pull.
 */
export async function ensureFreshPlayerFeed(
  db: EngineDb,
  clock: Clock,
  opts: { ttlMs?: number; maxWrites?: number } = {},
): Promise<EnsureFreshPlayerFeedResult> {
  if (inflightFeed) return inflightFeed;
  const run = refreshPlayerFeed(db, clock, opts).finally(() => {
    inflightFeed = null;
  });
  inflightFeed = run;
  return run;
}

async function refreshPlayerFeed(
  db: EngineDb,
  clock: Clock,
  {
    ttlMs = PLAYER_FEED_TTL_MS,
    maxWrites = MAX_ON_DEMAND_PLAYER_WRITES,
  }: { ttlMs?: number; maxWrites?: number },
): Promise<EnsureFreshPlayerFeedResult> {
  const none = (outcome: "fresh" | "unavailable" | "deferred"): EnsureFreshPlayerFeedResult => ({
    outcome,
    changed: 0,
    injuryChanges: 0,
  });
  const now = clock.now().getTime();
  try {
    const h = await db
      .select({ at: health.lastSuccessAt })
      .from(health)
      .where(eq(health.key, PLAYER_FEED_APPLIED_KEY));
    const at = h[0]?.at ? new Date(h[0].at).getTime() : null;
    if (at !== null && now - at < ttlMs) return none("fresh");
    if (feedMissAt !== null && now - feedMissAt < PLAYER_FEED_MISS_TTL_MS) return none("unavailable");

    // An empty players table is a bootstrap, not staleness: the first full
    // ingest belongs to the `ingest.players` job, not to a tool call that
    // would then write ~11k rows mid-session.
    const stored = await db
      .select({
        playerId: players.playerId,
        injuryStatus: players.injuryStatus,
        injuryBodyPart: players.injuryBodyPart,
        status: players.status,
        nflTeam: players.nflTeam,
        active: players.active,
        depthChartOrder: players.depthChartOrder,
        position: players.position,
        fantasyPositions: players.fantasyPositions,
      })
      .from(players);
    if (stored.length === 0) return none("unavailable");

    let raw: Record<string, SleeperPlayerRaw> | null;
    try {
      raw = await fetchAllPlayers({ db, ...FEED_FETCH_OPTS });
    } catch {
      raw = null;
    }
    if (!raw || Object.keys(raw).length === 0) {
      feedMissAt = now;
      return none("unavailable");
    }
    feedMissAt = null;

    const byId = new Map(stored.map((s) => [s.playerId, s]));
    const changed: Record<string, SleeperPlayerRaw> = {};
    let changedCount = 0;
    for (const [id, p] of Object.entries(raw)) {
      const s = byId.get(id);
      if (
        !s ||
        (p.injury_status ?? null) !== s.injuryStatus ||
        (p.injury_body_part ?? null) !== s.injuryBodyPart ||
        (p.status ?? null) !== s.status ||
        (p.team ?? null) !== s.nflTeam ||
        (p.active ?? false) !== s.active ||
        (p.depth_chart_order ?? null) !== s.depthChartOrder ||
        (p.position ?? null) !== s.position ||
        JSON.stringify(p.fantasy_positions ?? null) !== JSON.stringify(s.fantasyPositions ?? null)
      ) {
        changed[id] = p;
        changedCount++;
      }
    }
    if (changedCount === 0) {
      // Nothing to write, but the table now provably matches the feed:
      // stamp it applied so the next reads inside the TTL are one SELECT.
      await stampFeedApplied(db, clock);
      return { outcome: "refreshed", changed: 0, injuryChanges: 0 };
    }
    if (changedCount > maxWrites) {
      // Not applied, so not fresh — but suppressed like a miss so back-to-back
      // reads do not re-download the 5MB feed; the hourly job carries deltas
      // this large.
      feedMissAt = now;
      return none("deferred");
    }

    // upsertPlayers stamps PLAYER_FEED_APPLIED_KEY inside its transaction.
    const res = await upsertPlayers(db, clock, changed);
    return { outcome: "refreshed", changed: res.count, injuryChanges: res.injuryChanges.length };
  } catch {
    // "Never throws" covers the whole body: a failing read, health stamp, or
    // upsert (a dropped connection, a transient DB error) degrades to "serve
    // what is stored" and is remembered like a fetch miss.
    feedMissAt = now;
    return none("unavailable");
  }
}

/** §5.2 trending adds: clear and set the latest counts. */
export async function upsertTrending(
  db: EngineDb,
  rows: Array<{ player_id: string; count: number }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(players).set({ trendingAdds: null });
    for (const r of rows) {
      await tx.update(players).set({ trendingAdds: r.count }).where(eq(players.playerId, r.player_id));
    }
  });
}
