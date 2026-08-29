/**
 * Write tools (§8.4 table 2) and draft tools (§8.4 table 4) against a real
 * PGlite database with the production migrations applied.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import type { EngineDb, SessionKind } from "@league/engine";
import {
  decisionLogs,
  draft,
  draftPicks,
  lineupEntries,
  playerWeekProj,
  playerWeekStats,
  rankings,
  rosterEntries,
  sessions,
  teams,
  transactions,
} from "@league/engine";
import {
  scheduleCheckInTool,
  setLineupTool,
  setTeamNameTool,
  voteOnTradeTool,
  writeDecisionLogTool,
  MAX_DECISION_LOG_CHARS,
} from "../src/tools/write.ts";
import {
  DRAFT_TOOLS,
  autoPickCandidate,
  getAvailablePlayersTool,
  getDraftStateTool,
  makePickTool,
  snakePosition,
  unfilledStartingSlots,
} from "../src/tools/draft.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { createTestDb } from "./helpers/db.ts";
import type { TestDb } from "./helpers/db.ts";
import {
  SEASON,
  makePlayer,
  rosterPlayer,
  seedFullRoster,
  seedLeague,
  seedTeams,
} from "../../engine/test/helpers/factories.ts";

const NOW = "2026-09-08T15:00:00.000Z";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
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

/** A running draft over `order` sitting on `currentPick`. */
async function startDraft(order: number[], currentPick: number): Promise<void> {
  await db.insert(draft).values({
    id: 1,
    status: "running",
    order,
    currentPick,
    clockEndsAt: new Date("2026-09-08T15:03:00.000Z"),
  });
}

/* ========================================================================== */
/* set_lineup                                                                 */
/* ========================================================================== */

describe("set_lineup", () => {
  it("sets a legal lineup and returns starters, bench and IR", async () => {
    await seedLeague(db);
    const [teamId] = await seedTeams(db);
    const r = await seedFullRoster(db, teamId!);

    const res = await setLineupTool.execute(
      {
        slots: {
          QB: r.qb,
          RB1: r.rb1,
          RB2: r.rb2,
          WR1: r.wr1,
          WR2: r.wr2,
          TE: r.te,
          FLEX: r.flexRb,
          DST: r.dst,
          K: r.k,
          IR: null,
        },
      },
      ctxFor({ teamId }),
    );

    expect(res.ok).not.toBe(false);
    expect(res).toMatchObject({ week: 1, ir: null });
    expect(res.starters).toMatchObject({ QB: r.qb, FLEX: r.flexRb, DST: r.dst, K: r.k });
    expect(res.bench).toHaveLength(5);

    const stored = await db.select().from(lineupEntries).where(eq(lineupEntries.teamId, teamId!));
    expect(stored).toHaveLength(9);
  });

  it("passes every §7.1 violation through, not just the first", async () => {
    await seedLeague(db);
    const [teamId, otherTeamId] = await seedTeams(db);
    const r = await seedFullRoster(db, teamId!);
    const notMine = await makePlayer(db, { playerId: "outsider-qb", position: "QB" });
    await rosterPlayer(db, otherTeamId!, notMine);

    const res = await setLineupTool.execute(
      {
        slots: {
          QB: notMine, // not on my roster
          RB1: r.rb1,
          RB2: r.rb1, // duplicate
          WR1: r.qb, // slot ineligible
          WR2: r.wr2,
          TE: r.te,
          FLEX: r.flexRb,
          DST: r.dst,
          K: r.k,
          IR: null,
        },
      },
      ctxFor({ teamId }),
    );

    expect(res.ok).toBe(false);
    const details = (res as { details: Array<{ code: string }> }).details;
    const codes = details.map((d) => d.code);
    expect(codes).toContain("not_on_roster");
    expect(codes).toContain("duplicate_player");
    expect(codes).toContain("slot_ineligible");
    // Nothing was written.
    expect(await db.select().from(lineupEntries).where(eq(lineupEntries.teamId, teamId!))).toHaveLength(0);
  });

  it("rejects a slot key that is not a lineup slot before the engine sees it", async () => {
    await seedLeague(db);
    const [teamId] = await seedTeams(db);
    await seedFullRoster(db, teamId!);

    const res = await setLineupTool.execute(
      { slots: { RB3: "whoever" } } as never,
      ctxFor({ teamId }),
    );
    expect(res).toMatchObject({ ok: false, error: "invalid_args" });
  });
});

