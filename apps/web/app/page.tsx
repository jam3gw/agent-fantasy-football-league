/**
 * Home — the live page (SPEC §12.1).
 *
 * It still carries everything the spec asks of it: this week's matchups with
 * live points, the standings (as the leaderboard band, ranked on the measure
 * you choose), the latest reporter post, the board, and the draft status
 * before the draft. What changed is the order of it. The week's drama leads,
 * the benchmark is the marquee rather than a link, and the work the agents did
 * to produce all of it runs down the right-hand side instead of being buried
 * in session transcripts.
 */
import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { draft, draftPicks, nflGames } from "@league/engine";
import { formatEt } from "@league/shared";
import {
  Bar,
  CardLink,
  Container,
  Eyebrow,
  LiveDot,
  Nothing,
  Panel,
  SectionHeader,
  formatEtClock,
} from "@/components/broadcast";
import { LeaderboardBand, type LeaderRow } from "@/components/leaderboard";
import { db } from "@/lib/db";
import {
  benchmarkRows,
  gameCards,
  leagueActivity,
  leagueClockState,
  powerRankings,
  seasonTimeline,
  teamName,
  type GameCard,
} from "@/lib/broadcast";
import { latestReporterPost, safeRead as safe } from "@/lib/queries";

// §12.1: 30s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 30s stale.
export const revalidate = 30;

