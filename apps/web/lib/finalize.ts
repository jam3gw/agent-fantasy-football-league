import "server-only";
/**
 * Week finalization and the scoring degradation ladder (SPEC §13.3, §13.4).
 *
 * Finalization is never skipped and never waits for a person. The engine walks
 * down the source list on its own and records which source scored the week.
 */
import { eq } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "@league/engine";
import {
  finalizeWeekCore,
  getSettings,
  health,
  playerWeekStats,
  updateSettings,
  weekGamesComplete,
} from "@league/engine";
import { fetchWeekStats, upsertWeekStats } from "@league/data";
import type { SleeperStatsEntry } from "@league/data";

export type ScoringSource = "sleeper" | "nflverse";

export interface FinalizeResult {
  week: number;
  source: ScoringSource | "none";
  playersScored: number;
  matchupsFinalized: number;
  currentWeek: number;
  degraded: boolean;
  /** §5.6: players compared against nflverse, and how many differed by > 0.5. */
  audited: number;
  auditDiscrepancies: number;
  /**
   * True when the week's games have not been played yet, so nothing was
   * finalized and `current_week` did not move. The workflow skips the
   * next-week plan on a deferred result.
   */
  deferred?: boolean;
}

/**
 * Finalize a week. Tries Sleeper, then nflverse; whichever succeeds is
 * recorded on the week (§13.4). FantasyPros sat between them until 2026-08-29;
 * it was removed with the rest of that integration, so the ladder is two deep.
 */
export async function finalizeWeek(db: EngineDb, clock: Clock, week: number): Promise<FinalizeResult> {
  const settings = await getSettings(db);
  const season = settings.season;

  // A week whose games have not been played does not finalize — the calendar
  // booked this run, not the season. §13.4's "never skipped, never waits for
  // a person" is about stats sources being down after the games happened;
  // finalization waits for games, only for games. (2026-09-01: the first
  // Tuesday of the regular phase fell nine days before kickoff and week 1
  // finalized as six 0–0s.) The booking chain re-books every Tuesday, so a
  // deferred week is retried on the first Tuesday after its games.
  const completion = await weekGamesComplete(db, clock, week);
  if (!completion.complete) {
    // A pending week is a healthy deferral: stamp success and clear any old
    // error. A missing schedule is a fault: raise the error WITHOUT stamping
    // success, so monitoring keyed on success staleness still sees it.
    const fault = completion.reason === "no_games_recorded";
    const stamp = fault
      ? {
          lastError: `week ${week} cannot finalize: no NFL games recorded — is the schedule ingested?`,
          lastErrorAt: clock.now(),
        }
      : { lastSuccessAt: clock.now(), lastError: null, lastErrorAt: null };
    await db
      .insert(health)
      .values({ key: "stats.finalize", ...stamp })
      .onConflictDoUpdate({ target: health.key, set: stamp });
    return {
      week,
      source: "none",
      playersScored: 0,
      matchupsFinalized: 0,
      currentWeek: settings.currentWeek,
      degraded: false,
      audited: 0,
      auditDiscrepancies: 0,
      deferred: true,
    };
  }

  let source: ScoringSource | "none" = "none";
  let playersScored = 0;

  // Source 1 — Sleeper stats (primary).
  try {
    const entries = await fetchWeekStats(season, week, { db });
    if (entries.length > 0) {
      const res = await upsertWeekStats(db, clock, { season, week, entries, markFinal: true, source: "sleeper" });
      playersScored = res.count;
      source = "sleeper";
    }
  } catch {
    source = "none";
  }

  // Source 2 — nflverse weekly stats through scoring_settings. Offense and
  // kickers only; D/ST scores 0 and the week is flagged (§13.4).
  if (source === "none") {
    try {
      const entries = await fetchNflverseWeek(db, season, week);
      if (entries.length > 0) {
        const res = await upsertWeekStats(db, clock, {
          season,
          week,
          entries,
          markFinal: true,
          source: "nflverse",
        });
        playersScored = res.count;
        source = "nflverse";
      }
    } catch {
      source = "none";
    }
  }

  // Whatever happened above, the week finalizes from whatever stats exist —
  // §13.4: "Finalization is never skipped and never waits for a person."
  const core = await finalizeWeekCore(db, clock, week);
  if (!core.ok) throw new Error(`finalizeWeekCore failed: ${core.message}`);

  // Record the source so the site and health page can show it.
  const extra = (await getSettings(db)).extra as Record<string, unknown>;
  const weekSources = { ...((extra.weekScoringSources as Record<string, string>) ?? {}), [String(week)]: source };
  await updateSettings(db, { extra: { ...extra, weekScoringSources: weekSources } });

  // One shape for insert and conflict alike: a clean finalization clears any
  // standing error (it used to linger on /admin/health for good), and the
  // no-source flag survives the upsert (the conflict path used to drop it).
  const finalizeStamp =
    source === "none"
      ? {
          lastSuccessAt: clock.now(),
          lastError: `week ${week} finalized with no stats source`,
          lastErrorAt: clock.now(),
        }
      : { lastSuccessAt: clock.now(), lastError: null, lastErrorAt: null };
  await db
    .insert(health)
    .values({ key: "stats.finalize", ...finalizeStamp })
    .onConflictDoUpdate({ target: health.key, set: finalizeStamp });

  // §13.3 step: audit the week against nflverse. It never changes a score —
  // the week is already final — it only records where the two disagree.
  const audit = await auditAgainstNflverse(db, clock, season, week, source);

  return {
    week,
    source,
    playersScored,
    matchupsFinalized: core.value.matchupsFinalized,
    currentWeek: core.value.currentWeek,
    degraded: source !== "sleeper",
    audited: audit.checked,
    auditDiscrepancies: audit.discrepancies,
  };
}

