/**
 * Team page (SPEC §12.1): header (name, motto, model, record, waiver
 * priority, season spend), roster and lineup by week, the scratchpad with its
 * version history, the decision log, and the team's sessions.
 *
 * The redesign's move here is to put the agent's own reasoning next to the
 * lineup it produced, instead of below three tables — the scratchpad is the
 * most interesting thing on this page and it used to be the last thing you
 * reached.
 *
 * Two routes render this: `/teams/[slug]` for the current week and
 * `/teams/[slug]/week/[week]` for a chosen one. The week used to be a query
 * string, and a page that reads its query string is rendered per request,
 * which kept §12.1's freshness window from ever reaching the CDN.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, count, desc, eq, inArray, ne } from "drizzle-orm";
import {
  STARTING_SLOTS,
  decisionLogs,
  pendingCheckIns,
  playerWeekProj,
  scratchpadVersions,
  scratchpads,
  sessions,
  spendRollups,
} from "@league/engine";
import { formatEt } from "@league/shared";
import { modelTierNote } from "@league/agent";
import { CardLink, Container, Nothing, Tag, formatEtStamp } from "@/components/broadcast";
import { InlineMarkdown, Markdown } from "@/components/markdown";
import { SessionRows } from "@/components/session-rows";
import { ActivityTabs, Clamp, NotesCard } from "@/components/team-page";
import { kindLabel } from "@/lib/sessionsFilter";
import { flattenMarkdown } from "@/lib/broadcastLogic";
import { db } from "@/lib/db";
import {
  safeRead as safe,
  settings,
  standings,
  teamBench,
  teamBySlug,
  teamLineup,
  teamSessions as sessionsOf,
  type LineupPlayer,
} from "@/lib/queries";

/** How much of the fetched history each list shows before it is cut. */
const SESSIONS_SHOWN = 25;
const DECISIONS_SHOWN = 12;

/** A move's summary longer than this gets a "More" under its first lines. */
const LONG_MOVE_CHARS = 220;
/** Under this, the notes show in full; over it, they open on request. */
const LONG_NOTES_CHARS = 900;

