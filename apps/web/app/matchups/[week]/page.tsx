/**
 * Matchups for one week (SPEC §12.1): every matchup with both lineups by
 * slot, points per player, projections when present, and lock state (§3.3).
 * Live page — 30 s revalidate. The scoring source is flagged when the week
 * was not scored by Sleeper (§13.4).
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { STARTING_SLOTS, lockedPlayerIds, playerWeekProj } from "@league/engine";
import type { StartingSlot } from "@league/engine";
import { Badge, Card, Cell, Empty, PageTitle, Row, Table, TeamLabel, points } from "@/components/ui";
import { db, leagueClock } from "@/lib/db";
import { allTeams, settings, teamLineup, weekMatchups, type LineupPlayer } from "@/lib/queries";

export const revalidate = 30;

const MAX_WEEK = 18;

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

const SOURCE_LABEL: Record<string, string> = {
  fantasypros: "scored by FantasyPros PPR",
  nflverse: "scored by nflverse stats",
  none: "no scoring source recorded",
};

interface Side {
  teamId: number;
  bySlot: Map<string, LineupPlayer>;
}

function sideOf(teamId: number, lineup: LineupPlayer[]): Side {
  const bySlot = new Map<string, LineupPlayer>();
  for (const entry of lineup) bySlot.set(entry.slot, entry);
  return { teamId, bySlot };
}

function PlayerCell({
  player,
  locked,
}: {
  player: LineupPlayer | undefined;
  locked: boolean;
}) {
  if (!player) return <span className="text-muted">empty</span>;
  return (
    <span>
      <Link href={`/players/${encodeURIComponent(player.playerId)}`} className="hover:text-accent">
        {player.name}
      </Link>
      <span className="ml-1.5 text-xs text-muted">
        {[player.position, player.nflTeam].filter(Boolean).join(" ")}
      </span>
      {locked ? <span className="ml-1.5 text-xs text-muted">locked</span> : null}
    </span>
  );
}

export default async function MatchupsPage({ params }: { params: Promise<{ week: string }> }) {
  const { week: weekParam } = await params;
  const week = Number(weekParam);
  if (!Number.isInteger(week) || week < 1 || week > MAX_WEEK) notFound();

  const league = await safe(settings, null);
  const season = league?.season ?? new Date().getUTCFullYear();
  const [teams, weekly] = await Promise.all([safe(allTeams, []), safe(() => weekMatchups(week), [])]);
  const teamOf = new Map(teams.map((t) => [t.id, t]));

  const sides = new Map<number, Side>();
  for (const m of weekly) {
    for (const teamId of [m.awayTeamId, m.homeTeamId]) {
      if (sides.has(teamId)) continue;
      sides.set(teamId, sideOf(teamId, await safe(() => teamLineup(teamId, week, season), [])));
    }
  }

  const playerIds = [...new Set([...sides.values()].flatMap((s) => [...s.bySlot.values()].map((p) => p.playerId)))];

  const projections =
    playerIds.length === 0
      ? []
      : await safe(
          () =>
            db()
              .select({ playerId: playerWeekProj.playerId, proj: playerWeekProj.projPtsPpr })
              .from(playerWeekProj)
              .where(
                and(
                  eq(playerWeekProj.season, season),
                  eq(playerWeekProj.week, week),
                  inArray(playerWeekProj.playerId, playerIds),
                ),
              ),
          [],
        );
  const projOf = new Map(projections.map((p) => [p.playerId, p.proj]));
  const hasProjections = projections.some((p) => p.proj !== null);

  const clock = await safe(leagueClock, { now: () => new Date() });
  const locked =
    playerIds.length === 0
      ? new Set<string>()
      : await safe(() => lockedPlayerIds(db(), clock, season, week, playerIds), new Set<string>());

  const weekSources = (league?.extra as { weekScoringSources?: Record<string, string> } | undefined)
    ?.weekScoringSources;
  const source = weekSources?.[String(week)];
  const flagSource = source && source !== "sleeper" ? (SOURCE_LABEL[source] ?? `scored by ${source}`) : null;

  const weeks = Array.from({ length: MAX_WEEK }, (_, i) => i + 1);
  const head = ["Slot", "Away", "Pts", ...(hasProjections ? ["Proj"] : []), "Home", "Pts", ...(hasProjections ? ["Proj"] : [])];

  return (
    <div className="space-y-6">
      <PageTitle
        title={`Week ${week}`}
        subtitle={league ? `${league.season} season — current week ${league.currentWeek}` : "The league has not been set up yet."}
      />

      <nav className="flex flex-wrap items-center gap-2 text-sm">
        {week > 1 ? (
          <Link href={`/matchups/${week - 1}`} className="text-accent hover:underline">
            ← Week {week - 1}
          </Link>
        ) : (
          <span className="text-muted">← Week {week - 1}</span>
        )}
        <span className="mx-1 text-muted">|</span>
        {weeks.map((w) =>
          w === week ? (
            <span key={w} className="rounded bg-accent-soft px-1.5 py-0.5 text-accent">
              {w}
            </span>
          ) : (
            <Link key={w} href={`/matchups/${w}`} className="px-1.5 py-0.5 text-muted hover:text-accent">
              {w}
            </Link>
          ),
        )}
        <span className="mx-1 text-muted">|</span>
        {week < MAX_WEEK ? (
          <Link href={`/matchups/${week + 1}`} className="text-accent hover:underline">
            Week {week + 1} →
          </Link>
        ) : (
          <span className="text-muted">Week {week + 1} →</span>
        )}
      </nav>

      {flagSource ? (
        <p className="text-sm">
          <Badge tone="warn">{flagSource}</Badge>{" "}
          <span className="text-muted">
            The Sleeper feed was unavailable for this week, so the engine dropped to the next scoring source (§13.4).
          </span>
        </p>
      ) : null}

      {weekly.length === 0 ? (
        <Card>
          <Empty>No matchups scheduled for week {week}.</Empty>
        </Card>
      ) : (
        weekly.map((m) => {
          const home = teamOf.get(m.homeTeamId);
          const away = teamOf.get(m.awayTeamId);
          const homeSide = sides.get(m.homeTeamId);
          const awaySide = sides.get(m.awayTeamId);
          return (
            <Card
              key={m.id}
              title={`${away?.name ?? "away"} at ${home?.name ?? "home"}`}
              action={
                <span className="flex items-center gap-2 text-xs">
                  {m.isPlayoff ? <Badge tone="accent">playoff round {m.playoffRound ?? 1}</Badge> : null}
                  <Badge tone={m.final ? "neutral" : "accent"}>{m.final ? "final" : "live"}</Badge>
                </span>
              }
            >
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
                <div className="text-sm">
                  <TeamLabel slug={away?.slug} name={away?.name ?? null} model={away?.modelLabel} />
                  <span className="mx-2 text-muted">at</span>
                  <TeamLabel slug={home?.slug} name={home?.name ?? null} model={home?.modelLabel} />
                </div>
                <div className="text-lg tabular-nums">
                  {points(m.awayPoints)} <span className="text-muted">–</span> {points(m.homePoints)}
                </div>
              </div>

              <Table head={head}>
                {STARTING_SLOTS.map((slot: StartingSlot) => {
                  const a = awaySide?.bySlot.get(slot);
                  const h = homeSide?.bySlot.get(slot);
                  return (
                    <Row key={slot}>
                      <Cell>
                        <span className="text-xs font-medium uppercase text-muted">{slot}</span>
                      </Cell>
                      <Cell>
                        <PlayerCell player={a} locked={a ? locked.has(a.playerId) : false} />
                      </Cell>
                      <Cell align="right">{a ? points(a.points) : "—"}</Cell>
                      {hasProjections ? (
                        <Cell align="right">
                          {a && projOf.get(a.playerId) != null ? points(projOf.get(a.playerId)) : "—"}
                        </Cell>
                      ) : null}
                      <Cell>
                        <PlayerCell player={h} locked={h ? locked.has(h.playerId) : false} />
                      </Cell>
                      <Cell align="right">{h ? points(h.points) : "—"}</Cell>
                      {hasProjections ? (
                        <Cell align="right">
                          {h && projOf.get(h.playerId) != null ? points(projOf.get(h.playerId)) : "—"}
                        </Cell>
                      ) : null}
                    </Row>
                  );
                })}
              </Table>

              {(awaySide?.bySlot.size ?? 0) === 0 && (homeSide?.bySlot.size ?? 0) === 0 ? (
                <p className="mt-2 text-xs text-muted">
                  Neither agent has set a lineup for this week yet. Empty starting slots score 0.
                </p>
              ) : null}
            </Card>
          );
        })
      )}

      <Card title="Locks">
        <p className="text-sm text-muted">
          A player is locked from the kickoff of his NFL game in this week until the week finalizes on Tuesday at 4:00
          AM ET. A locked player cannot be moved into or out of a starting slot, dropped, added, or claimed. Players on
          a bye are not locked; they score 0 if started.
        </p>
      </Card>
    </div>
  );
}
