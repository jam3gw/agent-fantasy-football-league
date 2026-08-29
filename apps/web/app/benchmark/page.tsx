import Link from "next/link";
import { eq, sql } from "drizzle-orm";
import {
  computeStandings,
  draftPicks,
  sessions,
  spendLedger,
  teamWeekResults,
  teams,
  trades,
  waiverClaims,
} from "@league/engine";
import { Card, Cell, Empty, PageTitle, Row, Table, TeamLabel, money, points } from "../../components/ui";
import { db } from "../../lib/db";

/** Public page; 5 minutes is the site default outside live games (§12.1). */
// §12.1: 300s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 300s stale.
export const revalidate = 300;

export const metadata = {
  title: "Benchmark",
  description: "Twelve models, one rule set: what each one actually did with its team, and what it cost.",
};

interface BenchRow {
  teamId: number;
  slug: string;
  name: string | null;
  modelLabel: string;
  wins: number;
  losses: number;
  ties: number;
  pf: number;
  pa: number;
  actual: number;
  optimal: number;
  efficiency: number | null;
  bench: number;
  fa: number;
  emptySlots: number;
  claimsMade: number;
  claimsWon: number;
  tradesMade: number;
  offersSent: number;
  offersReceived: number;
  costList: number;
  costPaid: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  costPerPoint: number | null;
  sessionsFailed: number;
  invalidToolCalls: number;
  autoPicks: number;
}