/* ========================================================================== */
/* write_decision_log                                                         */
/* ========================================================================== */

describe("write_decision_log", () => {
  it("is an ending tool and writes the log", async () => {
    await seedLeague(db);
    const [teamId] = await seedTeams(db);

    expect(writeDecisionLogTool.ending).toBe(true);

    const res = await writeDecisionLogTool.execute(
      { summary: "Set the lineup, claimed a kicker." },
      ctxFor({ teamId, kind: "weekly_review" }),
    );
    expect(res.ok).not.toBe(false);

    const rows = await db.select().from(decisionLogs).where(eq(decisionLogs.teamId, teamId!));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toBe("Set the lineup, claimed a kicker.");
    expect(rows[0]!.kind).toBe("weekly_review");
  });

  it("rejects a summary over 800 characters as invalid_args and writes nothing", async () => {
    await seedLeague(db);
    const [teamId] = await seedTeams(db);

    const res = await writeDecisionLogTool.execute(
      { summary: "x".repeat(MAX_DECISION_LOG_CHARS + 1) },
      ctxFor({ teamId }),
    );
    expect(res).toMatchObject({ ok: false, error: "invalid_args" });
    expect(await db.select().from(decisionLogs)).toHaveLength(0);
  });
});

/* ========================================================================== */
/* vote_on_trade                                                              */
/* ========================================================================== */

describe("vote_on_trade", () => {
  it("is refused outside a trade_vote session", async () => {
    await seedLeague(db);
    const [teamId] = await seedTeams(db);

    const res = await voteOnTradeTool.execute(
      { trade_id: 1, vote: "veto", reason: "lopsided" },
      ctxFor({ teamId, kind: "trade_window" }),
    );
    expect(res).toMatchObject({ ok: false, error: "wrong_session_kind" });
  });

  it("reaches the engine in a trade_vote session (no such trade here)", async () => {
    await seedLeague(db);
    const [teamId] = await seedTeams(db);

    const res = await voteOnTradeTool.execute(
      { trade_id: 999, vote: "allow", reason: "fine by me" },
      ctxFor({ teamId, kind: "trade_vote" }),
    );
    expect(res).toMatchObject({ ok: false, error: "not_found" });
  });

  it("caps the reason at 200 characters", async () => {
    await seedLeague(db);
    const [teamId] = await seedTeams(db);
    const res = await voteOnTradeTool.execute(
      { trade_id: 1, vote: "veto", reason: "x".repeat(201) },
      ctxFor({ teamId, kind: "trade_vote" }),
    );
    expect(res).toMatchObject({ ok: false, error: "invalid_args" });
  });
});

/* ========================================================================== */
/* set_team_name                                                              */
/* ========================================================================== */

