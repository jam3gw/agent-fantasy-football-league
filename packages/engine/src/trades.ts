/**
 * Trade lifecycle (SPEC §3.5, §7.5): propose / respond (accept, reject,
 * counter) / cancel / vote / review resolution / expiry, and execution with
 * ghost lineup entries for locked players. Freeze and reservation reads live
 * in roster.ts; this module adds exclude-one-trade variants for re-validating
 * a trade against everything *else* that is open.
 */
import { and, asc, eq, gt, inArray, isNotNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "./db/index.ts";
import type { TradeStatus } from "./db/schema.ts";
import { lineupEntries, rosterEntries, sessions, teams, trades, tradeVotes } from "./db/schema.ts";
import type { EngineErrorCode, EngineFailure, EngineResult } from "./errors.ts";
import { fail, ok } from "./errors.ts";
import { handleEvent } from "./events.ts";
import { lockedPlayerIds } from "./locks.ts";
import { incomingReservedCount, irOccupant, maxActiveRoster } from "./roster.ts";
import type { LeagueSettings } from "./settings.ts";
import { getSettings } from "./settings.ts";
import { recordTransaction } from "./transactions.ts";

export type StoredTrade = typeof trades.$inferSelect;
export type StoredTradeVote = typeof tradeVotes.$inferSelect;

/** §3.5 failure reasons a trade can end with (`trades.resolution_reason`). */
export type TradeResolutionReason = "player_moved" | "roster_illegal" | "deadline_passed" | "team_paused";

export interface TradeProposalInput {
  toTeamId: number;
  givePlayerIds: string[];
  getPlayerIds: string[];
  message?: string | null;
}

export interface TradeCounterInput {
  givePlayerIds: string[];
  getPlayerIds: string[];
  message?: string | null;
}

export interface RespondToTradeResult {
  tradeId: number;
  status: TradeStatus;
  /** Set when action = 'counter': the id of the new offer. */
  counterTradeId?: number;
  /** Set when action = 'accept'. */
  reviewEndsAt?: Date;
  /** Set when action = 'accept': open offers ended because they shared a player with this one (§3.5). */
  supersededTradeIds?: number[];
}

const MAX_MESSAGE_CHARS = 500;
const MAX_VOTE_REASON_CHARS = 200;
/** "3 offers per day" is a rolling 24-hour window (§3.5). */
const OFFER_WINDOW_MS = 24 * 3600_000;

const maxActive = maxActiveRoster;

/**
 * Players `teamId` cannot put in an offer, with one trade excluded — used
 * when a trade re-validates itself on accept/execute ("nothing frozen
 * *elsewhere*", §3.5).
 *
 * Only a trade in review (`accepted`) freezes players for offers. An open
 * (`proposed`) offer binds nobody: a team may shop the same player to several
 * teams at once, and another team may ask for a player who is already in an
 * outgoing offer. The first accept wins — `supersedeOverlappingOffers` ends
 * every other open offer that shares a player. (Drops are stricter: roster.ts
 * `frozenPlayerIds` still holds a proposer's give-side while an offer is open,
 * so a player is never dropped out from under the offers he is in.)
 */
export async function frozenPlayerIdsExcluding(
  db: EngineDb,
  teamId: number,
  excludeTradeId?: number,
): Promise<Set<string>> {
  const conditions: Array<SQL<unknown> | undefined> = [
    eq(trades.status, "accepted"),
    or(eq(trades.proposerTeamId, teamId), eq(trades.counterpartyTeamId, teamId)),
  ];
  if (excludeTradeId !== undefined) conditions.push(ne(trades.id, excludeTradeId));
  const inReview = await db.select().from(trades).where(and(...conditions));
  const frozen = new Set<string>();
  for (const t of inReview) {
    if (t.proposerTeamId === teamId) for (const p of t.givePlayerIds) frozen.add(p);
    if (t.counterpartyTeamId === teamId) for (const p of t.getPlayerIds) frozen.add(p);
  }
  return frozen;
}

/**
 * Transaction-scoped advisory lock serialising every propose and accept.
 * An accept locks its own row and then every other open offer (to supersede
 * the overlapping ones); two accepts at once would take those locks in
 * opposite orders and deadlock. Taking this lock first, before any row lock,
 * makes them queue instead. Propose takes it too, so an offer cannot slip in
 * between an accept's supersede pass and its commit and escape it. Released
 * with the transaction. Key: arbitrary constant, unique to this use.
 */
const TRADE_OFFER_LOCK_KEY = 0x7472_6164; // "trad"

async function lockTradeOffers(tx: EngineDb): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${TRADE_OFFER_LOCK_KEY})`);
}

/**
 * Why an open offer was retired because another offer sharing one of its
 * players was accepted first (§3.5). Stored in `resolution_reason` as
 * `superseded by trade <id>`; the constant is the prefix.
 */
export const SUPERSEDED_REASON_PREFIX = "superseded by trade ";

/**
 * A `trade_response` session retired because its offer was superseded before
 * the counterparty answered. Like `MOOT_VOTE_REASON`, a healthy no-op.
 */
export const MOOT_OFFER_REASON = "offer superseded before this response was needed";
/** The same, for an offer that expired with its response session still queued. */
export const MOOT_OFFER_REASON_EXPIRED = "offer expired before this response was needed";

/**
 * The accept of `accepted` binds its players (§3.5). Every other open offer
 * that names any of those players — on either side, from any team — can no
 * longer be honoured, so it ends now as `superseded` rather than sitting open
 * until it fails at its own accept. The counterparty's queued response
 * session is retired with it. Emits `trade.superseded` per offer.
 */
async function supersedeOverlappingOffers(
  tx: EngineDb,
  clock: Clock,
  accepted: { id: number; givePlayerIds: string[]; getPlayerIds: string[] },
): Promise<number[]> {
  const now = clock.now();
  const bound = new Set([...accepted.givePlayerIds, ...accepted.getPlayerIds]);
  const open = await tx
    .select()
    .from(trades)
    .where(and(eq(trades.status, "proposed"), ne(trades.id, accepted.id)))
    .for("update");
  const hit = open.filter((t) => [...t.givePlayerIds, ...t.getPlayerIds].some((p) => bound.has(p)));
  const ids: number[] = [];
  for (const t of hit) {
    const done = await tx
      .update(trades)
      .set({
        status: "superseded",
        resolutionReason: `${SUPERSEDED_REASON_PREFIX}${accepted.id}`,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(and(eq(trades.id, t.id), eq(trades.status, "proposed")))
      .returning({ id: trades.id });
    if (done.length === 0) continue;
    await retireQueuedSessions(tx, clock, "trade_response", t.id, MOOT_OFFER_REASON);
    await handleEvent(tx, clock, { type: "trade.superseded", tradeId: t.id, byTradeId: accepted.id });
    ids.push(t.id);
  }
  return ids.sort((x, y) => x - y);
}

/** Subset of `playerIds` NOT on `teamId`'s roster. */
async function notOwned(tx: EngineDb, teamId: number, playerIds: string[]): Promise<string[]> {
  if (playerIds.length === 0) return [];
  const rows = await tx
    .select({ playerId: rosterEntries.playerId })
    .from(rosterEntries)
    .where(and(eq(rosterEntries.teamId, teamId), inArray(rosterEntries.playerId, playerIds)));
  const owned = new Set(rows.map((r) => r.playerId));
  return playerIds.filter((id) => !owned.has(id));
}

/**
 * Active count after the hypothetical move (§3.1 counts with IR occupancy):
 * roster − outgoing + incoming, minus 1 when the week's IR occupant remains on
 * the roster (a traded-away IR occupant empties the slot), plus reservations
 * from other accepted trades (§3.5).
 */
async function activeAfterTrade(
  tx: EngineDb,
  teamId: number,
  week: number,
  outgoing: string[],
  incoming: string[],
  excludeTradeId?: number,
): Promise<number> {
  const roster = await tx
    .select({ playerId: rosterEntries.playerId })
    .from(rosterEntries)
    .where(eq(rosterEntries.teamId, teamId));
  const out = new Set(outgoing);
  const size = roster.filter((r) => !out.has(r.playerId)).length + incoming.length;
  const ir = await irOccupant(tx, teamId, week);
  const irFilled = ir !== null && !out.has(ir) && roster.some((r) => r.playerId === ir);
  const reserved = await incomingReservedCount(tx, teamId, week, excludeTradeId);
  return size - (irFilled ? 1 : 0) + reserved;
}

interface ProposalParams {
  proposerTeamId: number;
  counterpartyTeamId: number;
  givePlayerIds: string[];
  getPlayerIds: string[];
  /** null skips the length check (accept re-validation of a stored offer). */
  message: string | null;
}

/**
 * Every §3.5 proposal check. Returns the first failure or null. Used verbatim
 * for propose and counter (with the offer limit) and re-run on accept (without
 * it, with this trade's own freeze excluded via `excludeTradeId`).
 */
async function checkProposal(
  tx: EngineDb,
  settings: LeagueSettings,
  now: Date,
  p: ProposalParams,
  opts: { excludeTradeId?: number; enforceOfferLimit: boolean },
): Promise<EngineFailure | null> {
  const week = settings.currentWeek;

  if (p.proposerTeamId === p.counterpartyTeamId) {
    return fail("invalid_args", "a team cannot trade with itself");
  }
  const teamRows = await tx
    .select()
    .from(teams)
    .where(inArray(teams.id, [p.proposerTeamId, p.counterpartyTeamId]));
  const proposer = teamRows.find((t) => t.id === p.proposerTeamId);
  const counterparty = teamRows.find((t) => t.id === p.counterpartyTeamId);
  if (!proposer) return fail("not_found", `team ${p.proposerTeamId} not found`);
  if (!counterparty) return fail("not_found", `team ${p.counterpartyTeamId} not found`);
  if (proposer.paused || counterparty.paused) {
    return fail("team_paused", "offers cannot be made to or by a paused team");
  }

  if (p.givePlayerIds.length === 0 && p.getPlayerIds.length === 0) {
    return fail("invalid_args", "an offer must include at least one player");
  }
  const all = [...p.givePlayerIds, ...p.getPlayerIds];
  if (new Set(all).size !== all.length) {
    return fail("invalid_args", "duplicate or overlapping player ids in the offer");
  }
  if (p.message !== null && p.message.length > MAX_MESSAGE_CHARS) {
    return fail("invalid_args", `message exceeds ${MAX_MESSAGE_CHARS} characters`);
  }

  if (opts.enforceOfferLimit) {
    const cutoff = new Date(now.getTime() - OFFER_WINDOW_MS);
    const rows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(trades)
      .where(and(eq(trades.proposerTeamId, p.proposerTeamId), gt(trades.proposedAt, cutoff)));
    if ((rows[0]?.n ?? 0) >= settings.tradeMaxOffersPerDay) {
      return fail(
        "offer_limit",
        `at most ${settings.tradeMaxOffersPerDay} offers per rolling 24 hours`,
        { hint: "counters count toward the limit; wait for the window to slide" },
      );
    }
  }

  if (week > settings.tradeDeadlineWeek) {
    return fail("deadline_passed", `the trade deadline has passed (after week ${settings.tradeDeadlineWeek})`);
  }

  const missingGive = await notOwned(tx, p.proposerTeamId, p.givePlayerIds);
  if (missingGive.length > 0) {
    return fail("not_on_roster", `give-side player(s) not on the proposer's roster: ${missingGive.join(", ")}`);
  }
  const missingGet = await notOwned(tx, p.counterpartyTeamId, p.getPlayerIds);
  if (missingGet.length > 0) {
    return fail("not_on_roster", `get-side player(s) not on the counterparty's roster: ${missingGet.join(", ")}`);
  }

  const frozenGive = await frozenPlayerIdsExcluding(tx, p.proposerTeamId, opts.excludeTradeId);
  const giveFrozen = p.givePlayerIds.filter((id) => frozenGive.has(id));
  if (giveFrozen.length > 0) {
    return fail("frozen", `give-side player(s) frozen in another trade: ${giveFrozen.join(", ")}`);
  }
  const frozenGet = await frozenPlayerIdsExcluding(tx, p.counterpartyTeamId, opts.excludeTradeId);
  const getFrozen = p.getPlayerIds.filter((id) => frozenGet.has(id));
  if (getFrozen.length > 0) {
    return fail("frozen", `get-side player(s) frozen in another trade: ${getFrozen.join(", ")}`);
  }

  const cap = maxActive(settings);
  const proposerActive = await activeAfterTrade(
    tx, p.proposerTeamId, week, p.givePlayerIds, p.getPlayerIds, opts.excludeTradeId,
  );
  if (proposerActive > cap) {
    return fail("roster_illegal", `the trade would put the proposer at ${proposerActive} active players (max ${cap})`);
  }
  const counterpartyActive = await activeAfterTrade(
    tx, p.counterpartyTeamId, week, p.getPlayerIds, p.givePlayerIds, opts.excludeTradeId,
  );
  if (counterpartyActive > cap) {
    return fail("roster_illegal", `the trade would put the counterparty at ${counterpartyActive} active players (max ${cap})`);
  }
  return null;
}

