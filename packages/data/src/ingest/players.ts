/** Sleeper players ingest (SPEC §5.1): upsert + injury-change events for rostered starters. */
import { eq, inArray } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "@league/engine";
import {
  STARTING_SLOTS,
  getSettings,
  handleEvent,
  lineupEntries,
  players,
} from "@league/engine";
import type { SleeperPlayerRaw } from "../sleeper.ts";

/** Statuses whose arrival triggers injury.changed for a starter (§5.1). */
export const INJURY_EVENT_STATUSES = ["Doubtful", "Out", "IR", "PUP", "NFI", "Sus"];

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
    return { count, injuryChanges };
  });
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
