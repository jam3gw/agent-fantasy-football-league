/**
 * Standings, playoff seeding, and bracket advancement (SPEC §3.7, §7.6).
 * Standings are computed on demand from final matchups — there is no
 * standings table.
 */
import { and, eq } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "./db/index.ts";
import { matchups, teams } from "./db/schema.ts";
import type { EngineResult } from "./errors.ts";
import { fail, ok } from "./errors.ts";
import { getSettings, updateSettings } from "./settings.ts";
import { recordTransaction } from "./transactions.ts";

export interface StandingsRow {
  teamId: number;
  wins: number;
  losses: number;
  ties: number;
  /** (wins + 0.5 × ties) / games; 0 when no games are final. */
  winPct: number;
  pointsFor: number;
  pointsAgainst: number;
  rank: number;
}

interface Record_ {
  teamId: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  games: number;
  tiebreakRand: number;
  /** opponent → { wins, ties, games } for head-to-head tiebreaks */
  vs: Map<number, { wins: number; ties: number; games: number }>;
}

function winPctOf(r: { wins: number; ties: number; games: number }): number {
  return r.games === 0 ? 0 : (r.wins + 0.5 * r.ties) / r.games;
}

/**
 * Standings from final regular-season matchups.
 * Order (§3.7): win percentage, then head-to-head among the tied teams, then
 * points for, then the stored coin flip (`teams.tiebreak_rand`, higher first).
 */
export async function computeStandings(db: EngineDb): Promise<StandingsRow[]> {
  const settings = await getSettings(db);
  const allTeams = await db.select().from(teams);
  const finals = await db
    .select()
    .from(matchups)
    .where(and(eq(matchups.final, true), eq(matchups.isPlayoff, false)));

  const rec = new Map<number, Record_>();
  for (const t of allTeams) {
    rec.set(t.id, {
      teamId: t.id,
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      games: 0,
      tiebreakRand: t.tiebreakRand,
      vs: new Map(),
    });
  }

  for (const m of finals) {
    if (m.week > settings.regularSeasonEndWeek) continue;
    const home = rec.get(m.homeTeamId);
    const away = rec.get(m.awayTeamId);
    if (!home || !away) continue;
    const hp = m.homePoints ?? 0;
    const ap = m.awayPoints ?? 0;
    home.pointsFor += hp;
    home.pointsAgainst += ap;
    away.pointsFor += ap;
    away.pointsAgainst += hp;
    home.games++;
    away.games++;
    const hvs = home.vs.get(away.teamId) ?? { wins: 0, ties: 0, games: 0 };
    const avs = away.vs.get(home.teamId) ?? { wins: 0, ties: 0, games: 0 };
    hvs.games++;
    avs.games++;
    if (hp > ap) {
      home.wins++;
      away.losses++;
      hvs.wins++;
    } else if (ap > hp) {
      away.wins++;
      home.losses++;
      avs.wins++;
    } else {
      home.ties++;
      away.ties++;
      hvs.ties++;
      avs.ties++;
    }
    home.vs.set(away.teamId, hvs);
    away.vs.set(home.teamId, avs);
  }

  const rows = [...rec.values()];

  /**
   * Sort in two stages so the ordering is always well defined. Comparing
   * head-to-head inside a single comparator is non-transitive when a tied
   * group is not fully connected (A beat B, neither played C), and the result
   * would then depend on the sort implementation. Instead: group by win
   * percentage first, then order each group on its own.
   */
  const groups = new Map<string, Record_[]>();
  for (const r of rows) {
    const key = winPctOf(r).toFixed(9);
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  const sorted: Record_[] = [];
  for (const key of [...groups.keys()].sort((a, b) => Number(b) - Number(a))) {
    const group = groups.get(key)!;
    if (group.length === 1) {
      sorted.push(group[0]!);
      continue;
    }
    // Head-to-head record within this group; null when a team played none of
    // the others, which makes the tiebreak inapplicable for the whole group.
    const h2h = (r: Record_): number | null => {
      let wins = 0;
      let ties = 0;
      let games = 0;
      for (const other of group) {
        if (other.teamId === r.teamId) continue;
        const v = r.vs.get(other.teamId);
        if (!v) continue;
        wins += v.wins;
        ties += v.ties;
        games += v.games;
      }
      return games === 0 ? null : (wins + 0.5 * ties) / games;
    };
    const scores = new Map(group.map((r) => [r.teamId, h2h(r)]));
    const everyoneConnected = group.every((r) => scores.get(r.teamId) !== null);
    group.sort((a, b) => {
      if (everyoneConnected) {
        const ha = scores.get(a.teamId)!;
        const hb = scores.get(b.teamId)!;
        if (Math.abs(ha - hb) > 1e-9) return hb - ha;
      }
      if (Math.abs(b.pointsFor - a.pointsFor) > 1e-9) return b.pointsFor - a.pointsFor;
      return b.tiebreakRand - a.tiebreakRand;
    });
    sorted.push(...group);
  }

  return sorted.map((r, i) => ({
    teamId: r.teamId,
    wins: r.wins,
    losses: r.losses,
    ties: r.ties,
    winPct: winPctOf(r),
    pointsFor: Math.round(r.pointsFor * 100) / 100,
    pointsAgainst: Math.round(r.pointsAgainst * 100) / 100,
    rank: i + 1,
  }));
}

export type PlayoffSeeds = Record<string, number>;

export async function getPlayoffSeeds(db: EngineDb): Promise<PlayoffSeeds> {
  const settings = await getSettings(db);
  return ((settings.extra as { playoffSeeds?: PlayoffSeeds }).playoffSeeds ?? {}) as PlayoffSeeds;
}

/**
 * Seed the playoffs after the regular season finalizes (§3.7, §9.2 step 5).
 * Week 15: 3v6 and 4v5, seeds 1–2 bye. The six non-qualifiers are eliminated.
 * Idempotent.
 */
export async function seedPlayoffs(db: EngineDb, clock: Clock): Promise<EngineResult<{ seeds: PlayoffSeeds }>> {
  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    const startWeek = settings.playoffStartWeek;
    const existing = await tx
      .select()
      .from(matchups)
      .where(and(eq(matchups.week, startWeek), eq(matchups.isPlayoff, true)));
    if (existing.length > 0) return ok({ seeds: await getPlayoffSeeds(tx) });

    const standings = await computeStandings(tx);
    const qualifiers = standings.slice(0, settings.playoffTeams);
    if (qualifiers.length < settings.playoffTeams)
      return fail("invalid_args", `only ${qualifiers.length} teams available for the playoffs`);

    const seeds: PlayoffSeeds = {};
    qualifiers.forEach((row, i) => {
      seeds[String(row.teamId)] = i + 1;
    });

    const seedTeam = (n: number) => qualifiers[n - 1]!.teamId;
    // Round 1: 3v6, 4v5 (higher seed is home).
    await tx.insert(matchups).values([
      {
        week: startWeek,
        homeTeamId: seedTeam(3),
        awayTeamId: seedTeam(6),
        isPlayoff: true,
        playoffRound: 1,
        final: false,
      },
      {
        week: startWeek,
        homeTeamId: seedTeam(4),
        awayTeamId: seedTeam(5),
        isPlayoff: true,
        playoffRound: 1,
        final: false,
      },
    ]);

    const qualifierIds = new Set(qualifiers.map((q) => q.teamId));
    for (const row of standings) {
      if (!qualifierIds.has(row.teamId)) {
        await tx.update(teams).set({ eliminated: true }).where(eq(teams.id, row.teamId));
      }
    }
    await updateSettings(tx, { extra: { ...(settings.extra as object), playoffSeeds: seeds } });
    await recordTransaction(tx, {
      type: "commissioner",
      week: startWeek,
      teamIds: qualifiers.map((q) => q.teamId),
      payload: {
        action: "playoffs_seeded",
        seeds,
        eliminated: standings.slice(settings.playoffTeams).map((r) => r.teamId),
        at: clock.now().toISOString(),
      },
    });
    return ok({ seeds });
  });
}

