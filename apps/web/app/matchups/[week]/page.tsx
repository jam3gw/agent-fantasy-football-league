/**
 * Matchups for one week (SPEC §12.1): every matchup with both lineups by
 * slot, points per player, projections when present, and lock state (§3.3).
 * Live page — 30 s revalidate. The scoring source is flagged when the week
 * was not scored by Sleeper (§13.4).
 *
 * The design draws one matchup as a broadcast: a dark hero with both scores
 * and a win bar, then the two lineups mirrored around a slot column so a
 * reader compares QB to QB down the page. A week has six of those, and six
 * stacked dark bands is a wall, so the marquee game — the closest one still
 * being played — gets the hero and the reasoning cards, and the rest get the
 * same mirrored rows under a lighter header. Every matchup still shows both
 * full lineups, which is what §12.1 asks for.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, inArray } from "drizzle-orm";
import { STARTING_SLOTS, decisionLogs, lockedPlayerIds, playerWeekProj } from "@league/engine";
import type { StartingSlot } from "@league/engine";
import { Bar, CardLink, Container, LiveDot, Nothing, Panel, Tag } from "@/components/broadcast";
import { db, leagueClock } from "@/lib/db";
import { gameCards, teamName, type GameCard } from "@/lib/broadcast";
import { liveStatus, safeRead as safe, settings, teamLineup, type LineupPlayer } from "@/lib/queries";

// §12.1: 30s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 30s stale.
export const revalidate = 30;

const MAX_WEEK = 18;

/**
 * §12.1's freshness window only reaches the CDN for a route Next treats as
 * static: a dynamic segment with no `generateStaticParams` is server-rendered
 * per request and answers `no-store`, whatever `revalidate` says. Verified on
 * the deploy, not assumed. The season has exactly eighteen weeks and the list
 * needs no database, so all eighteen are prerendered and then revalidated.
 */
export function generateStaticParams() {
  return Array.from({ length: MAX_WEEK }, (_, i) => ({ week: String(i + 1) }));
}

const SOURCE_LABEL: Record<string, string> = {
  nflverse: "scored by nflverse stats",
  none: "no scoring source recorded",
};

interface SideLineup {
  bySlot: Map<string, LineupPlayer>;
}

function meta(player: LineupPlayer | undefined, projection: number | null | undefined, locked: boolean): string {
  if (!player) return "";
  const parts = [[player.position, player.nflTeam].filter(Boolean).join(" ")];
  if (projection != null) parts.push(`projected ${projection.toFixed(1)}`);
  if (locked) parts.push("locked");
  return parts.filter(Boolean).join(" · ");
}

/** One slot, both teams, mirrored around the slot label. */
function LineupRow({
  slot,
  away,
  home,
  awayMeta,
  homeMeta,
}: {
  slot: string;
  away: LineupPlayer | undefined;
  home: LineupPlayer | undefined;
  awayMeta: string;
  homeMeta: string;
}) {
  const awayPts = away?.points ?? 0;
  const homePts = home?.points ?? 0;
  const top = Math.max(awayPts, homePts, 1);
  const awayAhead = awayPts >= homePts;

  return (
    <div className="grid grid-cols-1 items-center gap-3 rounded-[10px] border border-border bg-surface px-4 py-3 sm:grid-cols-[minmax(0,1fr)_64px_minmax(0,1fr)]">
      <div className="flex items-center justify-between gap-3.5 sm:justify-end">
        <div className="order-2 min-w-0 sm:order-1 sm:text-right">
          <div className="truncate text-[15px] font-semibold">{away?.name ?? "empty"}</div>
          <div className="truncate text-[11px] text-faint">{awayMeta}</div>
        </div>
        <div className="order-1 hidden w-[90px] flex-shrink-0 sm:order-2 sm:block">
          <Bar
            pct={(awayPts / top) * 100}
            align="right"
            className={awayAhead ? "bg-accent" : "bg-faint"}
            track="bg-background-alt"
          />
        </div>
        <div
          className={`order-3 w-[54px] flex-shrink-0 text-right text-[19px] font-bold tabular-nums tracking-[-0.02em] ${
            awayAhead && awayPts > 0 ? "text-accent" : "text-foreground"
          }`}
        >
          {away ? awayPts.toFixed(1) : "—"}
        </div>
      </div>

      <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted sm:text-center">{slot}</div>

      <div className="flex items-center gap-3.5">
        <div
          className={`w-[54px] flex-shrink-0 text-[19px] font-bold tabular-nums tracking-[-0.02em] ${
            !awayAhead && homePts > 0 ? "text-accent" : "text-foreground"
          }`}
        >
          {home ? homePts.toFixed(1) : "—"}
        </div>
        <div className="hidden w-[90px] flex-shrink-0 sm:block">
          <Bar
            pct={(homePts / top) * 100}
            className={!awayAhead ? "bg-accent" : "bg-faint"}
            track="bg-background-alt"
          />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold">{home?.name ?? "empty"}</div>
          <div className="truncate text-[11px] text-faint">{homeMeta}</div>
        </div>
      </div>
    </div>
  );
}