describe("set_team_name", () => {
  async function unnamedTeam(): Promise<number> {
    const rows = await db
      .insert(teams)
      .values({
        slug: "rookie",
        name: null,
        modelId: "anthropic/claude-fable-5",
        modelLabel: "claude-fable-5",
        provider: "anthropic",
        tiebreakRand: 0.5,
      })
      .returning({ id: teams.id });
    return rows[0]!.id;
  }

  it("names the team in an onboarding session", async () => {
    await seedLeague(db);
    const teamId = await unnamedTeam();

    const res = await setTeamNameTool.execute(
      { name: "Gridiron Heuristics", motto: "Expected value, every week." },
      ctxFor({ teamId, kind: "onboarding" }),
    );
    expect(res).toMatchObject({ ok: true, name: "Gridiron Heuristics" });

    const row = (await db.select().from(teams).where(eq(teams.id, teamId)))[0]!;
    expect(row.name).toBe("Gridiron Heuristics");
  });

  it("is refused outside onboarding", async () => {
    await seedLeague(db);
    const teamId = await unnamedTeam();

    const res = await setTeamNameTool.execute({ name: "Late Rename" }, ctxFor({ teamId, kind: "weekly_review" }));
    expect(res).toMatchObject({ ok: false, error: "wrong_session_kind" });
    expect((await db.select().from(teams).where(eq(teams.id, teamId)))[0]!.name).toBeNull();
  });

  it("can only be used once", async () => {
    await seedLeague(db);
    const teamId = await unnamedTeam();
    const ctx = ctxFor({ teamId, kind: "onboarding" });

    expect(await setTeamNameTool.execute({ name: "First Name" }, ctx)).toMatchObject({ ok: true });
    const second = await setTeamNameTool.execute({ name: "Second Name" }, ctx);
    expect(second).toMatchObject({ ok: false, error: "name_already_set" });
    expect((await db.select().from(teams).where(eq(teams.id, teamId)))[0]!.name).toBe("First Name");
  });

  it("caps the name at 40 and the motto at 120 characters", async () => {
    await seedLeague(db);
    const teamId = await unnamedTeam();
    const ctx = ctxFor({ teamId, kind: "onboarding" });

    expect(await setTeamNameTool.execute({ name: "x".repeat(41) }, ctx)).toMatchObject({
      ok: false,
      error: "invalid_args",
    });
    expect(await setTeamNameTool.execute({ name: "ok", motto: "y".repeat(121) }, ctx)).toMatchObject({
      ok: false,
      error: "invalid_args",
    });
  });
});

describe("schedule_check_in (§8.10)", () => {
  const at = "2026-09-08T17:00:00Z"; // two hours after NOW, on the grid

  it("stores the reasoning and stamps the session that booked it", async () => {
    await seedLeague(db);
    const teamId = (await seedTeams(db))[0]!;
    const res = await scheduleCheckInTool.execute(
      {
        at,
        reason: "did Achane practise on Thursday?",
        reasoning: "he sat out Wednesday and my FLEX call hinges on his status",
      },
      ctxFor({ teamId, sessionId: 42, kind: "weekly_review" }),
    );
    expect(res).toMatchObject({ ok: true, reasoning: "he sat out Wednesday and my FLEX call hinges on his status" });

    const row = (
      await db.select().from(sessions).where(and(eq(sessions.teamId, teamId), eq(sessions.kind, "self_check_in")))
    )[0]!;
    expect(row.context.reasoning).toContain("FLEX call");
    // Provenance comes from the context, never from the model: the booking
    // session's id is stamped so the site can link the check-in to the
    // transcript that decided on it.
    expect(row.context.booked_by_session_id).toBe(42);
  });

  it("refuses to book without the reasoning", async () => {
    await seedLeague(db);
    const teamId = (await seedTeams(db))[0]!;
    const res = await scheduleCheckInTool.execute(
      { at, reason: "just checking" } as never,
      ctxFor({ teamId, sessionId: 42, kind: "weekly_review" }),
    );
    expect(res).toMatchObject({ ok: false, error: "invalid_args" });
  });
});

/* ========================================================================== */
/* Draft helpers                                                              */
/* ========================================================================== */

describe("snake order", () => {
  it("reverses on even rounds", () => {
    const order = [10, 20, 30];
    expect(snakePosition(order, 1)).toEqual({ round: 1, slotInRound: 1, teamId: 10 });
    expect(snakePosition(order, 3)).toEqual({ round: 1, slotInRound: 3, teamId: 30 });
    expect(snakePosition(order, 4)).toEqual({ round: 2, slotInRound: 1, teamId: 30 });
    expect(snakePosition(order, 6)).toEqual({ round: 2, slotInRound: 3, teamId: 10 });
    expect(snakePosition(order, 7)).toEqual({ round: 3, slotInRound: 1, teamId: 10 });
  });
});

