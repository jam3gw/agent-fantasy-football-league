/**
 * Player card (SPEC §12.1): stats by week, current ownership (rostered, on
 * waivers, or a free agent), and the transactions that mention this player.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  nflGames,
  playerWeekProj,
  playerWeekStats,
  players,
  rosterEntries,
  transactions,
} from "@league/engine";
import { formatEt } from "@league/shared";
import { Badge, Card, Cell, Empty, PageTitle, Row, Table, TeamLabel, points } from "@/components/ui";
import { db } from "@/lib/db";
import { allTeams, settings } from "@/lib/queries";

export const revalidate = 300;

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** Does this transaction payload name the player anywhere? */
function mentionsPlayer(value: unknown, playerId: string): boolean {
  if (typeof value === "string") return value === playerId;
  if (Array.isArray(value)) return value.some((v) => mentionsPlayer(v, playerId));
  if (value && typeof value === "object") return Object.values(value).some((v) => mentionsPlayer(v, playerId));
  return false;
}

export default async function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const playerId = decodeURIComponent(id);

  const found = await safe(() => db().select().from(players).where(eq(players.playerId, playerId)), []);
  const player = found[0];
  if (!player) notFound();

  const league = await safe(settings, null);
  const season = league?.season ?? new Date().getUTCFullYear();

  const [teams, ownership, stats, projections, games, recentTx] = await Promise.all([
    safe(allTeams, []),
    safe(() => db().select().from(rosterEntries).where(eq(rosterEntries.playerId, playerId)), []),
    safe(
      () =>
        db()
          .select()
          .from(playerWeekStats)
          .where(and(eq(playerWeekStats.playerId, playerId), eq(playerWeekStats.season, season)))
          .orderBy(asc(playerWeekStats.week)),
      [],
    ),
    safe(
      () =>
        db()
          .select()
          .from(playerWeekProj)
          .where(and(eq(playerWeekProj.playerId, playerId), eq(playerWeekProj.season, season))),
      [],
    ),
    player.nflTeam
      ? safe(() => db().select().from(nflGames).where(eq(nflGames.season, season)), [])
      : Promise.resolve([]),
    safe(() => db().select().from(transactions).orderBy(desc(transactions.createdAt)).limit(1000), []),
  ]);

  const teamOf = new Map(teams.map((t) => [t.id, t]));
  const owner = ownership[0] ? teamOf.get(ownership[0].teamId) : undefined;
  const projOf = new Map(projections.map((p) => [p.week, p.projPtsPpr]));
  const opponentOf = new Map<number, string>();
  for (const g of games) {
    if (g.home === player.nflTeam) opponentOf.set(g.week, `vs ${g.away}`);
    else if (g.away === player.nflTeam) opponentOf.set(g.week, `at ${g.home}`);
  }
  const mine = recentTx.filter((t) => mentionsPlayer(t.payload, playerId));
  const total = stats.reduce((sum, s) => sum + (s.ptsPpr ?? 0), 0);

  const onWaivers = player.waiverUntil !== null;

  return (
    <div className="space-y-6">
      <PageTitle
        title={player.fullName}
        subtitle={[player.position, player.nflTeam, player.number ? `#${player.number}` : null]
          .filter(Boolean)
          .join(" · ")}
      />

      <Card title="Player">
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Ownership</dt>
            <dd className="mt-0.5">
              {owner ? (
                <TeamLabel slug={owner.slug} name={owner.name} model={owner.modelLabel} />
              ) : onWaivers ? (
                <Badge tone="warn">on waivers</Badge>
              ) : (
                <Badge tone="accent">free agent</Badge>
              )}
            </dd>
            <dd className="mt-0.5 text-xs text-muted">
              {owner && ownership[0]
                ? `acquired via ${ownership[0].acquiredVia} on ${formatEt(ownership[0].acquiredAt)}`
                : onWaivers && player.waiverUntil
                  ? `clears ${formatEt(player.waiverUntil)}`
                  : "can be added at any time by any team"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Eligible slots</dt>
            <dd className="mt-0.5">{player.fantasyPositions?.join(", ") || player.position || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Status</dt>
            <dd className="mt-0.5">{player.status ?? "—"}</dd>
            <dd className="text-xs text-muted">
              {player.injuryStatus ? `${player.injuryStatus}${player.injuryBodyPart ? ` (${player.injuryBodyPart})` : ""}` : "no injury designation"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Active</dt>
            <dd className="mt-0.5">{player.active ? "yes" : "no"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Trending adds</dt>
            <dd className="mt-0.5 tabular-nums">{player.trendingAdds ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Season points</dt>
            <dd className="mt-0.5 tabular-nums">{points(total)}</dd>
            <dd className="text-xs text-muted">{stats.length} weeks scored</dd>
          </div>
        </dl>
      </Card>

      <Card title={`Stats by week — ${season}`}>
        {stats.length === 0 ? (
          <Empty>No weekly stats stored for this player yet.</Empty>
        ) : (
          <Table head={["Week", "Opponent", "Points", "Projected", "Engine", "Source", "Final", "Raw"]}>
            {stats.map((s) => (
              <Row key={s.week}>
                <Cell>
                  <Link href={`/matchups/${s.week}`} className="hover:text-accent">
                    {s.week}
                  </Link>
                </Cell>
                <Cell>{opponentOf.get(s.week) ?? "bye"}</Cell>
                <Cell align="right">{points(s.ptsPpr)}</Cell>
                <Cell align="right">{projOf.get(s.week) != null ? points(projOf.get(s.week)) : "—"}</Cell>
                <Cell align="right">{s.enginePts != null ? points(s.enginePts) : "—"}</Cell>
                <Cell>{s.source}</Cell>
                <Cell>{s.final ? "yes" : "live"}</Cell>
                <Cell>
                  <details>
                    <summary className="cursor-pointer text-xs text-accent">stats</summary>
                    <pre className="mt-2 max-w-md whitespace-pre-wrap break-words rounded border border-border bg-background p-2 font-mono text-xs">
                      {JSON.stringify(s.stats, null, 2)}
                    </pre>
                  </details>
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Transactions and ownership history">
        {mine.length === 0 ? (
          <Empty>No transaction has involved this player.</Empty>
        ) : (
          <Table head={["When", "Type", "Week", "Teams", "Detail"]}>
            {mine.map((t) => (
              <Row key={t.id}>
                <Cell>{formatEt(t.createdAt)}</Cell>
                <Cell>
                  <Badge>{t.type.replace("_", " ")}</Badge>
                </Cell>
                <Cell>{t.week ?? "—"}</Cell>
                <Cell>
                  <span className="flex flex-wrap gap-2">
                    {t.teamIds.map((teamId) => {
                      const team = teamOf.get(teamId);
                      return <TeamLabel key={teamId} slug={team?.slug} name={team?.name ?? `team ${teamId}`} />;
                    })}
                  </span>
                </Cell>
                <Cell>
                  <details>
                    <summary className="cursor-pointer text-xs text-accent">payload</summary>
                    <pre className="mt-2 max-w-lg whitespace-pre-wrap break-words rounded border border-border bg-background p-2 font-mono text-xs">
                      {JSON.stringify(t.payload, null, 2)}
                    </pre>
                  </details>
                </Cell>
              </Row>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-muted">
          The most recent 1,000 league transactions are searched. Older moves stay on{" "}
          <Link href="/transactions" className="text-accent hover:underline">
            the transactions page
          </Link>
          .
        </p>
      </Card>
    </div>
  );
}
