/**
 * Read tools (§8.4 table 1) against a real PGlite database with the production
 * migrations applied. Covers the league-state shape, lock and bye flags,
 * free-agent filtering, scratchpad isolation (§15.5), vote secrecy during a
 * trade review (§3.5), the web-search domain block (§12.1), player_research
 * (§5.7), and paging (§8.2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import type { EngineDb, SessionKind } from "@league/engine";
import {
  boardPosts,
  lineupEntries,
  matchups,
  playerWeekProj,
  playerWeekStats,
  players,
  rankings,
  scratchpads,
  teams,
  tradeVotes,
  trades,
  transactions,
} from "@league/engine";
import {
  READ_TOOLS,
  getFreeAgentsTool,
  getLeagueStateTool,
  getMatchupTool,
  getMyTeamTool,
  getNflScheduleTool,
  getPendingTradesTool,
  getPlayerStatsTool,
  getTeamRosterTool,
  getTradeTool,
  getTransactionsTool,
  getWaiverClaimsTool,
  isBlockedSearchHost,
  playerResearchTool,
  readBoardTool,
  readScratchpadTool,
  searchPlayersTool,
  setWebSearchFetcher,
  webSearchTool,
} from "../src/tools/read.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { createTestDb } from "./helpers/db.ts";
import type { TestDb } from "./helpers/db.ts";
import { SEASON, makeGame, makePlayer, rosterPlayer, seedLeague, seedTeams } from "../../engine/test/helpers/factories.ts";

/** Sunday Sep 13 2026, 1:30 PM ET — after the 1:00 PM window kicked off. */
const NOW = "2026-09-13T17:30:00.000Z";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
  setWebSearchFetcher(null);
  vi.unstubAllGlobals();
});

function ctxFor(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    db: db as unknown as EngineDb,
    clock: new FixedClock(NOW),
    teamId: null,
    sessionId: 1,
    kind: "weekly_review" as SessionKind,
    season: SEASON,
    config: {},
    sessionContext: {},
    ...overrides,
  };
}

/** Week 1 has an early (kicked off) game and a late one; DAL is on bye. */
async function seedWeek1Games(): Promise<void> {
  await makeGame(db, { week: 1, home: "KC", away: "BUF", kickoffAt: new Date("2026-09-13T17:00:00.000Z") });
  await makeGame(db, { week: 1, home: "SF", away: "SEA", kickoffAt: new Date("2026-09-13T20:25:00.000Z") });
  await makeGame(db, { week: 2, home: "DAL", away: "NYG", kickoffAt: new Date("2026-09-20T17:00:00.000Z") });
  await makeGame(db, { week: 2, home: "KC", away: "SF", kickoffAt: new Date("2026-09-20T17:00:00.000Z") });
}

function ok(res: unknown): Record<string, unknown> {
  expect((res as { ok?: boolean }).ok).not.toBe(false);
  return res as Record<string, unknown>;
}

/* ========================================================================== */
/* the set                                                                    */
/* ========================================================================== */

describe("READ_TOOLS", () => {
  it("exposes exactly the §8.4 read tools, each with a schema", () => {
    expect(READ_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "player_research",
        "get_free_agents",
        "get_league_state",
        "get_matchup",
        "get_my_team",
        "get_nfl_schedule",
        "get_pending_trades",
        "get_player_stats",
        "get_team_roster",
        "get_team_week_results",
        "get_trade",
        "get_transactions",
        "get_waiver_claims",
        "read_board",
        "read_scratchpad",
        "search_players",
        "web_search",
      ].sort(),
    );
    for (const t of READ_TOOLS) {
      expect(t.schema).toBeDefined();
      expect(t.ending).toBeUndefined();
      expect(t.description.length).toBeGreaterThan(10);
    }
  });
});

/* ========================================================================== */
/* get_league_state                                                           */
/* ========================================================================== */