describe("unfilledStartingSlots", () => {
  it("uses FLEX only after the dedicated slots are full", () => {
    const slots = ["QB", "RB1", "RB2", "WR1", "WR2", "TE", "FLEX", "DST", "K"] as const;
    const rbs = [1, 2, 3].map(() => ({ position: "RB", fantasyPositions: ["RB"] }));
    expect(unfilledStartingSlots([...slots], rbs)).toEqual(["QB", "WR1", "WR2", "TE", "DST", "K"]);
  });
});

/* ========================================================================== */
/* make_pick                                                                  */
/* ========================================================================== */

describe("make_pick", () => {
  it("is exported as an ending draft tool", () => {
    expect(makePickTool.ending).toBe(true);
    expect(DRAFT_TOOLS.map((t) => t.name)).toEqual(["get_draft_state", "get_available_players", "make_pick"]);
  });

  it("records the pick, the roster entry and the transaction — and no lineup entry", async () => {
    await seedLeague(db, { phase: "drafting" });
    const teamIds = await seedTeams(db);
    await startDraft(teamIds, 1);
    const pid = await makePlayer(db, { playerId: "cmc", position: "RB", fullName: "Christian McCaffrey" });

    const res = await makePickTool.execute(
      { player_id: pid, reason: "best player available by a wide margin" },
      ctxFor({ teamId: teamIds[0]!, kind: "draft_pick", sessionContext: { pick_no: 1 } }),
    );
    expect(res).toMatchObject({ ok: true, pick_no: 1, round: 1, player_id: pid });

    const picks = await db.select().from(draftPicks);
    expect(picks).toHaveLength(1);
    expect(picks[0]).toMatchObject({
      pickNo: 1,
      round: 1,
      slotInRound: 1,
      teamId: teamIds[0],
      playerId: pid,
      madeBy: "agent",
      reason: "best player available by a wide margin",
    });
    expect(picks[0]!.pickedAt.toISOString()).toBe(NOW);

    const roster = await db.select().from(rosterEntries).where(eq(rosterEntries.playerId, pid));
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ teamId: teamIds[0], acquiredVia: "draft" });

    const txns = await db.select().from(transactions).where(eq(transactions.type, "draft_pick"));
    expect(txns).toHaveLength(1);
    expect(txns[0]!.payload).toMatchObject({ pick_no: 1, player_id: pid, made_by: "agent" });

    // §7.8: drafted players arrive on the bench.
    expect(await db.select().from(lineupEntries)).toHaveLength(0);
  });

  it("rejects a second pick of the same player with already_drafted", async () => {
    await seedLeague(db, { phase: "drafting" });
    const teamIds = await seedTeams(db);
    await startDraft(teamIds, 1);
    const pid = await makePlayer(db, { playerId: "taken", position: "WR" });
    await rosterPlayer(db, teamIds[1]!, pid);

    const res = await makePickTool.execute(
      { player_id: pid, reason: "he is good" },
      ctxFor({ teamId: teamIds[0]!, kind: "draft_pick", sessionContext: { pick_no: 1 } }),
    );
    expect(res).toMatchObject({ ok: false, error: "already_drafted" });
    expect(await db.select().from(draftPicks)).toHaveLength(0);
  });

  it("enforces the §10.4 position caps", async () => {
    await seedLeague(db, { phase: "drafting" });
    const teamIds = await seedTeams(db);
    await startDraft(teamIds, 1);
    const teamId = teamIds[0]!;

    const kicker1 = await makePlayer(db, { playerId: "k1", position: "K" });
    await rosterPlayer(db, teamId, kicker1);
    const kicker2 = await makePlayer(db, { playerId: "k2", position: "K" });

    const res = await makePickTool.execute(
      { player_id: kicker2, reason: "two kickers is a strategy" },
      ctxFor({ teamId, kind: "draft_pick", sessionContext: { pick_no: 1 } }),
    );
    expect(res).toMatchObject({ ok: false, error: "position_cap" });
    expect(await db.select().from(draftPicks)).toHaveLength(0);
  });

  it("enforces must_fill_starters when rounds run out", async () => {
    // 2-round draft: pick 13 is the last round, so nothing is left after it.
    await seedLeague(db, { phase: "drafting", draftRounds: 2 });
    const teamIds = await seedTeams(db);
    await startDraft(teamIds, 13);
    const here = snakePosition(teamIds, 13)!;
    expect(here.round).toBe(2);

    const wr = await makePlayer(db, { playerId: "wr-late", position: "WR" });
    const res = await makePickTool.execute(
      { player_id: wr, reason: "upside" },
      ctxFor({ teamId: here.teamId, kind: "draft_pick", sessionContext: { pick_no: 13 } }),
    );
    expect(res).toMatchObject({ ok: false, error: "must_fill_starters" });
    expect(await db.select().from(draftPicks)).toHaveLength(0);
  });

  it("returns not_your_pick when the session's pick_no is stale", async () => {
    await seedLeague(db, { phase: "drafting" });
    const teamIds = await seedTeams(db);
    await startDraft(teamIds, 2);
    const pid = await makePlayer(db, { playerId: "late", position: "TE" });

    const res = await makePickTool.execute(
      { player_id: pid, reason: "still my turn, surely" },
      ctxFor({ teamId: teamIds[0]!, kind: "draft_pick", sessionContext: { pick_no: 1 } }),
    );
    expect(res).toMatchObject({ ok: false, error: "not_your_pick" });
    expect(await db.select().from(draftPicks)).toHaveLength(0);
  });

  it("returns not_your_pick when another team is on the clock", async () => {
    await seedLeague(db, { phase: "drafting" });
    const teamIds = await seedTeams(db);
    await startDraft(teamIds, 1);
    const pid = await makePlayer(db, { playerId: "sniped", position: "QB" });

    const res = await makePickTool.execute(
      { player_id: pid, reason: "cutting the line" },
      ctxFor({ teamId: teamIds[5]!, kind: "draft_pick", sessionContext: { pick_no: 1 } }),
    );
    expect(res).toMatchObject({ ok: false, error: "not_your_pick" });
  });

  it("refuses to pick while the draft is paused", async () => {
    await seedLeague(db, { phase: "drafting" });
    const teamIds = await seedTeams(db);
    await startDraft(teamIds, 1);
    await db.update(draft).set({ status: "paused" }).where(eq(draft.id, 1));
    const pid = await makePlayer(db, { playerId: "paused-pick", position: "QB" });

    const res = await makePickTool.execute(
      { player_id: pid, reason: "impatient" },
      ctxFor({ teamId: teamIds[0]!, kind: "draft_pick", sessionContext: { pick_no: 1 } }),
    );
    expect(res).toMatchObject({ ok: false, error: "draft_not_running" });
  });

  it("caps the reason at 200 characters", async () => {
    await seedLeague(db, { phase: "drafting" });
    const teamIds = await seedTeams(db);
    await startDraft(teamIds, 1);
    const pid = await makePlayer(db, { playerId: "verbose", position: "QB" });

    const res = await makePickTool.execute(
      { player_id: pid, reason: "x".repeat(201) },
      ctxFor({ teamId: teamIds[0]!, kind: "draft_pick", sessionContext: { pick_no: 1 } }),
    );
    expect(res).toMatchObject({ ok: false, error: "invalid_args" });
  });
});

