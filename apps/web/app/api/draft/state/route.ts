/**
 * Live draft state for the draft room (SPEC §10.2: the page polls this every
 * 3 seconds). Never cached — `force-dynamic` plus `Cache-Control: no-store`
 * (§12.1: "Use no-store for the draft state API").
 *
 * This is the site's own polling endpoint, not one of the five public API
 * paths, so it is deliberately not rate limited: a draft room open in a few
 * tabs would otherwise trip the 60/minute courtesy limit mid-draft.
 */
import { count, desc, eq, inArray } from "drizzle-orm";
import { draft as draftTable, draftPicks, leagueSettings, players, teams } from "@league/engine";
import { db, leagueClock } from "../../../../lib/db";
import { snakeSlot } from "../../../../lib/draft";

export const dynamic = "force-dynamic";

const RECENT_PICKS = 15;

export async function GET(): Promise<Response> {
  const clock = await leagueClock();
  const now = clock.now();

  const state = (await db().select().from(draftTable).where(eq(draftTable.id, 1)))[0];
  const settings = (await db().select().from(leagueSettings).where(eq(leagueSettings.id, 1)))[0];
  const teamRows = await db().select().from(teams);
  const byId = new Map(teamRows.map((t) => [t.id, t]));

  const recent = await db().select().from(draftPicks).orderBy(desc(draftPicks.pickNo)).limit(RECENT_PICKS);
  const playerIds = recent.map((p) => p.playerId);
  const playerRows = playerIds.length
    ? await db()
        .select({
          playerId: players.playerId,
          fullName: players.fullName,
          position: players.position,
          nflTeam: players.nflTeam,
        })
        .from(players)
        .where(inArray(players.playerId, playerIds))
    : [];
  const playerById = new Map(playerRows.map((p) => [p.playerId, p]));

  const madeCount = (await db().select({ n: count() }).from(draftPicks))[0]?.n ?? 0;

  const order = state?.order ?? [];
  const rounds = settings?.draftRounds ?? 14;
  const totalPicks = order.length * rounds;
  const currentPick = state?.currentPick ?? null;
  const here = currentPick !== null && order.length > 0 ? snakeSlot(currentPick, order.length) : null;
  const onTheClockId = here ? (order[here.orderIndex] ?? null) : null;
  const onTheClockTeam = onTheClockId !== null ? byId.get(onTheClockId) : undefined;

  const clockEndsAt = state?.clockEndsAt ?? null;
  const secondsRemaining =
    state?.status === "running" && clockEndsAt
      ? Math.max(0, Math.round((clockEndsAt.getTime() - now.getTime()) / 1000))
      : state?.status === "paused"
        ? (state.clockRemainingSeconds ?? null)
        : null;

  const body = {
    now: now.toISOString(),
    status: state?.status ?? "not_started",
    currentPick,
    round: here?.round ?? null,
    slotInRound: here?.slotInRound ?? null,
    picksMade: madeCount,
    totalPicks,
    rounds,
    clockEndsAt: clockEndsAt ? clockEndsAt.toISOString() : null,
    secondsRemaining,
    startedAt: state?.startedAt ? state.startedAt.toISOString() : null,
    endedAt: state?.endedAt ? state.endedAt.toISOString() : null,
    order: order.map((teamId, index) => ({
      slot: index + 1,
      teamId,
      slug: byId.get(teamId)?.slug ?? null,
      name: byId.get(teamId)?.name ?? null,
      model: byId.get(teamId)?.modelLabel ?? null,
    })),
    onTheClock: onTheClockTeam
      ? {
          teamId: onTheClockTeam.id,
          slug: onTheClockTeam.slug,
          name: onTheClockTeam.name,
          model: onTheClockTeam.modelLabel,
        }
      : null,
    recentPicks: recent.map((p) => {
      const player = playerById.get(p.playerId);
      const team = byId.get(p.teamId);
      return {
        pickNo: p.pickNo,
        round: p.round,
        slotInRound: p.slotInRound,
        teamId: p.teamId,
        slug: team?.slug ?? null,
        teamName: team?.name ?? null,
        model: team?.modelLabel ?? null,
        playerId: p.playerId,
        playerName: player?.fullName ?? p.playerId,
        position: player?.position ?? null,
        nflTeam: player?.nflTeam ?? null,
        madeBy: p.madeBy,
        reason: p.reason,
        pickedAt: p.pickedAt.toISOString(),
      };
    }),
  };

  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
