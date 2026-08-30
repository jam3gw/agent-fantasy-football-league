/**
 * Season schedule generation (SPEC §3.7).
 *
 * - `generateSchedule`: pure circle-method round robin, deterministic from a
 *   string seed. Weeks 1–11 = the 11 rounds (everyone plays everyone once);
 *   weeks 12–14 repeat the pairings of rounds 1–3 with home/away swapped (so
 *   each repeated opponent gets the other side of the ball; the *pairings* are
 *   identical). A late draft (`startWeek > 1`) drops the earliest weeks — those
 *   games never exist and teams simply play fewer games; weeks 12–14 still
 *   repeat rounds 1–3.
 * - `createSeasonSchedule`: engine write that stores the regular-season
 *   matchup rows. Idempotent.
 */
import { asc, eq } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "./db/index.ts";
import { matchups, teams } from "./db/schema.ts";
import type { EngineResult } from "./errors.ts";
import { fail, ok } from "./errors.ts";
import { getSettings, updateSettings } from "./settings.ts";
import { recordTransaction } from "./transactions.ts";

export interface ScheduledGame {
  week: number;
  homeTeamId: number;
  awayTeamId: number;
}

/** xmur3 string hash → 32-bit seed for mulberry32. */
function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** mulberry32 PRNG: deterministic floats in [0, 1). */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic regular-season schedule (§3.7) for weeks `startWeek..endWeek`
 * (endWeek default 14). The seed drives (a) the shuffle of team order before
 * the circle method and (b) every home/away assignment; the same seed always
 * yields the same schedule.
 */
export function generateSchedule(
  teamIds: number[],
  seed: string,
  startWeek: number,
  endWeek = 14,
): ScheduledGame[] {
  const n = teamIds.length;
  if (n < 2 || n % 2 !== 0) {
    throw new Error(`generateSchedule needs an even number of teams (got ${n})`);
  }
  const rand = mulberry32(hashSeed(seed));

  // Seeded Fisher–Yates shuffle of the team order.
  const order = [...teamIds];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }

  // Circle method: fix order[0], rotate the rest; n − 1 rounds.
  const roundsCount = n - 1;
  const rounds: Array<Array<{ home: number; away: number }>> = [];
  const arr = [...order];
  for (let r = 0; r < roundsCount; r++) {
    const pairs: Array<{ home: number; away: number }> = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i]!;
      const b = arr[n - 1 - i]!;
      const aHome = rand() < 0.5;
      pairs.push({ home: aHome ? a : b, away: aHome ? b : a });
    }
    rounds.push(pairs);
    arr.splice(1, 0, arr.pop()!);
  }

  // Template week w: round w for w ≤ 11; rounds 1–3 again (home/away swapped)
  // for w = 12..14. startWeek > 1 drops the earliest weeks.
  const games: ScheduledGame[] = [];
  for (let week = 1; week <= endWeek; week++) {
    if (week < startWeek) continue;
    const repeat = week > roundsCount;
    const round = repeat ? rounds[week - roundsCount - 1]! : rounds[week - 1]!;
    for (const p of round) {
      games.push({
        week,
        homeTeamId: repeat ? p.away : p.home,
        awayTeamId: repeat ? p.home : p.away,
      });
    }
  }
  return games;
}

/**
 * Create the regular-season matchup rows (§3.7). The seed comes from
 * `league_settings.schedule_seed`; when unset one is derived from the clock
 * and stored. Idempotent: if any regular-season matchups exist, does nothing.
 */
export async function createSeasonSchedule(
  db: EngineDb,
  clock: Clock,
): Promise<EngineResult<{ created: number; seed: string; startWeek: number }>> {
  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    const existing = await tx
      .select({ id: matchups.id })
      .from(matchups)
      .where(eq(matchups.isPlayoff, false))
      .limit(1);
    if (existing.length > 0) {
      return ok({ created: 0, seed: settings.scheduleSeed ?? "", startWeek: settings.startWeek });
    }

    let seed = settings.scheduleSeed;
    if (seed === null) {
      seed = clock.now().getTime().toString(36);
      await updateSettings(tx, { scheduleSeed: seed });
    }

    const teamRows = await tx.select({ id: teams.id }).from(teams).orderBy(asc(teams.id));
    if (teamRows.length < 2 || teamRows.length % 2 !== 0) {
      return fail("invalid_args", `cannot schedule ${teamRows.length} teams (need an even count)`);
    }

    const games = generateSchedule(
      teamRows.map((t) => t.id),
      seed,
      settings.startWeek,
      settings.regularSeasonEndWeek,
    );
    await tx.insert(matchups).values(
      games.map((g) => ({
        week: g.week,
        homeTeamId: g.homeTeamId,
        awayTeamId: g.awayTeamId,
        final: false,
        isPlayoff: false,
      })),
    );
    await recordTransaction(tx, {
      type: "commissioner",
      week: null,
      teamIds: teamRows.map((t) => t.id),
      payload: {
        action: "schedule_created",
        seed,
        startWeek: settings.startWeek,
        games: games.length,
        at: clock.now().toISOString(),
      },
    });
    return ok({ created: games.length, seed, startWeek: settings.startWeek });
  });
}
