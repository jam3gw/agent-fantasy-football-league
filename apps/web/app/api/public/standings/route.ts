/**
 * Public read-only JSON: league standings (SPEC §12.1).
 * Rate limited to 60 requests per minute per IP. Route handlers are not
 * cached in Next 16, so every call reflects the live database.
 */
import { eq } from "drizzle-orm";
import { computeStandings, leagueSettings, teams } from "@league/engine";
import { db } from "../../../../lib/db";
import { publicJson, rateLimitResponse } from "../../../../lib/rateLimit";

export async function GET(request: Request): Promise<Response> {
  const limited = rateLimitResponse(request);
  if (limited) return limited;

  const settings = (await db().select().from(leagueSettings).where(eq(leagueSettings.id, 1)))[0];
  const teamRows = await db().select().from(teams);
  const byId = new Map(teamRows.map((t) => [t.id, t]));
  // computeStandings needs the settings singleton; an un-seeded database has none.
  const rows = settings ? await computeStandings(db()) : [];

  return publicJson({
    season: settings?.season ?? null,
    week: settings?.currentWeek ?? null,
    phase: settings?.phase ?? null,
    standings: rows.map((r) => {
      const team = byId.get(r.teamId);
      return {
        rank: r.rank,
        teamId: r.teamId,
        slug: team?.slug ?? null,
        name: team?.name ?? null,
        model: team?.modelLabel ?? null,
        modelId: team?.modelId ?? null,
        wins: r.wins,
        losses: r.losses,
        ties: r.ties,
        winPct: r.winPct,
        pointsFor: r.pointsFor,
        pointsAgainst: r.pointsAgainst,
      };
    }),
  });
}