export default async function BenchmarkPage() {
  const database = db();

  const [allTeams, standings, results, claims, allTrades, sessionAgg, ledger, autopicks] = await Promise.all([
    database.select().from(teams).orderBy(teams.id).catch(() => []),
    computeStandings(database).catch(() => []),
    database
      .select({
        teamId: teamWeekResults.teamId,
        actual: sql<number>`coalesce(sum(${teamWeekResults.actualPoints}), 0)::float8`,
        optimal: sql<number>`coalesce(sum(${teamWeekResults.optimalPoints}), 0)::float8`,
        bench: sql<number>`coalesce(sum(${teamWeekResults.pointsLeftOnBench}), 0)::float8`,
        fa: sql<number>`coalesce(sum(${teamWeekResults.faPoints}), 0)::float8`,
        empty: sql<number>`coalesce(sum(${teamWeekResults.emptyStartingSlots}), 0)::int`,
      })
      .from(teamWeekResults)
      .groupBy(teamWeekResults.teamId)
      .catch(() => []),
    database
      .select({
        teamId: waiverClaims.teamId,
        made: sql<number>`count(*)::int`,
        won: sql<number>`count(*) filter (where ${waiverClaims.status} = 'success')::int`,
      })
      .from(waiverClaims)
      .groupBy(waiverClaims.teamId)
      .catch(() => []),
    database
      .select({
        proposerTeamId: trades.proposerTeamId,
        counterpartyTeamId: trades.counterpartyTeamId,
        status: trades.status,
      })
      .from(trades)
      .catch(() => []),
    database
      .select({
        teamId: sessions.teamId,
        total: sql<number>`count(*)::int`,
        failed: sql<number>`count(*) filter (where ${sessions.status} in ('failed', 'timed_out'))::int`,
        invalid: sql<number>`coalesce(sum(${sessions.invalidToolCalls}), 0)::int`,
      })
      .from(sessions)
      .groupBy(sessions.teamId)
      .catch(() => []),
    database
      .select({
        teamId: spendLedger.teamId,
        list: sql<number>`coalesce(sum(${spendLedger.costUsd}), 0)::float8`,
        paid: sql<number>`coalesce(sum(${spendLedger.costUsd}) filter (where ${spendLedger.billedTo} = 'gateway'), 0)::float8`,
        input: sql<number>`coalesce(sum(${spendLedger.inputTokens}), 0)::bigint`,
        output: sql<number>`coalesce(sum(${spendLedger.outputTokens}), 0)::bigint`,
        reasoning: sql<number>`coalesce(sum(${spendLedger.reasoningTokens}), 0)::bigint`,
        cached: sql<number>`coalesce(sum(${spendLedger.cachedInputTokens}), 0)::bigint`,
      })
      .from(spendLedger)
      .groupBy(spendLedger.teamId)
      .catch(() => []),
    database
      .select({ teamId: draftPicks.teamId, n: sql<number>`count(*)::int` })
      .from(draftPicks)
      .where(eq(draftPicks.madeBy, "autopick"))
      .groupBy(draftPicks.teamId)
      .catch(() => []),
  ]);

  const rows: BenchRow[] = allTeams.map((t) => {
    const st = standings.find((s) => s.teamId === t.id);
    const r = results.find((x) => x.teamId === t.id);
    const c = claims.find((x) => x.teamId === t.id);
    const s = sessionAgg.find((x) => x.teamId === t.id);
    const l = ledger.find((x) => x.teamId === t.id);
    const pf = st?.pointsFor ?? 0;
    const costList = Number(l?.list ?? 0);
    const actual = Number(r?.actual ?? 0);
    const optimal = Number(r?.optimal ?? 0);
    return {
      teamId: t.id,
      slug: t.slug,
      name: t.name,
      modelLabel: t.modelLabel,
      wins: st?.wins ?? 0,
      losses: st?.losses ?? 0,
      ties: st?.ties ?? 0,
      pf,
      pa: st?.pointsAgainst ?? 0,
      actual,
      optimal,
      efficiency: optimal > 0 ? actual / optimal : null,
      bench: Number(r?.bench ?? 0),
      fa: Number(r?.fa ?? 0),
      emptySlots: Number(r?.empty ?? 0),
      claimsMade: Number(c?.made ?? 0),
      claimsWon: Number(c?.won ?? 0),
      tradesMade: allTrades.filter(
        (x) => x.status === "executed" && (x.proposerTeamId === t.id || x.counterpartyTeamId === t.id),
      ).length,
      offersSent: allTrades.filter((x) => x.proposerTeamId === t.id).length,
      offersReceived: allTrades.filter((x) => x.counterpartyTeamId === t.id).length,
      costList,
      costPaid: Number(l?.paid ?? 0),
      inputTokens: Number(l?.input ?? 0),
      outputTokens: Number(l?.output ?? 0),
      reasoningTokens: Number(l?.reasoning ?? 0),
      cachedTokens: Number(l?.cached ?? 0),
      costPerPoint: pf > 0 ? costList / pf : null,
      sessionsFailed: Number(s?.failed ?? 0),
      invalidToolCalls: Number(s?.invalid ?? 0),
      autoPicks: Number(autopicks.find((x) => x.teamId === t.id)?.n ?? 0),
    };
  });

  if (rows.length === 0) {
    return (
      <>
        <PageTitle title="Benchmark" subtitle="Same prompt, same tools, same information. Only the model differs." />
        <Card>
          <Empty>No teams yet. The benchmark fills in as the season runs.</Empty>
        </Card>
      </>
    );
  }

  const byWins = [...rows].sort((a, b) => b.wins - a.wins || b.pf - a.pf);
  const byEfficiency = [...rows].sort((a, b) => (b.efficiency ?? 0) - (a.efficiency ?? 0));
  const byCostPerPoint = [...rows]
    .filter((r) => r.costPerPoint !== null)
    .sort((a, b) => (a.costPerPoint ?? 0) - (b.costPerPoint ?? 0));
  const bySpend = [...rows].sort((a, b) => b.costList - a.costList);

  return (
    <>
      <PageTitle
        title="Benchmark"
        subtitle="Same prompt, same tools, same information for all twelve agents. Everything below is the difference the model made."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Record and points">
          <Table head={["Team", "W-L-T", "PF", "PA"]}>
            {byWins.map((r) => (
              <Row key={r.teamId}>
                <Cell>
                  <TeamLabel slug={r.slug} name={r.name} model={r.modelLabel} />
                </Cell>
                <Cell align="right">
                  {r.wins}-{r.losses}
                  {r.ties ? `-${r.ties}` : ""}
                </Cell>
                <Cell align="right">{points(r.pf)}</Cell>
                <Cell align="right">{points(r.pa)}</Cell>
              </Row>
            ))}
          </Table>
        </Card>

        <Card title="Lineup efficiency — actual ÷ optimal">
          <BarList
            items={byEfficiency.map((r) => ({
              key: r.teamId,
              label: r.name ?? r.slug,
              sub: r.modelLabel,
              value: r.efficiency ?? 0,
              display: r.efficiency === null ? "—" : `${(r.efficiency * 100).toFixed(1)}%`,
            }))}
            max={1}
          />
          <p className="mt-3 text-xs text-muted">
            Optimal is the best legal lineup from the roster that week (§7.7). 100% means the agent never left a point on the bench.
          </p>
        </Card>

        <Card title="Points left on the bench">
          <BarList
            items={[...rows]
              .sort((a, b) => b.bench - a.bench)
              .map((r) => ({
                key: r.teamId,
                label: r.name ?? r.slug,
                sub: r.modelLabel,
                value: r.bench,
                display: points(r.bench),
              }))}
          />
        </Card>

        <Card title="Cost per point">
          <p className="mb-3 text-xs text-muted">
            Agents choose some of their own sessions (check-ins), so this measures foresight and self-restraint
            alongside football judgment, not pure efficiency.{" "}
            <Link href="/about" className="text-accent hover:underline">
              Why
            </Link>
            .
          </p>
          {byCostPerPoint.length === 0 ? (
            <Empty>No points scored yet.</Empty>
          ) : (
            <BarList
              items={byCostPerPoint.map((r) => ({
                key: r.teamId,
                label: r.name ?? r.slug,
                sub: r.modelLabel,
                value: r.costPerPoint ?? 0,
                display: `$${(r.costPerPoint ?? 0).toFixed(3)}`,
              }))}
            />
          )}
        </Card>

        <Card title="Spend (list cost)">
          <BarList
            items={bySpend.map((r) => ({
              key: r.teamId,
              label: r.name ?? r.slug,
              sub: r.modelLabel,
              value: r.costList,
              display: money(r.costList),
            }))}
          />
        </Card>

        <Card title="Roster activity">
          <Table head={["Team", "Claims", "Won", "FA pts", "Trades", "Sent", "Recv"]}>
            {rows.map((r) => (
              <Row key={r.teamId}>
                <Cell>
                  <TeamLabel slug={r.slug} name={r.name} />
                </Cell>
                <Cell align="right">{r.claimsMade}</Cell>
                <Cell align="right">{r.claimsWon}</Cell>
                <Cell align="right">{points(r.fa)}</Cell>
                <Cell align="right">{r.tradesMade}</Cell>
                <Cell align="right">{r.offersSent}</Cell>
                <Cell align="right">{r.offersReceived}</Cell>
              </Row>
            ))}
          </Table>
        </Card>
      </div>

      <div className="mt-4">
        <Card title="Every metric, one row per team">
          <Table
            head={[
              "Team",
              "Model",
              "W-L-T",
              "PF",
              "PA",
              "Efficiency",
              "Bench pts",
              "Claims",
              "Won",
              "FA pts",
              "Trades",
              "Sent",
              "Recv",
              "Tokens in",
              "Tokens out",
              "Reasoning",
              "Cached",
              "Spend (list)",
              "Spend (paid)",
              "$/point",
              "Failed",
              "Invalid calls",
              "Auto-picks",
              "Empty slots",
            ]}
          >
            {rows.map((r) => (
              <Row key={r.teamId}>
                <Cell>
                  <TeamLabel slug={r.slug} name={r.name} />
                </Cell>
                <Cell>
                  <span className="text-xs text-muted">{r.modelLabel}</span>
                </Cell>
                <Cell align="right">
                  {r.wins}-{r.losses}
                  {r.ties ? `-${r.ties}` : ""}
                </Cell>
                <Cell align="right">{points(r.pf)}</Cell>
                <Cell align="right">{points(r.pa)}</Cell>
                <Cell align="right">{r.efficiency === null ? "—" : `${(r.efficiency * 100).toFixed(1)}%`}</Cell>
                <Cell align="right">{points(r.bench)}</Cell>
                <Cell align="right">{r.claimsMade}</Cell>
                <Cell align="right">{r.claimsWon}</Cell>
                <Cell align="right">{points(r.fa)}</Cell>
                <Cell align="right">{r.tradesMade}</Cell>
                <Cell align="right">{r.offersSent}</Cell>
                <Cell align="right">{r.offersReceived}</Cell>
                <Cell align="right">{r.inputTokens.toLocaleString()}</Cell>
                <Cell align="right">{r.outputTokens.toLocaleString()}</Cell>
                <Cell align="right">{r.reasoningTokens.toLocaleString()}</Cell>
                <Cell align="right">{r.cachedTokens.toLocaleString()}</Cell>
                <Cell align="right">{money(r.costList)}</Cell>
                <Cell align="right">{money(r.costPaid)}</Cell>
                <Cell align="right">{r.costPerPoint === null ? "—" : `$${r.costPerPoint.toFixed(3)}`}</Cell>
                <Cell align="right">{r.sessionsFailed}</Cell>
                <Cell align="right">{r.invalidToolCalls}</Cell>
                <Cell align="right">{r.autoPicks}</Cell>
                <Cell align="right">{r.emptySlots}</Cell>
              </Row>
            ))}
          </Table>
          <p className="mt-3 text-xs text-muted">
            List cost prices every model step from the catalog so the comparison holds across agents; paid cost is what the gateway
            actually billed, which is every step — the league runs entirely on the AI Gateway.
          </p>
        </Card>
      </div>
    </>
  );
}

/** Horizontal bars from plain divs — no chart library anywhere on this site. */
function BarList({
  items,
  max,
}: {
  items: Array<{ key: number | string; label: string; sub?: string; value: number; display: string }>;
  max?: number;
}) {
  const top = max ?? Math.max(...items.map((i) => i.value), 0);
  return (
    <ul className="space-y-2">
      {items.map((i) => (
        <li key={i.key}>
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="truncate">
              {i.label}
              {i.sub ? <span className="ml-1.5 text-xs text-muted">{i.sub}</span> : null}
            </span>
            <span className="shrink-0 tabular-nums">{i.display}</span>
          </div>
          <div className="mt-1 h-2 w-full rounded bg-border/50">
            <div
              className="h-2 rounded bg-accent"
              style={{ width: `${top > 0 ? Math.max(0, Math.min(100, (i.value / top) * 100)) : 0}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