/** Map an accept re-check failure to §3.5's resolution reasons. */
function acceptResolution(code: EngineErrorCode): TradeResolutionReason {
  switch (code) {
    case "team_paused":
      return "team_paused";
    case "deadline_passed":
      return "deadline_passed";
    case "roster_illegal":
      return "roster_illegal";
    default:
      // not_on_roster, frozen (elsewhere), anything else: the player is no
      // longer available for this trade.
      return "player_moved";
  }
}

/** Shared insert path for propose and counter: validate, insert, emit. */
async function createOffer(
  tx: EngineDb,
  clock: Clock,
  settings: LeagueSettings,
  proposerTeamId: number,
  counterpartyTeamId: number,
  givePlayerIds: string[],
  getPlayerIds: string[],
  message: string | null,
  parentTradeId: number | null,
  excludeTradeId?: number,
): Promise<EngineResult<{ tradeId: number }>> {
  const now = clock.now();
  const failure = await checkProposal(
    tx,
    settings,
    now,
    { proposerTeamId, counterpartyTeamId, givePlayerIds, getPlayerIds, message },
    { enforceOfferLimit: true, ...(excludeTradeId !== undefined ? { excludeTradeId } : {}) },
  );
  if (failure) return failure;
  const rows = await tx
    .insert(trades)
    .values({
      proposerTeamId,
      counterpartyTeamId,
      givePlayerIds,
      getPlayerIds,
      message,
      status: "proposed",
      proposedAt: now,
      parentTradeId,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: trades.id });
  const tradeId = rows[0]!.id;
  // No public transaction yet — trades become public transactions on execution.
  await handleEvent(tx, clock, { type: "trade.proposed", tradeId, proposerTeamId, counterpartyTeamId });
  return ok({ tradeId });
}

