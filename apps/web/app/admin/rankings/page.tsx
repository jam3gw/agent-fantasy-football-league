import { asc, desc, eq, sql } from "drizzle-orm";
import { formatEt } from "@league/shared";
import { players, rankings } from "@league/engine";
import { Badge, Card, Cell, Empty, PageTitle, Row, Table } from "../../../components/ui";
import { db } from "../../../lib/db";
import { draftGateStatus, refreshRankingsAction } from "../../../lib/adminActions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Rankings" };

/** §5.7: the draft cannot start below this many ranked players. */
const RANKED_FLOOR = 200;
const PREVIEW_ROWS = 25;

export default async function AdminRankingsPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string }>;
}) {
  const { msg } = await searchParams;
  const database = db();

  const [latest, counts, preview, gate] = await Promise.all([
    database.select().from(rankings).orderBy(desc(rankings.fetchedAt)).limit(1).catch(() => []),
    database
      .select({
        set: rankings.set,
        week: rankings.week,
        total: sql<number>`count(*)::int`,
        ranked: sql<number>`count(${rankings.rank})::int`,
        fetchedAt: sql<Date>`max(${rankings.fetchedAt})`,
      })
      .from(rankings)
      .groupBy(rankings.set, rankings.week)
      .catch(() => []),
    database
      .select({
        rank: rankings.rank,
        posRank: rankings.posRank,
        tier: rankings.tier,
        adp: rankings.adp,
        name: players.fullName,
        team: players.nflTeam,
        position: players.position,
      })
      .from(rankings)
      .innerJoin(players, eq(players.playerId, rankings.playerId))
      .where(eq(rankings.set, "draft"))
      .orderBy(asc(rankings.rank))
      .limit(PREVIEW_ROWS)
      .catch(() => []),
    draftGateStatus().catch(() => ({ ranked: 0, ok: false })),
  ]);

  const sourceCounts = (latest[0]?.sourceCounts ?? {}) as Record<string, number>;
  const fetchedAt = latest[0]?.fetchedAt ?? null;

  return (
    <>
      <PageTitle
        title="Rankings"
        subtitle="The engine pulls the draft board from Sleeper's projection feed. Nothing is uploaded here; the only control is a refresh."
      />
      {msg ? <p className="mb-4 rounded-lg border border-accent/50 bg-accent-soft px-4 py-3 text-sm text-accent">{msg}</p> : null}

      <div
        className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
          gate.ok ? "border-accent/50 bg-accent-soft text-accent" : "border-warn/50 text-warn"
        }`}
      >
        <strong>Draft gate (§5.7):</strong> {gate.ranked} ranked player{gate.ranked === 1 ? "" : "s"} (need {RANKED_FLOOR}) —{" "}
        {gate.ok ? "the draft may start." : "the draft cannot start yet."}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Latest pull"
          action={
            <form action={refreshRankingsAction}>
              <button type="submit" className="rounded border border-border px-2 py-1 text-xs hover:border-accent hover:text-accent">
                Refresh now
              </button>
            </form>
          }
        >
          <p className="mb-3 text-sm">
            Fetched: <strong>{fetchedAt ? formatEt(fetchedAt) : "never"}</strong>
          </p>
          {counts.length === 0 ? (
            <Empty>No rankings stored. Book the ingest.rankings job.</Empty>
          ) : (
            <Table head={["Set", "Week", "Players", "With a rank", "Last fetched"]}>
              {counts.map((c) => (
                <Row key={`${c.set}-${c.week}`}>
                  <Cell>{c.set}</Cell>
                  <Cell align="right">{c.week}</Cell>
                  <Cell align="right">{c.total}</Cell>
                  <Cell align="right">
                    {c.set === "draft" && c.ranked < RANKED_FLOOR ? <Badge tone="warn">{c.ranked}</Badge> : c.ranked}
                  </Cell>
                  <Cell>{c.fetchedAt ? formatEt(new Date(c.fetchedAt)) : "—"}</Cell>
                </Row>
              ))}
            </Table>
          )}

          <h3 className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Rows returned per call</h3>
          {Object.keys(sourceCounts).length === 0 ? (
            <Empty>The last run recorded no per-call counts.</Empty>
          ) : (
            <Table head={["Call", "Rows"]}>
              {Object.entries(sourceCounts).map(([call, n]) => (
                <Row key={call}>
                  <Cell>
                    <span className="font-mono text-xs">{call}</span>
                  </Cell>
                  <Cell align="right">{n}</Cell>
                </Row>
              ))}
            </Table>
          )}
          <p className="mt-3 text-xs text-muted">
            Sleeper&rsquo;s feed is unauthenticated and returns the full board in one call, so there is no quota to run out of and no
            player-id mapping to resolve — its ids are already ours. If the count falls short of {RANKED_FLOOR}, the feed changed shape
            upstream and the health page will carry the error.
          </p>
        </Card>

        <Card title="Top of the board">
          {preview.length === 0 ? (
            <Empty>No draft rankings stored yet.</Empty>
          ) : (
            <Table head={["#", "Player", "Pos", "Tier", "ADP"]}>
              {preview.map((p) => (
                <Row key={`${p.rank}-${p.name}`}>
                  <Cell align="right">{p.rank}</Cell>
                  <Cell>
                    {p.name} <span className="text-muted">{p.team ?? "FA"}</span>
                  </Cell>
                  <Cell>{p.posRank ?? p.position ?? "—"}</Cell>
                  <Cell align="right">{p.tier ?? "—"}</Cell>
                  <Cell align="right">{p.adp ?? "—"}</Cell>
                </Row>
              ))}
            </Table>
          )}
          <p className="mt-3 text-xs text-muted">
            Rank and position rank come from ADP order. Tier is a cliff in projected points within a position, so a player with no
            projection has none rather than an invented one.
          </p>
        </Card>
      </div>
    </>
  );
}