describe("get_league_state", () => {
  it("returns season, week, phase, my team, teams, standings, waivers, locks, deadline and pending items", async () => {
    await seedLeague(db, { currentWeek: 2 });
    const teamIds = await seedTeams(db);
    const [a, b, c] = teamIds as [number, number, number];
    await seedWeek1Games();
    await db.insert(matchups).values({
      week: 1,
      homeTeamId: a,
      awayTeamId: b,
      homePoints: 100,
      awayPoints: 90,
      final: true,
      winnerTeamId: a,
    });
    // An offer waiting on me and a trade I owe a vote on.
    await db.insert(trades).values({
      proposerTeamId: b,
      counterpartyTeamId: a,
      givePlayerIds: ["x1"],
      getPlayerIds: ["y1"],
      status: "proposed",
      proposedAt: new Date("2026-09-13T12:00:00.000Z"),
    });
    await db.insert(trades).values({
      proposerTeamId: b,
      counterpartyTeamId: c,
      givePlayerIds: ["x2"],
      getPlayerIds: ["y2"],
      status: "accepted",
      proposedAt: new Date("2026-09-13T10:00:00.000Z"),
      reviewEndsAt: new Date("2026-09-14T10:00:00.000Z"),
    });

    const res = ok(await getLeagueStateTool.execute({}, ctxFor({ teamId: a })));
    expect(res.season).toBe(SEASON);
    expect(res.week).toBe(2);
    expect(res.phase).toBe("regular");
    expect((res.my_team as { id: number }).id).toBe(a);
    expect((res.my_team as { model: string }).model).toBeTruthy();
    expect((res.teams as unknown[]).length).toBe(12);
    expect((res.standings as unknown[]).length).toBe(12);
    expect((res.standings as Array<{ team_id: number; rank: number }>)[0]!.team_id).toBe(a);
    expect((res.waiver_order as unknown[]).length).toBe(12);
    expect(res.my_waiver_position).toBe(1);
    expect((res.next_waiver_run as { at: string }).at).toBeTruthy();
    expect(res.next_lock_times).toBeDefined();
    expect((res.trade_deadline as { after_week: number }).after_week).toBe(11);

    const pending = res.pending as Record<string, unknown>;
    expect((pending.offers_awaiting_my_response as Array<{ from_team_id: number }>)[0]!.from_team_id).toBe(b);
    expect((pending.votes_owed as unknown[]).length).toBe(1);
    expect((pending.roster_flags as { ir_illegal: boolean }).ir_illegal).toBe(false);
    expect((pending.roster_flags as { empty_starting_slots: string[] }).empty_starting_slots).toHaveLength(9);
  });

  it("lists the next lock times this week with my players who lock then", async () => {
    await seedLeague(db);
    const [a] = (await seedTeams(db)) as [number];
    await seedWeek1Games();
    const late = await makePlayer(db, { nflTeam: "SF", position: "WR" });
    await rosterPlayer(db, a, late);

    const res = ok(await getLeagueStateTool.execute({}, ctxFor({ teamId: a })));
    const locks = res.next_lock_times as Array<{ nfl_teams: string[]; my_players_locking: Array<{ player_id: string }> }>;
    // The 1:00 PM game already kicked off, so only the 4:25 window is left.
    expect(locks).toHaveLength(1);
    expect(locks[0]!.nfl_teams).toContain("SF");
    expect(locks[0]!.my_players_locking.map((p) => p.player_id)).toEqual([late]);
  });

  it("works for the reporter (no team) with my_team null", async () => {
    await seedLeague(db);
    await seedTeams(db);
    const res = ok(await getLeagueStateTool.execute({}, ctxFor({ teamId: null })));
    expect(res.my_team).toBeNull();
    expect((res.pending as { votes_owed: unknown[] }).votes_owed).toEqual([]);
  });
});

/* ========================================================================== */
/* get_my_team / get_team_roster                                              */
/* ========================================================================== */

describe("get_my_team", () => {
  it("flags locked players, byes, slots, points and projections", async () => {
    await seedLeague(db);
    const [a] = (await seedTeams(db)) as [number];
    await seedWeek1Games();
    const kc = await makePlayer(db, { nflTeam: "KC", position: "RB", fullName: "Locked Back" });
    const sf = await makePlayer(db, { nflTeam: "SF", position: "WR", fullName: "Late Receiver" });
    const dal = await makePlayer(db, { nflTeam: "DAL", position: "QB", fullName: "Bye Passer" });
    for (const p of [kc, sf, dal]) await rosterPlayer(db, a, p);
    await db.insert(lineupEntries).values({ teamId: a, week: 1, playerId: kc, slot: "RB1" });
    await db
      .insert(playerWeekStats)
      .values({ playerId: kc, season: SEASON, week: 1, stats: { rush_yd: 80, rec: 3 }, ptsPpr: 14.5 });

    const res = ok(await getMyTeamTool.execute({}, ctxFor({ teamId: a })));
    const rows = res.players as Array<Record<string, unknown>>;
    const byId = new Map(rows.map((r) => [r.player_id as string, r]));

    expect(byId.get(kc)!.locked).toBe(true);
    expect(byId.get(kc)!.slot).toBe("RB1");
    expect(byId.get(kc)!.points_this_week).toBe(14.5);
    expect(byId.get(kc)!.season_points).toBe(14.5);
    expect(byId.get(kc)!.opponent).toBe("vs BUF");

    expect(byId.get(sf)!.locked).toBe(false);
    expect(byId.get(sf)!.slot).toBe("BN");
    expect(byId.get(sf)!.on_bye_this_week).toBe(false);

    expect(byId.get(dal)!.on_bye_this_week).toBe(true);
    expect(byId.get(dal)!.bye_week).toBe(1);
    expect(byId.get(dal)!.locked).toBe(false);

    expect(res.empty_starting_slots).toEqual(["QB", "RB2", "WR1", "WR2", "TE", "FLEX", "DST", "K"]);
    expect((res.team as { id: number }).id).toBe(a);
  });

  it("refuses for a session with no team", async () => {
    await seedLeague(db);
    await seedTeams(db);
    const res = await getMyTeamTool.execute({}, ctxFor({ teamId: null }));
    expect(res.ok).toBe(false);
  });
});