/** Propose a trade (§3.5). Status 'proposed'; emits `trade.proposed`. */
export async function proposeTrade(
  db: EngineDb,
  clock: Clock,
  proposerTeamId: number,
  input: TradeProposalInput,
): Promise<EngineResult<{ tradeId: number }>> {
  return db.transaction(async (tx) => {
    await lockTradeOffers(tx);
    const settings = await getSettings(tx);
    return createOffer(
      tx,
      clock,
      settings,
      proposerTeamId,
      input.toTeamId,
      input.givePlayerIds,
      input.getPlayerIds,
      input.message ?? null,
      null,
    );
  });
}

/**
 * Counterparty response to a 'proposed' offer (§3.5): accept (re-runs every
 * proposal check; enters 24-hour review), reject, or counter (a new offer from
 * the counterparty; the original becomes 'countered').
 */
export async function respondToTrade(
  db: EngineDb,
  clock: Clock,
  teamId: number,
  tradeId: number,
  action: "accept" | "reject" | "counter",
  counter?: TradeCounterInput,
): Promise<EngineResult<RespondToTradeResult>> {
  return db.transaction(async (tx) => {
    // Serialise with every other propose/accept first (see lockTradeOffers),
    // then lock the row so the status we read is the status we update.
    await lockTradeOffers(tx);
    const settings = await getSettings(tx);
    const now = clock.now();
    const tradeRows = await tx.select().from(trades).where(eq(trades.id, tradeId)).for("update");
    const trade = tradeRows[0];
    if (!trade) return fail("not_found", `trade ${tradeId} not found`);
    if (trade.counterpartyTeamId !== teamId) {
      return fail("not_your_trade", `trade ${tradeId} was not offered to team ${teamId}`);
    }
    if (trade.status !== "proposed") {
      return fail("bad_status", `trade ${tradeId} is '${trade.status}', not 'proposed'`);
    }

    // Expired offer (§3.5: offers expire after trade_offer_expiry_hours).
    const expiresAt = trade.proposedAt.getTime() + settings.tradeOfferExpiryHours * 3600_000;
    if (expiresAt < now.getTime()) {
      await tx.update(trades).set({ status: "expired", resolvedAt: now, updatedAt: now }).where(eq(trades.id, tradeId));
      return fail("deadline_passed", "offer expired", {
        hint: `offers expire after ${settings.tradeOfferExpiryHours} hours with no response`,
      });
    }

    if (action === "reject") {
      await tx.update(trades).set({ status: "rejected", respondedAt: now, updatedAt: now }).where(eq(trades.id, tradeId));
      return ok({ tradeId, status: "rejected" as TradeStatus });
    }

    if (action === "counter") {
      if (!counter) return fail("invalid_args", "a counter needs givePlayerIds and getPlayerIds");
      // The counter replaces the original offer, so the original's freeze is
      // excluded — countering with the originally offered players must work.
      const created = await createOffer(
        tx,
        clock,
        settings,
        teamId,
        trade.proposerTeamId,
        counter.givePlayerIds,
        counter.getPlayerIds,
        counter.message ?? null,
        tradeId,
        tradeId,
      );
      if (!created.ok) return created;
      await tx.update(trades).set({ status: "countered", respondedAt: now, updatedAt: now }).where(eq(trades.id, tradeId));
      return ok({ tradeId, status: "countered" as TradeStatus, counterTradeId: created.value.tradeId });
    }

    // accept: re-run every proposal check (§3.5), excluding this trade's own
    // freeze; no offer limit (accepting is not a new offer).
    const failure = await checkProposal(
      tx,
      settings,
      now,
      {
        proposerTeamId: trade.proposerTeamId,
        counterpartyTeamId: trade.counterpartyTeamId,
        givePlayerIds: trade.givePlayerIds,
        getPlayerIds: trade.getPlayerIds,
        message: null,
      },
      { enforceOfferLimit: false, excludeTradeId: tradeId },
    );
    if (failure) {
      const reason = acceptResolution(failure.error);
      await tx
        .update(trades)
        .set({ status: "failed", resolutionReason: reason, respondedAt: now, resolvedAt: now, updatedAt: now })
        .where(eq(trades.id, tradeId));
      await handleEvent(tx, clock, { type: "trade.failed", tradeId, reason });
      return fail(reason, failure.message, failure.hint ? { hint: failure.hint } : {});
    }
    const reviewEndsAt = new Date(now.getTime() + settings.tradeReviewHours * 3600_000);
    const accepted = await tx
      .update(trades)
      .set({ status: "accepted", respondedAt: now, reviewEndsAt, updatedAt: now })
      .where(and(eq(trades.id, tradeId), eq(trades.status, "proposed")))
      .returning({ id: trades.id });
    if (accepted.length === 0) {
      // Superseded between our read and our write (the row lock makes this a
      // belt-and-braces check, never the normal path).
      const fresh = (await tx.select().from(trades).where(eq(trades.id, tradeId)))[0];
      return fail("bad_status", `trade ${tradeId} is '${fresh?.status ?? "gone"}', not 'proposed'`);
    }
    const supersededTradeIds = await supersedeOverlappingOffers(tx, clock, {
      id: tradeId,
      givePlayerIds: trade.givePlayerIds,
      getPlayerIds: trade.getPlayerIds,
    });
    await handleEvent(tx, clock, {
      type: "trade.accepted",
      tradeId,
      partyTeamIds: [trade.proposerTeamId, trade.counterpartyTeamId],
      reviewEndsAt,
    });
    return ok({ tradeId, status: "accepted" as TradeStatus, reviewEndsAt, supersededTradeIds });
  });
}