/** "1st", "2nd", "3rd", "12th". */
function ordinal(n: number): string {
  const rem100 = n % 100;
  const suffix = rem100 >= 11 && rem100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

/**
 * One row of the lineup or the bench: slot, player with position and team,
 * the week's projection, and the points scored — faint until there are any.
 */
function RosterRow({
  player,
  slot,
  projection,
}: {
  player: LineupPlayer | undefined;
  slot: string;
  projection?: number | null;
}) {
  const scored = player && player.points !== 0;
  return (
    <div className="grid grid-cols-[44px_minmax(0,1fr)_auto_auto] items-center gap-x-3 border-t border-border/80 px-4 py-2.5 first:border-t-0">
      <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-faint">{slot}</div>
      <div className="flex min-w-0 flex-col gap-px">
        {player ? (
          <>
            <Link
              href={`/players/${encodeURIComponent(player.playerId)}`}
              className="truncate text-[15px] font-semibold text-foreground hover:text-accent"
            >
              {player.name}
            </Link>
            <span className="truncate text-[11px] text-faint">
              {[player.position, player.nflTeam].filter(Boolean).join(" ") || "\u00a0"}
            </span>
          </>
        ) : (
          <span className="text-[15px] text-faint">empty</span>
        )}
      </div>
      <span className="text-[12px] tabular-nums text-faint">{projection != null ? `proj ${projection.toFixed(1)}` : ""}</span>
      <span className={`min-w-[40px] text-right text-[17px] font-bold tabular-nums ${scored ? "text-foreground" : "text-faint"}`}>
        {player ? player.points.toFixed(1) : "—"}
      </span>
    </div>
  );
}

export const MAX_WEEK = 18;

/** `/teams/[slug]/week/[week]`, or the team page itself when the week is the current one. */
export function teamWeekHref(slug: string, week: number, currentWeek: number): string {
  return week === currentWeek ? `/teams/${slug}` : `/teams/${slug}/week/${week}`;
}

/**
 * The week's projections for every rostered player on the page. A week the
 * feed has not projected yet returns no rows, and the page then says nothing
 * rather than projecting zeros.
 */
async function projectionsFor(playerIds: string[], week: number, season: number) {
  if (playerIds.length === 0) return [];
  return db()
    .select({ playerId: playerWeekProj.playerId, proj: playerWeekProj.projPtsPpr })
    .from(playerWeekProj)
    .where(
      and(eq(playerWeekProj.season, season), eq(playerWeekProj.week, week), inArray(playerWeekProj.playerId, playerIds)),
    );
}

export async function Team({ slug, week: chosenWeek }: { slug: string; week?: number }) {
  const [team, league] = await Promise.all([safe(() => teamBySlug(slug), undefined), safe(settings, null)]);
  if (!team) notFound();

  const season = league?.season ?? new Date().getUTCFullYear();
  const currentWeek = league?.currentWeek ?? 1;
  const week = chosenWeek ?? currentWeek;

  // Everything below depends only on the team and the week, so it all goes
  // out at once; the projections wait for the roster they are looked up by.
  const roster = Promise.all([
    safe(() => teamLineup(team.id, week, season), []),
    safe(() => teamBench(team.id, week, season), []),
  ]);
  const [[lineup, bench], projections, table, pad, versions, checkIns, decisions, teamSessions, spend, totals] =
    await Promise.all([
      roster,
      roster.then(([lineup, bench]) =>
        safe(() => projectionsFor([...new Set([...lineup, ...bench].map((p) => p.playerId))], week, season), []),
      ),
      safe(standings, []),
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
      safe(() => sessionsOf(team, 100), []),
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
      // The Activity tabs show how many there are in all, not how many the
      // page fetched: the lists above are capped and a season runs past them.
      safe(
        async () => ({
          moves: (await db().select({ n: count() }).from(decisionLogs).where(eq(decisionLogs.teamId, team.id)))[0]?.n ?? 0,
          sessions:
            (
              await db()
                .select({ n: count() })
                .from(sessions)
                .where(and(eq(sessions.teamId, team.id), ne(sessions.status, "queued")))
            )[0]?.n ?? 0,
        }),
        null,
      ),
    ]);
  const counts = totals ?? { moves: decisions.length, sessions: teamSessions.length };

  const row = table.find((r) => r.teamId === team.id);
  const seasonSpend = spend.find((s) => s.periodStart === String(season)) ?? spend[0];
  const bySlot = new Map(lineup.map((entry) => [entry.slot, entry]));
  const ir = bySlot.get("IR");
  const starterPoints = STARTING_SLOTS.reduce((sum, slot) => sum + (bySlot.get(slot)?.points ?? 0), 0);

  const projOf = new Map(projections.map((p) => [p.playerId, p.proj]));
  const starterProjected =
    projections.length === 0
      ? null
      : STARTING_SLOTS.reduce((sum, slot) => {
          const entry = bySlot.get(slot);
          return sum + (entry ? (projOf.get(entry.playerId) ?? 0) : 0);
        }, 0);
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

  const tierNote = modelTierNote(team.modelId);
  const notes = scratchpad?.content.trim() ?? "";
  const moves = decisions.slice(0, DECISIONS_SHOWN);
  const shownSessions = teamSessions.slice(0, SESSIONS_SHOWN);

  const versionList =
    versions.length > 0 ? (
      <ol className="space-y-3">
        {versions.map((v) => (
          <li key={v.id} className="rounded-xl border border-border bg-surface p-4">
            <div className="flex flex-wrap items-baseline gap-2 text-[11px] text-faint">
              <span>{formatEt(v.createdAt)}</span>
              {v.sessionId ? (
                <Link href={`/sessions/${v.sessionId}`} className="text-accent hover:underline">
                  session {v.sessionId}
                </Link>
              ) : null}
            </div>
            <div className="mt-2">
              <Markdown source={v.content} id={`pad-v${v.id}`} className="space-y-2 break-words text-[12px] leading-[1.6]" />
            </div>
          </li>
        ))}
      </ol>
    ) : null;

  const movesPanel =
    moves.length === 0 ? (
      <div className="rounded-xl border border-border bg-surface">
        <Nothing>No decisions logged yet.</Nothing>
      </div>
    ) : (
      <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
        {moves.map((d) => {
          const text = flattenMarkdown(d.summary) || "(nothing outside a code block)";
          return (
            <div
              key={d.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 border-t border-border/80 px-[18px] py-3.5 first:border-t-0 sm:grid-cols-[110px_minmax(0,1fr)_auto]"
            >
              <span className="col-span-2 whitespace-nowrap font-mono text-[11px] text-faint sm:col-span-1 sm:pt-[3px]">
                {formatEtStamp(d.createdAt)}
              </span>
              <div className="min-w-0">
                <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-accent">
                  {kindLabel(d.kind)}
                  {d.week ? ` · week ${d.week}` : ""}
                </div>
                <div className="mt-1 text-[14px] leading-[1.55] text-pretty">
                  <Clamp long={text.length > LONG_MOVE_CHARS}>
                    <InlineMarkdown source={text} id={`d${d.id}`} />
                  </Clamp>
                </div>
              </div>
              {d.sessionId ? (
                <Link
                  href={`/sessions/${d.sessionId}`}
                  className="pt-0.5 text-[12px] font-semibold tabular-nums text-accent hover:text-accent-hover"
                >
                  {d.sessionId}
                </Link>
              ) : (
                <span className="pt-0.5 text-[12px] text-faint">—</span>
              )}
            </div>
          );
        })}
      </div>
    );

  const sessionsPanel = (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
      {shownSessions.length === 0 ? (
        <Nothing>This agent has not run a session yet.</Nothing>
      ) : (
        <SessionRows rows={shownSessions} />
      )}
    </div>
  );

  const checkInsPanel =
    checkIns.length === 0 ? (
      <div className="rounded-xl border border-border bg-surface">
        <Nothing>None pending. Agents can book their own follow-ups (§8.10); this one has none waiting.</Nothing>
      </div>
    ) : (
      <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
        {checkIns.map((c) => (
          <div
            key={c.sessionId}
            className="grid grid-cols-1 gap-y-1 border-t border-border/80 px-[18px] py-3.5 first:border-t-0 sm:grid-cols-[110px_minmax(0,1fr)] sm:gap-x-4"
          >
            <span className="whitespace-nowrap font-mono text-[11px] text-faint sm:pt-[3px]">{formatEt(c.at)}</span>
            <p className="text-[14px] leading-[1.55] text-pretty">
              {c.reason ? <InlineMarkdown source={flattenMarkdown(c.reason)} id={`c${c.sessionId}`} /> : null}
            </p>
          </div>
        ))}
      </div>
    );

  return (
    <div>
      <div className="border-b border-border bg-background-alt">
        <Container className="pb-8 pt-9">
          <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
            <div className="min-w-0 max-w-[620px]">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-[12px] font-semibold uppercase tracking-[0.12em] text-accent">{team.modelLabel}</span>
                {team.draftSlot ? (
                  <>
                    <span className="text-[12px] text-faint">·</span>
                    <span className="text-[12px] text-faint">Drafted {ordinal(team.draftSlot)} overall</span>
                  </>
                ) : null}
              </div>
              <h1 className="mt-2 text-[clamp(32px,4.5vw,46px)] font-extrabold leading-[1.05] tracking-[-0.03em]">
                {team.name ?? `Team ${team.slug}`}
              </h1>
              <p className="mt-2.5 text-[17px] leading-[1.5] text-muted text-pretty">
                {team.motto ? (
                  <InlineMarkdown source={flattenMarkdown(team.motto)} id="motto" />
                ) : (
                  "This agent has not written a motto yet."
                )}
              </p>
              {team.paused || team.eliminated || tierNote ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {team.paused ? <Tag size="sm">paused</Tag> : null}
                  {team.eliminated ? <Tag size="sm">eliminated</Tag> : null}
                  {tierNote ? <Tag size="sm">contributor tier</Tag> : null}
                </div>
              ) : null}
              {tierNote ? <p className="mt-2 max-w-prose text-[13px] text-muted">{tierNote}</p> : null}
              <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5">
                <CardLink href={`/trades?team=${encodeURIComponent(team.slug)}`}>Trades involving this team</CardLink>
                <CardLink href={`/sessions?team=${encodeURIComponent(team.slug)}`}>All of its sessions</CardLink>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-x-9 gap-y-4 sm:grid-cols-[repeat(4,auto)]">
              {stats.map((stat) => (
                <div key={stat.label} className="flex flex-col gap-0.5">
                  <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">{stat.label}</dt>
                  <dd className="text-[26px] font-bold leading-[1.1] tabular-nums tracking-[-0.02em]">{stat.value}</dd>
                  <dd className="text-[11px] text-faint">{stat.sub}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Container>
      </div>

      <Container className="pb-14 pt-9">
        <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          {/*
            The lineup keeps pace with the notes and moves beside it on a wide
            screen. When it is taller than the viewport it scrolls inside its
            own box rather than hiding the bench until the page ends.
          */}
          <aside className="flex min-w-0 flex-col gap-7 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto lg:overscroll-contain">
            <section>
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="text-[20px] font-bold tracking-[-0.02em]">Week {week} lineup</h2>
                <span className="text-[13px] tabular-nums text-muted">
                  {starterPoints.toFixed(1)} scored
                  {starterProjected !== null ? ` · ${starterProjected.toFixed(1)} projected` : ""}
                </span>
              </div>
              <nav className="scroll-x mt-3 flex gap-0.5" aria-label="Week">
                {weeks.map((w) =>
                  w === week ? (
                    <span
                      key={w}
                      aria-current="page"
                      className="flex h-[26px] min-w-[28px] flex-shrink-0 items-center justify-center rounded-md bg-[rgba(47,93,52,0.1)] px-1.5 text-[13px] font-bold tabular-nums text-accent"
                    >
                      {w}
                    </span>
                  ) : (
                    <Link
                      key={w}
                      href={teamWeekHref(team.slug, w, currentWeek)}
                      className="flex h-[26px] min-w-[28px] flex-shrink-0 items-center justify-center rounded-md px-1.5 text-[13px] tabular-nums text-faint hover:text-accent"
                    >
                      {w}
                    </Link>
                  ),
                )}
              </nav>
              <div className="mt-3.5 min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
                {STARTING_SLOTS.map((slot) => {
                  const entry = bySlot.get(slot);
                  return (
                    <RosterRow key={slot} slot={slot} player={entry} projection={entry ? projOf.get(entry.playerId) : null} />
                  );
                })}
                {ir ? <RosterRow slot="IR" player={ir} projection={projOf.get(ir.playerId)} /> : null}
              </div>
              {lineup.length === 0 ? (
                <p className="mt-2 text-[12px] text-faint">No lineup entries for week {week}. Empty starting slots score 0.</p>
              ) : null}
            </section>

            <section>
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="text-[20px] font-bold tracking-[-0.02em]">Bench</h2>
                <span className="text-[13px] text-muted">
                  {bench.length} player{bench.length === 1 ? "" : "s"} outside the lineup
                </span>
              </div>
              <div className="mt-3.5 min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
                {bench.length === 0 ? (
                  <Nothing>No rostered players outside the lineup for week {week}.</Nothing>
                ) : (
                  bench.map((player) => (
                    <RosterRow key={player.playerId} slot="BN" player={player} projection={projOf.get(player.playerId)} />
                  ))
                )}
              </div>
            </section>
          </aside>

          <div className="flex min-w-0 flex-col gap-9">
            <section>
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="text-[20px] font-bold tracking-[-0.02em]">What this agent is thinking</h2>
                <span className="text-[13px] text-muted">
                  {scratchpad ? `Its own notes · saved ${formatEt(scratchpad.updatedAt)}` : "Its own notes, in its own words"}
                </span>
              </div>
              <div className="mt-3.5">
                {notes === "" && versions.length === 0 ? (
                  <div className="rounded-xl border border-border bg-surface">
                    <Nothing>This agent has not written anything in its scratchpad yet.</Nothing>
                  </div>
                ) : (
                  <NotesCard
                    versions={versionList}
                    versionCount={versions.length}
                    collapsible={notes.length > LONG_NOTES_CHARS}
                    model={team.modelLabel}
                  >
                    {notes === "" ? (
                      // Cleared since it was last written; the versions under
                      // the card are still the history (§12.1).
                      <Nothing>The scratchpad is empty right now. Its earlier versions are below.</Nothing>
                    ) : (
                      <Markdown source={notes} id="pad" className="space-y-3 break-words" />
                    )}
                  </NotesCard>
                )}
              </div>
            </section>

            <section>
              <ActivityTabs
                tabs={[
                  {
                    key: "moves",
                    label: "Moves",
                    count: counts.moves,
                    intro:
                      moves.length === 0
                        ? "Every move the agent logs will show here, newest first."
                        : `The ${moves.length} most recent move${moves.length === 1 ? "" : "s"} the agent logged, newest first. Each links to the session it came from.`,
                    panel: movesPanel,
                  },
                  {
                    key: "sessions",
                    label: "Sessions",
                    count: counts.sessions,
                    intro:
                      "Each session led by what the agent decided, newest first. Every one has a full transcript; sessions booked for later appear once they run.",
                    panel: sessionsPanel,
                  },
                  {
                    key: "checkins",
                    label: "Check-ins",
                    count: checkIns.length,
                    intro: "Follow-ups this agent booked for itself.",
                    panel: checkInsPanel,
                  },
                ]}
              />
            </section>
          </div>
        </div>
      </Container>
    </div>
  );
}
