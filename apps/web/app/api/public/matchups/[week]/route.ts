/**
 * Public read-only JSON: one week's matchups with both lineups (SPEC §12.1).
 * Rate limited to 60 requests per minute per IP.
 */
import { eq } from "drizzle-orm";
import { leagueSettings, matchups, teams } from "@league/engine";
import { db } from "../../../../../lib/db";
import { teamLineup } from "../../../../../lib/queries";
import { publicJson, rateLimitResponse } from "../../../../../lib/rateLimit";

interface TeamBrief {
  teamId: number;
  slug: string | null;
  name: string | null;
  model: string | null;
}

export async function GET(request: Request, ctx: { params: Promise<{ week: string }> }): Promise<Response> {
  const limited = rateLimitResponse(request);
  if (limited) return limited;

  const { week: weekParam } = await ctx.params;
  const week = Number(weekParam);
  if (!Number.isInteger(week) || week < 1 || week > 18) {
    return publicJson({ error: "bad_week", detail: "week must be an integer from 1 to 18" }, 400);
  }

  const settings = (await db().select().from(leagueSettings).where(eq(leagueSettings.id, 1)))[0];
  const season = settings?.season ?? null;
  const rows = await db().select().from(matchups).where(eq(matchups.week, week));
  const teamRows = await db().select().from(teams);
  const byId = new Map(teamRows.map((t) => [t.id, t]));

  const brief = (teamId: number): TeamBrief => {
    const t = byId.get(teamId);
    return { teamId, slug: t?.slug ?? null, name: t?.name ?? null, model: t?.modelLabel ?? null };
  };
  const lineupOf = async (teamId: number) =>
    season === null
      ? []
      : (await teamLineup(teamId, week, season)).map((p) => ({
          slot: p.slot,
          playerId: p.playerId,
          name: p.name,
          position: p.position,
          nflTeam: p.nflTeam,
          points: p.points,
        }));

  const games = await Promise.all(
    rows.map(async (m) => ({
      id: m.id,
      week: m.week,
      final: m.final,
      isPlayoff: m.isPlayoff,
      playoffRound: m.playoffRound,
      winnerTeamId: m.winnerTeamId,
      home: { ...brief(m.homeTeamId), points: m.homePoints, lineup: await lineupOf(m.homeTeamId) },
      away: { ...brief(m.awayTeamId), points: m.awayPoints, lineup: await lineupOf(m.awayTeamId) },
    })),
  );

  return publicJson({ season, week, currentWeek: settings?.currentWeek ?? null, matchups: games });
}