/** Proposer cancels a pending ('proposed') offer. */
export async function cancelTrade(
  db: EngineDb,
  clock: Clock,
  teamId: number,
  tradeId: number,
): Promise<EngineResult<{ tradeId: number; status: TradeStatus }>> {
  return db.transaction(async (tx) => {
    const now = clock.now();
    const tradeRows = await tx.select().from(trades).where(eq(trades.id, tradeId));
    const trade = tradeRows[0];
    if (!trade) return fail("not_found", `trade ${tradeId} not found`);
    if (trade.proposerTeamId !== teamId) {
      return fail("not_your_trade", `trade ${tradeId} was not proposed by team ${teamId}`);
    }
    if (trade.status !== "proposed") {
      return fail("bad_status", `trade ${tradeId} is '${trade.status}', not 'proposed'`);
    }
    await tx.update(trades).set({ status: "cancelled", resolvedAt: now, updatedAt: now }).where(eq(trades.id, tradeId));
    return ok({ tradeId, status: "cancelled" as TradeStatus });
  });
}

/**
 * One vote from an uninvolved team on a trade in review (§3.5). Vetoed when
 * vetoes reach trade_veto_votes (7); executed immediately when effective
 * allows (cast allow votes + paused uninvolved teams, whose votes count as
 * allow) make that many vetoes impossible (4 with defaults).
 */
