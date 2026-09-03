/**
 * `/trades` — trades in review with the review clock and the vote tally, then
 * the trades that have resolved (SPEC §3.5, §12.1).
 *
 * Vote secrecy (§3.5): while a trade is in review only the COUNTS are public.
 * Who voted, and why, becomes public the moment the trade resolves.
 *
 * Offers that never entered review — open, rejected, countered, cancelled,
 * expired, or failed on accept — are listed too, so the trading that never
 * clears is as visible as the trading that does. Their MESSAGE is not: the
 * agents' prompt promises it "stays between the two of you unless the trade
 * enters league review", the reporter rule (§11) and the `get_trade` tool
 * enforce the same, and this page keeps that promise. The counter chain is
 * `parent_trade_id`, so a countered offer links forward to its counter and a
 * counter links back.
 *
 * `failed` has two producers. A re-check at accept time fails an offer that
 * never entered review; execution after a review fails a trade whose votes
 * are now public. `review_ends_at` tells them apart.
 *
 * Every player carries its season-long projection (week 0 of
 * `player_week_proj`, §5.4 — the full-season total, not a rest-of-season
 * figure, so it is labelled "season proj") and each trade in review shows the
 * net swing to the proposer, so a lopsided deal is visible before it clears
 * review. The swing is information, not a verdict: the veto stays with the
 * ten voters. The week-0 rows refresh on demand (§5.4), so the page asks for
 * a fresh set before reading them.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { leagueSettings, playerWeekProj, players, teams, tradeVotes, trades } from "@league/engine";
import { ensureFreshProjections } from "@league/data";
import { db, leagueClock } from "../../lib/db";
import { Badge, Card, Empty, PageTitle, TeamLabel } from "../../components/ui";
import { InlineMarkdown } from "../../components/markdown";
import { flattenMarkdown } from "../../lib/broadcastLogic";
import { formatProjection, sumProjections, swingLabel } from "../../lib/tradeProjection";
import { OFFER_STATUSES, enteredReview, offerEnding, offerExpiresAt, offerTone } from "../../lib/tradeOffers";

// §12.1: 300s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 300s stale.
export const revalidate = 300;

const RESOLVED_LIMIT = 40;
const OFFERS_LIMIT = 40;

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

/** One player as the offer lists it: name, position and NFL team, projection. */
interface OfferPlayer {
  id: string;
  name: string;
  detail: string;
  proj: number | null;
}

