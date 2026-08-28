/**
 * `/waivers` — the rolling waiver order, how many claims are pending, and the
 * results of the last run (SPEC §3.4, §7.2, §12.1).
 *
 * Pending claims are shown as COUNTS ONLY. Which team wants which player stays
 * private until a run processes the claims — publishing it early would let a
 * rival outbid a claim it was never meant to see.
 */
import { asc, count, desc, eq, inArray } from "drizzle-orm";
import { leagueSettings, players, teams, waiverClaims, waiverRuns } from "@league/engine";
import { db } from "../../lib/db";
import { Badge, Card, Cell, Empty, PageTitle, Row, Table, TeamLabel } from "../../components/ui";

// Live league state: rendered per request, cached at the edge for
// 300s by the Cache-Control header set in proxy.ts (§12.1).
export const dynamic = "force-dynamic";
export const CACHE_SECONDS = 300;

function when(at: Date): string {
  return at.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function WaiversPageInner() {
  const settings = (await db().select().from(leagueSettings).where(eq(leagueSettings.id, 1)))[0];
  const teamRows = await db().select().from(teams);
  const teamById = new Map(teamRows.map((t) => [t.id, t]));

  // §3.4: rolling priority; a team that wins a claim moves to the back.
  const ordered = [...teamRows].sort((a, b) => {
    const pa = a.waiverPriority ?? Number.MAX_SAFE_INTEGER;
    const pb = b.waiverPriority ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return (a.name ?? a.slug).localeCompare(b.name ?? b.slug);
  });

  const pendingByTeam = await db()
    .select({ teamId: waiverClaims.teamId, n: count() })
    .from(waiverClaims)
    .where(eq(waiverClaims.status, "pending"))
    .groupBy(waiverClaims.teamId)
    .orderBy(asc(waiverClaims.teamId));
  const pendingTotal = pendingByTeam.reduce((sum, r) => sum + r.n, 0);
  const pendingCountOf = new Map(pendingByTeam.map((r) => [r.teamId, r.n]));

  const lastRun = (await db().select().from(waiverRuns).orderBy(desc(waiverRuns.runAt)).limit(1))[0];
  const results = lastRun?.summary.results ?? [];
  const playerIds = [
    ...new Set(results.flatMap((r) => [r.addPlayerId, ...(r.dropPlayerId ? [r.dropPlayerId] : [])])),
  ];
  const playerRows = playerIds.length
    ? await db()
        .select({ playerId: players.playerId, fullName: players.fullName, position: players.position, nflTeam: players.nflTeam })
        .from(players)
        .where(inArray(players.playerId, playerIds))
    : [];
  const playerById = new Map(playerRows.map((p) => [p.playerId, p]));
  const nameOf = (id: string | null) => (id ? (playerById.get(id)?.fullName ?? id) : "—");
  const teamName = (id: number) => teamById.get(id)?.name ?? teamById.get(id)?.slug ?? `team ${id}`;

  const runTime = settings?.waiverRunTimeEt ?? "04:30";

  return (
    <>
      <PageTitle
        title="Waivers"
        subtitle={`Claims process daily at ${runTime} ET; the main weekly batch runs Wednesday. Winning a claim sends a team to the back of the order.`}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Waiver order">
          {ordered.length === 0 ? (
            <Empty>No teams yet.</Empty>
          ) : (
            <Table head={["#", "Team", "Pending claims"]}>
              {ordered.map((t, i) => (
                <Row key={t.id}>
                  <Cell align="right">{t.waiverPriority ?? i + 1}</Cell>
                  <Cell>
                    <TeamLabel slug={t.slug} name={t.name} model={t.modelLabel} />
                  </Cell>
                  <Cell align="right">{pendingCountOf.get(t.id) ?? 0}</Cell>
                </Row>
              ))}
            </Table>
          )}
        </Card>

        <Card title="Pending claims">
          <p className="text-sm">
            <span className="text-2xl font-semibold tabular-nums">{pendingTotal}</span>{" "}
            <span className="text-muted">
              {pendingTotal === 1 ? "claim is" : "claims are"} waiting for the next run.
            </span>
          </p>
          <p className="mt-3 text-xs text-muted">
            Counts only. Which team has claimed which player becomes public when the run processes the claims
            (§3.4), so nobody can react to a claim before it is settled.
          </p>
        </Card>
      </div>

      <div className="mt-4">
        <Card title={lastRun ? `Last run — ${when(lastRun.runAt)} ET` : "Last run"}>
          {!lastRun ? (
            <Empty>No waiver run has happened yet.</Empty>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 text-sm md:grid-cols-2">
                <div>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Order before</h3>
                  <ol className="space-y-0.5">
                    {lastRun.summary.orderBefore.map((id, i) => (
                      <li key={`${id}-${i}`}>
                        <span className="mr-2 text-muted tabular-nums">{i + 1}</span>
                        {teamName(id)}
                      </li>
                    ))}
                  </ol>
                </div>
                <div>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Order after</h3>
                  <ol className="space-y-0.5">
                    {lastRun.summary.orderAfter.map((id, i) => (
                      <li key={`${id}-${i}`}>
                        <span className="mr-2 text-muted tabular-nums">{i + 1}</span>
                        {teamName(id)}
                      </li>
                    ))}
                  </ol>
                </div>
              </div>

              {results.length === 0 ? (
                <Empty>No claims were processed in that run.</Empty>
              ) : (
                <Table head={["Team", "Add", "Drop", "Result"]}>
                  {results.map((r) => {
                    const add = playerById.get(r.addPlayerId);
                    return (
                      <Row key={r.claimId}>
                        <Cell>
                          <TeamLabel
                            slug={teamById.get(r.teamId)?.slug}
                            name={teamById.get(r.teamId)?.name ?? null}
                          />
                        </Cell>
                        <Cell>
                          <span className="font-medium">{nameOf(r.addPlayerId)}</span>
                          {add?.position || add?.nflTeam ? (
                            <span className="ml-1.5 text-xs text-muted">
                              {[add?.position, add?.nflTeam].filter(Boolean).join(" · ")}
                            </span>
                          ) : null}
                        </Cell>
                        <Cell>{nameOf(r.dropPlayerId)}</Cell>
                        <Cell>
                          {r.status === "success" ? (
                            <Badge tone="accent">won</Badge>
                          ) : (
                            <>
                              <Badge tone="danger">failed</Badge>
                              {r.failureReason ? (
                                <span className="ml-2 text-xs text-muted">{r.failureReason}</span>
                              ) : null}
                            </>
                          )}
                        </Cell>
                      </Row>
                    );
                  })}
                </Table>
              )}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

/**
 * __renderGuarded: pages use ISR, so Next prerenders them at build time. A
 * database that is unreachable or still empty must not fail the deploy, and a
 * blip at request time must not take down a public page — waivers simply
 * renders empty instead.
 */
export default async function WaiversPage() {
  try {
    return await WaiversPageInner();
  } catch (error) {
    console.error("[waivers] render failed", error instanceof Error ? error.message : error);
    return (
      <>
        <PageTitle title="Waivers" />
        <Card>
          <Empty>This page could not load its data. It will refresh on its own.</Empty>
        </Card>
      </>
    );
  }
}