/**
 * Create the next playoff round from the finalized previous one (§3.7).
 * After week 15: seed 1 plays the lowest remaining seed, seed 2 the other.
 * After week 16: the final. Losers are eliminated. Idempotent.
 */
export async function advancePlayoffs(
  db: EngineDb,
  clock: Clock,
  completedWeek: number,
): Promise<EngineResult<{ created: number }>> {
  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    const seeds = await getPlayoffSeeds(tx);
    const nextWeek = completedWeek + 1;
    if (nextWeek > settings.playoffStartWeek + 2) return ok({ created: 0 });

    const existing = await tx
      .select()
      .from(matchups)
      .where(and(eq(matchups.week, nextWeek), eq(matchups.isPlayoff, true)));
    if (existing.length > 0) return ok({ created: 0 });

    const prev = await tx
      .select()
      .from(matchups)
      .where(and(eq(matchups.week, completedWeek), eq(matchups.isPlayoff, true)));
    if (prev.length === 0 || prev.some((m) => !m.final))
      return fail("bad_status", `week ${completedWeek} playoff matchups are not final`);

    const winners: number[] = [];
    for (const m of prev) {
      const w = m.winnerTeamId;
      if (w === null) return fail("bad_status", `matchup ${m.id} has no winner`);
      winners.push(w);
      const loser = w === m.homeTeamId ? m.awayTeamId : m.homeTeamId;
      await tx.update(teams).set({ eliminated: true }).where(eq(teams.id, loser));
    }

    const seedOf = (teamId: number) => seeds[String(teamId)] ?? 99;
    let pairs: Array<[number, number]>;
    const round = completedWeek - settings.playoffStartWeek + 2;

    if (completedWeek === settings.playoffStartWeek) {
      // Byes (seeds 1 and 2) join: 1 v lowest remaining seed, 2 v the other.
      const byes = Object.entries(seeds)
        .filter(([, s]) => s <= 2)
        .map(([id]) => Number(id))
        .sort((a, b) => seedOf(a) - seedOf(b));
      if (byes.length < 2) return fail("invalid_args", "playoff byes missing");
      const remaining = [...winners].sort((a, b) => seedOf(b) - seedOf(a)); // lowest seed first
      pairs = [
        [byes[0]!, remaining[0]!],
        [byes[1]!, remaining[1]!],
      ];
    } else {
      pairs = [[winners[0]!, winners[1]!]];
    }

    let created = 0;
    for (const [a, b] of pairs) {
      // Higher seed (lower number) is home.
      const [home, away] = seedOf(a) <= seedOf(b) ? [a, b] : [b, a];
      await tx.insert(matchups).values({
        week: nextWeek,
        homeTeamId: home,
        awayTeamId: away,
        isPlayoff: true,
        playoffRound: round,
        final: false,
      });
      created++;
    }
    await recordTransaction(tx, {
      type: "commissioner",
      week: nextWeek,
      teamIds: pairs.flat(),
      payload: {
        action: "playoff_round_created",
        round,
        matchups: pairs.map(([a, b]) => ({ a, b })),
        eliminated: prev.map((m) => (m.winnerTeamId === m.homeTeamId ? m.awayTeamId : m.homeTeamId)),
        at: clock.now().toISOString(),
      },
    });
    return ok({ created });
  });
}