/* ========================================================================== */
/* get_draft_state                                                            */
/* ========================================================================== */

describe("get_draft_state", () => {
  it("reports the clock, my picks, picks until my turn and my roster needs", async () => {
    await seedLeague(db, { phase: "drafting" });
    const teamIds = await seedTeams(db);
    await startDraft(teamIds, 3);
    const me = teamIds[2]!;

    // Two picks already made, one of them mine.
    const qb = await makePlayer(db, { playerId: "my-qb", position: "QB" });
    const rb = await makePlayer(db, { playerId: "their-rb", position: "RB" });
    await db.insert(draftPicks).values([
      {
        pickNo: 1,
        round: 1,
        slotInRound: 1,
        teamId: teamIds[0]!,
        playerId: rb,
        madeBy: "agent",
        reason: "rb1",
        pickedAt: new Date(NOW),
      },
      {
        pickNo: 2,
        round: 1,
        slotInRound: 2,
        teamId: teamIds[1]!,
        playerId: qb,
        madeBy: "autopick",
        reason: "auto-pick: deadline",
        pickedAt: new Date(NOW),
      },
    ]);
    await rosterPlayer(db, teamIds[0]!, rb);
    await rosterPlayer(db, teamIds[1]!, qb);

    // My roster so far: QB + 2 RB, so FLEX, both WRs, TE, DST and K are unfilled.
    const myQb = await makePlayer(db, { playerId: "me-qb", position: "QB" });
    const myRb1 = await makePlayer(db, { playerId: "me-rb1", position: "RB" });
    const myRb2 = await makePlayer(db, { playerId: "me-rb2", position: "RB" });
    for (const p of [myQb, myRb1, myRb2]) await rosterPlayer(db, me, p);

    const res = await getDraftStateTool.execute({}, ctxFor({ teamId: me, kind: "draft_pick" }));
    expect(res).toMatchObject({
      ok: true,
      status: "running",
      rounds: 14,
      teams: 12,
      round: 1,
      pick_no: 3,
      on_the_clock_team_id: me,
      is_my_pick: true,
      picks_until_my_turn: 0,
      my_next_pick_no: 3,
    });
    expect(res.order).toEqual(teamIds);
    expect(res.my_roster_needs).toEqual(["WR1", "WR2", "TE", "FLEX", "DST", "K"]);
    expect((res.last_picks as unknown[]).length).toBe(2);
    expect(res.my_picks).toEqual([]);
  });

  it("counts the picks until my next turn across the snake", async () => {
    await seedLeague(db, { phase: "drafting" });
    const teamIds = await seedTeams(db);
    await startDraft(teamIds, 2);

    // Team at slot 12 picks at 12 and 13 (snake turn).
    const res = await getDraftStateTool.execute({}, ctxFor({ teamId: teamIds[11]!, kind: "draft_pick" }));
    expect(res).toMatchObject({ is_my_pick: false, my_next_pick_no: 12, picks_until_my_turn: 10 });
  });
});