describe("get_team_roster", () => {
  it("returns another team's roster in the same shape and never a scratchpad", async () => {
    await seedLeague(db);
    const [a, b] = (await seedTeams(db)) as [number, number];
    await seedWeek1Games();
    const p = await makePlayer(db, { nflTeam: "SF", position: "TE" });
    await rosterPlayer(db, b, p);
    await db.insert(scratchpads).values({ teamId: b, content: "SECRET PLAN" });

    const res = ok(await getTeamRosterTool.execute({ team_id: b }, ctxFor({ teamId: a })));
    expect((res.team as { id: number }).id).toBe(b);
    expect((res.players as unknown[]).length).toBe(1);
    expect(JSON.stringify(res)).not.toContain("SECRET PLAN");
  });

  it("reports not_found for a team that does not exist", async () => {
    await seedLeague(db);
    await seedTeams(db);
    const res = await getTeamRosterTool.execute({ team_id: 999 }, ctxFor({ teamId: 1 }));
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("not_found");
  });
});

/* ========================================================================== */
/* get_matchup                                                                */
/* ========================================================================== */

describe("get_matchup", () => {
  it("returns both lineups with points and a summary of the other matchups", async () => {
    await seedLeague(db);
    const teamIds = await seedTeams(db);
    const [a, b, c, d] = teamIds as [number, number, number, number];
    await seedWeek1Games();
    const mine = await makePlayer(db, { nflTeam: "KC", position: "QB", fullName: "My QB" });
    const theirs = await makePlayer(db, { nflTeam: "SF", position: "QB", fullName: "Their QB" });
    await rosterPlayer(db, a, mine);
    await rosterPlayer(db, b, theirs);
    await db.insert(lineupEntries).values([
      { teamId: a, week: 1, playerId: mine, slot: "QB" },
      { teamId: b, week: 1, playerId: theirs, slot: "QB" },
    ]);
    await db.insert(playerWeekStats).values([
      { playerId: mine, season: SEASON, week: 1, stats: { pass_yd: 300 }, ptsPpr: 22.1 },
      { playerId: theirs, season: SEASON, week: 1, stats: { pass_yd: 100 }, ptsPpr: 8 },
    ]);
    await db.insert(matchups).values([
      { week: 1, homeTeamId: a, awayTeamId: b },
      { week: 1, homeTeamId: c, awayTeamId: d },
    ]);

    const res = ok(await getMatchupTool.execute({}, ctxFor({ teamId: a })));
    const m = res.my_matchup as { home: Record<string, unknown>; away: Record<string, unknown> };
    expect(m.home.points).toBe(22.1);
    expect(m.away.points).toBe(8);
    expect((m.home.lineup as Array<{ slot: string }>).length).toBe(9);
    const qbSlot = (m.home.lineup as Array<Record<string, unknown>>).find((s) => s.slot === "QB")!;
    expect(qbSlot.locked).toBe(true);
    expect(qbSlot.points).toBe(22.1);
    expect((res.other_matchups as unknown[]).length).toBe(1);
  });

  it("rejects a future week", async () => {
    await seedLeague(db);
    await seedTeams(db);
    const res = await getMatchupTool.execute({ week: 5 }, ctxFor({ teamId: 1 }));
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("bad_week");
  });
});

/* ========================================================================== */
/* get_player_stats / search_players                                          */
/* ========================================================================== */

describe("get_player_stats", () => {
  it("returns weekly points, last-season totals, next opponent, bye and ownership", async () => {
    await seedLeague(db);
    const [a] = (await seedTeams(db)) as [number];
    await seedWeek1Games();
    const owned = await makePlayer(db, { nflTeam: "KC", position: "RB", fullName: "Owned Back" });
    const free = await makePlayer(db, { nflTeam: "SF", position: "WR", fullName: "Free Receiver" });
    await rosterPlayer(db, a, owned);
    await db.insert(playerWeekStats).values([
      { playerId: owned, season: SEASON, week: 1, stats: { rush_yd: 100, rush_td: 1 }, ptsPpr: 16 },
      { playerId: owned, season: SEASON - 1, week: 1, stats: { rush_yd: 50 }, ptsPpr: 5 },
      { playerId: owned, season: SEASON - 1, week: 2, stats: { rush_yd: 60 }, ptsPpr: 6 },
    ]);

    const res = ok(await getPlayerStatsTool.execute({ player_ids: [owned, free, "nope"] }, ctxFor({ teamId: a })));
    const items = res.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(res.missing_player_ids).toEqual(["nope"]);
    const o = items.find((i) => i.player_id === owned)!;
    expect((o.this_season as { by_week: unknown[] }).by_week).toHaveLength(1);
    expect((o.this_season as { total: number }).total).toBe(16);
    expect((o.last_season as { total_pts_ppr: number; games: number })).toEqual({
      season: SEASON - 1,
      total_pts_ppr: 11,
      games: 2,
    });
    expect((o.ownership as { status: string; team_id: number }).status).toBe("rostered");
    expect((o.ownership as { team_id: number }).team_id).toBe(a);
    expect((o.next_opponent as { opponent: string }).opponent).toBe("vs BUF");
    const f = items.find((i) => i.player_id === free)!;
    expect((f.ownership as { status: string }).status).toBe("free_agent");
  });
});

