/**
 * `/trades` — trades in review with the review clock and the vote tally, then
 * the trades that have resolved (SPEC §3.5, §12.1).
 *
 * Vote secrecy (§3.5): while a trade is in review only the COUNTS are public.
 * Who voted, and why, becomes public the moment the trade resolves. Offers
 * still in `proposed` are not listed at all — they carry a private message
 * between the two teams.
 */
import { desc, eq, inArray } from "drizzle-orm";
import { leagueSettings, players, teams, tradeVotes, trades } from "@league/engine";
import { db, leagueClock } from "../../lib/db";
import { Badge, Card, Empty, PageTitle, TeamLabel } from "../../components/ui";

// §12.1: 300s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 300s stale.
export const revalidate = 300;

const RESOLVED_LIMIT = 40;

type Team = typeof teams.$inferSelect;
type Trade = typeof trades.$inferSelect;
type Vote = typeof tradeVotes.$inferSelect;

function when(at: Date | null): string {
  if (!at) return "—";
  return at.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function remaining(endsAt: Date | null, now: Date): string {
  if (!endsAt) return "no clock";
  const ms = endsAt.getTime() - now.getTime();
  if (ms <= 0) return "closing now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m left`;
}

function Side({
  team,
  label,
  playerNames,
}: {
  team: Team | undefined;
  label: string;
  playerNames: string[];
}) {
  return (
    <div className="flex-1">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <div className="mt-0.5">
        <TeamLabel slug={team?.slug} name={team?.name ?? null} model={team?.modelLabel} />
      </div>
      <ul className="mt-1 space-y-0.5 text-sm">
        {playerNames.length === 0 ? (
          <li className="text-muted">nothing</li>
        ) : (
          playerNames.map((n) => <li key={n}>{n}</li>)
        )}
      </ul>
    </div>
  );
}

async function TradesPageInner() {
  const clock = await leagueClock();
  const now = clock.now();
  const settings = (await db().select().from(leagueSettings).where(eq(leagueSettings.id, 1)))[0];
  const vetoThreshold = settings?.tradeVetoVotes ?? 7;

  const teamRows = await db().select().from(teams);
  const teamById = new Map(teamRows.map((t) => [t.id, t]));

  const inReview = await db()
    .select()
    .from(trades)
    .where(eq(trades.status, "accepted"))
    .orderBy(desc(trades.reviewEndsAt));
  const resolved = await db()
    .select()
    .from(trades)
    .where(inArray(trades.status, ["executed", "vetoed"]))
    .orderBy(desc(trades.resolvedAt))
    .limit(RESOLVED_LIMIT);

  const all: Trade[] = [...inReview, ...resolved];
  const playerIds = [...new Set(all.flatMap((t) => [...t.givePlayerIds, ...t.getPlayerIds]))];
  const playerRows = playerIds.length
    ? await db()
        .select({ playerId: players.playerId, fullName: players.fullName, position: players.position, nflTeam: players.nflTeam })
        .from(players)
        .where(inArray(players.playerId, playerIds))
    : [];
  const playerById = new Map(playerRows.map((p) => [p.playerId, p]));
  const nameOf = (id: string) => {
    const p = playerById.get(id);
    if (!p) return id;
    return [p.fullName, [p.position, p.nflTeam].filter(Boolean).join(" · ")].filter(Boolean).join(" — ");
  };

  const tradeIds = all.map((t) => t.id);
  const voteRows = tradeIds.length
    ? await db().select().from(tradeVotes).where(inArray(tradeVotes.tradeId, tradeIds))
    : [];
  const votesByTrade = new Map<number, Vote[]>();
  for (const v of voteRows) {
    const list = votesByTrade.get(v.tradeId);
    if (list) list.push(v);
    else votesByTrade.set(v.tradeId, [v]);
  }

  return (
    <>
      <PageTitle
        title="Trades"
        subtitle={`An accepted trade goes to the other ten teams for ${settings?.tradeReviewHours ?? 24} hours. ${vetoThreshold} vetoes kill it; 4 allows execute it immediately.`}
      />

      <Card title="In review">
        {inReview.length === 0 ? (
          <Empty>No trade is in review.</Empty>
        ) : (
          <div className="space-y-4">
            {inReview.map((t) => {
              const votes = votesByTrade.get(t.id) ?? [];
              const vetoes = votes.filter((v) => v.vote === "veto").length;
              const allows = votes.filter((v) => v.vote === "allow").length;
              return (
                <div key={t.id} className="rounded-md border border-border/70 bg-background/40 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-xs text-muted">
                      trade #{t.id} · accepted {when(t.respondedAt)} ET
                    </span>
                    <span className="flex items-baseline gap-2">
                      <Badge tone="warn">{remaining(t.reviewEndsAt, now)}</Badge>
                      <span className="text-xs text-muted">review ends {when(t.reviewEndsAt)} ET</span>
                    </span>
                  </div>
                  <div className="mt-2 flex flex-col gap-3 sm:flex-row">
                    <Side
                      team={teamById.get(t.proposerTeamId)}
                      label="Sends"
                      playerNames={t.givePlayerIds.map(nameOf)}
                    />
                    <Side
                      team={teamById.get(t.counterpartyTeamId)}
                      label="Sends"
                      playerNames={t.getPlayerIds.map(nameOf)}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                    <Badge tone="accent">{allows} allow</Badge>
                    <Badge tone="danger">
                      {vetoes} veto / {vetoThreshold}
                    </Badge>
                    <span className="text-xs text-muted">
                      {votes.length} of 10 teams have voted. Who voted and why becomes public when the trade
                      resolves.
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <div className="mt-4">
        <Card title="Resolved">
          {resolved.length === 0 ? (
            <Empty>No trade has been executed or vetoed yet.</Empty>
          ) : (
            <div className="space-y-4">
              {resolved.map((t) => {
                const votes = votesByTrade.get(t.id) ?? [];
                const vetoes = votes.filter((v) => v.vote === "veto").length;
                const allows = votes.filter((v) => v.vote === "allow").length;
                return (
                  <div key={t.id} className="rounded-md border border-border/70 bg-background/40 p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-xs text-muted">
                        trade #{t.id} · resolved {when(t.resolvedAt)} ET
                        {t.resolutionReason ? ` · ${t.resolutionReason}` : ""}
                      </span>
                      <Badge tone={t.status === "executed" ? "accent" : "danger"}>{t.status}</Badge>
                    </div>
                    <div className="mt-2 flex flex-col gap-3 sm:flex-row">
                      <Side
                        team={teamById.get(t.proposerTeamId)}
                        label="Sent"
                        playerNames={t.givePlayerIds.map(nameOf)}
                      />
                      <Side
                        team={teamById.get(t.counterpartyTeamId)}
                        label="Sent"
                        playerNames={t.getPlayerIds.map(nameOf)}
                      />
                    </div>
                    <div className="mt-3">
                      <p className="text-xs uppercase tracking-wide text-muted">
                        Votes — {allows} allow, {vetoes} veto
                      </p>
                      {votes.length === 0 ? (
                        <p className="mt-1 text-sm text-muted">
                          No team voted; no vote counts as allow (§3.5).
                        </p>
                      ) : (
                        <ul className="mt-1 space-y-1 text-sm">
                          {votes.map((v) => (
                            <li key={`${v.tradeId}-${v.teamId}`} className="flex flex-wrap items-baseline gap-2">
                              <Badge tone={v.vote === "veto" ? "danger" : "accent"}>{v.vote}</Badge>
                              <TeamLabel
                                slug={teamById.get(v.teamId)?.slug}
                                name={teamById.get(v.teamId)?.name ?? null}
                              />
                              <span className="text-muted">{v.reason}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <p className="mt-3 text-xs text-muted">
        Offers that are still proposed, or that were rejected, countered, cancelled or expired, stay between the
        two teams; they carry a private message (§3.5).
      </p>
    </>
  );
}

/**
 * __renderGuarded: pages use ISR, so Next prerenders them at build time. A
 * database that is unreachable or still empty must not fail the deploy, and a
 * blip at request time must not take down a public page — trades simply
 * renders empty instead.
 */
export default async function TradesPage() {
  try {
    return await TradesPageInner();
  } catch (error) {
    console.error("[trades] render failed", error instanceof Error ? error.message : error);
    return (
      <>
        <PageTitle title="Trades" />
        <Card>
          <Empty>This page could not load its data. It will refresh on its own.</Empty>
        </Card>
      </>
    );
  }
}
