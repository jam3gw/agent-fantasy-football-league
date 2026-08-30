/** Test fixtures: league settings, 12 teams, players, games, rosters. */
import type { EngineDb } from "../../src/db/index.ts";
import type { LineupSlot } from "../../src/db/schema.ts";
import { lineupEntries, nflGames, players, rosterEntries, teams } from "../../src/db/schema.ts";
import type { LeagueSettings } from "../../src/settings.ts";
import { initLeagueSettings } from "../../src/settings.ts";

export const SEASON = 2026;

export const MODEL_IDS = [
  "anthropic/claude-fable-5",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-5",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "google/gemini-3.1-pro-preview",
  "spacexai/grok-4.6",
  "deepseek/deepseek-v4-pro",
  "moonshotai/kimi-k3",
  "alibaba/qwen3.8-max",
  "meta/muse-spark-1.2",
  "zai/glm-5.3",
];

export async function seedLeague(
  db: EngineDb,
  overrides: Partial<Parameters<typeof initLeagueSettings>[1]> = {},
): Promise<LeagueSettings> {
  return initLeagueSettings(db, { season: SEASON, phase: "regular", currentWeek: 1, ...overrides });
}

/** 12 teams; waiver priority = team index + 1; deterministic tiebreaks. */
export async function seedTeams(db: EngineDb): Promise<number[]> {
  const rows = await db
    .insert(teams)
    .values(
      MODEL_IDS.map((modelId, i) => ({
        slug: `team-${i + 1}`,
        name: `Team ${i + 1}`,
        modelId,
        modelLabel: modelId.split("/")[1]!,
        provider: modelId.split("/")[0]!,
        draftSlot: i + 1,
        waiverPriority: i + 1,
        tiebreakRand: (i + 1) / 100,
      })),
    )
    .returning({ id: teams.id });
  return rows.map((r) => r.id);
}

let playerSeq = 0;

export interface PlayerSpec {
  playerId?: string;
  fullName?: string;
  position?: string;
  fantasyPositions?: string[];
  nflTeam?: string | null;
  status?: string | null;
  injuryStatus?: string | null;
  waiverUntil?: Date | null;
  active?: boolean;
}

export async function makePlayer(db: EngineDb, spec: PlayerSpec = {}): Promise<string> {
  playerSeq++;
  const position = spec.position ?? "RB";
  const playerId = spec.playerId ?? `p${playerSeq}`;
  await db.insert(players).values({
    playerId,
    fullName: spec.fullName ?? `Player ${playerSeq}`,
    position,
    fantasyPositions: spec.fantasyPositions ?? (position === "DEF" ? ["DEF"] : [position]),
    nflTeam: spec.nflTeam === undefined ? "KC" : spec.nflTeam,
    status: spec.status ?? "Active",
    injuryStatus: spec.injuryStatus ?? null,
    waiverUntil: spec.waiverUntil ?? null,
    active: spec.active ?? true,
  });
  return playerId;
}

export async function makePlayers(db: EngineDb, specs: PlayerSpec[]): Promise<string[]> {
  const ids: string[] = [];
  for (const s of specs) ids.push(await makePlayer(db, s));
  return ids;
}

export async function makeGame(
  db: EngineDb,
  spec: { season?: number; week: number; kickoffAt: Date; home: string; away: string; status?: "scheduled" | "live" | "final" },
): Promise<string> {
  const gameId = `${spec.season ?? SEASON}_${spec.week}_${spec.away}_${spec.home}`;
  await db.insert(nflGames).values({
    gameId,
    season: spec.season ?? SEASON,
    week: spec.week,
    kickoffAt: spec.kickoffAt,
    home: spec.home,
    away: spec.away,
    status: spec.status ?? "scheduled",
  });
  return gameId;
}

export async function rosterPlayer(
  db: EngineDb,
  teamId: number,
  playerId: string,
  via: "draft" | "waiver" | "free_agent" | "trade" | "commissioner" = "draft",
  acquiredAt: Date = new Date("2026-09-01T00:00:00Z"),
): Promise<void> {
  await db.insert(rosterEntries).values({ teamId, playerId, acquiredVia: via, acquiredAt });
}

export async function setLineupEntry(
  db: EngineDb,
  teamId: number,
  week: number,
  playerId: string,
  slot: LineupSlot,
): Promise<void> {
  await db.insert(lineupEntries).values({ teamId, week, playerId, slot });
}

/**
 * A full legal 14-man roster for a team: QB, 2 RB, 2 WR, TE, FLEX-RB, DST, K
 * + 5 bench. Returns ids by role. Does not set any lineup.
 */
export async function seedFullRoster(
  db: EngineDb,
  teamId: number,
  opts: { nflTeam?: string; prefix?: string } = {},
): Promise<{
  qb: string;
  rb1: string;
  rb2: string;
  wr1: string;
  wr2: string;
  te: string;
  flexRb: string;
  dst: string;
  k: string;
  bench: string[];
  all: string[];
}> {
  const team = opts.nflTeam ?? "KC";
  const p = opts.prefix ?? `t${teamId}`;
  const mk = async (suffix: string, position: string) =>
    makePlayer(db, { playerId: `${p}-${suffix}`, position, nflTeam: team, fullName: `${p} ${suffix}` });
  const qb = await mk("qb", "QB");
  const rb1 = await mk("rb1", "RB");
  const rb2 = await mk("rb2", "RB");
  const wr1 = await mk("wr1", "WR");
  const wr2 = await mk("wr2", "WR");
  const te = await mk("te", "TE");
  const flexRb = await mk("flex", "RB");
  const dst = await makePlayer(db, { playerId: `${p}-dst`, position: "DEF", nflTeam: team, fullName: `${p} DST` });
  const k = await mk("k", "K");
  const bench: string[] = [];
  for (let i = 1; i <= 5; i++) bench.push(await mk(`bn${i}`, i % 2 === 0 ? "WR" : "RB"));
  const all = [qb, rb1, rb2, wr1, wr2, te, flexRb, dst, k, ...bench];
  for (const pid of all) await rosterPlayer(db, teamId, pid);
  return { qb, rb1, rb2, wr1, wr2, te, flexRb, dst, k, bench, all };
}
