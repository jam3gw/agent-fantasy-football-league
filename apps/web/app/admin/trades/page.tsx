import { desc, eq, inArray } from "drizzle-orm";
import { formatEt } from "@league/shared";
import { players, teams, trades } from "@league/engine";
import { Badge, Card, Cell, Empty, PageTitle, Row, Table } from "../../../components/ui";
import { db } from "../../../lib/db";
import { reverseTradeAction } from "../../../lib/adminActions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Trades" };

export default async function AdminTradesPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string }>;
}) {
  const { msg } = await searchParams;
  const database = db();

  const executed = await database
    .select()
    .from(trades)
    .where(eq(trades.status, "executed"))
    .orderBy(desc(trades.resolvedAt))
    .limit(50)
    .catch(() => []);
  const reversed = await database
    .select()
    .from(trades)
    .where(eq(trades.status, "cancelled"))
    .orderBy(desc(trades.resolvedAt))
    .limit(20)
    .catch(() => []);
  const allTeams = await database.select().from(teams).catch(() => []);

  const ids = [...new Set([...executed, ...reversed].flatMap((t) => [...t.givePlayerIds, ...t.getPlayerIds]))];
  const names =
    ids.length > 0
      ? await database
          .select({ playerId: players.playerId, name: players.fullName })
          .from(players)
          .where(inArray(players.playerId, ids))
          .catch(() => [])
      : [];
  const nameOf = new Map(names.map((n) => [n.playerId, n.name]));
  const teamName = (id: number) => allTeams.find((t) => t.id === id)?.name ?? `Team ${id}`;
  const list = (playerIds: string[]) => playerIds.map((p) => nameOf.get(p) ?? p).join(", ") || "—";

  return (
    <>
      <PageTitle
        title="Trades"
        subtitle="Reversal exists for one reason: an engine bug moved players it should not have. It is not a veto and not a do-over."
      />
      {msg ? <p className="mb-4 rounded-lg border border-accent/50 bg-accent-soft px-4 py-3 text-sm text-accent">{msg}</p> : null}

      <Card title={`Executed trades — ${executed.length}`}>
        {executed.length === 0 ? (
          <Empty>No executed trades.</Empty>
        ) : (
          <Table head={["#", "Executed", "Proposer sent", "Counterparty sent", "Reverse (bug only)"]}>
            {executed.map((t) => (
              <Row key={t.id}>
                <Cell>{t.id}</Cell>
                <Cell>{t.resolvedAt ? formatEt(t.resolvedAt) : "—"}</Cell>
                <Cell>
                  <div className="font-medium">{teamName(t.proposerTeamId)}</div>
                  <div className="text-xs text-muted">{list(t.givePlayerIds)}</div>
                </Cell>
                <Cell>
                  <div className="font-medium">{teamName(t.counterpartyTeamId)}</div>
                  <div className="text-xs text-muted">{list(t.getPlayerIds)}</div>
                </Cell>
                <Cell>
                  <form action={reverseTradeAction} className="flex flex-col gap-1.5">
                    <input type="hidden" name="tradeId" value={t.id} />
                    <input
                      name="reason"
                      required
                      minLength={3}
                      placeholder="Which bug? (required, public)"
                      className="w-56 rounded border border-border bg-background px-2 py-1 text-xs"
                    />
                    <button
                      type="submit"
                      className="self-start rounded border border-border px-2 py-1 text-xs hover:border-danger hover:text-danger"
                    >
                      Reverse trade {t.id}
                    </button>
                  </form>
                </Cell>
              </Row>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-muted">
          Reversing returns every player to the team that held them before the trade, clears their lineup entries for the current and
          next week (they land on the bench, §7.8), and records a public commissioner transaction.
        </p>
      </Card>

      <div className="mt-4">
        <Card title={`Reversed and cancelled — ${reversed.length}`}>
          {reversed.length === 0 ? (
            <Empty>Nothing has been reversed.</Empty>
          ) : (
            <Table head={["#", "When", "Teams", "Reason"]}>
              {reversed.map((t) => (
                <Row key={t.id}>
                  <Cell>{t.id}</Cell>
                  <Cell>{t.resolvedAt ? formatEt(t.resolvedAt) : "—"}</Cell>
                  <Cell>
                    {teamName(t.proposerTeamId)} ↔ {teamName(t.counterpartyTeamId)}
                  </Cell>
                  <Cell>
                    <Badge tone="warn">{t.resolutionReason ?? "cancelled"}</Badge>
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
