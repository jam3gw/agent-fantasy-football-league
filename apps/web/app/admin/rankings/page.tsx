import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { formatEt } from "@league/shared";
import { players, rankings, rankingsUnmatched } from "@league/engine";
import { Badge, Card, Cell, Empty, PageTitle, Row, Table } from "../../../components/ui";
import { db } from "../../../lib/db";
import { draftGateStatus, mapUnmatchedPlayerAction, refreshRankingsAction } from "../../../lib/adminActions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Rankings" };

/** §5.7: the draft cannot start below this many ranked players. */
const RANKED_FLOOR = 200;
const MAX_UNMATCHED_SHOWN = 50;
const MAX_CANDIDATES = 60;

export default async function AdminRankingsPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string }>;
}) {
  const { msg } = await searchParams;
  const database = db();

  const [latest, counts, unmatched, gate] = await Promise.all([
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
      .select()
      .from(rankingsUnmatched)
      .where(isNull(rankingsUnmatched.resolvedPlayerId))
      .orderBy(rankingsUnmatched.id)
      .limit(MAX_UNMATCHED_SHOWN)
      .catch(() => []),
    draftGateStatus().catch(() => ({ ranked: 0, unmatchedTop200: 0, ok: false })),
  ]);

  const sourceCounts = (latest[0]?.sourceCounts ?? {}) as Record<string, number>;
  const fetchedAt = latest[0]?.fetchedAt ?? null;

  // Mapping candidates: same fantasy position, preferring the same NFL team.
  const positions = [...new Set(unmatched.map((u) => (u.fpPosition ?? "").toUpperCase()).filter(Boolean))];
  const candidatePool =
    positions.length > 0
      ? await database
          .select({
            playerId: players.playerId,
            fullName: players.fullName,
            position: players.position,
            nflTeam: players.nflTeam,
          })
          .from(players)
          .where(and(eq(players.active, true), inArray(players.position, positions)))
          .catch(() => [])
      : [];

  return (
    <>
      <PageTitle
        title="Rankings"
        subtitle="The engine pulls the draft board from FantasyPros. Nothing is uploaded here; the only controls are a mapping and a refresh."
      />
      {msg ? <p className="mb-4 rounded-lg border border-accent/50 bg-accent-soft px-4 py-3 text-sm text-accent">{msg}</p> : null}

      <div
        className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
          gate.ok ? "border-accent/50 bg-accent-soft text-accent" : "border-warn/50 text-warn"
        }`}
      >
        <strong>Draft gate (§5.7):</strong> {gate.ranked} ranked player{gate.ranked === 1 ? "" : "s"} (need {RANKED_FLOOR}) ·{" "}
        {gate.unmatchedTop200} unmatched inside the top 200 (need 0) —{" "}
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
            <Empty>No rankings stored. Book the ingest.fp_rankings job.</Empty>
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
            The free tier truncates responses. If it cannot reach {RANKED_FLOOR} ranked players, the only options are a paid FantasyPros
            plan or lowering the threshold in settings (§5.7).
          </p>
        </Card>

        <Card title={`Unmatched FantasyPros players — ${unmatched.length}${unmatched.length === MAX_UNMATCHED_SHOWN ? "+" : ""}`}>
          {unmatched.length === 0 ? (
            <Empty>Every ranked FantasyPros player maps to a Sleeper player.</Empty>
          ) : (
            <div className="space-y-3">
              {unmatched.map((u) => {
                const pos = (u.fpPosition ?? "").toUpperCase();
                const team = (u.fpTeam ?? "").toUpperCase();
                const samePos = candidatePool.filter((p) => (p.position ?? "").toUpperCase() === pos);
                const sameTeam = samePos.filter((p) => (p.nflTeam ?? "").toUpperCase() === team);
                const candidates = (sameTeam.length > 0 ? sameTeam : samePos).slice(0, MAX_CANDIDATES);
                const ecr = rankOf(u.raw);
                return (
                  <form key={u.id} action={mapUnmatchedPlayerAction} className="rounded border border-border p-3 text-sm">
                    <input type="hidden" name="unmatchedId" value={u.id} />
                    <div className="mb-2 flex flex-wrap items-baseline gap-2">
                      <span className="font-medium">{u.fpName}</span>
                      <span className="text-xs text-muted">
                        {pos || "?"} · {team || "?"} · fp id {u.fpPlayerId}
                      </span>
                      {ecr !== null ? (
                        <Badge tone={ecr <= 200 ? "danger" : "neutral"}>ECR {ecr}</Badge>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="block">
                        <span className="mb-1 block text-xs text-muted">
                          Sleeper player {sameTeam.length > 0 ? `(${team} ${pos})` : `(${pos || "any"})`}
                        </span>
                        <select name="playerId" className="w-64 rounded border border-border bg-background px-2 py-1 text-sm">
                          <option value="">— pick a player —</option>
                          {candidates.map((p) => (
                            <option key={p.playerId} value={p.playerId}>
                              {p.fullName} ({p.nflTeam ?? "FA"}) · {p.playerId}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs text-muted">or a player id</span>
                        <input
                          name="customPlayerId"
                          className="w-40 rounded border border-border bg-background px-2 py-1 font-mono text-xs"
                          placeholder="4034"
                        />
                      </label>
                      <button type="submit" className="rounded border border-border px-2 py-1 text-xs hover:border-accent hover:text-accent">
                        Map
                      </button>
                    </div>
                  </form>
                );
              })}
            </div>
          )}
          <p className="mt-3 text-xs text-muted">
            Mapping writes <span className="font-mono">fp_player_map</span> (matched_by <span className="font-mono">manual</span>) and
            marks the unmatched row resolved. Refresh the pull afterwards so the board picks the player up.
          </p>
        </Card>
      </div>
    </>
  );
}

/** The FantasyPros ECR carried on an unmatched row, when it parses as a number. */
function rankOf(raw: Record<string, unknown> | null): number | null {
  const v = raw?.rank_ecr ?? raw?.rank;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
