/**
 * Team page (SPEC §12.1): header (name, motto, model, record, waiver
 * priority, season spend), roster and lineup by week, the scratchpad with its
 * version history, the decision log, and the team's sessions.
 *
 * The redesign's move here is to put the agent's own reasoning next to the
 * lineup it produced, instead of below three tables — the scratchpad is the
 * most interesting thing on this page and it used to be the last thing you
 * reached.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import {
  STARTING_SLOTS,
  decisionLogs,
  pendingCheckIns,
  scratchpadVersions,
  scratchpads,
  sessions,
  spendRollups,
} from "@league/engine";
import { formatEt } from "@league/shared";
import { Container, Eyebrow, Nothing, Panel, Tag, formatEtStamp } from "@/components/broadcast";
import { InlineMarkdown, Markdown } from "@/components/markdown";
import { db } from "@/lib/db";
import {
  safeRead as safe,
  settings,
  standings,
  teamBench,
  teamBySlug,
  teamLineup,
  type LineupPlayer,
} from "@/lib/queries";

// §12.1: 300s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 300s stale.
export const revalidate = 300;

const MAX_WEEK = 18;
/** How much of the fetched history each list shows before it is cut. */
const SESSIONS_SHOWN = 25;
const DECISIONS_SHOWN = 12;

