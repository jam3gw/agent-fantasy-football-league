/**
 * The context snapshot (SPEC §8.5): the compact JSON that follows the brief in
 * every session's first user message. Same shape for every model.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { formatEt, nextEtTime } from "@league/shared";
import type { SessionKind } from "@league/engine";
import {
  STARTING_SLOTS,
  boardPosts,
  computeStandings,
  decisionLogs,
  draft,
  getSettings,
  lineupEntries,
  lockedPlayerIds,
  matchups,
  nflGames,
  playerWeekProj,
  playerWeekStats,
  players,
  readScratchpad,
  rosterEntries,
  teamWeekResults,
  teams,
  trades,
  tradeVotes,
  waiverClaims,
} from "@league/engine";
import type { ToolContext } from "./tools/types.ts";

export interface ContextSnapshot {
  now_et: string;
  season: number;
  week: number;
  phase: string;
  deadline_at: string | null;
  next_waiver_run_et: string;
  /** Present before and during the draft: when the draft is set to start. */
  draft_scheduled_et?: string;
  next_locks: Array<{ nfl_team: string; kickoff_et: string }>;
  trade_deadline_week: number;
  my_team?: MyTeam;
  last_week_result?: LastWeekResult;
  this_week_matchup?: MatchupView;
  pending?: PendingItems;
  board: Array<{ id: number; team: string | null; body: string; at: string }>;
  scratchpad?: string;
  recent_decisions?: string[];
  kind_data?: Record<string, unknown>;
}

interface MyTeam {
  id: number;
  name: string | null;
  model: string;
  record: { wins: number; losses: number; ties: number; points_for: number };
  waiver_priority: number | null;
  roster: Array<{
    player_id: string;
    name: string;
    position: string | null;
    nfl_team: string | null;
    slot: string; // starting slot, "BN", or "IR"
    injury_status: string | null;
    locked: boolean;
    bye: boolean;
    points_this_week: number | null;
    proj_pts_ppr: number | null;
  }>;
}

interface LastWeekResult {
  week: number;
  my_points: number;
  opponent: string | null;
  opponent_points: number;
  by_starter: Array<{ slot: string; player_id: string; name: string; points: number }>;
  optimal_points: number;
  points_left_on_bench: number;
}

interface MatchupView {
  week: number;
  opponent_team_id: number | null;
  opponent_name: string | null;
  my_points: number | null;
  opponent_points: number | null;
}

interface PendingItems {
  offers_to_me: Array<{ trade_id: number; from_team_id: number; give: string[]; get: string[] }>;
  offers_from_me: Array<{ trade_id: number; to_team_id: number }>;
  votes_owed: Array<{ trade_id: number; review_ends_at: string }>;
  my_waiver_claims: Array<{ add_player_id: string; drop_player_id: string | null; priority: number }>;
  roster_flags: string[];
}

