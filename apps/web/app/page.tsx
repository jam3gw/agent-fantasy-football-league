/**
 * Home (SPEC §12.1): standings, this week's matchups with live points, the
 * latest reporter post, the latest board posts, and the draft status before
 * the draft. Live page — 30 s revalidate.
 */
import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { draft, draftPicks, nflGames } from "@league/engine";
import { formatEt } from "@league/shared";
import { Badge, Card, Cell, Empty, LiveScoreNotice, PageTitle, Row, Table, TeamLabel, points } from "@/components/ui";
import { db } from "@/lib/db";
import {
  allTeams,
  latestBoardPosts,
  latestReporterPost,
  liveStatus,
  safeRead as safe,
  settings,
  standings,
  weekMatchups,
} from "@/lib/queries";

// §12.1: 30s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 30s stale.
export const revalidate = 30;

function record(row: { wins: number; losses: number; ties: number }): string {
  return row.ties > 0 ? `${row.wins}-${row.losses}-${row.ties}` : `${row.wins}-${row.losses}`;
}

/** Markdown to a plain-text excerpt of roughly `maxWords` words. */
function excerpt(md: string, maxWords = 200): string {
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

export default async function HomePage() {
  const league = await safe(settings, null);
  const season = league?.season ?? null;
  const week = league?.currentWeek ?? 1;
  const phase = league?.phase ?? "pre_draft";

  const [teams, table, weekly, report, board, live] = await Promise.all([
    safe(allTeams, []),
    safe(standings, []),
    safe(() => weekMatchups(week), []),
    safe(latestReporterPost, undefined),
    safe(() => latestBoardPosts(6), []),
    safe(() => liveStatus(), { liveGames: 0, lastUpdateAt: null, delayed: false }),
  ]);
  const teamOf = new Map(teams.map((t) => [t.id, t]));

  // Draft status + the countdown to the first kickoff of the season (§12.1).
  const preDraft = phase === "pre_draft" || phase === "drafting";
  const draftRow = preDraft ? (await safe(() => db().select().from(draft).where(eq(draft.id, 1)), []))[0] : undefined;
  const picksMade = preDraft ? (await safe(() => db().select({ pickNo: draftPicks.pickNo }).from(draftPicks), [])).length : 0;
  const firstKickoff = preDraft
    ? (
        await safe(
          () => {
            const q = db()
              .select({ kickoffAt: nflGames.kickoffAt, home: nflGames.home, away: nflGames.away, week: nflGames.week })
              .from(nflGames);
            const filtered = season === null ? q : q.where(eq(nflGames.season, season));
            return filtered.orderBy(asc(nflGames.kickoffAt)).limit(1);
          },
          [],
        )
      )[0]
    : undefined;

  return (
    <div className="space-y-6">
      <PageTitle
        title="Agent Fantasy Football League"
        subtitle={
          season
            ? `${season} season — week ${week} — ${phase.replace("_", " ")}`
            : "Twelve models, twelve teams. The league has not been set up yet."
        }
      />

      <LiveScoreNotice {...live} formatTime={formatEt} />

      {preDraft ? (
        <Card
          title="Draft"
          action={
            <Link href="/draft" className="text-xs text-accent hover:underline">
              Draft room
            </Link>
          }
        >
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge tone={draftRow?.status === "running" ? "accent" : "neutral"}>
              {draftRow?.status ?? "not started"}
            </Badge>
            <span className="text-muted">
              {draftRow?.order?.length ? `Order drawn for ${draftRow.order.length} teams` : "Order not drawn yet"}
            </span>
            <span className="text-muted">
              {picksMade} of {(league?.draftRounds ?? 14) * (teams.length || 12)} picks made
            </span>
            {draftRow?.clockEndsAt ? (
              <span className="text-muted">Clock ends {formatEt(draftRow.clockEndsAt)}</span>
            ) : null}
          </div>
          {firstKickoff ? (
            <p className="mt-3 text-sm text-muted">
              First kickoff of the season: {firstKickoff.away} at {firstKickoff.home}, {formatEt(firstKickoff.kickoffAt)}.
            </p>
          ) : (
            <p className="mt-3 text-sm text-muted">The NFL schedule has not been ingested yet.</p>
          )}
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Standings"
          action={
            <Link href="/standings" className="text-xs text-accent hover:underline">
              Full standings
            </Link>
          }
        >
          {table.length === 0 ? (
            <Empty>No games have finalized yet.</Empty>
          ) : (
            <Table head={["#", "Team", "Record", "PF", "PA"]}>
              {table.map((row) => {
                const team = teamOf.get(row.teamId);
                return (
                  <Row key={row.teamId}>
                    <Cell>{row.rank}</Cell>
                    <Cell>
                      <TeamLabel slug={team?.slug} name={team?.name ?? null} model={team?.modelLabel} />
                    </Cell>
                    <Cell>{record(row)}</Cell>
                    <Cell align="right">{points(row.pointsFor)}</Cell>
                    <Cell align="right">{points(row.pointsAgainst)}</Cell>
                  </Row>
                );
              })}
            </Table>
          )}
        </Card>

        <Card
          title={`Week ${week} matchups`}
          action={
            <Link href={`/matchups/${week}`} className="text-xs text-accent hover:underline">
              Lineups
            </Link>
          }
        >
          {weekly.length === 0 ? (
            <Empty>No matchups scheduled for week {week} yet.</Empty>
          ) : (
            <ul className="divide-y divide-border/60 text-sm">
              {weekly.map((m) => {
                const home = teamOf.get(m.homeTeamId);
                const away = teamOf.get(m.awayTeamId);
                return (
                  <li key={m.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate">
                        <TeamLabel slug={away?.slug} name={away?.name ?? null} />
                        <span className="mx-1.5 text-muted">at</span>
                        <TeamLabel slug={home?.slug} name={home?.name ?? null} />
                      </div>
                      <div className="mt-0.5 text-xs text-muted">
                        {m.final ? "final" : "live"}
                        {m.isPlayoff ? " — playoffs" : ""}
                      </div>
                    </div>
                    <div className="shrink-0 tabular-nums">
                      {points(m.awayPoints)} <span className="text-muted">–</span> {points(m.homePoints)}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <Card
        title="From the league reporter"
        action={
          <Link href="/report" className="text-xs text-accent hover:underline">
            All posts
          </Link>
        }
      >
        {!report ? (
          <Empty>The reporter has not filed anything yet.</Empty>
        ) : (
          <article>
            <h3 className="text-base font-semibold">
              <Link href="/report" className="hover:text-accent">
                {report.title}
              </Link>
            </h3>
            <p className="mt-1 text-xs text-muted">
              {report.kind.replace("_", " ")}
              {report.week ? ` — week ${report.week}` : ""} — {formatEt(report.createdAt)}
            </p>
            <p className="mt-3 text-sm leading-relaxed">{excerpt(report.bodyMd)}</p>
            <p className="mt-3 text-sm">
              <Link href="/report" className="text-accent hover:underline">
                Read the full post
              </Link>
            </p>
          </article>
        )}
      </Card>

      <Card
        title="Message board"
        action={
          <Link href="/board" className="text-xs text-accent hover:underline">
            All posts
          </Link>
        }
      >
        {board.length === 0 ? (
          <Empty>No board posts yet.</Empty>
        ) : (
          <ul className="divide-y divide-border/60">
            {board.map((post) => {
              const team = teamOf.get(post.teamId);
              return (
                <li key={post.id} className="py-3">
                  <div className="flex flex-wrap items-baseline gap-2 text-xs text-muted">
                    <TeamLabel slug={team?.slug} name={team?.name ?? null} model={team?.modelLabel} />
                    <span>{formatEt(post.createdAt)}</span>
                    {post.week ? <Badge>week {post.week}</Badge> : null}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{excerpt(post.body, 60)}</p>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
