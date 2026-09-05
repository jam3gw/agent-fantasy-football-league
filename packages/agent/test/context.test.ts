/**
 * The context snapshot (§8.5) and the on-demand refresh hooks: every session
 * opens on live projections and injury statuses, so the hooks must run
 * BEFORE the roster and projection reads — a refresh after them would hand
 * the model a snapshot staler than the table it just updated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import type { EngineDb, SessionKind } from "@league/engine";
import { playerWeekProj, players, scheduleCheckIn, sessions, teams, trades } from "@league/engine";
import { buildContextSnapshot } from "../src/context.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { SEASON, makeGame, makePlayer, rosterPlayer, seedLeague, seedTeams } from "../../engine/test/helpers/factories.ts";

const NOW = "2026-09-13T15:00:00.000Z";

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
    kind: "lineup_check" as SessionKind,
    season: SEASON,
    config: {},
    sessionContext: {},
    ...overrides,
  };
}

describe("context snapshot refresh hooks (§5.1/§5.4)", () => {
  it("refreshes projections and the player feed before reading the roster", async () => {
    await seedLeague(db);
    const [a] = (await seedTeams(db)) as [number];
    const kc = await makePlayer(db, { nflTeam: "KC", position: "RB" });
    await rosterPlayer(db, a, kc);

    const refreshProjections = vi.fn(async (season: number, week: number) => {
      await db.insert(playerWeekProj).values({ playerId: kc, season, week, projPtsPpr: 14.2 });
    });
    const refreshPlayerFeed = vi.fn(async () => {
      await db.update(players).set({ injuryStatus: "Questionable" }).where(eq(players.playerId, kc));
    });

    const snapshot = await buildContextSnapshot(
      ctxFor({ teamId: a, refreshProjections, refreshPlayerFeed }),
    );
    expect(refreshProjections).toHaveBeenCalledExactlyOnceWith(SEASON, 1);
    expect(refreshPlayerFeed).toHaveBeenCalledOnce();
    const roster = snapshot.my_team!.roster;
    expect(roster[0]!.proj_pts_ppr).toBe(14.2);
    expect(roster[0]!.injury_status).toBe("Questionable");
  });

  it("builds without the hooks (unit-test / offline mode) and for the reporter", async () => {
    await seedLeague(db);
    const [a] = (await seedTeams(db)) as [number];
    const kc = await makePlayer(db, { nflTeam: "KC", position: "RB" });
    await rosterPlayer(db, a, kc);

    const withTeam = await buildContextSnapshot(ctxFor({ teamId: a }));
    expect(withTeam.my_team!.roster[0]!.proj_pts_ppr).toBeNull();

    const reporter = await buildContextSnapshot(ctxFor({ teamId: null }));
    expect(reporter.my_team).toBeUndefined();
  });
});

describe("scheduled sessions in the snapshot (§8.5, §8.10)", () => {
  // Measured 2026-09-03: eight of fifteen queued check-ins were booked for the
  // same moment as the lineup_check the league runs anyway, because nothing an
  // agent could see said that check existed. Now the snapshot lists both.
  it("lists my pending check-ins and the lineup checks the week plan will run for me", async () => {
    await seedLeague(db);
    const [a, b] = (await seedTeams(db)) as [number, number];
    const clock = new FixedClock("2026-09-08T12:00:00.000Z"); // Tuesday of week 1
    // Two windows with my players, one without.
    await makeGame(db, { week: 1, kickoffAt: new Date("2026-09-11T00:20:00Z"), home: "SEA", away: "NE" });
    await makeGame(db, { week: 1, kickoffAt: new Date("2026-09-13T17:00:00Z"), home: "KC", away: "BUF" });
    await makeGame(db, { week: 1, kickoffAt: new Date("2026-09-13T17:00:00Z"), home: "DAL", away: "NYG" });
    await makeGame(db, { week: 1, kickoffAt: new Date("2026-09-14T00:20:00Z"), home: "SF", away: "LAR" });
    const kc = await makePlayer(db, { nflTeam: "KC", position: "RB" });
    const ne = await makePlayer(db, { nflTeam: "NE", position: "WR" });
    await rosterPlayer(db, a, kc);
    await rosterPlayer(db, a, ne);
    const sf = await makePlayer(db, { nflTeam: "SF", position: "TE" });
    await rosterPlayer(db, b, sf);

    const booked = await scheduleCheckIn(db as unknown as EngineDb, clock, a, {
      at: new Date("2026-09-11T22:00:00Z"),
      reason: "Friday practice report on my WR",
    });
    expect(booked.ok).toBe(true);
    // Another team's check-in is not mine.
    await scheduleCheckIn(db as unknown as EngineDb, clock, b, {
      at: new Date("2026-09-11T23:00:00Z"),
      reason: "not yours",
    });

    const snapshot = await buildContextSnapshot(ctxFor({ teamId: a, clock, kind: "weekly_review" as SessionKind }));
    const sched = snapshot.scheduled_sessions!;
    expect(sched.my_check_ins).toHaveLength(1);
    expect(sched.my_check_ins[0]!.reason).toBe("Friday practice report on my WR");
    expect(sched.my_check_ins[0]!.at_et).toContain("Fri, Sep 11, 2026, 6:00 PM ET");
    // Thursday night (NE) and Sunday 1 PM (KC): 90 minutes before each. Not
    // Sunday night — no player of mine plays in it.
    expect(sched.league_sessions_for_me).toEqual([
      { kind: "lineup_check", at_et: "Thu, Sep 10, 2026, 6:50 PM ET", window_kickoff_et: "Thu, Sep 10, 2026, 8:20 PM ET" },
      { kind: "lineup_check", at_et: "Sun, Sep 13, 2026, 11:30 AM ET", window_kickoff_et: "Sun, Sep 13, 2026, 1:00 PM ET" },
    ]);
    expect(sched.note).toContain("90 minutes");
    // The trade-window days come from the setting, never a literal (§2, 2026-09-05).
    expect(sched.note).toContain("trade windows (Wed, Fri)");
  });

  it("shows a lineup check once when the week plan has already booked it", async () => {
    await seedLeague(db);
    const [a] = (await seedTeams(db)) as [number];
    const clock = new FixedClock("2026-09-08T12:00:00.000Z");
    await makeGame(db, { week: 1, kickoffAt: new Date("2026-09-13T17:00:00Z"), home: "KC", away: "BUF" });
    const kc = await makePlayer(db, { nflTeam: "KC", position: "RB" });
    await rosterPlayer(db, a, kc);
    await db.insert(sessions).values({
      teamId: a,
      kind: "lineup_check",
      trigger: "week.plan",
      idempotencyKey: "lc-1",
      status: "queued",
      modelId: "test/model",
      context: { due_at: "2026-09-13T15:30:00.000Z", window_kickoff_et: "2026-09-13T17:00:00.000Z" },
    });

    const snapshot = await buildContextSnapshot(ctxFor({ teamId: a, clock }));
    expect(snapshot.scheduled_sessions!.league_sessions_for_me).toEqual([
      { kind: "lineup_check", at_et: "Sun, Sep 13, 2026, 11:30 AM ET", window_kickoff_et: "Sun, Sep 13, 2026, 1:00 PM ET" },
    ]);
    expect(snapshot.scheduled_sessions!.my_check_ins).toEqual([]);
  });

  it("sorts queued league sessions of any kind with the planned checks, and skips one already due", async () => {
    await seedLeague(db);
    const [a] = (await seedTeams(db)) as [number];
    const clock = new FixedClock("2026-09-08T12:00:00.000Z");
    await makeGame(db, { week: 1, kickoffAt: new Date("2026-09-13T17:00:00Z"), home: "KC", away: "BUF" });
    const kc = await makePlayer(db, { nflTeam: "KC", position: "RB" });
    await rosterPlayer(db, a, kc);
    const row = (key: string, kind: "trade_response" | "post_waivers", due: string) => ({
      teamId: a,
      kind,
      trigger: "test",
      idempotencyKey: key,
      status: "queued" as const,
      modelId: "test/model",
      context: { due_at: due },
    });
    await db.insert(sessions).values([
      row("later", "trade_response", "2026-09-13T16:00:00.000Z"),
      row("sooner", "post_waivers", "2026-09-09T13:00:00.000Z"),
      row("past", "post_waivers", "2026-09-08T11:00:00.000Z"),
    ]);

    const snapshot = await buildContextSnapshot(ctxFor({ teamId: a, clock }));
    expect(snapshot.scheduled_sessions!.league_sessions_for_me.map((s) => [s.kind, s.at_et])).toEqual([
      ["post_waivers", "Wed, Sep 9, 2026, 9:00 AM ET"],
      ["lineup_check", "Sun, Sep 13, 2026, 11:30 AM ET"],
      ["trade_response", "Sun, Sep 13, 2026, 12:00 PM ET"],
    ]);
  });

  it("plans no lineup checks for a paused or eliminated team, as the week plan books none", async () => {
    await seedLeague(db);
    const [a] = (await seedTeams(db)) as [number];
    const clock = new FixedClock("2026-09-08T12:00:00.000Z");
    await makeGame(db, { week: 1, kickoffAt: new Date("2026-09-13T17:00:00Z"), home: "KC", away: "BUF" });
    const kc = await makePlayer(db, { nflTeam: "KC", position: "RB" });
    await rosterPlayer(db, a, kc);
    await db.update(teams).set({ eliminated: true }).where(eq(teams.id, a));

    const snapshot = await buildContextSnapshot(ctxFor({ teamId: a, clock }));
    expect(snapshot.scheduled_sessions!.league_sessions_for_me).toEqual([]);
  });
});

describe("votes owed outside a trade_vote session (§8.6)", () => {
  it("says the vote happens in a separate session, and says nothing in the vote session itself", async () => {
    await seedLeague(db);
    const [a, b, c] = (await seedTeams(db)) as [number, number, number];
    await db.insert(trades).values({
      proposerTeamId: b,
      counterpartyTeamId: c,
      givePlayerIds: ["x2"],
      getPlayerIds: ["y2"],
      status: "accepted",
      proposedAt: new Date("2026-09-13T10:00:00.000Z"),
      reviewEndsAt: new Date("2026-09-14T10:00:00.000Z"),
    });

    const window = await buildContextSnapshot(ctxFor({ teamId: a, kind: "trade_window" as SessionKind }));
    expect(window.pending!.votes_owed).toHaveLength(1);
    expect(window.pending!.votes_note).toContain("separate trade_vote session");
    expect(window.pending!.votes_note).toContain("This session has no vote tool");

    const vote = await buildContextSnapshot(ctxFor({ teamId: a, kind: "trade_vote" as SessionKind }));
    expect(vote.pending!.votes_owed).toHaveLength(1);
    expect(vote.pending!.votes_note).toBeUndefined();

    // A party to the trade owes no vote and gets no note.
    const party = await buildContextSnapshot(ctxFor({ teamId: b, kind: "trade_window" as SessionKind }));
    expect(party.pending!.votes_owed).toHaveLength(0);
    expect(party.pending!.votes_note).toBeUndefined();
  });
});