describe("search_players", () => {
  it("matches by name, filters by position and reports ownership", async () => {
    await seedLeague(db);
    const [a] = (await seedTeams(db)) as [number];
    const wr = await makePlayer(db, { fullName: "Justin Jefferson", position: "WR", nflTeam: "MIN" });
    await makePlayer(db, { fullName: "Justin Fields", position: "QB", nflTeam: "NYJ" });
    await rosterPlayer(db, a, wr);

    const all = ok(await searchPlayersTool.execute({ query: "justin" }, ctxFor({ teamId: a })));
    expect((all.items as unknown[]).length).toBe(2);

    const onlyWr = ok(await searchPlayersTool.execute({ query: "justin", position: "wr" }, ctxFor({ teamId: a })));
    const items = onlyWr.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]!.player_id).toBe(wr);
    expect((items[0]!.ownership as { status: string }).status).toBe("rostered");
  });
});

/* ========================================================================== */
/* get_free_agents                                                            */
/* ========================================================================== */

describe("get_free_agents", () => {
  it("excludes rostered players and flags on_waivers with waiver_until", async () => {
    await seedLeague(db);
    const [a] = (await seedTeams(db)) as [number];
    await seedWeek1Games();
    const rostered = await makePlayer(db, { fullName: "Rostered Guy", position: "RB", nflTeam: "KC" });
    await rosterPlayer(db, a, rostered);
    const freeAgent = await makePlayer(db, { fullName: "Free Guy", position: "RB", nflTeam: "SF", waiverUntil: null });
    const waiverGuy = await makePlayer(db, {
      fullName: "Waiver Guy",
      position: "WR",
      nflTeam: "SF",
      waiverUntil: new Date("2026-09-16T08:30:00.000Z"),
    });

    const res = ok(await getFreeAgentsTool.execute({}, ctxFor({ teamId: a })));
    const items = res.items as Array<Record<string, unknown>>;
    const ids = items.map((i) => i.player_id);
    expect(ids).not.toContain(rostered);
    expect(ids).toContain(freeAgent);
    expect(ids).toContain(waiverGuy);
    const w = items.find((i) => i.player_id === waiverGuy)!;
    expect(w.on_waivers).toBe(true);
    expect(w.waiver_until).toBe("2026-09-16T08:30:00.000Z");
    const f = items.find((i) => i.player_id === freeAgent)!;
    expect(f.on_waivers).toBe(false);
    expect(f.waiver_until).toBeNull();
  });

  it("filters by position and sorts by trending, last week, season and projection", async () => {
    await seedLeague(db, { currentWeek: 2 });
    await seedTeams(db);
    const hot = await makePlayer(db, { fullName: "Hot Add", position: "RB" });
    const cold = await makePlayer(db, { fullName: "Cold Add", position: "RB" });
    const wr = await makePlayer(db, { fullName: "Some WR", position: "WR" });
    await db.update(players).set({ trendingAdds: 5000 }).where(eq(players.playerId, hot));
    await db.update(players).set({ trendingAdds: 1 }).where(eq(players.playerId, cold));
    await db
      .insert(playerWeekStats)
      .values({ playerId: cold, season: SEASON, week: 1, stats: {}, ptsPpr: 30 });

    const trending = ok(await getFreeAgentsTool.execute({ sort: "trending" }, ctxFor()));
    expect((trending.items as Array<{ player_id: string }>)[0]!.player_id).toBe(hot);

    const lastWeek = ok(await getFreeAgentsTool.execute({ sort: "last_week" }, ctxFor()));
    expect((lastWeek.items as Array<{ player_id: string; last_week_points: number }>)[0]!.player_id).toBe(cold);
    expect((lastWeek.items as Array<{ last_week_points: number }>)[0]!.last_week_points).toBe(30);

    const byPos = ok(await getFreeAgentsTool.execute({ position: "WR" }, ctxFor()));
    expect((byPos.items as Array<{ player_id: string }>).map((i) => i.player_id)).toEqual([wr]);
  });

  it("pages with has_more and next_offset (§8.2)", async () => {
    await seedLeague(db);
    await seedTeams(db);
    for (let i = 0; i < 5; i++) await makePlayer(db, { fullName: `FA ${i}`, position: "RB" });

    const first = ok(await getFreeAgentsTool.execute({ limit: 2 }, ctxFor()));
    expect((first.items as unknown[]).length).toBe(2);
    expect(first.total).toBe(5);
    expect(first.has_more).toBe(true);
    expect(first.next_offset).toBe(2);

    const last = ok(await getFreeAgentsTool.execute({ limit: 2, offset: 4 }, ctxFor()));
    expect((last.items as unknown[]).length).toBe(1);
    expect(last.has_more).toBe(false);
    expect(last.next_offset).toBeUndefined();
  });
});

/* ========================================================================== */
/* get_nfl_schedule / get_transactions / get_waiver_claims                    */
/* ========================================================================== */

describe("get_nfl_schedule", () => {
  it("lists games with ET and UTC kickoffs plus the teams on bye", async () => {
    await seedLeague(db);
    await seedTeams(db);
    await seedWeek1Games();
    const res = ok(await getNflScheduleTool.execute({}, ctxFor()));
    expect((res.games as unknown[]).length).toBe(2);
    const g = (res.games as Array<Record<string, unknown>>)[0]!;
    expect(g.kickoff_at).toBe("2026-09-13T17:00:00.000Z");
    expect(String(g.kickoff_et)).toContain("ET");
    expect(g.kicked_off).toBe(true);
    expect(res.byes).toEqual(["DAL", "NYG"]);
  });
});

