/**
 * `/draft` — the draft room (SPEC §10, §12.1). While the draft is running the
 * live panel polls `/api/draft/state` every 3 seconds; afterwards this is the
 * full board: every pick by round with the team, the player and the agent's
 * stated reason.
 */
import { asc, eq, inArray } from "drizzle-orm";
import { draft as draftTable, draftPicks, leagueSettings, players, teams } from "@league/engine";
import { db } from "../../lib/db";
import { Badge, Card, Cell, Empty, PageTitle, Row, Table, TeamLabel } from "../../components/ui";
import { InlineMarkdown } from "../../components/markdown";
import { flattenMarkdown } from "../../lib/broadcastLogic";
import DraftLive from "./live";

/** 30 s while the draft is live (§12.1); the board only changes on a pick. */
// §12.1: 30s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 30s stale.
export const revalidate = 30;

const STATUS_LABEL: Record<string, string> = {
  not_started: "not started",
  running: "running",
  paused: "paused",
  complete: "complete",
};

function when(at: Date | null): string {
  if (!at) return "—";
  return at.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function DraftPageInner() {
  const state = (await db().select().from(draftTable).where(eq(draftTable.id, 1)))[0];
  const settings = (await db().select().from(leagueSettings).where(eq(leagueSettings.id, 1)))[0];
  const teamRows = await db().select().from(teams);
  const teamById = new Map(teamRows.map((t) => [t.id, t]));

  const picks = await db().select().from(draftPicks).orderBy(asc(draftPicks.pickNo));
  const playerIds = picks.map((p) => p.playerId);
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

  const status = state?.status ?? "not_started";
  const order = state?.order ?? [];
  const rounds = settings?.draftRounds ?? 14;
  const totalPicks = order.length > 0 ? order.length * rounds : rounds * 12;
  const autopicks = picks.filter((p) => p.madeBy === "autopick").length;

  const byRound = new Map<number, typeof picks>();
  for (const pick of picks) {
    const list = byRound.get(pick.round);
    if (list) list.push(pick);
    else byRound.set(pick.round, [pick]);
  }
  const roundNumbers = [...byRound.keys()].sort((a, b) => a - b);

  return (
    <>
      <PageTitle
        title="Draft"
        subtitle={`Snake draft, ${rounds} rounds, ${totalPicks} picks, ${settings?.draftClockSeconds ?? 180} seconds on the clock. Every pick carries the agent's reason.`}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-muted">
        <Badge tone={status === "running" ? "accent" : status === "paused" ? "warn" : "neutral"}>
          {STATUS_LABEL[status] ?? status}
        </Badge>
        <span>
          {picks.length} of {totalPicks} picks
        </span>
        {autopicks > 0 ? (
          <span>
            {autopicks} auto{autopicks === 1 ? "pick" : "picks"}
          </span>
        ) : null}
        {state?.startedAt ? <span>started {when(state.startedAt)} ET</span> : null}
        {state?.endedAt ? <span>ended {when(state.endedAt)} ET</span> : null}
      </div>

      {status === "running" || status === "paused" ? (
        <div className="mb-4">
          <DraftLive />
        </div>
      ) : null}

      {order.length > 0 ? (
        <div className="mb-4">
          <Card title="Draft order">
            <ol className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {order.map((teamId, index) => {
                const team = teamById.get(teamId);
                return (
                  <li key={teamId} className="flex items-baseline gap-2">
                    <span className="w-6 shrink-0 text-right text-xs text-muted tabular-nums">{index + 1}</span>
                    <TeamLabel slug={team?.slug} name={team?.name ?? null} model={team?.modelLabel} />
                  </li>
                );
              })}
            </ol>
          </Card>
        </div>
      ) : null}

      {picks.length === 0 ? (
        <Card title="Board">
          <Empty>
            {status === "not_started" ? "The draft has not started yet." : "No picks have been made yet."}
          </Empty>
        </Card>
      ) : (
        <div className="space-y-4">
          {roundNumbers.map((round) => (
            <Card key={round} title={`Round ${round}`}>
              <Table head={["Pick", "Team", "Player", "Reason"]}>
                {(byRound.get(round) ?? []).map((pick) => {
                  const team = teamById.get(pick.teamId);
                  const player = playerById.get(pick.playerId);
                  return (
                    <Row key={pick.pickNo}>
                      <Cell align="right">
                        <span className="text-muted tabular-nums">{pick.pickNo}</span>
                      </Cell>
                      <Cell>
                        <TeamLabel slug={team?.slug} name={team?.name ?? null} model={team?.modelLabel} />
                      </Cell>
                      <Cell>
                        <span className="font-medium">{player?.fullName ?? pick.playerId}</span>
                        {player?.position || player?.nflTeam ? (
                          <span className="ml-1.5 text-xs text-muted">
                            {[player?.position, player?.nflTeam].filter(Boolean).join(" · ")}
                          </span>
                        ) : null}
                      </Cell>
                      <Cell>
                        <div className="flex flex-wrap items-baseline gap-2">
                          {pick.madeBy === "autopick" ? <Badge tone="warn">autopick</Badge> : null}
                          <span className="text-sm text-muted">
                            {pick.reason ? (
                              <InlineMarkdown source={flattenMarkdown(pick.reason)} id={`r${pick.pickNo}`} />
                            ) : null}
                          </span>
                        </div>
                      </Cell>
                    </Row>
                  );
                })}
              </Table>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * __renderGuarded: pages use ISR, so Next prerenders them at build time. A
 * database that is unreachable or still empty must not fail the deploy, and a
 * blip at request time must not take down a public page — the draft simply
 * renders empty instead.
 */
export default async function DraftPage() {
  try {
    return await DraftPageInner();
  } catch (error) {
    console.error("[the draft] render failed", error instanceof Error ? error.message : error);
    return (
      <>
        <PageTitle title="The Draft" />
        <Card>
          <Empty>This page could not load its data. It will refresh on its own.</Empty>
        </Card>
      </>
    );
  }
}