export async function voteOnTrade(
  db: EngineDb,
  clock: Clock,
  teamId: number,
  tradeId: number,
  vote: "allow" | "veto",
  reason: string,
): Promise<EngineResult<{ vetoes: number; allows: number; status: TradeStatus }>> {
  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    const now = clock.now();
    if (!reason || reason.trim().length === 0) {
      return fail("invalid_args", "a one-line reason is required with a vote");
    }
    if (reason.length > MAX_VOTE_REASON_CHARS) {
      return fail("too_long", `vote reason must be at most ${MAX_VOTE_REASON_CHARS} characters`);
    }
    // Lock the trade row for the whole vote. Two votes arriving together would
    // otherwise both read three allows, both insert, and both try to execute —
    // the second finding the players already moved and failing a trade that
    // had in fact succeeded.
    const tradeRows = await tx.select().from(trades).where(eq(trades.id, tradeId)).for("update");
    const trade = tradeRows[0];
    if (!trade) return fail("not_found", `trade ${tradeId} not found`);
    if (trade.status !== "accepted") {
      return fail("bad_status", `trade ${tradeId} is '${trade.status}', not in review`);
    }
    if (trade.reviewEndsAt !== null && trade.reviewEndsAt.getTime() <= now.getTime()) {
      return fail("bad_status", "the review window has ended");
    }
    const allTeams = await tx.select().from(teams);
    const voter = allTeams.find((t) => t.id === teamId);
    if (!voter) return fail("not_found", `team ${teamId} not found`);
    const parties = [trade.proposerTeamId, trade.counterpartyTeamId];
    if (parties.includes(teamId)) {
      return fail("not_eligible_to_vote", "teams in the trade do not vote on it");
    }
    if (voter.paused) {
      return fail("not_eligible_to_vote", "a paused team's vote counts as allow automatically");
    }
    const existing = await tx
      .select()
      .from(tradeVotes)
      .where(and(eq(tradeVotes.tradeId, tradeId), eq(tradeVotes.teamId, teamId)));
    if (existing.length > 0) return fail("already_voted", `team ${teamId} already voted on trade ${tradeId}`);

    await tx.insert(tradeVotes).values({ tradeId, teamId, vote, reason, createdAt: now });
    const votes = await tx.select().from(tradeVotes).where(eq(tradeVotes.tradeId, tradeId));
    const vetoes = votes.filter((v) => v.vote === "veto").length;
    const pausedUninvolved = allTeams.filter((t) => t.paused && !parties.includes(t.id)).length;
    const allows = votes.filter((v) => v.vote === "allow").length + pausedUninvolved;
    await handleEvent(tx, clock, { type: "trade.vote_cast", tradeId, vetoes, allows });

    const uninvolvedCount = allTeams.length - 2;
    const allowThreshold = uninvolvedCount - settings.tradeVetoVotes + 1; // 4 with defaults
    let status: TradeStatus = "accepted";
    if (vetoes >= settings.tradeVetoVotes) {
      await vetoTrade(tx, clock, trade.id);
      status = "vetoed";
    } else if (allows >= allowThreshold) {
      const result = await executeTrade(tx, clock, settings, trade);
      status = result.status;
    }
    return ok({ vetoes, allows, status });
  });
}

