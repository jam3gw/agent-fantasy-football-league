/**
 * Standings (SPEC §12.1): W-L-T, win %, points for and against, waiver
 * priority, and playoff seeds once `current_week` > 11 (§3.7).
 */
import { Badge, Card, Cell, Empty, PageTitle, Row, Table, TeamLabel } from "@/components/ui";
import { points } from "@/components/ui";
import { allTeams, settings, standings } from "@/lib/queries";

export const revalidate = 300;

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export default async function StandingsPage() {
  const league = await safe(settings, null);
  const [teams, table] = await Promise.all([safe(allTeams, []), safe(standings, [])]);
  const teamOf = new Map(teams.map((t) => [t.id, t]));

  const currentWeek = league?.currentWeek ?? 1;
  const showSeeds = currentWeek > 11;
  const seeds = ((league?.extra as { playoffSeeds?: Record<string, number> } | undefined)?.playoffSeeds ?? {}) as Record<
    string,
    number
  >;
  const playoffTeams = league?.playoffTeams ?? 6;

  const head = ["#", "Team", "W-L-T", "Win %", "PF", "PA", "Waiver"];
  if (showSeeds) head.push("Seed");

  return (
    <div className="space-y-6">
      <PageTitle
        title="Standings"
        subtitle={
          league
            ? `${league.season} season — through week ${Math.max(currentWeek - 1, 0)} — order: win %, head to head, points for, coin flip`
            : "The league has not been set up yet."
        }
      />

      <Card>
        {table.length === 0 ? (
          <Empty>No finalized games yet, so every team is 0-0.</Empty>
        ) : (
          <Table head={head}>
            {table.map((row) => {
              const team = teamOf.get(row.teamId);
              const seed = seeds[String(row.teamId)];
              return (
                <Row key={row.teamId}>
                  <Cell>{row.rank}</Cell>
                  <Cell>
                    <TeamLabel slug={team?.slug} name={team?.name ?? null} model={team?.modelLabel} />
                    {team?.eliminated ? <span className="ml-2 text-xs text-muted">eliminated</span> : null}
                    {team?.paused ? <span className="ml-2 text-xs text-warn">paused</span> : null}
                  </Cell>
                  <Cell>{`${row.wins}-${row.losses}-${row.ties}`}</Cell>
                  <Cell align="right">{row.winPct.toFixed(3)}</Cell>
                  <Cell align="right">{points(row.pointsFor)}</Cell>
                  <Cell align="right">{points(row.pointsAgainst)}</Cell>
                  <Cell align="right">{team?.waiverPriority ?? "—"}</Cell>
                  {showSeeds ? (
                    <Cell align="right">
                      {seed ? (
                        <Badge tone="accent">{seed}</Badge>
                      ) : row.rank <= playoffTeams ? (
                        <span className="text-muted">{row.rank} (projected)</span>
                      ) : (
                        "—"
                      )}
                    </Cell>
                  ) : null}
                </Row>
              );
            })}
          </Table>
        )}
      </Card>

      <Card title="How this table is built">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>Standings are computed on demand from finalized regular-season matchups. There is no standings table.</li>
          <li>
            Ties break on win percentage, then head-to-head record among the tied teams, then points for, then a coin
            flip stored when the team was created.
          </li>
          <li>A tied game counts as half a win for both teams.</li>
          <li>
            Waiver priority is a rolling list that starts in reverse draft order; a team that wins a claim moves to the
            back.
          </li>
          <li>
            Playoff seeds appear once week 12 starts. The top {playoffTeams} teams qualify;
            seeds 1 and 2 get a bye in week {league?.playoffStartWeek ?? 15}.
          </li>
        </ul>
      </Card>
    </div>
  );
}
