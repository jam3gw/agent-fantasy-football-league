/**
 * Public read-only JSON: one team (SPEC §12.1) — header, record, roster,
 * current-week lineup and the public scratchpad.
 * Rate limited to 60 requests per minute per IP.
 */
import { eq } from "drizzle-orm";
import { computeStandings, leagueSettings, players, rosterEntries, scratchpads } from "@league/engine";
import { db } from "../../../../../lib/db";
import { teamBySlug, teamLineup } from "../../../../../lib/queries";
import { publicJson, rateLimitResponse } from "../../../../../lib/rateLimit";

export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const limited = rateLimitResponse(request);
  if (limited) return limited;

  const { slug } = await ctx.params;
  const team = await teamBySlug(slug);
  if (!team) return publicJson({ error: "not_found", detail: `no team with slug ${slug}` }, 404);

  const settings = (await db().select().from(leagueSettings).where(eq(leagueSettings.id, 1)))[0];
  const season = settings?.season ?? null;
  const week = settings?.currentWeek ?? null;

  const standings = settings ? await computeStandings(db()) : [];
  const record = standings.find((r) => r.teamId === team.id);

  const roster = await db()
    .select({
      playerId: rosterEntries.playerId,
      name: players.fullName,
      position: players.position,
      nflTeam: players.nflTeam,
      injuryStatus: players.injuryStatus,
      status: players.status,
      acquiredVia: rosterEntries.acquiredVia,
      acquiredAt: rosterEntries.acquiredAt,
    })
    .from(rosterEntries)
    .innerJoin(players, eq(players.playerId, rosterEntries.playerId))
    .where(eq(rosterEntries.teamId, team.id));

  const lineup = season !== null && week !== null ? await teamLineup(team.id, week, season) : [];
  const pad = (await db().select().from(scratchpads).where(eq(scratchpads.teamId, team.id)))[0];

  return publicJson({
    season,
    week,
    team: {
      teamId: team.id,
      slug: team.slug,
      name: team.name,
      motto: team.motto,
      model: team.modelLabel,
      modelId: team.modelId,
      provider: team.provider,
      draftSlot: team.draftSlot,
      waiverPriority: team.waiverPriority,
      paused: team.paused,
      eliminated: team.eliminated,
    },
    record: record
      ? {
          rank: record.rank,
          wins: record.wins,
          losses: record.losses,
          ties: record.ties,
          winPct: record.winPct,
          pointsFor: record.pointsFor,
          pointsAgainst: record.pointsAgainst,
        }
      : null,
    roster: roster.map((r) => ({
      playerId: r.playerId,
      name: r.name,
      position: r.position,
      nflTeam: r.nflTeam,
      injuryStatus: r.injuryStatus ?? r.status ?? null,
      acquiredVia: r.acquiredVia,
      acquiredAt: r.acquiredAt.toISOString(),
    })),
    lineup: lineup.map((p) => ({
      slot: p.slot,
      playerId: p.playerId,
      name: p.name,
      position: p.position,
      nflTeam: p.nflTeam,
      points: p.points,
    })),
    scratchpad: pad ? { content: pad.content, updatedAt: pad.updatedAt.toISOString() } : null,
  });
}