/* ========================================================================== */
/* get_available_players                                                      */
/* ========================================================================== */

describe("get_available_players", () => {
  async function seedBoard(): Promise<string[]> {
    const ids: string[] = [];
    const specs: Array<[string, string]> = [
      ["board-rb1", "RB"],
      ["board-wr1", "WR"],
      ["board-qb1", "QB"],
      ["board-rb2", "RB"],
      ["board-te1", "TE"],
    ];
    for (const [id, position] of specs) ids.push(await makePlayer(db, { playerId: id, position }));
    await db.insert(rankings).values(
      ids.map((playerId, i) => ({
        playerId,
        set: "draft" as const,
        week: 0,
        rank: i + 1,
        posRank: `${specs[i]![1]}${i + 1}`,
        tier: 1,
        adp: i + 1.5,
        fetchedAt: new Date(NOW),
      })),
    );
    return ids;
  }

  it("excludes drafted players and sorts by rank", async () => {
    await seedLeague(db, { phase: "drafting" });
    const teamIds = await seedTeams(db);
    await startDraft(teamIds, 2);
    const ids = await seedBoard();

    await db.insert(draftPicks).values({
      pickNo: 1,
      round: 1,
      slotInRound: 1,
      teamId: teamIds[0]!,
      playerId: ids[0]!,
      madeBy: "agent",
      reason: "rb1",
      pickedAt: new Date(NOW),
    });
    await rosterPlayer(db, teamIds[0]!, ids[0]!);

    const res = await getAvailablePlayersTool.execute({}, ctxFor({ teamId: teamIds[1]!, kind: "draft_pick" }));
    const items = res.items as Array<{ player_id: string; rank: number | null; adp: number | null }>;
    expect(items.map((p) => p.player_id)).toEqual([ids[1], ids[2], ids[3], ids[4]]);
    expect(items[0]!.rank).toBe(2);
    expect(items[0]!.adp).toBe(2.5);
    expect(res.total).toBe(4);
    expect(res.has_more).toBe(false);
  });

  it("pages with limit and offset", async () => {
    await seedLeague(db, { phase: "drafting" });
    const teamIds = await seedTeams(db);
    await startDraft(teamIds, 1);
    const ids = await seedBoard();

    const first = await getAvailablePlayersTool.execute(
      { limit: 2 },
      ctxFor({ teamId: teamIds[0]!, kind: "draft_pick" }),
    );
    expect((first.items as Array<{ player_id: string }>).map((p) => p.player_id)).toEqual([ids[0], ids[1]]);
    expect(first).toMatchObject({ total: 5, offset: 0, has_more: true, next_offset: 2 });

    const second = await getAvailablePlayersTool.execute(
      { limit: 2, offset: 2 },
      ctxFor({ teamId: teamIds[0]!, kind: "draft_pick" }),
    );
    expect((second.items as Array<{ player_id: string }>).map((p) => p.player_id)).toEqual([ids[2], ids[3]]);
    expect(second).toMatchObject({ offset: 2, has_more: true, next_offset: 4 });
  });

  it("filters by position and rejects a limit over 60", async () => {
    await seedLeague(db, { phase: "drafting" });
    const teamIds = await seedTeams(db);
    await startDraft(teamIds, 1);
    const ids = await seedBoard();
    const ctx = ctxFor({ teamId: teamIds[0]!, kind: "draft_pick" });

    const rbs = await getAvailablePlayersTool.execute({ position: "RB" }, ctx);
    expect((rbs.items as Array<{ player_id: string }>).map((p) => p.player_id)).toEqual([ids[0], ids[3]]);

    const flex = await getAvailablePlayersTool.execute({ position: "FLEX" }, ctx);
    expect((flex.items as Array<{ player_id: string }>).map((p) => p.player_id)).toEqual([
      ids[0],
      ids[1],
      ids[3],
      ids[4],
    ]);

    expect(await getAvailablePlayersTool.execute({ limit: 61 }, ctx)).toMatchObject({
      ok: false,
      error: "invalid_args",
    });
  });

  it("does not offer players already on a roster", async () => {
    await seedLeague(db, { phase: "drafting" });
    const teamIds = await seedTeams(db);
    await startDraft(teamIds, 1);
    const ids = await seedBoard();
    await rosterPlayer(db, teamIds[3]!, ids[2]!);

    const res = await getAvailablePlayersTool.execute({}, ctxFor({ teamId: teamIds[0]!, kind: "draft_pick" }));
    expect((res.items as Array<{ player_id: string }>).map((p) => p.player_id)).not.toContain(ids[2]);
  });
});