describe("get_transactions", () => {
  it("filters by team and pages", async () => {
    await seedLeague(db);
    const [a, b] = (await seedTeams(db)) as [number, number];
    for (let i = 0; i < 3; i++) {
      await db.insert(transactions).values({ type: "add", week: 1, teamIds: [a], payload: { i } });
    }
    await db.insert(transactions).values({ type: "drop", week: 1, teamIds: [b], payload: {} });

    const mine = ok(await getTransactionsTool.execute({ team_id: a }, ctxFor({ teamId: a })));
    expect(mine.total).toBe(3);
    const paged = ok(await getTransactionsTool.execute({ team_id: a, limit: 2 }, ctxFor({ teamId: a })));
    expect((paged.items as unknown[]).length).toBe(2);
    expect(paged.has_more).toBe(true);
    expect(paged.next_offset).toBe(2);

    const all = ok(await getTransactionsTool.execute({}, ctxFor({ teamId: a })));
    expect(all.total).toBe(4);
  });
});

describe("get_waiver_claims", () => {
  it("returns my pending claims, my waiver position and the last run results", async () => {
    await seedLeague(db);
    const [a] = (await seedTeams(db)) as [number];
    const add = await makePlayer(db, { fullName: "Claim Target", waiverUntil: new Date("2026-09-16T08:30:00.000Z") });
    const { waiverClaims, waiverRuns } = await import("@league/engine");
    await db.insert(waiverClaims).values({ teamId: a, addPlayerId: add, priority: 1, status: "pending" });
    await db.insert(waiverRuns).values({
      runAt: new Date("2026-09-09T08:30:00.000Z"),
      summary: {
        orderBefore: [a],
        orderAfter: [a],
        results: [
          { claimId: 99, teamId: a, addPlayerId: add, dropPlayerId: null, status: "failed", failureReason: "roster_full" },
        ],
      },
    });

    const res = ok(await getWaiverClaimsTool.execute({}, ctxFor({ teamId: a })));
    expect(res.my_waiver_position).toBe(1);
    expect((res.pending_claims as Array<{ add_player_name: string }>)[0]!.add_player_name).toBe("Claim Target");
    expect((res.last_run as { my_results: Array<{ failure_reason: string }> }).my_results[0]!.failure_reason).toBe(
      "roster_full",
    );
  });

  it("refuses for a session with no team", async () => {
    await seedLeague(db);
    await seedTeams(db);
    expect((await getWaiverClaimsTool.execute({}, ctxFor())).ok).toBe(false);
  });
});

/* ========================================================================== */
/* trades: counts only during review (§3.5)                                   */
/* ========================================================================== */

describe("get_pending_trades", () => {
  it("shows vote counts but never who voted while a trade is in review", async () => {
    await seedLeague(db);
    const teamIds = await seedTeams(db);
    const [a, b, c, d] = teamIds as [number, number, number, number];
    const inserted = await db
      .insert(trades)
      .values({
        proposerTeamId: a,
        counterpartyTeamId: b,
        givePlayerIds: ["g1"],
        getPlayerIds: ["g2"],
        status: "accepted",
        proposedAt: new Date("2026-09-13T10:00:00.000Z"),
        reviewEndsAt: new Date("2026-09-14T10:00:00.000Z"),
      })
      .returning({ id: trades.id });
    const tradeId = inserted[0]!.id;
    await db.insert(tradeVotes).values([
      { tradeId, teamId: c, vote: "veto", reason: "COLLUSION SUSPECTED" },
      { tradeId, teamId: d, vote: "allow", reason: "fine by me" },
    ]);

    const res = ok(await getPendingTradesTool.execute({}, ctxFor({ teamId: c })));
    const review = (res.trades_in_review as Array<Record<string, unknown>>)[0]!;
    expect(review.votes).toEqual({ vetoes: 1, allows: 1, votes_cast: 2, not_yet_voted: 8 });
    const json = JSON.stringify(res);
    expect(json).not.toContain("COLLUSION SUSPECTED");
    expect(json).not.toContain("fine by me");
    expect(review.i_can_vote).toBe(true);
  });

  it("separates offers to me from offers I sent", async () => {
    await seedLeague(db);
    const [a, b] = (await seedTeams(db)) as [number, number];
    await db.insert(trades).values([
      {
        proposerTeamId: b,
        counterpartyTeamId: a,
        givePlayerIds: ["in"],
        getPlayerIds: ["out"],
        status: "proposed",
        proposedAt: new Date("2026-09-13T10:00:00.000Z"),
      },
      {
        proposerTeamId: a,
        counterpartyTeamId: b,
        givePlayerIds: ["mine"],
        getPlayerIds: ["theirs"],
        status: "proposed",
        proposedAt: new Date("2026-09-13T11:00:00.000Z"),
      },
    ]);
    const res = ok(await getPendingTradesTool.execute({}, ctxFor({ teamId: a })));
    expect((res.offers_to_me as Array<{ i_would_receive: string[] }>)[0]!.i_would_receive).toEqual(["in"]);
    expect((res.offers_from_me as Array<{ i_give: string[] }>)[0]!.i_give).toEqual(["mine"]);
  });
});

