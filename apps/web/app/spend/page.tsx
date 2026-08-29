import Link from "next/link";
import { isNull, sql } from "drizzle-orm";
import { etDay } from "@league/shared";
import {
  PRE_SEASON_KINDS,
  computeStandings,
  costAlarms,
  getSettings,
  sessions,
  spendLedger,
  spendRollups,
  teams,
} from "@league/engine";
import { Badge, Card, Cell, Empty, PageTitle, Row, Table, money } from "../../components/ui";
import { db, leagueClock } from "../../lib/db";

// §12.1: 300s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 300s stale.
export const revalidate = 300;

export const metadata = {
  title: "Spend",
  description: "Every dollar the league spends, per agent and per day, with the season projection.",
};

/** Days of history in the daily charts. */
const CHART_DAYS = 21;
/** §8.7: the season projection annualises over the full 18-week season. */
const SEASON_WEEKS = 18;

const etDaySql = sql<string>`to_char(${spendLedger.createdAt} at time zone 'America/New_York', 'YYYY-MM-DD')`;

export default async function SpendPage() {
  const database = db();
  const clock = await leagueClock();
  const today = etDay(clock.now());

  const [settings, allTeams, standings, perAgent, perAgentDay, byDay, kindTotals, rollups, alarms, sessionCounts] =
    await Promise.all([
      getSettings(database).catch(() => null),
      database.select().from(teams).orderBy(teams.id).catch(() => []),
      computeStandings(database).catch(() => []),
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
        .select({
          teamId: spendLedger.teamId,
          day: etDaySql,
          list: sql<number>`coalesce(sum(${spendLedger.costUsd}), 0)::float8`,
        })
        .from(spendLedger)
        .groupBy(spendLedger.teamId, etDaySql)
        .catch(() => []),
      database
        .select({
          day: etDaySql,
          list: sql<number>`coalesce(sum(${spendLedger.costUsd}), 0)::float8`,
        })
        .from(spendLedger)
        .groupBy(etDaySql)
        .orderBy(etDaySql)
        .catch(() => []),
      database
        .select({
          kind: spendLedger.kind,
          list: sql<number>`coalesce(sum(${spendLedger.costUsd}), 0)::float8`,
        })
        .from(spendLedger)
        .groupBy(spendLedger.kind)
        .catch(() => []),
      database.select().from(spendRollups).catch(() => []),
      database.select().from(costAlarms).where(isNull(costAlarms.acknowledgedAt)).catch(() => []),
      database
        .select({ teamId: sessions.teamId, n: sql<number>`count(*)::int` })
        .from(sessions)
        .groupBy(sessions.teamId)
        .catch(() => []),
    ]);

  const weekKey = `W${settings?.currentWeek ?? 1}`;
  const weekOf = (scopeKey: string) =>
    Number(
      rollups.find((r) => r.scope === "agent" && r.scopeKey === scopeKey && r.period === "week" && r.periodStart === weekKey)
        ?.costUsd ?? 0,
    );

  // One row per agent: the twelve teams plus the reporter (§12.1).
  const agents = [
    ...allTeams.map((t) => ({
      key: String(t.id),
      teamId: t.id as number | null,
      href: `/spend/${t.slug}`,
      name: t.name ?? t.slug,
      model: t.modelLabel,
    })),
    { key: "reporter", teamId: null as number | null, href: "/spend/reporter", name: "League reporter", model: "reporter" },
  ];

  const rows = agents.map((a) => {
    const agg = perAgent.find((p) => (p.teamId ?? null) === a.teamId);
    const list = Number(agg?.list ?? 0);
    const todayCost = perAgentDay
      .filter((p) => (p.teamId ?? null) === a.teamId && p.day === today)
      .reduce((sum, p) => sum + Number(p.list), 0);
    const st = a.teamId === null ? undefined : standings.find((s) => s.teamId === a.teamId);
    const sessionCount = Number(sessionCounts.find((s) => (s.teamId ?? null) === a.teamId)?.n ?? 0);
    return {
      ...a,
      today: todayCost,
      week: weekOf(a.key),
      season: list,
      paid: Number(agg?.paid ?? 0),
      sessions: sessionCount,
      perSession: sessionCount > 0 ? list / sessionCount : null,
      perPoint: st && st.pointsFor > 0 ? list / st.pointsFor : null,
      perWin: st && st.wins > 0 ? list / st.wins : null,
      input: Number(agg?.input ?? 0),
      output: Number(agg?.output ?? 0),
      reasoning: Number(agg?.reasoning ?? 0),
      cached: Number(agg?.cached ?? 0),
      alarms: alarms.filter((al) => al.scopeKey === a.key).length,
    };
  });

  const leagueSeason = rows.reduce((s, r) => s + r.season, 0);
  const leaguePaid = rows.reduce((s, r) => s + r.paid, 0);
  const leagueToday = rows.reduce((s, r) => s + r.today, 0);
  const leagueWeek = Number(
    rollups.find((r) => r.scope === "league" && r.period === "week" && r.periodStart === weekKey)?.costUsd ?? 0,
  ) || rows.reduce((s, r) => s + r.week, 0);

  // The same set `createSession` uses to decide which kinds carry no week
  // (§8.7), so "plus the draft" here and the week rollups cannot disagree.
  const draftCost = kindTotals
    .filter((k) => PRE_SEASON_KINDS.has(k.kind))
    .reduce((s, k) => s + Number(k.list), 0);
  const weeksElapsed = Math.max(1, (settings?.currentWeek ?? 1) - (settings?.startWeek ?? 1) + 1);
  const inSeasonSpend = Math.max(0, leagueSeason - draftCost);
  const projection = (inSeasonSpend / weeksElapsed) * SEASON_WEEKS + draftCost;

  // Daily charts: the last CHART_DAYS ET days that have any spend.
  const days = byDay.map((d) => d.day).slice(-CHART_DAYS);
  const dayTotal = new Map(byDay.map((d) => [d.day, Number(d.list)]));
  const maxDay = Math.max(...days.map((d) => dayTotal.get(d) ?? 0), 0);
  const cumulative = byDay.reduce<Array<{ day: string; total: number }>>((acc, d) => {
    const previous = acc.length > 0 ? acc[acc.length - 1]!.total : 0;
    acc.push({ day: d.day, total: previous + Number(d.list) });
    return acc;
  }, []);
  const cumulativeShown = cumulative.slice(-CHART_DAYS);
  const maxCumulative = cumulativeShown.length > 0 ? cumulativeShown[cumulativeShown.length - 1]!.total : 0;

  const colorOf = (index: number) => `hsl(${(index * 41) % 360} 55% 48%)`;

  return (
    <>
      <PageTitle
        title="Spend"
        subtitle="No cap, no dollar stop. Every model step and every paid tool call is recorded, and the alarms only ever notify."
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Today" value={money(leagueToday)} note={today} />
        <Stat label={`This week (${weekKey})`} value={money(leagueWeek)} note={`week ${settings?.currentWeek ?? "—"}`} />
        <Stat label="Season to date" value={money(leagueSeason)} note={`${money(leaguePaid)} billed to the gateway`} />
        <Stat
          label="At this pace"
          value={money(projection)}
          note={`${money(inSeasonSpend)} over ${weeksElapsed} week${weeksElapsed === 1 ? "" : "s"} × ${SEASON_WEEKS}, plus ${money(draftCost)} of draft and onboarding`}
        />
      </div>

      {alarms.length > 0 ? (
        <div className="mb-4 rounded-lg border border-warn/50 px-4 py-3 text-sm text-warn">
          {alarms.length} unacknowledged cost alarm{alarms.length === 1 ? "" : "s"}. An alarm is a notification, never a cap — no session
          is ever stopped by spend.
        </div>
      ) : null}

      <Card title="Per agent">
        {rows.length === 0 ? (
          <Empty>No agents yet.</Empty>
        ) : (
          <Table
            head={[
              "Agent",
              "Today",
              "Week",
              "Season (list)",
              "Season (paid)",
              "Sessions",
              "Avg / session",
              "$ / point",
              "$ / win",
              "In",
              "Out",
              "Reasoning",
              "Cached",
            ]}
          >
            {[...rows]
              .sort((a, b) => b.season - a.season)
              .map((r) => (
                <Row key={r.key}>
                  <Cell>
                    <Link href={r.href} className="font-medium hover:text-accent">
                      {r.name}
                    </Link>
                    <span className="ml-1.5 text-xs text-muted">{r.model}</span>
                    {r.alarms > 0 ? (
                      <span className="ml-1.5">
                        <Badge tone="warn">{r.alarms} alarm{r.alarms === 1 ? "" : "s"}</Badge>
                      </span>
                    ) : null}
                  </Cell>
                  <Cell align="right">{money(r.today)}</Cell>
                  <Cell align="right">{money(r.week)}</Cell>
                  <Cell align="right">{money(r.season)}</Cell>
                  <Cell align="right">{money(r.paid)}</Cell>
                  <Cell align="right">{r.sessions}</Cell>
                  <Cell align="right">{r.perSession === null ? "—" : money(r.perSession)}</Cell>
                  <Cell align="right">{r.perPoint === null ? "—" : `$${r.perPoint.toFixed(3)}`}</Cell>
                  <Cell align="right">{r.perWin === null ? "—" : money(r.perWin)}</Cell>
                  <Cell align="right">{r.input.toLocaleString()}</Cell>
                  <Cell align="right">{r.output.toLocaleString()}</Cell>
                  <Cell align="right">{r.reasoning.toLocaleString()}</Cell>
                  <Cell align="right">{r.cached.toLocaleString()}</Cell>
                </Row>
              ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-muted">
          List cost prices every step from the model catalog, so agents stay comparable. Every call bills the AI Gateway, so paid cost
          tracks list cost; the two columns stay separate because the gateway&rsquo;s own reported cost is preferred when it sends one.
        </p>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title={`Daily spend per agent — last ${days.length} day${days.length === 1 ? "" : "s"}`}>
          {days.length === 0 ? (
            <Empty>No spend recorded yet.</Empty>
          ) : (
            <>
              <ul className="space-y-2">
                {days.map((day) => {
                  const total = dayTotal.get(day) ?? 0;
                  return (
                    <li key={day}>
                      <div className="flex items-baseline justify-between text-xs">
                        <span className="text-muted">{day}</span>
                        <span className="tabular-nums">{money(total)}</span>
                      </div>
                      <div
                        className="mt-1 flex h-3 w-full overflow-hidden rounded bg-border/50"
                        style={{ width: `${maxDay > 0 ? Math.max(2, (total / maxDay) * 100) : 0}%` }}
                      >
                        {rows.map((r, i) => {
                          const v = perAgentDay
                            .filter((p) => (p.teamId ?? null) === r.teamId && p.day === day)
                            .reduce((s, p) => s + Number(p.list), 0);
                          if (v <= 0) return null;
                          return (
                            <div
                              key={r.key}
                              title={`${r.name}: ${money(v)}`}
                              style={{ width: `${(v / total) * 100}%`, background: colorOf(i) }}
                            />
                          );
                        })}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                {rows.map((r, i) => (
                  <span key={r.key} className="inline-flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-sm" style={{ background: colorOf(i) }} />
                    {r.name}
                  </span>
                ))}
              </div>
            </>
          )}
        </Card>

        <Card title="Cumulative season spend">
          {cumulativeShown.length === 0 ? (
            <Empty>No spend recorded yet.</Empty>
          ) : (
            <ul className="space-y-2">
              {cumulativeShown.map((c) => (
                <li key={c.day}>
                  <div className="flex items-baseline justify-between text-xs">
                    <span className="text-muted">{c.day}</span>
                    <span className="tabular-nums">{money(c.total)}</span>
                  </div>
                  <div className="mt-1 h-3 w-full rounded bg-border/50">
                    <div
                      className="h-3 rounded bg-accent"
                      style={{ width: `${maxCumulative > 0 ? (c.total / maxCumulative) * 100 : 0}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted">
            Running total of every ledger row, list cost. Days with no sessions do not appear.
          </p>
        </Card>
      </div>

      <div className="mt-4">
        <Card title="League spend by session kind">
          {kindTotals.length === 0 ? (
            <Empty>Nothing recorded yet.</Empty>
          ) : (
            <Table head={["Kind", "Cost", "Share"]}>
              {[...kindTotals]
                .sort((a, b) => Number(b.list) - Number(a.list))
                .map((k) => (
                  <Row key={k.kind}>
                    <Cell>{k.kind}</Cell>
                    <Cell align="right">{money(Number(k.list))}</Cell>
                    <Cell align="right">
                      {leagueSeason > 0 ? `${((Number(k.list) / leagueSeason) * 100).toFixed(1)}%` : "—"}
                    </Cell>
                  </Row>
                ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-muted">{note}</div>
    </div>
  );
}