/* ========================================================================== */
/* autoPickCandidate (§10.4)                                                  */
/* ========================================================================== */

describe("autoPickCandidate", () => {
  it("takes the highest-ranked available player that passes both rules", async () => {
    await seedLeague(db, { phase: "drafting" });
    const teamIds = await seedTeams(db);
    await startDraft(teamIds, 1);
    const teamId = teamIds[0]!;

    const k1 = await makePlayer(db, { playerId: "ap-k1", position: "K" });
    const k2 = await makePlayer(db, { playerId: "ap-k2", position: "K" });
    const wr = await makePlayer(db, { playerId: "ap-wr", position: "WR" });
    await db.insert(rankings).values([
      { playerId: k2, set: "draft", week: 0, rank: 1, fetchedAt: new Date(NOW) },
      { playerId: wr, set: "draft", week: 0, rank: 2, fetchedAt: new Date(NOW) },
    ]);
    // The team already has its one allowed kicker, so rank 1 is over the cap.
    await rosterPlayer(db, teamId, k1);

    const pick = await autoPickCandidate(db as unknown as EngineDb, teamId, 1);
    expect(pick?.player_id).toBe(wr);
  });

  it("falls back to last-season points, then to the projection", async () => {
    await seedLeague(db, { phase: "drafting" });
    const teamIds = await seedTeams(db);
    await startDraft(teamIds, 1);

    const quiet = await makePlayer(db, { playerId: "ap-quiet", position: "RB" });
    const proven = await makePlayer(db, { playerId: "ap-proven", position: "RB" });
    await db.insert(playerWeekStats).values([
      { playerId: proven, season: SEASON - 1, week: 1, stats: {}, ptsPpr: 22.5 },
      { playerId: quiet, season: SEASON - 1, week: 1, stats: {}, ptsPpr: 3 },
    ]);

    const pick = await autoPickCandidate(db as unknown as EngineDb, teamIds[0]!, 1);
    expect(pick?.player_id).toBe(proven);

    // With no stats at all, the preseason projection decides.
    await db.delete(playerWeekStats);
    await db
      .insert(playerWeekProj)
      .values({ playerId: quiet, season: SEASON, week: 0, projPtsPpr: 180 });
    const projPick = await autoPickCandidate(db as unknown as EngineDb, teamIds[0]!, 1);
    expect(projPick?.player_id).toBe(quiet);
  });

  it("never returns a player that make_pick would reject", async () => {
    // Last round of a 2-round draft: only a slot-filling starter is legal.
    await seedLeague(db, { phase: "drafting", draftRounds: 2 });
    const teamIds = await seedTeams(db);
    await startDraft(teamIds, 13);
    const here = snakePosition(teamIds, 13)!;

    const wr = await makePlayer(db, { playerId: "ap-late-wr", position: "WR" });
    const qb = await makePlayer(db, { playerId: "ap-late-qb", position: "QB" });
    await db.insert(rankings).values([
      { playerId: wr, set: "draft", week: 0, rank: 1, fetchedAt: new Date(NOW) },
      { playerId: qb, set: "draft", week: 0, rank: 2, fetchedAt: new Date(NOW) },
    ]);
    // 8 of 9 starting slots are filled; only QB is missing, so only a QB is legal.
    for (const [id, position] of [
      ["ap-rb1", "RB"],
      ["ap-rb2", "RB"],
      ["ap-wr1", "WR"],
      ["ap-wr2", "WR"],
      ["ap-te", "TE"],
      ["ap-flex", "RB"],
      ["ap-dst", "DEF"],
      ["ap-k", "K"],
    ] as const) {
      await rosterPlayer(db, here.teamId, await makePlayer(db, { playerId: id, position }));
    }

    const pick = await autoPickCandidate(db as unknown as EngineDb, here.teamId, 13);
    expect(pick?.player_id).toBe(qb);

    const res = await makePickTool.execute(
      { player_id: pick!.player_id, reason: "auto-pick: deadline" },
      ctxFor({ teamId: here.teamId, kind: "draft_pick", sessionContext: { pick_no: 13 } }),
    );
    expect(res).toMatchObject({ ok: true });
  });
});

