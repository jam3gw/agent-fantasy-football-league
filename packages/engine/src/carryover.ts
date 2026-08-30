/**
 * Week carry-over (SPEC §7.8). `weekPlanWorkflow(W+1)` copies week W's lineup
 * entries for players still on the roster. Ghost entries are never copied, and
 * a team that already has W+1 entries is left alone.
 */
import { and, eq } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "./db/index.ts";
import { lineupEntries, rosterEntries, teams } from "./db/schema.ts";
import type { EngineResult } from "./errors.ts";
import { ok } from "./errors.ts";
import { recordTransaction } from "./transactions.ts";

export interface CarryOverSummary {
  fromWeek: number;
  toWeek: number;
  teamsCarried: number;
  teamsSkipped: number;
  entriesCreated: number;
}

export async function carryOverLineups(
  db: EngineDb,
  clock: Clock,
  fromWeek: number,
): Promise<EngineResult<CarryOverSummary>> {
  const toWeek = fromWeek + 1;
  return db.transaction(async (tx) => {
    const allTeams = await tx.select({ id: teams.id }).from(teams);
    let teamsCarried = 0;
    let teamsSkipped = 0;
    let entriesCreated = 0;

    for (const t of allTeams) {
      const existing = await tx
        .select({ id: lineupEntries.id })
        .from(lineupEntries)
        .where(and(eq(lineupEntries.teamId, t.id), eq(lineupEntries.week, toWeek)));
      if (existing.length > 0) {
        teamsSkipped++;
        continue;
      }

      const prior = await tx
        .select({ playerId: lineupEntries.playerId, slot: lineupEntries.slot })
        .from(lineupEntries)
        .where(and(eq(lineupEntries.teamId, t.id), eq(lineupEntries.week, fromWeek)));
      if (prior.length === 0) {
        teamsSkipped++;
        continue;
      }

      const roster = new Set(
        (
          await tx
            .select({ playerId: rosterEntries.playerId })
            .from(rosterEntries)
            .where(eq(rosterEntries.teamId, t.id))
        ).map((r) => r.playerId),
      );
      // Ghosts (player no longer on the roster) are skipped, never copied.
      const carried = prior.filter((p) => roster.has(p.playerId));
      if (carried.length === 0) {
        teamsSkipped++;
        continue;
      }

      await tx.insert(lineupEntries).values(
        carried.map((c) => ({
          teamId: t.id,
          week: toWeek,
          playerId: c.playerId,
          slot: c.slot,
        })),
      );
      entriesCreated += carried.length;
      teamsCarried++;

      await recordTransaction(tx, {
        type: "lineup",
        week: toWeek,
        teamIds: [t.id],
        payload: {
          week: toWeek,
          carried_over: true,
          slots: Object.fromEntries(carried.map((c) => [c.slot, c.playerId])),
        },
      });
    }

    void clock;
    return ok({ fromWeek, toWeek, teamsCarried, teamsSkipped, entriesCreated });
  });
}