/**
 * Resolve every 'accepted' trade whose review window has ended (called by the
 * per-minute tick): veto at trade_veto_votes cast vetoes, execute otherwise
 * (no vote counts as allow at window end).
 */
export async function resolveEndedReviews(
  db: EngineDb,
  clock: Clock,
): Promise<EngineResult<Array<{ tradeId: number; status: TradeStatus; reason?: TradeResolutionReason }>>> {
  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    const now = clock.now();
    const due = await tx
      .select()
      .from(trades)
      .where(and(eq(trades.status, "accepted"), isNotNull(trades.reviewEndsAt), lte(trades.reviewEndsAt, now)))
      .orderBy(asc(trades.id));
    const results: Array<{ tradeId: number; status: TradeStatus; reason?: TradeResolutionReason }> = [];
    for (const trade of due) {
      const votes = await tx.select().from(tradeVotes).where(eq(tradeVotes.tradeId, trade.id));
      const vetoes = votes.filter((v) => v.vote === "veto").length;
      if (vetoes >= settings.tradeVetoVotes) {
        await vetoTrade(tx, clock, trade.id);
        results.push({ tradeId: trade.id, status: "vetoed" });
      } else {
        const result = await executeTrade(tx, clock, settings, trade);
        results.push({
          tradeId: trade.id,
          status: result.status,
          ...(result.reason ? { reason: result.reason } : {}),
        });
      }
    }
    return ok(results);
  });
}

