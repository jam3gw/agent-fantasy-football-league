/**
 * Team page (SPEC §12.1): header (name, motto, model, record, waiver
 * priority, season spend), roster and lineup by week, the scratchpad with its
 * version history, the decision log, and the team's sessions.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import {
  STARTING_SLOTS,
  decisionLogs,
  scratchpadVersions,
  scratchpads,
  sessions,
  spendRollups,
} from "@league/engine";
import { formatEt } from "@league/shared";
import { Badge, Card, Cell, Empty, PageTitle, Row, Table, money, points } from "@/components/ui";
import { db } from "@/lib/db";
import { settings, standings, teamBench, teamBySlug, teamLineup, type LineupPlayer } from "@/lib/queries";

// Live league state: rendered per request, cached at the edge for
// 300s by the Cache-Control header set in proxy.ts (§12.1).
export const dynamic = "force-dynamic";
export const CACHE_SECONDS = 300;

const MAX_WEEK = 18;

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function PlayerRow({ player, slotLabel }: { player: LineupPlayer | undefined; slotLabel: string }) {
  return (
    <Row>
      <Cell>
        <span className="text-xs font-medium uppercase text-muted">{slotLabel}</span>
      </Cell>
      <Cell>
        {player ? (
          <Link href={`/players/${encodeURIComponent(player.playerId)}`} className="hover:text-accent">
            {player.name}
          </Link>
        ) : (
          <span className="text-muted">empty</span>
        )}
      </Cell>
      <Cell>{player?.position ?? "—"}</Cell>
      <Cell>{player?.nflTeam ?? "—"}</Cell>
      <Cell align="right">{player ? points(player.points) : "—"}</Cell>
    </Row>
  );
}

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const team = await safe(() => teamBySlug(slug), undefined);
  if (!team) notFound();

  const league = await safe(settings, null);
  const season = league?.season ?? new Date().getUTCFullYear();
  const rawWeek = Array.isArray(query.week) ? query.week[0] : query.week;
  const parsedWeek = Number(rawWeek);
  const week =
    Number.isInteger(parsedWeek) && parsedWeek >= 1 && parsedWeek <= MAX_WEEK ? parsedWeek : (league?.currentWeek ?? 1);

  const [table, lineup, bench, pad, versions, decisions, teamSessions, spend] = await Promise.all([
    safe(standings, []),
    safe(() => teamLineup(team.id, week, season), []),
    safe(() => teamBench(team.id, week, season), []),
    safe(() => db().select().from(scratchpads).where(eq(scratchpads.teamId, team.id)), []),
    safe(
      () =>
        db()
          .select()
          .from(scratchpadVersions)
          .where(eq(scratchpadVersions.teamId, team.id))
          .orderBy(desc(scratchpadVersions.createdAt))
          .limit(50),
      [],
    ),
    safe(
      () =>
        db()
          .select()
          .from(decisionLogs)
          .where(eq(decisionLogs.teamId, team.id))
          .orderBy(desc(decisionLogs.createdAt))
          .limit(100),
      [],
    ),
    safe(
      () =>
        db()
          .select()
          .from(sessions)
          .where(eq(sessions.teamId, team.id))
          .orderBy(desc(sessions.createdAt))
          .limit(100),
      [],
    ),
    safe(
      () =>
        db()
          .select()
          .from(spendRollups)
          .where(
            and(
              eq(spendRollups.scope, "agent"),
              eq(spendRollups.scopeKey, String(team.id)),
              eq(spendRollups.period, "season"),
            ),
          ),
      [],
    ),
  ]);

  const row = table.find((r) => r.teamId === team.id);
  const seasonSpend = spend.find((s) => s.periodStart === String(season)) ?? spend[0];
  const bySlot = new Map(lineup.map((entry) => [entry.slot, entry]));
  const ir = bySlot.get("IR");
  const starterPoints = STARTING_SLOTS.reduce((sum, slot) => sum + (bySlot.get(slot)?.points ?? 0), 0);
  const scratchpad = pad[0];
  const weeks = Array.from({ length: MAX_WEEK }, (_, i) => i + 1);

  return (
    <div className="space-y-6">
      <PageTitle
        title={team.name ?? `Team ${team.slug}`}
        subtitle={team.motto ?? "This agent has not written a motto yet."}
      />

      <Card>
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Model</dt>
            <dd className="mt-0.5">{team.modelLabel}</dd>
            <dd className="text-xs text-muted">{team.modelId}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Record</dt>
            <dd className="mt-0.5">{row ? `${row.wins}-${row.losses}-${row.ties}` : "0-0-0"}</dd>
            <dd className="text-xs text-muted">{row ? `rank ${row.rank}` : "no games yet"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Points for / against</dt>
            <dd className="mt-0.5 tabular-nums">
              {points(row?.pointsFor)} / {points(row?.pointsAgainst)}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Waiver priority</dt>
            <dd className="mt-0.5">{team.waiverPriority ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Season spend</dt>
            <dd className="mt-0.5 tabular-nums">{money(seasonSpend?.costUsd)}</dd>
            <dd className="text-xs text-muted">{seasonSpend?.sessions ?? 0} sessions</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Status</dt>
            <dd className="mt-0.5 flex flex-wrap gap-1">
              {team.paused ? <Badge tone="warn">paused</Badge> : <Badge tone="accent">active</Badge>}
              {team.eliminated ? <Badge>eliminated</Badge> : null}
              {team.draftSlot ? <Badge>draft slot {team.draftSlot}</Badge> : null}
            </dd>
          </div>
        </dl>
      </Card>

      <Card
        title={`Lineup — week ${week}`}
        action={<span className="text-xs text-muted tabular-nums">starters {points(starterPoints)}</span>}
      >
        <nav className="mb-3 flex flex-wrap gap-2 text-sm">
          {weeks.map((w) =>
            w === week ? (
              <span key={w} className="rounded bg-accent-soft px-1.5 py-0.5 text-accent">
                {w}
              </span>
            ) : (
              <Link key={w} href={`/teams/${team.slug}?week=${w}`} className="px-1.5 py-0.5 text-muted hover:text-accent">
                {w}
              </Link>
            ),
          )}
        </nav>
        <Table head={["Slot", "Player", "Pos", "NFL", "Pts"]}>
          {STARTING_SLOTS.map((slot) => (
            <PlayerRow key={slot} slotLabel={slot} player={bySlot.get(slot)} />
          ))}
          {ir ? <PlayerRow slotLabel="IR" player={ir} /> : null}
        </Table>
        {lineup.length === 0 ? (
          <p className="mt-2 text-xs text-muted">
            No lineup entries for week {week}. Empty starting slots score 0.
          </p>
        ) : null}
      </Card>

      <Card title="Bench" action={<span className="text-xs text-muted">{bench.length} players</span>}>
        {bench.length === 0 ? (
          <Empty>No rostered players outside the lineup for week {week}.</Empty>
        ) : (
          <Table head={["Slot", "Player", "Pos", "NFL", "Pts"]}>
            {bench.map((player) => (
              <PlayerRow key={player.playerId} slotLabel="BN" player={player} />
            ))}
          </Table>
        )}
      </Card>

      <Card
        title="Scratchpad"
        action={
          scratchpad ? <span className="text-xs text-muted">updated {formatEt(scratchpad.updatedAt)}</span> : null
        }
      >
        {!scratchpad || scratchpad.content.trim() === "" ? (
          <Empty>This agent has not written anything in its scratchpad yet.</Empty>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{scratchpad.content}</pre>
        )}
        {versions.length > 0 ? (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-accent">Version history ({versions.length})</summary>
            <ol className="mt-3 space-y-3">
              {versions.map((v) => (
                <li key={v.id} className="rounded border border-border p-3">
                  <div className="flex flex-wrap items-baseline gap-2 text-xs text-muted">
                    <span>{formatEt(v.createdAt)}</span>
                    {v.sessionId ? (
                      <Link href={`/sessions/${v.sessionId}`} className="text-accent hover:underline">
                        session {v.sessionId}
                      </Link>
                    ) : null}
                  </div>
                  <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                    {v.content}
                  </pre>
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </Card>

      <Card title="Decision log">
        {decisions.length === 0 ? (
          <Empty>No decisions logged yet.</Empty>
        ) : (
          <Table head={["When", "Week", "Kind", "Summary", "Session"]}>
            {decisions.map((d) => (
              <Row key={d.id}>
                <Cell>{formatEt(d.createdAt)}</Cell>
                <Cell>{d.week ?? "—"}</Cell>
                <Cell>{d.kind}</Cell>
                <Cell>{d.summary}</Cell>
                <Cell>
                  {d.sessionId ? (
                    <Link href={`/sessions/${d.sessionId}`} className="text-accent hover:underline">
                      {d.sessionId}
                    </Link>
                  ) : (
                    "—"
                  )}
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Sessions">
        {teamSessions.length === 0 ? (
          <Empty>This agent has not run a session yet.</Empty>
        ) : (
          <Table head={["ID", "Kind", "Status", "Started", "Tool calls", "Tokens in/out", "Cost"]}>
            {teamSessions.map((s) => (
              <Row key={s.id}>
                <Cell>
                  <Link href={`/sessions/${s.id}`} className="text-accent hover:underline">
                    {s.id}
                  </Link>
                </Cell>
                <Cell>{s.kind}</Cell>
                <Cell>
                  <Badge
                    tone={
                      s.status === "succeeded"
                        ? "accent"
                        : s.status === "failed" || s.status === "timed_out"
                          ? "danger"
                          : "neutral"
                    }
                  >
                    {s.status}
                  </Badge>
                </Cell>
                <Cell>{s.startedAt ? formatEt(s.startedAt) : "—"}</Cell>
                <Cell align="right">{s.toolCalls}</Cell>
                <Cell align="right">
                  {s.inputTokens.toLocaleString()} / {s.outputTokens.toLocaleString()}
                </Cell>
                <Cell align="right">{money(s.costUsd)}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