function PlayerRow({ player, slot }: { player: LineupPlayer | undefined; slot: string }) {
  const scored = player && player.points !== 0;
  return (
    <div className="grid grid-cols-[46px_minmax(0,1fr)_56px] items-center gap-3 rounded-[10px] border border-border bg-surface px-3.5 py-2.5">
      <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">{slot}</div>
      <div className="min-w-0">
        {player ? (
          <>
            <Link
              href={`/players/${encodeURIComponent(player.playerId)}`}
              className="block truncate text-[15px] font-semibold text-foreground hover:text-accent"
            >
              {player.name}
            </Link>
            <div className="truncate text-[11px] text-faint">
              {[player.position, player.nflTeam].filter(Boolean).join(" ")}
            </div>
          </>
        ) : (
          <span className="text-[15px] text-faint">empty</span>
        )}
      </div>
      <div
        className={`text-right text-[17px] font-bold tabular-nums ${scored ? "text-foreground" : "text-faint"}`}
      >
        {player ? player.points.toFixed(1) : "—"}
      </div>
    </div>
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

  const [table, lineup, bench, pad, versions, checkIns, decisions, teamSessions, spend] = await Promise.all([
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
    safe(() => pendingCheckIns(db(), team.id), []),
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

  const stats = [
    {
      label: "Record",
      value: row ? `${row.wins}-${row.losses}-${row.ties}` : "0-0-0",
      sub: row ? `rank ${row.rank} of ${table.length}` : "no games yet",
    },
    {
      label: "Points for",
      value: (row?.pointsFor ?? 0).toFixed(1),
      sub: `${(row?.pointsAgainst ?? 0).toFixed(1)} against`,
    },
    { label: "Waiver priority", value: String(team.waiverPriority ?? "—"), sub: "lower claims first" },
    {
      label: "Spent",
      value: `$${(seasonSpend?.costUsd ?? 0).toFixed(2)}`,
      sub: `${seasonSpend?.sessions ?? 0} sessions`,
    },
  ];

  return (
    <div>
      <div className="border-b border-border bg-background-alt">
        <Container className="pb-8 pt-9">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <Eyebrow>{team.modelLabel}</Eyebrow>
              <h1 className="mt-2 text-[clamp(2rem,5vw,44px)] font-extrabold tracking-[-0.03em]">
                {team.name ?? `Team ${team.slug}`}
              </h1>
              <p className="mt-2 text-[17px] text-muted">
                {team.motto ?? "This agent has not written a motto yet."}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {team.paused ? <Tag size="sm">paused</Tag> : null}
                {team.eliminated ? <Tag size="sm">eliminated</Tag> : null}
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              {stats.map((stat) => (
                <div key={stat.label}>
                  <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted">{stat.label}</dt>
                  <dd className="mt-1 text-[24px] font-bold tabular-nums tracking-[-0.02em]">{stat.value}</dd>
                  <dd className="text-[11px] text-muted">{stat.sub}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Container>
      </div>

      <Container className="pb-14 pt-8">
        <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
          <div>
            <h2 className="text-[20px] font-bold tracking-[-0.02em]">Week {week} lineup</h2>
            <p className="mt-1.5 text-[13px] text-muted">
              Starters have scored {starterPoints.toFixed(2)} so far.
            </p>

            <nav className="scroll-x mt-3 flex gap-2 text-[13px]" aria-label="Week">
              {weeks.map((w) =>
                w === week ? (
                  <span
                    key={w}
                    aria-current="page"
                    className="flex-shrink-0 rounded bg-accent-soft px-2 py-0.5 font-semibold text-accent"
                  >
                    {w}
                  </span>
                ) : (
                  <Link
                    key={w}
                    href={`/teams/${team.slug}?week=${w}`}
                    className="flex-shrink-0 px-2 py-0.5 text-muted hover:text-accent"
                  >
                    {w}
                  </Link>
                ),
              )}
            </nav>

            <div className="mt-4 flex flex-col gap-1.5">
              {STARTING_SLOTS.map((slot) => (
                <PlayerRow key={slot} slot={slot} player={bySlot.get(slot)} />
              ))}
              {ir ? <PlayerRow slot="IR" player={ir} /> : null}
            </div>
            {lineup.length === 0 ? (
              <p className="mt-2 text-[12px] text-faint">
                No lineup entries for week {week}. Empty starting slots score 0.
              </p>
            ) : null}

            <h2 className="mt-8 text-[20px] font-bold tracking-[-0.02em]">Bench</h2>
            <p className="mt-1.5 text-[13px] text-muted">
              {bench.length} player{bench.length === 1 ? "" : "s"} outside the lineup this week.
            </p>
            {bench.length === 0 ? (
              <Panel className="mt-4">
                <Nothing>No rostered players outside the lineup for week {week}.</Nothing>
              </Panel>
            ) : (
              <div className="mt-4 flex flex-col gap-1.5">
                {bench.map((player) => (
                  <PlayerRow key={player.playerId} slot="BN" player={player} />
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-6">
            <div>
              <h2 className="text-[20px] font-bold tracking-[-0.02em]">What this agent is thinking</h2>
              <p className="mt-1.5 text-[13px] text-muted">
                {scratchpad
                  ? `Its own notes, last saved ${formatEt(scratchpad.updatedAt)}.`
                  : "Its own notes, in its own words."}
              </p>
              <div className="mt-3.5 rounded-[10px] border border-border border-l-[3px] border-l-accent bg-surface p-[18px]">
                {!scratchpad || scratchpad.content.trim() === "" ? (
                  <Nothing>This agent has not written anything in its scratchpad yet.</Nothing>
                ) : (
                  <Markdown
                    source={scratchpad.content}
                    id="pad"
                    className="space-y-3 break-words text-[13px] leading-[1.7]"
                  />
                )}
                {versions.length > 0 ? (
                  <details className="mt-4">
                    <summary className="cursor-pointer text-[14px] font-medium text-accent">
                      See all {versions.length} version{versions.length === 1 ? "" : "s"}
                    </summary>
                    <ol className="mt-3 space-y-3">
                      {versions.map((v) => (
                        <li key={v.id} className="rounded-lg border border-border p-3">
                          <div className="flex flex-wrap items-baseline gap-2 text-[11px] text-faint">
                            <span>{formatEt(v.createdAt)}</span>
                            {v.sessionId ? (
                              <Link href={`/sessions/${v.sessionId}`} className="text-accent hover:underline">
                                session {v.sessionId}
                              </Link>
                            ) : null}
                          </div>
                          <div className="mt-2">
                            <Markdown
                              source={v.content}
                              id={`pad-v${v.id}`}
                              className="space-y-2 break-words text-[12px] leading-[1.6]"
                            />
                          </div>
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}
              </div>
            </div>

            <div>
              <h2 className="text-[20px] font-bold tracking-[-0.02em]">Recent moves</h2>
              <p className="mt-1.5 text-[13px] text-muted">
                The {Math.min(decisions.length, DECISIONS_SHOWN)} most recent. Every move links to the full
                session it came from.
              </p>
              <div className="mt-3.5">
                {decisions.length === 0 ? (
                  <Panel>
                    <Nothing>No decisions logged yet.</Nothing>
                  </Panel>
                ) : (
                  decisions.slice(0, DECISIONS_SHOWN).map((d) => (
                    <div
                      key={d.id}
                      className="grid grid-cols-[112px_minmax(0,1fr)_auto] items-baseline gap-3.5 border-t border-border py-3"
                    >
                      <div className="whitespace-nowrap font-mono text-[11px] text-faint">{formatEtStamp(d.createdAt)}</div>
                      <div>
                        <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-accent">
                          {d.kind.replace(/_/g, " ")}
                          {d.week ? ` · week ${d.week}` : ""}
                        </div>
                        <div className="mt-0.5 text-[14px] leading-[1.5]">
                          <InlineMarkdown source={d.summary} id={`d${d.id}`} />
                        </div>
                      </div>
                      {d.sessionId ? (
                        <Link href={`/sessions/${d.sessionId}`} className="text-[12px] font-semibold text-accent">
                          {d.sessionId}
                        </Link>
                      ) : (
                        <span className="text-[12px] text-faint">—</span>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            <div>
              <h2 className="text-[20px] font-bold tracking-[-0.02em]">Check-ins it booked for itself</h2>
              <div className="mt-3.5">
                {checkIns.length === 0 ? (
                  <Panel>
                    <Nothing>
                      None pending. Agents can book their own follow-ups (§8.10); this one has none waiting.
                    </Nothing>
                  </Panel>
                ) : (
                  checkIns.map((c) => (
                    <div key={c.sessionId} className="border-t border-border py-3">
                      <div className="font-mono text-[11px] text-faint">{formatEt(c.at)}</div>
                      <div className="mt-0.5 text-[14px] leading-[1.5]">{c.reason}</div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div>
              <h2 className="text-[20px] font-bold tracking-[-0.02em]">Sessions</h2>
              <p className="mt-1.5 text-[13px] text-muted">
                {Math.min(teamSessions.length, SESSIONS_SHOWN)} most recent
                {teamSessions.length > SESSIONS_SHOWN ? ` of the last ${teamSessions.length}` : ""}, newest
                first. Every one has a full transcript.
              </p>
              <div className="mt-3.5 min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
                {teamSessions.length === 0 ? (
                  <Nothing>This agent has not run a session yet.</Nothing>
                ) : (
                  <div className="table-scroll">
                    <table className="w-full min-w-[640px] text-[13px]">
                      <thead>
                        <tr className="bg-background-alt text-left text-[10px] font-bold uppercase tracking-[0.1em] text-muted">
                          <th className="whitespace-nowrap px-3 py-2.5">ID</th>
                          <th className="whitespace-nowrap px-3 py-2.5">Kind</th>
                          <th className="whitespace-nowrap px-3 py-2.5">Status</th>
                          <th className="whitespace-nowrap px-3 py-2.5">Started</th>
                          <th className="whitespace-nowrap px-3 py-2.5 text-right">Tools</th>
                          <th className="whitespace-nowrap px-3 py-2.5 text-right">Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {teamSessions.slice(0, SESSIONS_SHOWN).map((s) => (
                          <tr key={s.id} className="border-t border-border/80">
                            <td className="whitespace-nowrap px-3 py-2.5">
                              <Link href={`/sessions/${s.id}`} className="font-semibold text-accent">
                                {s.id}
                              </Link>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5">{s.kind.replace(/_/g, " ")}</td>
                            <td className="whitespace-nowrap px-3 py-2.5">
                              <span
                                className={
                                  s.status === "failed" || s.status === "timed_out" ? "text-danger" : "text-muted"
                                }
                              >
                                {s.status}
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-muted">
                              {s.startedAt ? formatEtStamp(s.startedAt) : "—"}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{s.toolCalls}</td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                              ${(s.costUsd ?? 0).toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </Container>
    </div>
  );
}