/** Expire every 'proposed' offer older than trade_offer_expiry_hours. */
export async function expireOffers(db: EngineDb, clock: Clock): Promise<EngineResult<number[]>> {
  return db.transaction(async (tx) => {
    const settings = await getSettings(tx);
    const now = clock.now();
    const cutoff = new Date(now.getTime() - settings.tradeOfferExpiryHours * 3600_000);
    const rows = await tx
      .update(trades)
      .set({ status: "expired", resolvedAt: now, updatedAt: now })
      .where(and(eq(trades.status, "proposed"), lt(trades.proposedAt, cutoff)))
      .returning({ id: trades.id });
    for (const r of rows) await retireQueuedSessions(tx, clock, "trade_response", r.id, MOOT_OFFER_REASON_EXPIRED);
    return ok(rows.map((r) => r.id).sort((a, b) => a - b));
  });
}

/**
 * Trade-deadline sweep (§3.5): when current_week becomes trade_deadline_week+1
 * every 'proposed' offer expires. Trades in review finish their review.
 */
export async function expireAllProposedAtDeadline(db: EngineDb, clock: Clock): Promise<EngineResult<number[]>> {
  return db.transaction(async (tx) => {
    const now = clock.now();
    const rows = await tx
      .update(trades)
      .set({ status: "expired", resolvedAt: now, updatedAt: now })
      .where(eq(trades.status, "proposed"))
      .returning({ id: trades.id });
    for (const r of rows) await retireQueuedSessions(tx, clock, "trade_response", r.id, MOOT_OFFER_REASON_EXPIRED);
    return ok(rows.map((r) => r.id).sort((a, b) => a - b));
  });
}

/** End a trade as 'failed' with a resolution reason; emits `trade.failed`. */
async function markFailed(
  tx: EngineDb,
  clock: Clock,
  tradeId: number,
  reason: TradeResolutionReason,
): Promise<{ status: "failed"; reason: TradeResolutionReason }> {
  const now = clock.now();
  await tx
    .update(trades)
    .set({ status: "failed", resolutionReason: reason, resolvedAt: now, updatedAt: now })
    .where(eq(trades.id, tradeId));
  // Freeze and reservation are computed from open trades, so 'failed' unfreezes
  // by itself (§7.5 "unfreeze players": nothing to store).
  await retireQueuedVoteSessions(tx, clock, tradeId);
  await handleEvent(tx, clock, { type: "trade.failed", tradeId, reason });
  return { status: "failed", reason };
}

/** End a trade as 'vetoed'; emits `trade.vetoed`. Votes become public (site concern). */
async function vetoTrade(tx: EngineDb, clock: Clock, tradeId: number): Promise<void> {
  const now = clock.now();
  await tx.update(trades).set({ status: "vetoed", resolvedAt: now, updatedAt: now }).where(eq(trades.id, tradeId));
  await retireQueuedVoteSessions(tx, clock, tradeId);
  await handleEvent(tx, clock, { type: "trade.vetoed", tradeId });
}

/**
 * Retire the still-queued `trade_vote` sessions for a trade that just left
 * review. §3.5 executes a trade the moment allow votes reach the threshold —
 * hours before the 24-hour `reviewEndsAt` the sessions were booked with as
 * their deadline — and nothing else ever lowers that deadline, so the unrun
 * sessions each burned a full session discovering there was nothing left to
 * vote on (18 of them, ~$1.53, across three trades in one 48h stretch;
 * found 2026-09-03). A session already `running` is left to finish: it may
 * be mid-vote, and interrupting a live run is not this function's business.
 *
 * Retired rows carry `MOOT_VOTE_REASON` and no `ended_by`: they are not a
 * loop guard and not a failure, and the digest keys on the reason to keep
 * nine healthy no-ops per trade out of its failed-sessions table.
 */
