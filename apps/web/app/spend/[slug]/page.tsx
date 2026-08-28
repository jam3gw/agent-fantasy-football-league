import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { formatEt } from "@league/shared";
import { computeStandings, costAlarms, sessions, spendLedger, teams } from "@league/engine";
import { Badge, Card, Cell, Empty, PageTitle, Row, Table, money } from "../../../components/ui";
import { db } from "../../../lib/db";

// §12.1: 300s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 300s stale.
export const revalidate = 300;

const etDaySql = sql<string>`to_char(${spendLedger.createdAt} at time zone 'America/New_York', 'YYYY-MM-DD')`;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return { title: `Spend — ${slug}` };
}

export default async function AgentSpendPage({ params }: { params: Promise<{ slug: string }> }) {
  // Next 16: params is a Promise.
  const { slug } = await params;
  const database = db();

  const isReporter = slug === "reporter";
  const team = isReporter
    ? undefined
    : (await database.select().from(teams).where(eq(teams.slug, slug)).catch(() => []))[0];
  if (!isReporter && !team) notFound();

  const teamId = team?.id ?? null;
  const scopeKey = isReporter ? "reporter" : String(teamId);
  const teamFilter = teamId === null ? isNull(spendLedger.teamId) : eq(spendLedger.teamId, teamId);
  const sessionFilter = teamId === null ? isNull(sessions.teamId) : eq(sessions.teamId, teamId);

  const [byKind, byDay, sessionRows, standings, alarms] = await Promise.all([
    database
      .select({
        kind: spendLedger.kind,
        list: sql<number>`coalesce(sum(${spendLedger.costUsd}), 0)::float8`,
        paid: sql<number>`coalesce(sum(${spendLedger.costUsd}) filter (where ${spendLedger.billedTo} = 'gateway'), 0)::float8`,
        steps: sql<number>`count(*)::int`,
      })
      .from(spendLedger)
      .where(teamFilter)
      .groupBy(spendLedger.kind)
      .catch(() => []),
    database
      .select({
        day: etDaySql,
        list: sql<number>`coalesce(sum(${spendLedger.costUsd}), 0)::float8`,
      })
      .from(spendLedger)
      .where(teamFilter)
      .groupBy(etDaySql)
      .orderBy(etDaySql)
      .catch(() => []),
    database
      .select({
        id: sessions.id,
        kind: sessions.kind,
        status: sessions.status,
        modelId: sessions.modelId,
        createdAt: sessions.createdAt,
        costUsd: sessions.costUsd,
        inputTokens: sessions.inputTokens,
        outputTokens: sessions.outputTokens,
        reasoningTokens: sessions.reasoningTokens,
        toolCalls: sessions.toolCalls,
        invalidToolCalls: sessions.invalidToolCalls,
      })
      .from(sessions)
      .where(sessionFilter)
      .orderBy(desc(sessions.createdAt))
      .limit(200)
      .catch(() => []),
    computeStandings(database).catch(() => []),
    database
      .select()
      .from(costAlarms)
      .where(and(eq(costAlarms.scopeKey, scopeKey), isNull(costAlarms.acknowledgedAt)))
      .catch(() => []),
  ]);

  const total = byKind.reduce((s, k) => s + Number(k.list), 0);
  const paid = byKind.reduce((s, k) => s + Number(k.paid), 0);
  const maxKind = Math.max(...byKind.map((k) => Number(k.list)), 0);
  const shownDays = byDay.slice(-30);
  const maxDay = Math.max(...shownDays.map((d) => Number(d.list)), 0);
  const st = teamId === null ? undefined : standings.find((s) => s.teamId === teamId);
  const name = isReporter ? "League reporter" : (team?.name ?? slug);
  const sessionCount = sessionRows.length;

  return (
    <>
      <PageTitle
        title={`Spend — ${name}`}
        subtitle={
          isReporter
            ? "The thirteenth agent. No team, no roster, the same tools and the same allowance."
            : `${team?.modelLabel ?? ""} · ${team?.modelId ?? ""}`
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <Link href="/spend" className="text-muted hover:text-accent">
          ← all agents
        </Link>
        {!isReporter && team ? (
          <Link href={`/teams/${team.slug}`} className="text-muted hover:text-accent">
            team page
          </Link>
        ) : null}
        {alarms.length > 0 ? <Badge tone="warn">{alarms.length} open alarm{alarms.length === 1 ? "" : "s"}</Badge> : null}
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Stat label="Season (list)" value={money(total)} note="every model step, catalog prices" />
        <Stat label="Season (paid)" value={money(paid)} note="billed to the gateway" />
        <Stat label="Sessions" value={String(sessionCount)} note={sessionCount === 200 ? "most recent 200" : "all recorded"} />
        <Stat
          label="Cost per point"
          value={st && st.pointsFor > 0 ? `$${(total / st.pointsFor).toFixed(3)}` : "—"}
          note={st ? `${st.pointsFor.toFixed(1)} points for` : "no matchups"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="By session kind">
          {byKind.length === 0 ? (
            <Empty>Nothing recorded yet.</Empty>
          ) : (
            <ul className="space-y-2">
              {[...byKind]
                .sort((a, b) => Number(b.list) - Number(a.list))
                .map((k) => (
                  <li key={k.kind}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span>
                        {k.kind} <span className="text-xs text-muted">{k.steps} step{k.steps === 1 ? "" : "s"}</span>
                      </span>
                      <span className="tabular-nums">{money(Number(k.list))}</span>
                    </div>
                    <div className="mt-1 h-2 w-full rounded bg-border/50">
                      <div
                        className="h-2 rounded bg-accent"
                        style={{ width: `${maxKind > 0 ? (Number(k.list) / maxKind) * 100 : 0}%` }}
                      />
                    </div>
                  </li>
                ))}
            </ul>
          )}
        </Card>

        <Card title={`By day — last ${shownDays.length} day${shownDays.length === 1 ? "" : "s"} with spend`}>
          {shownDays.length === 0 ? (
            <Empty>Nothing recorded yet.</Empty>
          ) : (
            <ul className="space-y-2">
              {shownDays.map((d) => (
                <li key={d.day}>
                  <div className="flex items-baseline justify-between text-xs">
                    <span className="text-muted">{d.day}</span>
                    <span className="tabular-nums">{money(Number(d.list))}</span>
                  </div>
                  <div className="mt-1 h-2 w-full rounded bg-border/50">
                    <div
                      className="h-2 rounded bg-accent"
                      style={{ width: `${maxDay > 0 ? (Number(d.list) / maxDay) * 100 : 0}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-4">
        <Card title="Sessions">
          {sessionRows.length === 0 ? (
            <Empty>No sessions yet.</Empty>
          ) : (
            <Table head={["When", "Kind", "Status", "Model", "Tool calls", "In", "Out", "Reasoning", "Cost"]}>
              {sessionRows.map((s) => (
                <Row key={s.id}>
                  <Cell>
                    <Link href={`/sessions/${s.id}`} className="hover:text-accent">
                      {formatEt(s.createdAt)}
                    </Link>
                  </Cell>
                  <Cell>{s.kind}</Cell>
                  <Cell>
                    {s.status === "failed" || s.status === "timed_out" ? (
                      <Badge tone="warn">{s.status}</Badge>
                    ) : (
                      s.status
                    )}
                  </Cell>
                  <Cell>
                    <span className="font-mono text-xs">{s.modelId}</span>
                  </Cell>
                  <Cell align="right">
                    {s.toolCalls}
                    {s.invalidToolCalls > 0 ? <span className="ml-1 text-danger">({s.invalidToolCalls} invalid)</span> : null}
                  </Cell>
                  <Cell align="right">{s.inputTokens.toLocaleString()}</Cell>
                  <Cell align="right">{s.outputTokens.toLocaleString()}</Cell>
                  <Cell align="right">{s.reasoningTokens.toLocaleString()}</Cell>
                  <Cell align="right">{money(s.costUsd)}</Cell>
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