export async function buildContextSnapshot(ctx: ToolContext): Promise<ContextSnapshot> {
  const { db, clock } = ctx;
  const settings = await getSettings(db);
  const now = clock.now();
  const week = settings.currentWeek;

  const [hh, mm] = settings.waiverRunTimeEt.split(":").map(Number);
  const nextWaiver = nextEtTime(now, hh ?? 4, mm ?? 30, { strict: true });

  const upcoming = await db
    .select()
    .from(nflGames)
    .where(and(eq(nflGames.season, settings.season), eq(nflGames.week, week)));
  const nextLocks = upcoming
    .filter((g) => g.kickoffAt > now)
    .sort((a, b) => a.kickoffAt.getTime() - b.kickoffAt.getTime())
    .slice(0, 6)
    .flatMap((g) => [
      { nfl_team: g.home, kickoff_et: formatEt(g.kickoffAt) },
      { nfl_team: g.away, kickoff_et: formatEt(g.kickoffAt) },
    ]);

  const snapshot: ContextSnapshot = {
    now_et: formatEt(now),
    season: settings.season,
    week,
    phase: settings.phase,
    deadline_at: (ctx.sessionContext.deadline_at as string | undefined) ?? null,
    next_waiver_run_et: formatEt(nextWaiver),
    next_locks: nextLocks,
    trade_deadline_week: settings.tradeDeadlineWeek,
    board: [],
  };

  // §10.1: before the draft, every session sees when the draft is set to
  // start — onboarding plans around it, and pre-draft check-ins are only
  // useful before it. The commissioner sets it on /admin/settings.
  if (settings.phase === "pre_draft" || settings.phase === "drafting") {
    const scheduledAt = (settings.extra as Record<string, unknown>).draftScheduledAt;
    snapshot.draft_scheduled_et =
      typeof scheduledAt === "string" && !Number.isNaN(Date.parse(scheduledAt))
        ? formatEt(new Date(scheduledAt))
        : "not scheduled yet — the commissioner starts the draft manually";
  }

  // Last 10 board posts (§8.5); for board_reply the thread is added as kind data.
  const posts = await db
    .select({
      id: boardPosts.id,
      teamId: boardPosts.teamId,
      body: boardPosts.body,
      createdAt: boardPosts.createdAt,
    })
    .from(boardPosts)
    .orderBy(desc(boardPosts.createdAt))
    .limit(10);
  const allTeams = await db.select().from(teams);
  const teamName = (id: number) => allTeams.find((t) => t.id === id)?.name ?? null;
  snapshot.board = posts.reverse().map((p) => ({
    id: p.id,
    team: teamName(p.teamId),
    body: p.body,
    at: formatEt(p.createdAt),
  }));

  if (ctx.teamId === null) return snapshot; // reporter: league-wide view only

  const teamId = ctx.teamId;
  const team = allTeams.find((t) => t.id === teamId);
  if (!team) return snapshot;

  const standings = await computeStandings(db);
  const myStanding = standings.find((s) => s.teamId === teamId);

  // Roster with slot, lock, bye, points, projection.
  const roster = await db
    .select({
      playerId: rosterEntries.playerId,
      name: players.fullName,
      position: players.position,
      nflTeam: players.nflTeam,
      injuryStatus: players.injuryStatus,
    })
    .from(rosterEntries)
    .innerJoin(players, eq(players.playerId, rosterEntries.playerId))
    .where(eq(rosterEntries.teamId, teamId));

  const entries = await db
    .select({ playerId: lineupEntries.playerId, slot: lineupEntries.slot })
    .from(lineupEntries)
    .where(and(eq(lineupEntries.teamId, teamId), eq(lineupEntries.week, week)));
  const slotOf = new Map(entries.map((e) => [e.playerId, e.slot as string]));

  const rosterIds = roster.map((r) => r.playerId);
  const locked = await lockedPlayerIds(db, clock, settings.season, week, rosterIds);
  const teamsWithGames = new Set(upcoming.flatMap((g) => [g.home, g.away]));

  const stats = rosterIds.length
    ? await db
        .select({ playerId: playerWeekStats.playerId, ptsPpr: playerWeekStats.ptsPpr })
        .from(playerWeekStats)
        .where(
          and(
            eq(playerWeekStats.season, settings.season),
            eq(playerWeekStats.week, week),
            inArray(playerWeekStats.playerId, rosterIds),
          ),
        )
    : [];
  const ptsOf = new Map(stats.map((s) => [s.playerId, s.ptsPpr]));
  // Every session opens on live projections, not the last daily ingest.
  if (rosterIds.length) await ctx.refreshProjections?.(settings.season, week);
  const projRows = rosterIds.length
    ? await db
        .select({ playerId: playerWeekProj.playerId, proj: playerWeekProj.projPtsPpr })
        .from(playerWeekProj)
        .where(
          and(
            eq(playerWeekProj.season, settings.season),
            eq(playerWeekProj.week, week),
            inArray(playerWeekProj.playerId, rosterIds),
          ),
        )
    : [];
  const projOf = new Map(projRows.map((p) => [p.playerId, p.proj]));

  snapshot.my_team = {
    id: teamId,
    name: team.name,
    model: team.modelLabel,
    record: {
      wins: myStanding?.wins ?? 0,
      losses: myStanding?.losses ?? 0,
      ties: myStanding?.ties ?? 0,
      points_for: myStanding?.pointsFor ?? 0,
    },
    waiver_priority: team.waiverPriority,
    roster: roster.map((r) => ({
      player_id: r.playerId,
      name: r.name,
      position: r.position,
      nfl_team: r.nflTeam,
      slot: slotOf.get(r.playerId) ?? "BN",
      injury_status: r.injuryStatus,
      locked: locked.has(r.playerId),
      bye: r.nflTeam ? !teamsWithGames.has(r.nflTeam) : false,
      points_this_week: ptsOf.get(r.playerId) ?? null,
      proj_pts_ppr: projOf.get(r.playerId) ?? null,
    })),
  };

  // Last week's result — carried for weekly_review and post_waivers (§8.5).
  if ((ctx.kind === "weekly_review" || ctx.kind === "post_waivers") && week > 1) {
    const lastWeek = week - 1;
    const m = (await db.select().from(matchups).where(eq(matchups.week, lastWeek))).find(
      (x) => x.homeTeamId === teamId || x.awayTeamId === teamId,
    );
    if (m) {
      const isHome = m.homeTeamId === teamId;
      const oppId = isHome ? m.awayTeamId : m.homeTeamId;
      const priorEntries = await db
        .select({ playerId: lineupEntries.playerId, slot: lineupEntries.slot })
        .from(lineupEntries)
        .where(and(eq(lineupEntries.teamId, teamId), eq(lineupEntries.week, lastWeek)));
      const starterEntries = priorEntries.filter((e) =>
        (STARTING_SLOTS as readonly string[]).includes(e.slot),
      );
      const ids = starterEntries.map((e) => e.playerId);
      const priorStats = ids.length
        ? await db
            .select({ playerId: playerWeekStats.playerId, ptsPpr: playerWeekStats.ptsPpr })
            .from(playerWeekStats)
            .where(
              and(
                eq(playerWeekStats.season, settings.season),
                eq(playerWeekStats.week, lastWeek),
                inArray(playerWeekStats.playerId, ids),
              ),
            )
        : [];
      const priorPts = new Map(priorStats.map((s) => [s.playerId, s.ptsPpr ?? 0]));
      const names = ids.length
        ? await db
            .select({ playerId: players.playerId, name: players.fullName })
            .from(players)
            .where(inArray(players.playerId, ids))
        : [];
      const nameOf = new Map(names.map((n) => [n.playerId, n.name]));
      const results = (
        await db
          .select()
          .from(teamWeekResults)
          .where(and(eq(teamWeekResults.teamId, teamId), eq(teamWeekResults.week, lastWeek)))
      )[0];
      snapshot.last_week_result = {
        week: lastWeek,
        my_points: (isHome ? m.homePoints : m.awayPoints) ?? 0,
        opponent: teamName(oppId),
        opponent_points: (isHome ? m.awayPoints : m.homePoints) ?? 0,
        by_starter: starterEntries.map((e) => ({
          slot: e.slot,
          player_id: e.playerId,
          name: nameOf.get(e.playerId) ?? e.playerId,
          points: priorPts.get(e.playerId) ?? 0,
        })),
        optimal_points: results?.optimalPoints ?? 0,
        points_left_on_bench: results?.pointsLeftOnBench ?? 0,
      };
    }
  }

  // This week's matchup.
  const thisWeek = (await db.select().from(matchups).where(eq(matchups.week, week))).find(
    (x) => x.homeTeamId === teamId || x.awayTeamId === teamId,
  );
  if (thisWeek) {
    const isHome = thisWeek.homeTeamId === teamId;
    const oppId = isHome ? thisWeek.awayTeamId : thisWeek.homeTeamId;
    snapshot.this_week_matchup = {
      week,
      opponent_team_id: oppId,
      opponent_name: teamName(oppId),
      my_points: (isHome ? thisWeek.homePoints : thisWeek.awayPoints) ?? null,
      opponent_points: (isHome ? thisWeek.awayPoints : thisWeek.homePoints) ?? null,
    };
  }

  // Pending items.
  const openTrades = await db
    .select()
    .from(trades)
    .where(inArray(trades.status, ["proposed", "accepted"]));
  const myVotes = await db.select().from(tradeVotes).where(eq(tradeVotes.teamId, teamId));
  const votedOn = new Set(myVotes.map((v) => v.tradeId));
  const claims = await db
    .select()
    .from(waiverClaims)
    .where(and(eq(waiverClaims.teamId, teamId), eq(waiverClaims.status, "pending")));

  const rosterFlags: string[] = [];
  const irEntry = entries.find((e) => e.slot === "IR");
  if (irEntry) {
    const irPlayer = roster.find((r) => r.playerId === irEntry.playerId);
    const eligible =
      irPlayer &&
      (settings.irEligibleStatuses.includes(irPlayer.injuryStatus ?? "") ||
        settings.irEligibleStatuses.includes(""));
    if (irPlayer && !eligible) {
      rosterFlags.push(
        `Your IR player ${irPlayer.name} is no longer IR-eligible. You cannot add players until you move him out of IR or drop him.`,
      );
    }
  }

  snapshot.pending = {
    offers_to_me: openTrades
      .filter((t) => t.status === "proposed" && t.counterpartyTeamId === teamId)
      .map((t) => ({
        trade_id: t.id,
        from_team_id: t.proposerTeamId,
        give: t.getPlayerIds,
        get: t.givePlayerIds,
      })),
    offers_from_me: openTrades
      .filter((t) => t.status === "proposed" && t.proposerTeamId === teamId)
      .map((t) => ({ trade_id: t.id, to_team_id: t.counterpartyTeamId })),
    votes_owed: openTrades
      .filter(
        (t) =>
          t.status === "accepted" &&
          t.proposerTeamId !== teamId &&
          t.counterpartyTeamId !== teamId &&
          !votedOn.has(t.id),
      )
      .map((t) => ({
        trade_id: t.id,
        review_ends_at: t.reviewEndsAt ? formatEt(t.reviewEndsAt) : "",
      })),
    my_waiver_claims: claims.map((c) => ({
      add_player_id: c.addPlayerId,
      drop_player_id: c.dropPlayerId,
      priority: c.priority,
    })),
    roster_flags: rosterFlags,
  };

  snapshot.scratchpad = await readScratchpad(db, teamId);

  const recent = await db
    .select({ summary: decisionLogs.summary })
    .from(decisionLogs)
    .where(eq(decisionLogs.teamId, teamId))
    .orderBy(desc(decisionLogs.createdAt))
    .limit(3);
  snapshot.recent_decisions = recent.map((r) => r.summary);

  snapshot.kind_data = await kindData(ctx, settings.season, week);
  return snapshot;
}