describe("get_trade", () => {
  it("gives both rosters before and after, and hides vote reasons until the trade resolves", async () => {
    await seedLeague(db);
    const teamIds = await seedTeams(db);
    const [a, b, c] = teamIds as [number, number, number];
    const p1 = await makePlayer(db, { fullName: "Given Away", position: "RB" });
    const p2 = await makePlayer(db, { fullName: "Coming Back", position: "WR" });
    await rosterPlayer(db, a, p1);
    await rosterPlayer(db, b, p2);
    const inserted = await db
      .insert(trades)
      .values({
        proposerTeamId: a,
        counterpartyTeamId: b,
        givePlayerIds: [p1],
        getPlayerIds: [p2],
        status: "accepted",
        proposedAt: new Date("2026-09-13T10:00:00.000Z"),
        reviewEndsAt: new Date("2026-09-14T10:00:00.000Z"),
      })
      .returning({ id: trades.id });
    const tradeId = inserted[0]!.id;
    await db.insert(tradeVotes).values({ tradeId, teamId: c, vote: "veto", reason: "SECRET REASON" });

    const inReview = ok(await getTradeTool.execute({ trade_id: tradeId }, ctxFor({ teamId: c })));
    expect((inReview.proposer_gives as Array<{ name: string }>)[0]!.name).toBe("Given Away");
    const before = inReview.rosters_before as Record<string, Array<{ player_id: string }>>;
    const after = inReview.rosters_after as Record<string, Array<{ player_id: string }>>;
    expect(before[String(a)]!.map((p) => p.player_id)).toEqual([p1]);
    expect(after[String(a)]!.map((p) => p.player_id)).toEqual([p2]);
    expect(after[String(b)]!.map((p) => p.player_id)).toEqual([p1]);
    expect(inReview.vote_details).toBeNull();
    expect(JSON.stringify(inReview)).not.toContain("SECRET REASON");

    await db.update(trades).set({ status: "executed" }).where(eq(trades.id, tradeId));
    const resolved = ok(await getTradeTool.execute({ trade_id: tradeId }, ctxFor({ teamId: c })));
    expect((resolved.vote_details as Array<{ reason: string }>)[0]!.reason).toBe("SECRET REASON");
  });

  it("reports not_found for an unknown trade", async () => {
    await seedLeague(db);
    await seedTeams(db);
    const res = await getTradeTool.execute({ trade_id: 4242 }, ctxFor({ teamId: 1 }));
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("not_found");
  });

  it("hides an offer that never entered review from everyone but the two parties (§3.5)", async () => {
    await seedLeague(db);
    const teamIds = await seedTeams(db);
    const [a, b, c] = teamIds as [number, number, number];
    const p1 = await makePlayer(db, { fullName: "Quiet Piece", position: "RB" });
    await rosterPlayer(db, a, p1);

    for (const status of ["proposed", "rejected", "countered", "cancelled", "expired"] as const) {
      const inserted = await db
        .insert(trades)
        .values({
          proposerTeamId: a,
          counterpartyTeamId: b,
          givePlayerIds: [p1],
          getPlayerIds: [],
          status,
          message: "CANDID VALUATION",
          proposedAt: new Date("2026-09-13T10:00:00.000Z"),
        })
        .returning({ id: trades.id });
      const tradeId = inserted[0]!.id;

      // A third team and the reporter are both refused, and the message never leaks.
      for (const viewer of [c, null]) {
        const res = await getTradeTool.execute({ trade_id: tradeId }, ctxFor({ teamId: viewer }));
        expect(res.ok, `${status} seen by ${viewer === null ? "reporter" : "third team"}`).toBe(false);
        expect((res as { error: string }).error).toBe("not_visible");
        expect(JSON.stringify(res)).not.toContain("CANDID VALUATION");
      }

      // Both parties still see their own negotiation, dead or alive.
      for (const viewer of [a, b]) {
        const res = ok(await getTradeTool.execute({ trade_id: tradeId }, ctxFor({ teamId: viewer })));
        expect(res.message).toBe("CANDID VALUATION");
      }
    }
  });
});

/* ========================================================================== */
/* read_board                                                                 */
/* ========================================================================== */

describe("read_board", () => {
  it("returns threads with author team and model, and a single thread on request", async () => {
    await seedLeague(db);
    const [a, b] = (await seedTeams(db)) as [number, number];
    const root = await db
      .insert(boardPosts)
      .values({ teamId: a, body: "first post", depth: 0, week: 1 })
      .returning({ id: boardPosts.id });
    const rootId = root[0]!.id;
    await db.update(boardPosts).set({ rootId }).where(eq(boardPosts.id, rootId));
    await db.insert(boardPosts).values({ teamId: b, body: "a reply", replyToId: rootId, rootId, depth: 1, week: 1 });

    const res = ok(await readBoardTool.execute({}, ctxFor({ teamId: a })));
    const items = res.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]!.body).toBe("first post");
    expect(items[0]!.model).toBeTruthy();
    expect((items[0]!.replies as Array<{ body: string }>)[0]!.body).toBe("a reply");

    const thread = ok(await readBoardTool.execute({ thread_id: rootId }, ctxFor({ teamId: a })));
    expect((thread.items as unknown[]).length).toBe(2);
  });
});