export const MOOT_VOTE_REASON = "trade resolved before this vote was needed";

async function retireQueuedVoteSessions(tx: EngineDb, clock: Clock, tradeId: number): Promise<void> {
  await retireQueuedSessions(tx, clock, "trade_vote", tradeId, MOOT_VOTE_REASON);
}

/** Skip every still-queued session of `kind` booked for `tradeId`, with `reason` as its error text. */
async function retireQueuedSessions(
  tx: EngineDb,
  clock: Clock,
  kind: "trade_vote" | "trade_response",
  tradeId: number,
  reason: string,
): Promise<void> {
  const now = clock.now();
  await tx
    .update(sessions)
    .set({ status: "skipped", endedBy: null, error: reason, endedAt: now, updatedAt: now })
    .where(
      and(
        eq(sessions.kind, kind),
        eq(sessions.status, "queued"),
        sql`${sessions.context} ->> 'trade_id' = ${String(tradeId)}`,
      ),
    );
}

/**
 * Trade execution (§7.5), inside the caller's transaction. Re-validates
 * ownership and roster legality; on failure the trade ends 'failed'. On
 * success players move (arriving on the bench), a locked outgoing player's
 * current-week lineup entry stays with the old team as a ghost for scoring,
 * and one public 'trade' transaction is recorded.
 */
async function executeTrade(
  tx: EngineDb,
  clock: Clock,
  settings: LeagueSettings,
  trade: StoredTrade,
): Promise<{ status: "executed" | "failed"; reason?: TradeResolutionReason }> {
  const now = clock.now();
  const week = settings.currentWeek;
  const a = trade.proposerTeamId;
  const b = trade.counterpartyTeamId;

  const missingGive = await notOwned(tx, a, trade.givePlayerIds);
  const missingGet = await notOwned(tx, b, trade.getPlayerIds);
  if (missingGive.length > 0 || missingGet.length > 0) {
    return markFailed(tx, clock, trade.id, "player_moved");
  }
  const cap = maxActive(settings);
  const aActive = await activeAfterTrade(tx, a, week, trade.givePlayerIds, trade.getPlayerIds, trade.id);
  const bActive = await activeAfterTrade(tx, b, week, trade.getPlayerIds, trade.givePlayerIds, trade.id);
  if (aActive > cap || bActive > cap) {
    return markFailed(tx, clock, trade.id, "roster_illegal");
  }

  const allIds = [...trade.givePlayerIds, ...trade.getPlayerIds];
  const locked = await lockedPlayerIds(tx, clock, settings.season, week, allIds);
  const moves = [
    ...trade.givePlayerIds.map((playerId) => ({ playerId, from: a, to: b })),
    ...trade.getPlayerIds.map((playerId) => ({ playerId, from: b, to: a })),
  ];
  for (const m of moves) {
    await tx
      .delete(rosterEntries)
      .where(and(eq(rosterEntries.teamId, m.from), eq(rosterEntries.playerId, m.playerId)));
    await tx
      .insert(rosterEntries)
      .values({ teamId: m.to, playerId: m.playerId, acquiredVia: "trade", acquiredAt: now });
    // Current week: a locked player's entry stays with the old team as a ghost
    // (still scores for it, immutable); otherwise the entry is deleted. The
    // receiving team gets no entry (bench, §7.8). Week W+1 always clears.
    const weeksToClear = locked.has(m.playerId) ? [week + 1] : [week, week + 1];
    await tx
      .delete(lineupEntries)
      .where(
        and(
          eq(lineupEntries.teamId, m.from),
          eq(lineupEntries.playerId, m.playerId),
          inArray(lineupEntries.week, weeksToClear),
        ),
      );
  }

  await recordTransaction(tx, {
    type: "trade",
    week,
    teamIds: [a, b],
    payload: {
      tradeId: trade.id,
      proposerTeamId: a,
      counterpartyTeamId: b,
      givePlayerIds: trade.givePlayerIds,
      getPlayerIds: trade.getPlayerIds,
    },
  });
  await tx.update(trades).set({ status: "executed", resolvedAt: now, updatedAt: now }).where(eq(trades.id, trade.id));
  await retireQueuedVoteSessions(tx, clock, trade.id);
  await handleEvent(tx, clock, { type: "trade.executed", tradeId: trade.id });
  return { status: "executed" };
}