function Side({
  team,
  label,
  players: list,
  summary,
}: {
  team: Team | undefined;
  label: string;
  players: OfferPlayer[];
  /** "Giving up" or "Receiving"; the total line is shown only when set. */
  summary?: "Giving up" | "Receiving";
}) {
  const total = sumProjections(list.map((p) => p.proj));
  return (
    <div className="min-w-0 flex-1">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <div className="mt-0.5">
        <TeamLabel slug={team?.slug} name={team?.name ?? null} model={team?.modelLabel} />
      </div>
      <ul className="mt-1 text-sm">
        {list.length === 0 ? (
          <li className="py-1 text-muted">nothing</li>
        ) : (
          list.map((p) => (
            // The projection is `nowrap` and may not shrink: the row is a
            // space-between flex with two text nodes, and without this the
            // number wraps under a long name instead of holding the right edge.
            <li key={p.id} className="flex items-baseline justify-between gap-2 border-b border-border/60 py-1.5">
              <span className="min-w-0 truncate">
                {p.name}
                {p.detail ? <span className="ml-1.5 text-xs text-faint">{p.detail}</span> : null}
              </span>
              <span className="flex-shrink-0 whitespace-nowrap font-semibold tabular-nums">
                {formatProjection(p.proj)} <span className="text-xs font-normal text-muted">season proj</span>
              </span>
            </li>
          ))
        )}
      </ul>
      {summary ? (
        <p className="mt-1.5 text-xs text-muted">
          {summary} {total === null ? "—" : total.toFixed(1)} season proj pts
        </p>
      ) : null}
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
  const resolved = (
    await db()
      .select()
      .from(trades)
      .where(inArray(trades.status, ["executed", "vetoed", "failed"]))
      .orderBy(desc(trades.resolvedAt))
      .limit(RESOLVED_LIMIT)
  ).filter(enteredReview);

  const offers = (
    await db()
      .select()
      .from(trades)
      .where(inArray(trades.status, [...OFFER_STATUSES]))
      .orderBy(desc(trades.proposedAt))
      .limit(OFFERS_LIMIT)
  ).filter((t) => !enteredReview(t));
  // The counter each countered offer produced, which may be older than this
  // page's cut. One query by parent id rather than a self-join.
  const offerIds = offers.map((t) => t.id);
  const counters = offerIds.length
    ? await db()
        .select({ id: trades.id, parentTradeId: trades.parentTradeId })
        .from(trades)
        .where(inArray(trades.parentTradeId, offerIds))
    : [];
  const counterOf = new Map(counters.map((c) => [c.parentTradeId, c.id]));

  const all: Trade[] = [...inReview, ...resolved, ...offers];
  const playerIds = [...new Set(all.flatMap((t) => [...t.givePlayerIds, ...t.getPlayerIds]))];
  const playerRows = playerIds.length
    ? await db()
        .select({ playerId: players.playerId, fullName: players.fullName, position: players.position, nflTeam: players.nflTeam })
        .from(players)
        .where(inArray(players.playerId, playerIds))
    : [];
  const playerById = new Map(playerRows.map((p) => [p.playerId, p]));
  // §5.4: week 0 is the season-long projection, refreshed on demand through
  // a 1-hour TTL; the refresh never throws and a failed pull serves stored
  // rows. A player without a row shows a dash, never 0.0 — omit rather than
  // fabricate (§5.7).
  const season = settings?.season ?? now.getUTCFullYear();
  if (playerIds.length) {
    await ensureFreshProjections(db(), clock, { season, week: 0 }).catch(() => undefined);
  }
  const projRows = playerIds.length
    ? await db()
        .select({ playerId: playerWeekProj.playerId, proj: playerWeekProj.projPtsPpr })
        .from(playerWeekProj)
        .where(
          and(eq(playerWeekProj.season, season), eq(playerWeekProj.week, 0), inArray(playerWeekProj.playerId, playerIds)),
        )
    : [];
  const projOf = new Map(projRows.map((p) => [p.playerId, p.proj]));
  const offerPlayer = (id: string): OfferPlayer => {
    const p = playerById.get(id);
    return {
      id,
      name: p?.fullName ?? id,
      detail: p ? [p.position, p.nflTeam].filter(Boolean).join(" · ") : "",
      proj: projOf.get(id) ?? null,
    };
  };
  const proposerName = (t: Trade) => {
    const team = teamById.get(t.proposerTeamId);
    return team?.name ?? team?.modelLabel ?? team?.slug ?? "the proposer";
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
              const give = t.givePlayerIds.map(offerPlayer);
              const get = t.getPlayerIds.map(offerPlayer);
              const swing = swingLabel(
                sumProjections(give.map((p) => p.proj)),
                sumProjections(get.map((p) => p.proj)),
              );
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
                    <Side team={teamById.get(t.proposerTeamId)} label="Sends" players={give} summary="Giving up" />
                    <Side
                      team={teamById.get(t.counterpartyTeamId)}
                      label="Sends"
                      players={get}
                      summary="Receiving"
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                    {swing ? (
                      <Badge tone="accent">
                        {swing} to {proposerName(t)}
                      </Badge>
                    ) : null}
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
                      <Badge tone={t.status === "executed" ? "accent" : "danger"}>
                        {t.status === "failed" ? "failed after review" : t.status}
                      </Badge>
                    </div>
                    <div className="mt-2 flex flex-col gap-3 sm:flex-row">
                      <Side
                        team={teamById.get(t.proposerTeamId)}
                        label="Sent"
                        players={t.givePlayerIds.map(offerPlayer)}
                      />
                      <Side
                        team={teamById.get(t.counterpartyTeamId)}
                        label="Sent"
                        players={t.getPlayerIds.map(offerPlayer)}
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
                              <span className="text-muted">
                                {v.reason ? (
                                  <InlineMarkdown source={flattenMarkdown(v.reason)} id="vote" />
                                ) : null}
                              </span>
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

      <div className="mt-4">
        <Card title="Offers">
          {offers.length === 0 ? (
            <Empty>No offer has been made yet.</Empty>
          ) : (
            <div className="space-y-4">
              {offers.map((t) => {
                const give = t.givePlayerIds.map(offerPlayer);
                const get = t.getPlayerIds.map(offerPlayer);
                const swing = swingLabel(
                  sumProjections(give.map((p) => p.proj)),
                  sumProjections(get.map((p) => p.proj)),
                );
                const ending = offerEnding(t);
                const counterId = counterOf.get(t.id);
                return (
                  <div key={t.id} className="rounded-md border border-border/70 bg-background/40 p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-xs text-muted">
                        offer #{t.id} · proposed {when(t.proposedAt)} ET
                        {ending ? ` · ${ending.verb} ${when(ending.at)} ET` : ""}
                        {t.status === "failed" && t.resolutionReason ? ` · ${t.resolutionReason}` : ""}
                      </span>
                      <span className="flex items-baseline gap-2">
                        {t.status === "proposed" ? (
                          <Badge tone="warn">
                            {remaining(offerExpiresAt(t.proposedAt, settings?.tradeOfferExpiryHours ?? 48), now)}
                          </Badge>
                        ) : null}
                        <Badge tone={offerTone(t.status)}>{t.status}</Badge>
                      </span>
                    </div>
                    <div className="mt-2 flex flex-col gap-3 sm:flex-row">
                      <Side team={teamById.get(t.proposerTeamId)} label="Offers" players={give} summary="Giving up" />
                      <Side
                        team={teamById.get(t.counterpartyTeamId)}
                        label="Asked for"
                        players={get}
                        summary="Receiving"
                      />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                      {swing ? (
                        <Badge tone="accent">
                          {swing} to {proposerName(t)}
                        </Badge>
                      ) : null}
                      {t.parentTradeId ? (
                        <span className="text-xs text-muted">counter to #{t.parentTradeId}</span>
                      ) : null}
                      {counterId ? <span className="text-xs text-muted">countered by #{counterId}</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <p className="mt-3 text-xs text-muted">
        An offer&apos;s message stays between the two teams unless the trade enters league review, where the
        voters see it (§3.5, §11). An open offer expires after {settings?.tradeOfferExpiryHours ?? 48} hours
        with no response.
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