/* ========================================================================== */
/* read_scratchpad isolation (§15.5)                                          */
/* ========================================================================== */

describe("read_scratchpad", () => {
  it("returns only the calling team's scratchpad — team A cannot read team B's", async () => {
    await seedLeague(db);
    const [a, b] = (await seedTeams(db)) as [number, number];
    await db.insert(scratchpads).values([
      { teamId: a, content: "A plan: draft RBs" },
      { teamId: b, content: "B plan: stack QB+WR" },
    ]);

    const asA = ok(await readScratchpadTool.execute({}, ctxFor({ teamId: a })));
    expect(asA.content).toBe("A plan: draft RBs");
    expect(asA.team_id).toBe(a);

    // Even if a model invents a team_id argument, the schema drops it and the
    // caller's own scratchpad comes back.
    const spoof = ok(await readScratchpadTool.execute({ team_id: b } as never, ctxFor({ teamId: a })));
    expect(spoof.content).toBe("A plan: draft RBs");
    expect(JSON.stringify(spoof)).not.toContain("stack QB+WR");

    const asB = ok(await readScratchpadTool.execute({}, ctxFor({ teamId: b })));
    expect(asB.content).toBe("B plan: stack QB+WR");
  });

  it("has no team_id in its schema and refuses for the reporter", async () => {
    await seedLeague(db);
    await seedTeams(db);
    const res = await readScratchpadTool.execute({}, ctxFor({ teamId: null }));
    expect(res.ok).toBe(false);
    expect((res as { hint?: string }).hint).toContain("get_team_scratchpad");
  });
});

/* ========================================================================== */
/* web_search (§12.1)                                                         */
/* ========================================================================== */

describe("web_search", () => {
  it("removes the league's own domain and *.vercel.app, and returns the top 5", async () => {
    await seedLeague(db);
    await seedTeams(db);
    setWebSearchFetcher(async () => [
      { title: "League site", url: "https://league.example.com/teams/1", snippet: "our own site" },
      { title: "Preview deploy", url: "https://afl-preview.vercel.app/board", snippet: "preview" },
      { title: "R1", url: "https://espn.com/1", snippet: "s1", published: "2026-09-12" },
      { title: "R2", url: "https://nfl.com/2", snippet: "s2" },
      { title: "R3", url: "https://rotowire.com/3", snippet: "s3" },
      { title: "R4", url: "https://theathletic.com/4", snippet: "s4" },
      { title: "R5", url: "https://cbssports.com/5", snippet: "s5" },
      { title: "R6", url: "https://yahoo.com/6", snippet: "s6" },
      { title: "Subdomain", url: "https://www.league.example.com/x", snippet: "still ours" },
    ]);

    const res = ok(
      await webSearchTool.execute(
        { query: "week 1 injuries" },
        ctxFor({
          teamId: 1,
          config: { webSearchApiKey: "super-secret-key", siteDomain: "league.example.com" },
        }),
      ),
    );
    const results = res.results as Array<{ url: string; published?: string }>;
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.url)).toEqual([
      "https://espn.com/1",
      "https://nfl.com/2",
      "https://rotowire.com/3",
      "https://theathletic.com/4",
      "https://cbssports.com/5",
    ]);
    expect(results[0]!.published).toBe("2026-09-12");
    const json = JSON.stringify(res);
    expect(json).not.toContain("vercel.app");
    expect(json).not.toContain("league.example.com");
    expect(json).not.toContain("super-secret-key");
  });

  it("returns web_search_unavailable with no API key and on a provider error", async () => {
    await seedLeague(db);
    await seedTeams(db);
    const noKey = await webSearchTool.execute({ query: "x" }, ctxFor({ teamId: 1 }));
    expect(noKey.ok).toBe(false);
    expect((noKey as { error: string }).error).toBe("web_search_unavailable");

    setWebSearchFetcher(async () => {
      throw new Error("HTTP 500 from https://api.tavily.com/search?key=super-secret-key");
    });
    const failed = await webSearchTool.execute(
      { query: "x" },
      ctxFor({ teamId: 1, config: { webSearchApiKey: "super-secret-key" } }),
    );
    expect(failed.ok).toBe(false);
    expect((failed as { error: string }).error).toBe("web_search_unavailable");
    expect(JSON.stringify(failed)).not.toContain("super-secret-key");
  });

  it("blocks hosts by rule", () => {
    expect(isBlockedSearchHost("https://foo.vercel.app/a", undefined)).toBe(true);
    expect(isBlockedSearchHost("https://x.com/a", "x.com")).toBe(true);
    expect(isBlockedSearchHost("https://sub.x.com/a", "https://x.com")).toBe(true);
    expect(isBlockedSearchHost("https://espn.com/a", "x.com")).toBe(false);
    expect(isBlockedSearchHost("not a url", "x.com")).toBe(true);
  });
});

/* ========================================================================== */
/* player_research (§5.7)                                                     */
/* ========================================================================== */

