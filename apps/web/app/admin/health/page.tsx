import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { formatEt, parseDate } from "@league/shared";
import {
  costAlarms,
  costAlarmRules,
  getSettings,
  health,
  nflGames,
  scheduledJobs,
  scoringDiscrepancies,
  sessions,
  teams,
} from "@league/engine";
import { Badge, Card, Cell, Empty, PageTitle, Row, Table, TeamLabel, money } from "../../../components/ui";
import { db, leagueClock } from "../../../lib/db";
import { weekScoringSource } from "../../../lib/finalize";
import { MAX_CONCURRENT_SESSIONS } from "../../../lib/runSession";
import { acknowledgeAlarmAction, fpUsageToday, sendDigestNowAction } from "../../../lib/adminActions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Health" };

const WEEK_MS = 7 * 24 * 3600_000;
/** §13.4: the live feed is "delayed" once Sleeper has been silent for 10 minutes. */
const LIVE_STALE_MS = 10 * 60_000;
/** Rows in the queue card. Comfortably over the cap plus a full booking sweep. */
const SESSION_QUEUE_LIMIT = 60;

export default async function AdminHealthPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string }>;
}) {
  const { msg } = await searchParams;
  const database = db();
  const clock = await leagueClock();
  const now = clock.now();
  const since = new Date(now.getTime() - WEEK_MS);

  const settings = await getSettings(database).catch(() => null);
  const season = settings?.season ?? 0;
  const week = settings?.currentWeek ?? 0;

  const [feeds, allTeams, failed, discrepancies, dueJobs, alarms, rules, liveGames, recentSessions, fp, liveQueue] =
    await Promise.all([
      database.select().from(health).catch(() => []),
      database.select().from(teams).catch(() => []),
      database
        .select()
        .from(sessions)
        .where(and(eq(sessions.status, "failed"), gte(sessions.createdAt, since)))
        .orderBy(desc(sessions.createdAt))
        .catch(() => []),
      database
        .select()
        .from(scoringDiscrepancies)
        .orderBy(desc(scoringDiscrepancies.createdAt))
        .limit(25)
        .catch(() => []),
      database
        .select()
        .from(scheduledJobs)
        .where(eq(scheduledJobs.status, "due"))
        .orderBy(scheduledJobs.dueAt)
        .catch(() => []),
      database.select().from(costAlarms).where(isNull(costAlarms.acknowledgedAt)).orderBy(desc(costAlarms.firedAt)).catch(() => []),
      database.select().from(costAlarmRules).catch(() => []),
      database
        .select()
        .from(nflGames)
        .where(and(eq(nflGames.season, season), eq(nflGames.status, "live")))
        .catch(() => []),
      // Enough history to see a model's recent run of failures (§8.8).
      database.select().from(sessions).orderBy(desc(sessions.createdAt)).limit(400).catch(() => []),
      fpUsageToday().catch(() => ({ day: "—", total: 0, byTeam: {} as Record<string, number> })),
      // The session queue: since sessions are no longer represented by a job
      // row, this is the only place the queue is visible (§9.2). One query for
      // both states, so a session that changes status mid-render cannot appear
      // in two lists (a duplicate React key) or in neither.
      database
        .select()
        .from(sessions)
        .where(inArray(sessions.status, ["queued", "running"]))
        .orderBy(sessions.createdAt)
        .limit(SESSION_QUEUE_LIMIT)
        .catch(() => []),
    ]);

  const teamName = (id: number | null) =>
    id === null ? "Reporter" : (allTeams.find((t) => t.id === id)?.name ?? `Team ${id}`);
  const ruleFor = (id: number) => rules.find((r) => r.id === id);

  const livePoll = feeds.find((f) => f.key === "live.poll");
  const liveStale =
    liveGames.length > 0 &&
    (!livePoll?.lastSuccessAt || now.getTime() - livePoll.lastSuccessAt.getTime() > LIVE_STALE_MS);

  const overdue = dueJobs.filter((j) => j.dueAt.getTime() < now.getTime() - 120_000);

  // §9.2: six at once, one per team. A session whose due time has passed and
  // that is still queued is waiting for a slot — normal for a minute or two,
  // a problem if it persists. One predicate, used for both the count in the
  // title and the badge in the table, so the two cannot disagree.
  const runningSessions = liveQueue.filter((s) => s.status === "running");
  const queuedSessions = liveQueue.filter((s) => s.status === "queued");
  const isWaitingForSlot = (session: { context: Record<string, unknown> }) => {
    const at = parseDate(session.context.due_at);
    return at === null || at.getTime() <= now.getTime();
  };
  const waiting = queuedSessions.filter(isWaitingForSlot);
  const streaks = failureStreaks(recentSessions);
  const brokenModels = streaks.filter((s) => s.streak >= 3);
  const scoringSource = settings ? await weekScoringSource(database, Math.max(1, week - 1)).catch(() => null) : null;

  return (
    <>
      <PageTitle title="Health" subtitle="Feeds, sessions, jobs, quotas and cost alarms. Everything here is read from the database, live." />
      {msg ? <Banner tone="accent">{msg}</Banner> : null}

      {brokenModels.length > 0 ? (
        <Banner tone="danger">
          Provider outage suspected (§8.8): {brokenModels.map((s) => `${s.modelId} — ${s.streak} consecutive failures`).join("; ")}.
        </Banner>
      ) : null}
      {liveStale ? (
        <Banner tone="warn">
          Live scores delayed — {liveGames.length} game(s) live and the Sleeper poll last succeeded{" "}
          {livePoll?.lastSuccessAt ? formatEt(livePoll.lastSuccessAt) : "never"}. Live scoring pauses; there is no live fallback (§13.4).
        </Banner>
      ) : null}
      {alarms.length > 0 ? (
        <Banner tone="warn">
          {alarms.length} unacknowledged cost alarm{alarms.length === 1 ? "" : "s"}. An alarm notifies; it never stops a session.
        </Banner>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Data sources and last ingests"
          action={
            <form action={sendDigestNowAction}>
              <button type="submit" className="rounded border border-border px-2 py-1 text-xs hover:border-accent hover:text-accent">
                Send digest now
              </button>
            </form>
          }
        >
          {feeds.length === 0 ? (
            <Empty>No health rows yet — nothing has ingested.</Empty>
          ) : (
            <Table head={["Source", "Last success", "Last error"]}>
              {feeds
                .slice()
                .sort((a, b) => a.key.localeCompare(b.key))
                .map((f) => {
                  const ok = f.lastSuccessAt && (!f.lastErrorAt || f.lastErrorAt <= f.lastSuccessAt);
                  return (
                    <Row key={f.key}>
                      <Cell>
                        <span className="font-mono text-xs">{f.key}</span>{" "}
                        <Badge tone={ok ? "accent" : "warn"}>{ok ? "ok" : "check"}</Badge>
                      </Cell>
                      <Cell>{f.lastSuccessAt ? formatEt(f.lastSuccessAt) : "never"}</Cell>
                      <Cell>
                        {f.lastError ? (
                          <span className="text-danger">
                            {f.lastError.slice(0, 160)}
                            {f.lastErrorAt ? ` (${formatEt(f.lastErrorAt)})` : ""}
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </Cell>
                    </Row>
                  );
                })}
            </Table>
          )}
          <p className="mt-3 text-xs text-muted">
            Week {Math.max(1, week - 1)} was scored by <strong>{scoringSource ?? "—"}</strong>. Live games right now: {liveGames.length}.
          </p>
        </Card>

        <Card title="Open cost alarms">
          {alarms.length === 0 ? (
            <Empty>No unacknowledged alarms.</Empty>
          ) : (
            <Table head={["Scope", "Agent", "Amount", "Threshold", "Fired", ""]}>
              {alarms.map((a) => (
                <Row key={a.id}>
                  <Cell>{ruleFor(a.ruleId)?.scope ?? `rule ${a.ruleId}`}</Cell>
                  <Cell>{a.scopeKey === "league" ? "League" : a.scopeKey === "reporter" ? "Reporter" : teamName(Number(a.scopeKey))}</Cell>
                  <Cell align="right">{money(a.amountUsd)}</Cell>
                  <Cell align="right">{money(a.thresholdUsd)}</Cell>
                  <Cell>{formatEt(a.firedAt)}</Cell>
                  <Cell>
                    <form action={acknowledgeAlarmAction}>
                      <input type="hidden" name="alarmId" value={a.id} />
                      <button type="submit" className="rounded border border-border px-2 py-1 text-xs hover:border-accent hover:text-accent">
                        Acknowledge
                      </button>
                    </form>
                  </Cell>
                </Row>
              ))}
            </Table>
          )}
        </Card>

        <Card title={`Failed sessions (last 7 days) — ${failed.length}`}>
          {failed.length === 0 ? (
            <Empty>No failed sessions in the last seven days.</Empty>
          ) : (
            <Table head={["When", "Agent", "Kind", "Model", "Error"]}>
              {failed.slice(0, 30).map((s) => (
                <Row key={s.id}>
                  <Cell>{formatEt(s.createdAt)}</Cell>
                  <Cell>{teamName(s.teamId)}</Cell>
                  <Cell>{s.kind}</Cell>
                  <Cell>
                    <span className="font-mono text-xs">{s.modelId}</span>
                  </Cell>
                  <Cell>
                    <span className="text-danger">{(s.error ?? "").slice(0, 140) || "—"}</span>
                  </Cell>
                </Row>
              ))}
            </Table>
          )}
        </Card>

        <Card title="Model failure streaks">
          {streaks.length === 0 ? (
            <Empty>No sessions yet.</Empty>
          ) : (
            <Table head={["Model", "Consecutive failures", "Last session"]}>
              {streaks.map((s) => (
                <Row key={s.modelId}>
                  <Cell>
                    <span className="font-mono text-xs">{s.modelId}</span>
                  </Cell>
                  <Cell align="right">
                    {s.streak >= 3 ? <Badge tone="danger">{s.streak}</Badge> : s.streak}
                  </Cell>
                  <Cell>{formatEt(s.lastAt)}</Cell>
                </Row>
              ))}
            </Table>
          )}
        </Card>

        <Card
          title={`Sessions — ${runningSessions.length}/${MAX_CONCURRENT_SESSIONS} running, ${queuedSessions.length} queued (${waiting.length} waiting for a slot)`}
        >
          {liveQueue.length === 0 ? (
            <Empty>Nothing queued or running. The tick starts sessions as they come due.</Empty>
          ) : (
            <Table head={["Team", "Kind", "State", "Due", "Deadline"]}>
              {[...runningSessions, ...queuedSessions].map((s) => {
                const due = parseDate(s.context.due_at);
                const deadline = parseDate(s.context.deadline_at);
                return (
                  <Row key={s.id}>
                    <Cell>{teamName(s.teamId)}</Cell>
                    <Cell>
                      <span className="font-mono text-xs">{s.kind}</span>
                    </Cell>
                    <Cell>
                      {s.status === "running" ? (
                        <Badge tone="accent">running</Badge>
                      ) : isWaitingForSlot(s) ? (
                        <Badge tone="warn">waiting for a slot</Badge>
                      ) : (
                        <Badge>queued</Badge>
                      )}
                    </Cell>
                    <Cell>{due ? formatEt(due) : "—"}</Cell>
                    <Cell>{deadline ? formatEt(deadline) : "—"}</Cell>
                  </Row>
                );
              })}
            </Table>
          )}
        </Card>

        <Card title={`Scheduled jobs due — ${dueJobs.length} (${overdue.length} overdue)`}>
          {dueJobs.length === 0 ? (
            <Empty>Nothing due. The tick books the next 48 hours as it goes.</Empty>
          ) : (
            <Table head={["Type", "Due", "State"]}>
              {dueJobs.slice(0, 30).map((j) => (
                <Row key={j.id}>
                  <Cell>
                    <span className="font-mono text-xs">{j.type}</span>
                  </Cell>
                  <Cell>{formatEt(j.dueAt)}</Cell>
                  <Cell>
                    {j.dueAt.getTime() < now.getTime() - 120_000 ? <Badge tone="warn">overdue</Badge> : <Badge>due</Badge>}
                  </Cell>
                </Row>
              ))}
            </Table>
          )}
        </Card>

        <Card title={`FantasyPros requests today (${fp.day}) — ${fp.total}`}>
          <Table head={["Caller", "Requests", "Allowance"]}>
            <Row>
              <Cell>Engine pulls</Cell>
              <Cell align="right">{fp.byTeam.engine ?? 0}</Cell>
              <Cell>exempt from the per-agent allowance (§5.8)</Cell>
            </Row>
            {allTeams.map((t) => (
              <Row key={t.id}>
                <Cell>
                  <TeamLabel slug={t.slug} name={t.name} model={t.modelLabel} />
                </Cell>
                <Cell align="right">{fp.byTeam[String(t.id)] ?? 0}</Cell>
                <Cell>{settings?.fantasyprosDailyAllowance ?? 3} per day</Cell>
              </Row>
            ))}
          </Table>
          <p className="mt-3 text-xs text-muted">A cache hit still counts against an agent&apos;s allowance — the allowance is a league rule, not a cost control.</p>
        </Card>

        <Card title={`Scoring discrepancies — ${discrepancies.length} most recent`}>
          {discrepancies.length === 0 ? (
            <Empty>No discrepancies logged. Sleeper&apos;s pts_ppr and the engine&apos;s scoring agree.</Empty>
          ) : (
            <Table head={["Player", "Week", "pts_ppr", "engine", "diff"]}>
              {discrepancies.map((d) => (
                <Row key={d.id}>
                  <Cell>
                    <span className="font-mono text-xs">{d.playerId}</span>
                  </Cell>
                  <Cell align="right">{d.week}</Cell>
                  <Cell align="right">{d.ptsPpr ?? "—"}</Cell>
                  <Cell align="right">{d.enginePts ?? "—"}</Cell>
                  <Cell align="right">{d.diff ?? "—"}</Cell>
                </Row>
              ))}
            </Table>
          )}
          <p className="mt-3 text-xs text-muted">
            The league always uses Sleeper&apos;s <span className="font-mono">pts_ppr</span>; discrepancies are logged, not applied (§3.2).
          </p>
        </Card>
      </div>
    </>
  );
}

/** Consecutive failures at the head of each model's session history (§8.8). */
function failureStreaks(
  recent: Array<{ modelId: string; status: string; createdAt: Date }>,
): Array<{ modelId: string; streak: number; lastAt: Date }> {
  const byModel = new Map<string, Array<{ status: string; createdAt: Date }>>();
  for (const s of recent) {
    const list = byModel.get(s.modelId) ?? [];
    list.push({ status: s.status, createdAt: s.createdAt });
    byModel.set(s.modelId, list);
  }
  const out: Array<{ modelId: string; streak: number; lastAt: Date }> = [];
  for (const [modelId, list] of byModel) {
    // `recent` arrives newest first, so the head of the list is the newest run.
    let streak = 0;
    for (const s of list) {
      if (s.status === "failed" || s.status === "timed_out") streak++;
      else break;
    }
    out.push({ modelId, streak, lastAt: list[0]!.createdAt });
  }
  return out.sort((a, b) => b.streak - a.streak || a.modelId.localeCompare(b.modelId));
}

function Banner({ children, tone }: { children: React.ReactNode; tone: "accent" | "warn" | "danger" }) {
  const tones = {
    accent: "border-accent/50 bg-accent-soft text-accent",
    warn: "border-warn/50 text-warn",
    danger: "border-danger/50 text-danger",
  } as const;
  return <div className={`mb-4 rounded-lg border px-4 py-3 text-sm ${tones[tone]}`}>{children}</div>;
}