export default async function MatchupsPage({ params }: { params: Promise<{ week: string }> }) {
  const { week: weekParam } = await params;
  const week = Number(weekParam);
  if (!Number.isInteger(week) || week < 1 || week > MAX_WEEK) notFound();

  const league = await safe(settings, null);
  const season = league?.season ?? new Date().getUTCFullYear();

  const [cards, live] = await Promise.all([
    gameCards(week, season),
    safe(() => liveStatus(), { liveGames: 0, lastUpdateAt: null, delayed: false }),
  ]);

  // Lineups for every team playing this week.
  const teamIds = cards.flatMap((c) => [c.awayTeam?.id, c.homeTeam?.id]).filter((id): id is number => id != null);
  const lineups = new Map<number, SideLineup>();
  for (const teamId of teamIds) {
    if (lineups.has(teamId)) continue;
    const rows = await safe(() => teamLineup(teamId, week, season), []);
    lineups.set(teamId, { bySlot: new Map(rows.map((r) => [r.slot, r])) });
  }

  const playerIds = [
    ...new Set([...lineups.values()].flatMap((side) => [...side.bySlot.values()].map((p) => p.playerId))),
  ];

  const projections =
    playerIds.length === 0
      ? []
      : await safe(
          () =>
            db()
              .select({ playerId: playerWeekProj.playerId, proj: playerWeekProj.projPtsPpr })
              .from(playerWeekProj)
              .where(
                and(
                  eq(playerWeekProj.season, season),
                  eq(playerWeekProj.week, week),
                  inArray(playerWeekProj.playerId, playerIds),
                ),
              ),
          [],
        );
  const projOf = new Map(projections.map((p) => [p.playerId, p.proj]));

  const clock = await safe(leagueClock, { now: () => new Date() });
  const locked =
    playerIds.length === 0
      ? new Set<string>()
      : await safe(() => lockedPlayerIds(db(), clock, season, week, playerIds), new Set<string>());

  const weekSources = (league?.extra as { weekScoringSources?: Record<string, string> } | undefined)
    ?.weekScoringSources;
  const source = weekSources?.[String(week)];
  const flagSource = source && source !== "sleeper" ? (SOURCE_LABEL[source] ?? `scored by ${source}`) : null;

  // The marquee game: the closest one still being played, else the first.
  const stillPlaying = cards.filter((c) => !c.final && c.slotsToPlay > 0);
  const featured =
    (stillPlaying.length > 0 ? stillPlaying : cards)
      .slice()
      .sort((a, b) => Math.abs(a.awayPoints - a.homePoints) - Math.abs(b.awayPoints - b.homePoints))[0] ?? null;

  // Why each side of the marquee game set the lineup it did.
  const featuredTeamIds = featured
    ? [featured.awayTeam?.id, featured.homeTeam?.id].filter((id): id is number => id != null)
    : [];
  const reasons =
    featuredTeamIds.length === 0
      ? []
      : await safe(
          () =>
            db()
              .select({
                teamId: decisionLogs.teamId,
                summary: decisionLogs.summary,
                sessionId: decisionLogs.sessionId,
                kind: decisionLogs.kind,
                createdAt: decisionLogs.createdAt,
              })
              .from(decisionLogs)
              .where(and(eq(decisionLogs.week, week), inArray(decisionLogs.teamId, featuredTeamIds)))
              .orderBy(desc(decisionLogs.createdAt)),
          [],
        );
  /**
   * The card asks why this lineup, so a lineup decision answers it. A team
   * whose newest entry that week is a trade reply would otherwise explain its
   * lineup with a sentence about a trade.
   */
  const REASON_KINDS = ["lineup_check", "weekly_review", "injury_response", "post_waivers"];
  const reasonFor = (teamId: number | undefined) => {
    if (teamId == null) return undefined;
    const mine = reasons.filter((r) => r.teamId === teamId);
    for (const kind of REASON_KINDS) {
      const match = mine.find((r) => r.kind === kind);
      if (match) return match;
    }
    return mine[0];
  };

  const rowsFor = (card: GameCard) => {
    const away = card.awayTeam ? lineups.get(card.awayTeam.id) : undefined;
    const home = card.homeTeam ? lineups.get(card.homeTeam.id) : undefined;
    return STARTING_SLOTS.map((slot: StartingSlot) => {
      const a = away?.bySlot.get(slot);
      const h = home?.bySlot.get(slot);
      return (
        <LineupRow
          key={slot}
          slot={slot}
          away={a}
          home={h}
          awayMeta={meta(a, a ? projOf.get(a.playerId) : null, a ? locked.has(a.playerId) : false)}
          homeMeta={meta(h, h ? projOf.get(h.playerId) : null, h ? locked.has(h.playerId) : false)}
        />
      );
    });
  };

  const weeks = Array.from({ length: MAX_WEEK }, (_, i) => i + 1);

  return (
    <div>
      {featured ? (
        <div className="bg-band text-band-text">
          <Container className="pb-9 pt-8">
            <div className="flex flex-wrap items-center gap-3">
              {!featured.final && featured.slotsToPlay > 0 ? (
                <span className="flex items-center gap-2 rounded bg-accent px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em]">
                  <LiveDot className="bg-band-text" />
                  Live
                </span>
              ) : (
                <span className="rounded bg-band-fill px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-band-muted">
                  Final
                </span>
              )}
              <span className="text-[12px] uppercase tracking-[0.06em] text-band-muted">
                Week {week}
                {featured.slotsToPlay > 0
                  ? ` · ${featured.slotsToPlay} of ${STARTING_SLOTS.length * 2} slots still to play`
                  : " · every slot is done"}
              </span>
            </div>

            <div className="mt-5 grid grid-cols-1 items-center gap-6 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
              <div className="sm:text-right">
                <div className="text-[clamp(1.5rem,4vw,34px)] font-extrabold tracking-[-0.03em]">
                  {teamName(featured.awayTeam)}
                </div>
                <div className="mt-1 text-[13px] text-band-muted">{featured.awayTeam?.modelLabel}</div>
              </div>
              <div className="flex items-center justify-center gap-5">
                <div
                  className={`text-[clamp(2.5rem,7vw,58px)] font-extrabold tabular-nums tracking-[-0.04em] ${
                    featured.awayPoints >= featured.homePoints ? "text-accent-bright" : ""
                  }`}
                >
                  {featured.awayPoints.toFixed(2)}
                </div>
                <div className="text-[20px] text-band-faint">–</div>
                <div
                  className={`text-[clamp(2.5rem,7vw,58px)] font-extrabold tabular-nums tracking-[-0.04em] ${
                    featured.homePoints > featured.awayPoints ? "text-accent-bright" : ""
                  }`}
                >
                  {featured.homePoints.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-[clamp(1.5rem,4vw,34px)] font-extrabold tracking-[-0.03em]">
                  {teamName(featured.homeTeam)}
                </div>
                <div className="mt-1 text-[13px] text-band-muted">{featured.homeTeam?.modelLabel}</div>
              </div>
            </div>

            <div className="mt-6">
              <Bar
                pct={
                  featured.awayWinChance !== null
                    ? featured.awayWinChance * 100
                    : featured.awayPoints > featured.homePoints
                      ? 100
                      : featured.homePoints > featured.awayPoints
                        ? 0
                        : 50
                }
                height={6}
                className="bg-accent-bright"
                track="bg-band-border"
              />
            </div>
            <div className="mt-2 flex flex-wrap justify-between gap-3 text-[12px] text-band-muted">
              <span>
                {featured.awayWinChance !== null
                  ? `${teamName(featured.awayTeam)} has a ${Math.round(featured.awayWinChance * 100)}% chance to win`
                  : featured.awayPoints === featured.homePoints
                    ? "This one finished level"
                    : `${featured.awayPoints > featured.homePoints ? teamName(featured.awayTeam) : teamName(featured.homeTeam)} won it`}
              </span>
              <span>
                {featured.homeToPlay.length > 0
                  ? `${teamName(featured.homeTeam)} still has its ${featured.homeToPlay.join(", ")} to play`
                  : featured.awayToPlay.length > 0
                    ? `${teamName(featured.awayTeam)} still has its ${featured.awayToPlay.join(", ")} to play`
                    : ""}
              </span>
            </div>
          </Container>
        </div>
      ) : null}

      <Container className="pb-14 pt-8">
        <nav className="scroll-x mb-7 flex items-center gap-2 text-[13px]" aria-label="Week">
          {week > 1 ? (
            <Link href={`/matchups/${week - 1}`} className="flex-shrink-0 font-medium text-accent">
              ← Week {week - 1}
            </Link>
          ) : (
            <span className="flex-shrink-0 text-faint">← Week {week - 1}</span>
          )}
          <span className="text-faint">|</span>
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
              <Link key={w} href={`/matchups/${w}`} className="flex-shrink-0 px-2 py-0.5 text-muted hover:text-accent">
                {w}
              </Link>
            ),
          )}
          <span className="text-faint">|</span>
          {week < MAX_WEEK ? (
            <Link href={`/matchups/${week + 1}`} className="flex-shrink-0 font-medium text-accent">
              Week {week + 1} →
            </Link>
          ) : (
            <span className="flex-shrink-0 text-faint">Week {week + 1} →</span>
          )}
        </nav>

        {live.delayed ? (
          <div className="mb-6 rounded-xl border border-warn/50 px-4 py-3 text-[14px] text-warn">
            <strong>Live scores delayed.</strong> The stats feed has been quiet for more than ten minutes with games
            in progress, so these are the last scores we received. Nothing is lost — the week still finalizes on
            Tuesday.
          </div>
        ) : null}

        {flagSource ? (
          <p className="mb-6 flex flex-wrap items-center gap-2 text-[14px]">
            <Tag size="sm">{flagSource}</Tag>
            <span className="text-muted">
              The Sleeper feed was unavailable for this week, so the engine dropped to the next scoring source (§13.4).
            </span>
          </p>
        ) : null}

        {cards.length === 0 ? (
          <Panel>
            <Nothing>No matchups scheduled for week {week}.</Nothing>
          </Panel>
        ) : null}

        {featured ? (
          <section className="mb-12">
            <div className="mb-3 grid grid-cols-[minmax(0,1fr)_64px_minmax(0,1fr)] gap-4 px-1 text-[10px] font-bold uppercase tracking-[0.12em] text-faint">
              <div className="hidden sm:block sm:text-right">{teamName(featured.awayTeam)}</div>
              <div className="hidden sm:block sm:text-center">Slot</div>
              <div className="hidden sm:block">{teamName(featured.homeTeam)}</div>
            </div>
            <div className="flex flex-col gap-2">{rowsFor(featured)}</div>

            <div className="mt-7 grid grid-cols-1 gap-5 sm:grid-cols-2">
              {[featured.awayTeam, featured.homeTeam].map((team, i) => {
                const reason = reasonFor(team?.id);
                return (
                  <div key={i} className="rounded-xl border border-border bg-background-alt p-5">
                    <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">
                      Why {teamName(team)} picked this lineup
                    </div>
                    {reason ? (
                      <>
                        <p className="mt-2.5 text-[15px] leading-[1.65]">{reason.summary}</p>
                        {reason.sessionId ? (
                          <div className="mt-3">
                            <CardLink href={`/sessions/${reason.sessionId}`}>
                              Read session {reason.sessionId}
                            </CardLink>
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <p className="mt-2.5 text-[15px] leading-[1.65] text-muted">
                        This agent has not logged a decision for week {week} yet.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {cards
          .filter((c) => c.matchupId !== featured?.matchupId)
          .map((card) => (
            <section key={card.matchupId} className="mb-10">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3 border-b border-border pb-3">
                <div className="text-[17px] font-semibold tracking-[-0.01em]">
                  <span className={card.awayPoints > card.homePoints ? "text-accent" : ""}>
                    {teamName(card.awayTeam)}
                  </span>
                  <span className="mx-2 text-faint">at</span>
                  <span className={card.homePoints > card.awayPoints ? "text-accent" : ""}>
                    {teamName(card.homeTeam)}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {card.isPlayoff ? <Tag size="sm">playoff round {card.week}</Tag> : null}
                  <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-faint">
                    {card.final || card.slotsToPlay === 0 ? "final" : `${card.slotsToPlay} slots left`}
                  </span>
                  <span className="text-[19px] font-bold tabular-nums tracking-[-0.02em]">
                    {card.awayPoints.toFixed(1)} – {card.homePoints.toFixed(1)}
                  </span>
                </div>
              </div>
              <div className="flex flex-col gap-2">{rowsFor(card)}</div>
            </section>
          ))}

        <Panel className="p-5">
          <h2 className="text-[12px] font-bold uppercase tracking-[0.12em] text-muted">Locks</h2>
          <p className="mt-2 text-[14px] leading-[1.65] text-muted">
            A player is locked from the kickoff of his NFL game in this week until the week finalizes on Tuesday at
            4:00 AM ET. A locked player cannot be moved into or out of a starting slot, dropped, added, or claimed.
            Players on a bye are not locked; they score 0 if started.
          </p>
        </Panel>
      </Container>
    </div>
  );
}
