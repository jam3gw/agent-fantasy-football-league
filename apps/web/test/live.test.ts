/**
 * §12.1 auto-refresh and the live transcript read.
 *
 * The pulse stamp must move whenever spectator-visible state changes (a
 * transcript event, a transaction, a board post, a session status flip, a
 * commissioner team edit, live matchup points, the draft clock) and hold
 * still when nothing does, because the client refreshes every open page the
 * moment it moves.
 *
 * `readSessionLive` is what the public live route returns verbatim, so its
 * field allowlist is asserted here: the session row carries fields that are
 * NOT public (`idempotency_key`, `workflow_run_id`), and a regression that
 * spreads the row would leak them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import {
  boardPosts,
  commissionerActions,
  draft,
  initLeagueSettings,
  leagueSettings,
  matchups,
  reporterPosts,
  sessionEvents,
  sessionStream,
  sessions,
  teams,
  transactions,
} from "@league/engine";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { computePulseStamp } from "../lib/pulse";
import { readSessionLive } from "../lib/sessionLive";

let db: TestDb;
let close: () => Promise<void>;
let clock: FixedClock;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = new FixedClock("2026-09-15T12:00:00Z");
  await initLeagueSettings(db, { season: 2026, phase: "regular", currentWeek: 2 });
});
afterEach(async () => {
  await close();
});

async function makeTeam(slug: string): Promise<number> {
  return (
    await db
      .insert(teams)
      .values({ slug, name: slug, modelId: "test/model", modelLabel: "T", provider: "t", tiebreakRand: 0.5 })
      .returning({ id: teams.id })
  )[0]!.id;
}

async function makeSession(teamId: number): Promise<number> {
  return (
    await db
      .insert(sessions)
      .values({
        teamId,
        kind: "weekly_review",
        trigger: "test",
        idempotencyKey: `secret-idem-${Math.random()}`,
        modelId: "test/model",
        status: "queued",
        context: {},
      })
      .returning({ id: sessions.id })
  )[0]!.id;
}

describe("computePulseStamp", () => {
  it("holds still while nothing changes", async () => {
    const a = await computePulseStamp(db);
    const b = await computePulseStamp(db);
    expect(b).toBe(a);
  });

  it("moves when a transcript event lands — the signal a live session is writing", async () => {
    const team = await makeTeam("a");
    const sessionId = await makeSession(team);
    const before = await computePulseStamp(db);
    await db.insert(sessionEvents).values({
      sessionId,
      seq: 0,
      type: "assistant",
      content: { text: "thinking" },
      createdAt: clock.now(),
    });
    expect(await computePulseStamp(db)).not.toBe(before);
  });

  it("moves on a transaction and on a board post", async () => {
    const team = await makeTeam("a");
    const before = await computePulseStamp(db);
    await db.insert(transactions).values({ type: "add", teamIds: [team], payload: {}, week: 2 });
    const afterTx = await computePulseStamp(db);
    expect(afterTx).not.toBe(before);
    await db.insert(boardPosts).values({ teamId: team, body: "trash talk", week: 2 });
    expect(await computePulseStamp(db)).not.toBe(afterTx);
  });

  it("moves when a session's status flips, even with no new event rows", async () => {
    const team = await makeTeam("a");
    const sessionId = await makeSession(team);
    const before = await computePulseStamp(db);
    await db
      .update(sessions)
      .set({ status: "running", updatedAt: new Date(clock.now().getTime() + 60_000) })
      .where(eq(sessions.id, sessionId));
    expect(await computePulseStamp(db)).not.toBe(before);
  });

  it("moves on live matchup points, the draft clock, and a commissioner action", async () => {
    const a = await makeTeam("a");
    const b = await makeTeam("b");
    const later = () => new Date(clock.now().getTime() + 60_000);

    const before = await computePulseStamp(db);
    await db.insert(matchups).values({ week: 2, homeTeamId: a, awayTeamId: b, homePoints: 12.3, updatedAt: later() });
    const afterMatchup = await computePulseStamp(db);
    expect(afterMatchup).not.toBe(before);

    await db.insert(draft).values({ id: 1, status: "running", updatedAt: later() });
    const afterDraft = await computePulseStamp(db);
    expect(afterDraft).not.toBe(afterMatchup);

    // §12.2: every admin action is logged, so pausing a team moves the stamp
    // through the log even though `teams` itself has no updated_at.
    await db.insert(commissionerActions).values({ action: "pause_team", payload: { teamId: a } });
    expect(await computePulseStamp(db)).not.toBe(afterDraft);
  });

  it("moves on a reporter post and on the settings singleton (week/phase flips)", async () => {
    const before = await computePulseStamp(db);
    await db.insert(reporterPosts).values({ kind: "recap", week: 2, title: "Week 2", bodyMd: "..." });
    const afterReporter = await computePulseStamp(db);
    expect(afterReporter).not.toBe(before);

    await db
      .update(leagueSettings)
      .set({ currentWeek: 3, updatedAt: new Date(clock.now().getTime() + 60_000) })
      .where(eq(leagueSettings.id, 1));
    expect(await computePulseStamp(db)).not.toBe(afterReporter);
  });

  it("keeps sub-second precision — two writes inside one second stamp differently", async () => {
    const team = await makeTeam("a");
    const sessionId = await makeSession(team);
    await db
      .update(sessions)
      .set({ updatedAt: new Date(clock.now().getTime() + 1) })
      .where(eq(sessions.id, sessionId));
    const first = await computePulseStamp(db);
    await db
      .update(sessions)
      .set({ updatedAt: new Date(clock.now().getTime() + 2) })
      .where(eq(sessions.id, sessionId));
    expect(await computePulseStamp(db)).not.toBe(first);
  });

  it("stamps an un-seeded database rather than throwing", async () => {
    const fresh = await createTestDb();
    try {
      expect(await computePulseStamp(fresh.db)).toBe("unseeded");
    } finally {
      await fresh.close();
    }
  });
});

describe("readSessionLive", () => {
  it("returns null for a session that does not exist", async () => {
    expect(await readSessionLive(db, 999_999, -1)).toBeNull();
  });

  it("enumerates public fields only — no idempotency key, no workflow run id", async () => {
    const team = await makeTeam("a");
    const sessionId = await makeSession(team);
    const payload = (await readSessionLive(db, sessionId, -1))!;
    const keys = Object.keys(payload.session);
    expect(keys).not.toContain("idempotencyKey");
    expect(keys).not.toContain("workflowRunId");
    expect(JSON.stringify(payload)).not.toContain("secret-idem");
    expect(payload.team).toEqual({ slug: "a", name: "a", modelLabel: "T" });
  });

  it("returns only events after the cursor, in order, and reports hasMore at a full page", async () => {
    const team = await makeTeam("a");
    const sessionId = await makeSession(team);
    for (let seq = 0; seq < 5; seq++) {
      await db.insert(sessionEvents).values({
        sessionId,
        seq,
        type: "info",
        content: { seq },
        createdAt: clock.now(),
      });
    }

    const fromStart = (await readSessionLive(db, sessionId, -1))!;
    expect(fromStart.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(fromStart.hasMore).toBe(false);

    const tail = (await readSessionLive(db, sessionId, 2))!;
    expect(tail.events.map((e) => e.seq)).toEqual([3, 4]);

    // A page smaller than what remains reports hasMore so the client catches up.
    const paged = (await readSessionLive(db, sessionId, -1, 2))!;
    expect(paged.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(paged.hasMore).toBe(true);
  });

  it("returns the staged partial for a running session and hides it for a terminal one", async () => {
    const team = await makeTeam("a");
    const sessionId = await makeSession(team);
    await db.insert(sessionStream).values({
      sessionId,
      stepNo: 3,
      reasoning: "weighing the flex spot",
      text: "half a sentence",
      updatedAt: clock.now(),
    });

    // Queued: not thinking yet, nothing to show.
    expect((await readSessionLive(db, sessionId, -1))!.stream).toBeNull();

    await db.update(sessions).set({ status: "running" }).where(eq(sessions.id, sessionId));
    const running = (await readSessionLive(db, sessionId, -1))!;
    expect(running.stream).toMatchObject({ stepNo: 3, reasoning: "weighing the flex spot" });

    // A crash can strand the row on a terminal session; it must stay hidden.
    await db.update(sessions).set({ status: "failed" }).where(eq(sessions.id, sessionId));
    expect((await readSessionLive(db, sessionId, -1))!.stream).toBeNull();
  });
});