/** Kind-specific extras (§8.5 last bullet). */
async function kindData(
  ctx: ToolContext,
  _season: number,
  _week: number,
): Promise<Record<string, unknown> | undefined> {
  const { db, sessionContext } = ctx;
  const kind: SessionKind = ctx.kind;

  if (kind === "trade_response" || kind === "trade_vote") {
    const tradeId = Number(sessionContext.trade_id);
    if (!Number.isFinite(tradeId)) return undefined;
    const t = (await db.select().from(trades).where(eq(trades.id, tradeId)))[0];
    if (!t) return undefined;
    const base: Record<string, unknown> = {
      trade_id: t.id,
      proposer_team_id: t.proposerTeamId,
      counterparty_team_id: t.counterpartyTeamId,
      give_player_ids: t.givePlayerIds,
      get_player_ids: t.getPlayerIds,
      status: t.status,
    };
    if (kind === "trade_response") base.message = t.message;
    if (kind === "trade_vote") {
      // During review only the counts are visible (§3.5).
      const votes = await db.select().from(tradeVotes).where(eq(tradeVotes.tradeId, tradeId));
      base.vote_counts = {
        allow: votes.filter((v) => v.vote === "allow").length,
        veto: votes.filter((v) => v.vote === "veto").length,
      };
      base.review_ends_at = t.reviewEndsAt ? formatEt(t.reviewEndsAt) : null;
    }
    return base;
  }

  if (kind === "injury_response") {
    return {
      player_id: sessionContext.player_id,
      injury_status: sessionContext.injury_status,
    };
  }

  if (kind === "lineup_check") {
    return { window_kickoff_et: sessionContext.window_kickoff_et ?? null };
  }

  if (kind === "onboarding") {
    // §10.1: the order is drawn before onboarding, so an agent prepares for
    // the slot it actually has. "I pick 7th and again at 18th" is a different
    // plan from "I pick 1st"; without this the plans are all generic.
    const state = (await db.select().from(draft).where(eq(draft.id, 1)))[0];
    const order = state?.order ?? [];
    const slot = ctx.teamId === null ? -1 : order.indexOf(ctx.teamId);
    if (slot === -1) return { draft_order_drawn: false };
    const settings = await getSettings(db);
    const rounds = settings.draftRounds;
    const teamCount = order.length;
    // Snake: odd rounds run down the order, even rounds back up it.
    const picks = Array.from({ length: rounds }, (_, r) =>
      r % 2 === 0 ? r * teamCount + slot + 1 : r * teamCount + (teamCount - slot),
    );
    return {
      draft_order_drawn: true,
      your_draft_slot: slot + 1,
      of_teams: teamCount,
      your_pick_numbers: picks,
      rounds,
    };
  }

  if (kind === "draft_pick") {
    return {
      pick_no: sessionContext.pick_no,
      seconds_left: sessionContext.seconds_left ?? null,
    };
  }

  if (kind === "board_reply") {
    const postId = Number(sessionContext.thread_post_id);
    if (!Number.isFinite(postId)) return undefined;
    const root = (await db.select().from(boardPosts).where(eq(boardPosts.id, postId)))[0];
    if (!root) return undefined;
    const thread = await db
      .select()
      .from(boardPosts)
      .where(eq(boardPosts.rootId, root.rootId ?? root.id))
      .orderBy(boardPosts.createdAt);
    return {
      thread: thread.map((p) => ({ id: p.id, team_id: p.teamId, body: p.body, at: formatEt(p.createdAt) })),
    };
  }

  if (kind === "manual") {
    return { objective: sessionContext.objective ?? null };
  }

  return undefined;
}