/* ========================================================================== */
/* Cross-check: a made pick is no longer available                            */
/* ========================================================================== */

describe("draft flow", () => {
  it("removes the picked player from the board", async () => {
    await seedLeague(db, { phase: "drafting" });
    const teamIds = await seedTeams(db);
    await startDraft(teamIds, 1);
    const pid = await makePlayer(db, { playerId: "flow-rb", position: "RB" });
    await db.insert(rankings).values({
      playerId: pid,
      set: "draft",
      week: 0,
      rank: 1,
      posRank: "RB1",
      tier: 1,
      adp: 1.2,
      fetchedAt: new Date(NOW),
    });
    const ctx = ctxFor({ teamId: teamIds[0]!, kind: "draft_pick", sessionContext: { pick_no: 1 } });

    const before = await getAvailablePlayersTool.execute({}, ctx);
    expect(before.total).toBe(1);

    expect(await makePickTool.execute({ player_id: pid, reason: "RB1 overall" }, ctx)).toMatchObject({ ok: true });

    const after = await getAvailablePlayersTool.execute({}, ctx);
    expect(after.total).toBe(0);

    const stored = await db
      .select()
      .from(rosterEntries)
      .where(and(eq(rosterEntries.teamId, teamIds[0]!), eq(rosterEntries.playerId, pid)));
    expect(stored).toHaveLength(1);
  });
});