/** §5.6: what an audit found. A failed fetch is not a failed finalization. */
export interface AuditResult {
  checked: number;
  discrepancies: number;
}

/**
 * §5.6 — audit the week's offense and kicker points against nflverse and log
 * every disagreement over 0.5 points. nflverse carries no team defence, so
 * D/ST is out of scope; and a week nflverse itself scored has nothing to audit
 * against, so that is skipped rather than compared with itself.
 *
 * Rows go to `scoring_discrepancies`, the same log the Sleeper `pts_ppr` check
 * writes to (§3.2) — it is the one discrepancy table §6 defines. The summary
 * goes to `health` under `stats.audit` so `/admin/health` shows it.
 */
export async function auditAgainstNflverse(
  db: EngineDb,
  clock: Clock,
  season: number,
  week: number,
  source: ScoringSource | "none",
): Promise<AuditResult> {
  if (source === "nflverse" || source === "none") return { checked: 0, discrepancies: 0 };

  let reference: SleeperStatsEntry[];
  try {
    reference = await fetchNflverseWeek(db, season, week);
  } catch (err) {
    // The audit is advisory. A dead feed is recorded and the week stays final.
    await recordHealth(db, clock, "stats.audit", { error: `week ${week}: ${String(err)}` });
    return { checked: 0, discrepancies: 0 };
  }
  if (reference.length === 0) return { checked: 0, discrepancies: 0 };

  const { players, scoringDiscrepancies } = await import("@league/engine");
  const position = new Map(
    (await db.select({ playerId: players.playerId, position: players.position }).from(players)).map((p) => [
      p.playerId,
      p.position,
    ]),
  );
  // The points that scored the week, which is what §5.6 audits — not
  // `engine_pts`, which a source supplying computed points rather than a stat
  // line leaves at 0.
  const scored = new Map(
    (await db.select().from(playerWeekStats))
      .filter((r) => r.season === season && r.week === week)
      .map((r) => [r.playerId, r.ptsPpr ?? r.enginePts]),
  );

  let checked = 0;
  let discrepancies = 0;
  for (const entry of reference) {
    const pos = position.get(entry.player_id);
    if (!pos || pos === "DEF") continue; // §5.6: not used for D/ST
    const ours = scored.get(entry.player_id);
    if (ours === undefined || ours === null) continue;
    checked++;
    const theirs = Number(entry.stats.pts_ppr ?? 0);
    const diff = Math.round((theirs - ours) * 100) / 100;
    if (Math.abs(diff) <= 0.5) continue; // §5.6 threshold
    discrepancies++;
    await db.insert(scoringDiscrepancies).values({
      playerId: entry.player_id,
      season,
      week,
      ptsPpr: theirs,
      enginePts: ours,
      diff,
      createdAt: clock.now(),
    });
  }

  await recordHealth(db, clock, "stats.audit", {
    error: discrepancies > 0 ? `week ${week}: ${discrepancies} of ${checked} players differ from nflverse by more than 0.5` : null,
  });
  return { checked, discrepancies };
}

async function recordHealth(
  db: EngineDb,
  clock: Clock,
  key: string,
  input: { error?: string | null },
): Promise<void> {
  const now = clock.now();
  await db
    .insert(health)
    .values({
      key,
      lastSuccessAt: now,
      ...(input.error ? { lastError: input.error, lastErrorAt: now } : {}),
    })
    .onConflictDoUpdate({
      target: health.key,
      set: input.error ? { lastSuccessAt: now, lastError: input.error, lastErrorAt: now } : { lastSuccessAt: now },
    });
}

/**
 * Source 3: nflverse weekly player stats scored through `scoring_settings`.
 * D/ST needs play-by-play, which is a stretch goal (§13.4), so team defenses
 * score 0 in this path and the week is flagged as degraded.
 */
async function fetchNflverseWeek(db: EngineDb, season: number, week: number): Promise<SleeperStatsEntry[]> {
  const { fetchNflverseWeeklyStats } = await import("@league/data");
  const rows = await fetchNflverseWeeklyStats(season, { db });
  const settings = await getSettings(db);
  const { players } = await import("@league/engine");
  const byGsis = new Map(
    (await db.select({ playerId: players.playerId, gsisId: players.gsisId }).from(players))
      .filter((p) => p.gsisId)
      .map((p) => [p.gsisId!, p.playerId]),
  );
  const out: SleeperStatsEntry[] = [];
  for (const r of rows) {
    if (r.week !== week) continue;
    const playerId = byGsis.get(r.gsisId);
    if (!playerId) continue;
    out.push({ player_id: playerId, season, week, stats: { ...r.stats, pts_ppr: scoreStats(settings.scoringSettings, r.stats) } });
  }
  return out;
}

function scoreStats(scoring: Record<string, number>, stats: Record<string, number>): number {
  let total = 0;
  for (const [k, v] of Object.entries(stats)) {
    const c = scoring[k];
    if (c) total += c * v;
  }
  return Math.round(total * 100) / 100;
}

/** Which source scored a week (site + health page). */
export async function weekScoringSource(db: EngineDb, week: number): Promise<ScoringSource | "none" | null> {
  const settings = await getSettings(db);
  const sources = (settings.extra as { weekScoringSources?: Record<string, string> }).weekScoringSources;
  return (sources?.[String(week)] as ScoringSource | "none" | undefined) ?? null;
}

/** Rows still missing stats for a week (health page). */
export async function missingStatsCount(db: EngineDb, season: number, week: number): Promise<number> {
  const rows = await db
    .select()
    .from(playerWeekStats)
    .where(eq(playerWeekStats.week, week));
  return rows.filter((r) => r.season === season && r.ptsPpr === null).length;
}