describe("player_research", () => {
  /** A draft board of `n` players, ranked 1..n, alternating RB and WR. */
  async function seedBoard(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const position = i % 2 === 0 ? "RB" : "WR";
      const id = await makePlayer(db, { fullName: `Board Man ${i}`, position, nflTeam: "KC" });
      ids.push(id);
      await db.insert(rankings).values({
        playerId: id,
        set: "draft",
        week: 0,
        rank: i + 1,
        posRank: `${position}${Math.floor(i / 2) + 1}`,
        tier: Math.floor(i / 4) + 1,
        adp: (i + 1) * 1.5,
        fetchedAt: new Date(NOW),
      });
    }
    return ids;
  }

  it("returns the draft board in rank order with tier and ADP", async () => {
    await seedLeague(db);
    const [a] = (await seedTeams(db)) as [number];
    const ids = await seedBoard(6);
    await rosterPlayer(db, a, ids[0]!);

    const res = (await playerResearchTool.execute({ kind: "draft_rankings" }, ctxFor({ teamId: a }))) as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(res.total).toBe(6);
    expect(res.items.map((i) => i.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(res.items[0]!.adp).toBe(1.5);
    expect(res.items[0]!.tier).toBe(1);
    expect(res.items[0]!.pos_rank).toBe("RB1");
    // Ownership comes from the league, so an agent can see who is already taken
    // and who is still there to draft.
    expect((res.items[0]!.ownership as { status: string }).status).toBe("rostered");
    expect((res.items[1]!.ownership as { status: string }).status).toBe("free_agent");
  });

  it("filters by position and by player_ids", async () => {
    await seedLeague(db);
    const ids = await seedBoard(6);

    const rbs = (await playerResearchTool.execute(
      { kind: "draft_rankings", position: "RB" },
      ctxFor(),
    )) as { items: Array<Record<string, unknown>>; total: number };
    expect(rbs.total).toBe(3);
    expect(rbs.items.every((i) => i.position === "RB")).toBe(true);

    const two = (await playerResearchTool.execute(
      { kind: "draft_rankings", player_ids: [ids[0]!, ids[3]!] },
      ctxFor(),
    )) as { total: number };
    expect(two.total).toBe(2);
  });

  it("reads projections and trending from our own ingests", async () => {
    await seedLeague(db);
    const hot = await makePlayer(db, { fullName: "Waiver Darling", position: "WR", nflTeam: "SF" });
    const cold = await makePlayer(db, { fullName: "Nobody Wants Him", position: "WR", nflTeam: "NYJ" });
    await db.insert(playerWeekProj).values({ playerId: hot, season: SEASON, week: 1, projPtsPpr: 18.4 });
    await db.insert(playerWeekProj).values({ playerId: cold, season: SEASON, week: 1, projPtsPpr: 2.1 });
    await db.update(players).set({ trendingAdds: 4200 }).where(eq(players.playerId, hot));

    const proj = (await playerResearchTool.execute({ kind: "projections", week: 1 }, ctxFor())) as {
      items: Array<Record<string, unknown>>;
    };
    expect(proj.items[0]!.player_id).toBe(hot);
    expect(proj.items[0]!.proj_pts_ppr).toBe(18.4);

    const trending = (await playerResearchTool.execute({ kind: "trending" }, ctxFor())) as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(trending.total).toBe(1);
    expect(trending.items[0]!.trending_adds).toBe(4200);
  });

  it("reads injuries from the hourly player feed", async () => {
    await seedLeague(db);
    const hurt = await makePlayer(db, { fullName: "Sore Hamstring", position: "RB", nflTeam: "DAL" });
    await makePlayer(db, { fullName: "Perfectly Fine", position: "RB", nflTeam: "DAL" });
    await db
      .update(players)
      .set({ injuryStatus: "Questionable", injuryBodyPart: "Hamstring" })
      .where(eq(players.playerId, hurt));

    const res = (await playerResearchTool.execute({ kind: "injuries" }, ctxFor())) as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(res.total).toBe(1);
    expect(res.items[0]!.injury_status).toBe("Questionable");
    expect(res.items[0]!.injury_body_part).toBe("Hamstring");
  });

  it("makes no outbound request and has no allowance to spend", async () => {
    await seedLeague(db);
    await seedBoard(3);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    // Ten calls in a row: the FantasyPros tool refused after three.
    for (let i = 0; i < 10; i++) {
      const res = (await playerResearchTool.execute({ kind: "draft_rankings" }, ctxFor())) as {
        ok?: boolean;
        total?: number;
      };
      expect(res.ok, `call ${i + 1} should not fail`).not.toBe(false);
      expect(res.total).toBe(3);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says so when a set has not been ingested yet", async () => {
    await seedLeague(db);
    const res = (await playerResearchTool.execute({ kind: "ros_rankings" }, ctxFor())) as { error: string };
    expect(res.error).toBe("not_found");
  });
});

/* ========================================================================== */
/* team isolation sweep (§15.5)                                               */
/* ========================================================================== */

describe("team isolation", () => {
  it("no read tool accepts a team_id that would expose another team's scratchpad", async () => {
    const scratchpadReaders = READ_TOOLS.filter((t) => t.name === "read_scratchpad");
    expect(scratchpadReaders).toHaveLength(1);
    const parsed = scratchpadReaders[0]!.schema.parse({ team_id: 2 }) as Record<string, unknown>;
    expect(parsed.team_id).toBeUndefined();
    const all = await db.select().from(teams);
    expect(all).toEqual([]);
  });
});
