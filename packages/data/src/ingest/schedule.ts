/** nflverse schedule ingest (SPEC §5.5) into nfl_games. */
import { eq } from "drizzle-orm";
import type { EngineDb } from "@league/engine";
import { nflGames } from "@league/engine";
import type { NflverseGame } from "../nflverse.ts";

/** Upsert regular-season games. Never demotes a live/final status back to scheduled. */
export async function upsertGames(db: EngineDb, games: NflverseGame[]): Promise<number> {
  let n = 0;
  await db.transaction(async (tx) => {
    for (const g of games) {
      if (g.gameType !== "REG") continue;
      const existing = (await tx.select().from(nflGames).where(eq(nflGames.gameId, g.gameId)))[0];
      if (!existing) {
        await tx.insert(nflGames).values({
          gameId: g.gameId,
          season: g.season,
          week: g.week,
          kickoffAt: g.kickoffAt,
          home: g.home,
          away: g.away,
          homeScore: g.homeScore,
          awayScore: g.awayScore,
          status: g.final ? "final" : "scheduled",
        });
      } else {
        const status = g.final ? "final" : existing.status === "live" ? "live" : existing.status;
        await tx
          .update(nflGames)
          .set({
            kickoffAt: g.kickoffAt,
            homeScore: g.homeScore,
            awayScore: g.awayScore,
            status,
            updatedAt: new Date(),
          })
          .where(eq(nflGames.gameId, g.gameId));
      }
      n++;
    }
  });
  return n;
}