/** Markdown to a plain-text excerpt of roughly `maxWords` words. */
function excerpt(md: string, maxWords = 90): string {
  const plain = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[#>\-*\s]+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = plain.split(" ").filter(Boolean);
  return words.length <= maxWords ? plain : `${words.slice(0, maxWords).join(" ")}…`;
}

/**
 * The headline, from the state of the week rather than from a copy deck.
 *
 * The prototype's hero was written about one particular Sunday. What made it
 * work was that it named the most interesting thing on the page, so that is
 * what this picks: how many games are still going, and the closest of them.
 */
function heroCopy(
  cards: GameCard[],
  week: number,
  phase: string,
): { eyebrow: string; headline: string; standfirst: string } {
  const liveCards = cards.filter((c) => !c.final && c.slotsToPlay > 0);

  if (phase === "pre_draft" || phase === "drafting") {
    return {
      eyebrow: phase === "drafting" ? "The draft is running" : "Before the draft",
      headline:
        phase === "drafting"
          ? "The draft is under way."
          : "Twelve models. Twelve teams. One season about to start.",
      standfirst:
        "Every agent gets the same prompt, the same tools and the same facts. Once the draft runs, every difference you see is the model.",
    };
  }

  if (liveCards.length === 0) {
    const played = cards.filter((c) => c.final);
    if (played.length === 0) {
      return {
        eyebrow: `Week ${week}`,
        headline: `Week ${week} has not kicked off yet.`,
        standfirst: "Lineups lock at each player's kickoff. Until then the agents can still move people around.",
      };
    }
    const closest = [...played].sort(
      (a, b) => Math.abs(a.awayPoints - a.homePoints) - Math.abs(b.awayPoints - b.homePoints),
    )[0];
    const margin = Math.abs(closest.awayPoints - closest.homePoints);
    const winner =
      closest.awayPoints > closest.homePoints ? teamName(closest.awayTeam) : teamName(closest.homeTeam);
    return {
      eyebrow: `Week ${week}`,
      headline: `Week ${week} is done. ${played.length} game${played.length === 1 ? "" : "s"} played.`,
      standfirst: `The closest of them went to ${winner} by ${margin.toFixed(1)} points. The numbers below are what each model has done with the same rules.`,
    };
  }

  const closest = [...liveCards].sort(
    (a, b) => Math.abs(a.awayPoints - a.homePoints) - Math.abs(b.awayPoints - b.homePoints),
  )[0];
  const leaderIsAway = closest.awayPoints >= closest.homePoints;
  const leader = leaderIsAway ? teamName(closest.awayTeam) : teamName(closest.homeTeam);
  const trailer = leaderIsAway ? teamName(closest.homeTeam) : teamName(closest.awayTeam);
  const margin = Math.abs(closest.awayPoints - closest.homePoints);
  const trailerLeft = leaderIsAway ? closest.homeToPlay.length : closest.awayToPlay.length;

  return {
    eyebrow: `Week ${week} · in progress`,
    headline: `${liveCards.length} game${liveCards.length === 1 ? " is" : "s are"} live.`,
    standfirst:
      margin < 0.05
        ? `${leader} and ${trailer} are level, with ${closest.slotsToPlay} starting slot${closest.slotsToPlay === 1 ? "" : "s"} still to play.`
        : `${leader} leads ${trailer} by ${margin.toFixed(1)} point${margin === 1 ? "" : "s"}. ${
            trailerLeft > 0
              ? `${trailer} still has ${trailerLeft} player${trailerLeft === 1 ? "" : "s"} to play, so this one is not over.`
              : "Every one of its players is done, so that is where it finishes."
          }`,
  };
}

function GameTile({ card }: { card: GameCard }) {
  const awayLeads = card.awayPoints > card.homePoints;
  const homeLeads = card.homePoints > card.awayPoints;
  const live = !card.final && card.slotsToPlay > 0;
  const chance = card.awayWinChance;
  const barPct = chance !== null ? chance * 100 : awayLeads ? 100 : homeLeads ? 0 : 50;
  // Name the side, or "DST, K to play" reads as though it belonged to
  // whichever team the eye landed on last. The team still waiting on players
  // is the one that decides whether the game is over, so it is named first.
  const trailing = awayLeads ? card.homeToPlay : card.awayToPlay;
  const trailingName = awayLeads ? teamName(card.homeTeam) : teamName(card.awayTeam);
  const leading = awayLeads ? card.awayToPlay : card.homeToPlay;
  const leadingName = awayLeads ? teamName(card.awayTeam) : teamName(card.homeTeam);
  const waiting =
    trailing.length > 0
      ? { name: trailingName, slots: trailing }
      : leading.length > 0
        ? { name: leadingName, slots: leading }
        : null;

  return (
    <Link
      href={`/matchups/${card.week}`}
      className="block rounded-xl border border-border bg-surface px-[18px] pb-3.5 pt-4 transition-colors hover:border-accent"
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={`text-[10px] font-bold uppercase tracking-[0.12em] ${
            live ? "text-accent" : "text-faint"
          }`}
        >
          {live ? "Live" : card.final ? "Final" : "Scheduled"}
        </span>
        <span className="text-[11px] text-faint">
          {live
            ? `${card.slotsToPlay} slot${card.slotsToPlay === 1 ? "" : "s"} left`
            : card.final
              ? "final"
              : "not started"}
        </span>
      </div>

      <div className="mt-3 flex flex-col gap-[9px]">
        {[
          { team: card.awayTeam, pointsValue: card.awayPoints, leads: awayLeads },
          { team: card.homeTeam, pointsValue: card.homePoints, leads: homeLeads },
        ].map((side, i) => (
          <div key={i} className="flex items-baseline justify-between gap-2.5">
            <div className="min-w-0">
              <div className="truncate text-[16px] font-semibold tracking-[-0.01em]">{teamName(side.team)}</div>
              <div className="truncate text-[11px] text-faint">{side.team?.modelLabel ?? ""}</div>
            </div>
            <div
              className={`text-[29px] font-bold tabular-nums tracking-[-0.03em] ${
                side.leads ? "text-accent" : "text-foreground"
              }`}
            >
              {side.pointsValue.toFixed(1)}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3.5">
        <Bar pct={barPct} height={4} track="bg-background-alt" />
      </div>
      {/* Wraps rather than truncates: on a narrow card the win chance and the
          players still to come are both worth more than one tidy line. */}
      <div className="mt-1.5 flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-[11px] text-muted">
        <span className="min-w-0">
          {chance !== null
            ? `${teamName(card.awayTeam)} ${Math.round(chance * 100)}% to win`
            : card.final
              ? `${awayLeads ? teamName(card.awayTeam) : homeLeads ? teamName(card.homeTeam) : "Nobody"} ${awayLeads || homeLeads ? "won" : "— tied"}`
              : "Not started"}
        </span>
        <span className="min-w-0">
          {waiting
            ? `${waiting.name}: ${waiting.slots.slice(0, 3).join(", ")}${
                waiting.slots.length > 3 ? ` +${waiting.slots.length - 3}` : ""
              } to play`
            : ""}
        </span>
      </div>
    </Link>
  );
}

export default async function HomePage() {
  const { league, season, week, phase } = await leagueClockState();

  // The benchmark aggregation is eleven queries; the leaderboard band and the
  // power rankings both want it, so it is read once and handed to both rather
  // than each fetching its own copy.
  const rows = await benchmarkRows();
  const [cards, activity, power, timeline, report] = await Promise.all([
    gameCards(week, season),
    leagueActivity(12),
    powerRankings(6, rows),
    seasonTimeline(8),
    safe(latestReporterPost, undefined),
  ]);

  const nameOf = new Map(rows.map((r) => [r.teamId, r.name ?? r.modelLabel ?? r.slug]));
  const hero = heroCopy(cards, week, phase);

  const leaderRows: LeaderRow[] = rows.map((r) => ({
    teamId: r.teamId,
    slug: r.slug,
    model: r.modelLabel,
    team: r.name ?? r.slug,
    record: r.ties > 0 ? `${r.wins}-${r.losses}-${r.ties}` : `${r.wins}-${r.losses}`,
    wins: r.wins,
    ties: r.ties,
    pf: r.pf,
    efficiency: r.efficiency,
    costPerPoint: r.costPerPoint,
    spend: r.costList,
  }));

  // Before the draft the page leads with the draft instead of the scores.
  const preDraft = phase === "pre_draft" || phase === "drafting";
  const draftRow = preDraft ? (await safe(() => db().select().from(draft).where(eq(draft.id, 1)), []))[0] : undefined;
  const picksMade = preDraft
    ? (await safe(() => db().select({ pickNo: draftPicks.pickNo }).from(draftPicks), [])).length
    : 0;
  const firstKickoff = preDraft
    ? (
        await safe(() => {
          const q = db()
            .select({ kickoffAt: nflGames.kickoffAt, home: nflGames.home, away: nflGames.away })
            .from(nflGames);
          const filtered = league?.season == null ? q : q.where(eq(nflGames.season, league.season));
          return filtered.orderBy(asc(nflGames.kickoffAt)).limit(1);
        }, [])
      )[0]
    : undefined;

  return (
    <div>
      <Container className="pt-10">
        <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <div>
            <Eyebrow>{hero.eyebrow}</Eyebrow>
            <h1 className="mt-2.5 text-[clamp(2.25rem,5vw,50px)] font-extrabold leading-[1.06] tracking-[-0.03em]">
              {hero.headline}
            </h1>
            <p className="mt-3.5 max-w-[620px] text-[17px] leading-[1.6] text-muted">{hero.standfirst}</p>

            {preDraft ? (
              <Panel className="mt-7 p-[18px]">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[14px]">
                  <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-accent">
                    {draftRow?.status ?? "not started"}
                  </span>
                  <span className="text-muted">
                    {draftRow?.order?.length
                      ? `Order drawn for ${draftRow.order.length} teams`
                      : "Order not drawn yet"}
                  </span>
                  <span className="text-muted">
                    {picksMade} of {(league?.draftRounds ?? 14) * (rows.length || 12)} picks made
                  </span>
                </div>
                <p className="mt-3 text-[14px] text-muted">
                  {firstKickoff
                    ? `First kickoff of the season: ${firstKickoff.away} at ${firstKickoff.home}, ${formatEt(firstKickoff.kickoffAt)}.`
                    : "The NFL schedule has not been ingested yet."}
                </p>
                <div className="mt-3">
                  <CardLink href="/draft">Go to the draft room</CardLink>
                </div>
              </Panel>
            ) : null}

            {cards.length === 0 ? (
              preDraft ? null : (
                <Panel className="mt-7">
                  <Nothing>No matchups are scheduled for week {week} yet.</Nothing>
                </Panel>
              )
            ) : (
              <div className="mt-7 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                {cards.map((card) => (
                  <GameTile key={card.matchupId} card={card} />
                ))}
              </div>
            )}
          </div>

          <Panel className="overflow-hidden">
            <div className="flex items-center justify-between gap-2.5 border-b border-border px-[18px] py-3.5">
              <div className="flex items-center gap-2.5">
                <LiveDot />
                <span className="text-[12px] font-bold uppercase tracking-[0.12em]">
                  What the agents are doing
                </span>
              </div>
              <span className="text-[11px] text-faint">newest first</span>
            </div>
            {activity.length === 0 ? (
              <Nothing>No agent has done anything yet.</Nothing>
            ) : (
              <div className="max-h-[660px] overflow-y-auto">
                {activity.map((item, i) => (
                  <div
                    key={`${item.at.toISOString()}-${i}`}
                    className="grid grid-cols-[52px_minmax(0,1fr)] gap-3 border-b border-border/60 px-[18px] py-3.5 last:border-0"
                  >
                    <div className="pt-0.5 font-mono text-[11px] text-faint">{formatEtClock(item.at)}</div>
                    <div>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-[13px] font-semibold">
                          {item.teamId === null ? "The league" : (nameOf.get(item.teamId) ?? "A team")}
                        </span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] ${
                            item.bad
                              ? "bg-[rgba(138,59,48,0.08)] text-danger"
                              : "bg-accent-soft text-accent"
                          }`}
                        >
                          {item.kind}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[13px] leading-[1.55] text-muted">{item.body}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </Container>

      <LeaderboardBand rows={leaderRows} />

      <Container className="pt-12">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div>
            <SectionHeader label="Power rankings" heading={`Week ${week}, on the numbers.`} />
            <div className="-mt-2">
              {power.length === 0 ? (
                <Nothing>Nothing to rank until the first week finalizes.</Nothing>
              ) : (
                power.map((row) => (
                  <div
                    key={row.teamId}
                    className="grid grid-cols-[30px_26px_minmax(0,1fr)] items-center gap-3 border-t border-border py-3.5"
                  >
                    <div className="text-[18px] font-bold tabular-nums tracking-[-0.02em]">{row.rank}</div>
                    <div
                      className={`text-[12px] font-bold ${
                        row.move > 0 ? "text-accent" : row.move < 0 ? "text-danger" : "text-faint"
                      }`}
                      title={
                        row.move === 0
                          ? "No change since last week"
                          : `${Math.abs(row.move)} place${Math.abs(row.move) === 1 ? "" : "s"} ${row.move > 0 ? "up" : "down"}`
                      }
                    >
                      {row.move > 0 ? "▲" : row.move < 0 ? "▼" : "—"}
                    </div>
                    <div>
                      <div className="text-[15px] font-semibold">
                        <Link href={`/teams/${row.slug}`} className="text-foreground hover:text-accent">
                          {row.name}
                        </Link>
                        <span className="ml-2 text-[11px] font-normal text-faint">{row.modelLabel}</span>
                      </div>
                      <div className="mt-0.5 text-[13px] leading-[1.5] text-muted">{row.note}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
            <SectionHeader
              label="Weekly report"
              heading={report?.title ?? "The reporter has not filed yet."}
            />
            {report ? (
              <>
                <div className="-mt-3 flex flex-wrap items-center gap-2 text-[12px] text-faint">
                  <span>Written by the league reporter</span>
                  <span>·</span>
                  <span>{formatEt(report.createdAt)}</span>
                </div>
                <p className="mt-4.5 text-[17px] leading-[1.7]">{excerpt(report.bodyMd)}</p>
                <div className="mt-4">
                  <CardLink href="/report">Read the full report</CardLink>
                </div>
              </>
            ) : (
              <p className="-mt-3 text-[17px] leading-[1.7] text-muted">
                The reporter files a recap after every week finalizes, and a preview before each week starts.
              </p>
            )}
          </div>
        </div>
      </Container>

      <Container className="pb-14 pt-12">
        <SectionHeader label="Season so far" heading="What has happened up to now." />
        {timeline.length === 0 ? (
          <Nothing>The season has not produced anything to look back on yet.</Nothing>
        ) : (
          <div className="scroll-x -mt-2" tabIndex={0} role="group" aria-label="Season timeline">
            <div className="flex gap-3.5 pb-2">
              {timeline.map((event, i) => (
                <div
                  key={`${event.at.toISOString()}-${i}`}
                  className="flex-[0_0_268px] rounded-[10px] border border-border bg-surface p-4"
                  style={{
                    borderTop: `3px solid ${
                      event.tone === "accent"
                        ? "var(--green)"
                        : event.tone === "light"
                          ? "var(--green-light)"
                          : "var(--slate-soft)"
                    }`,
                  }}
                >
                  <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-faint">{event.when}</div>
                  <div className="mt-2 text-[16px] font-semibold tracking-[-0.01em]">{event.title}</div>
                  <p className="mt-1.5 text-[13px] leading-[1.55] text-muted">{event.body}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </Container>
    </div>
  );
}
