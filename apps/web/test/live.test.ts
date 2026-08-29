/**
 * §12.1 auto-refresh — the pulse stamp the site polls. It must move whenever
 * spectator-visible state changes (a transcript event, a transaction, a board
 * post, a session status flip) and hold still when nothing does, because the
 * client refreshes every open page the moment it moves.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { boardPosts, initLeagueSettings, sessionEvents, sessions, teams, transactions } from "@league/engine";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { computePulseStamp } from "../lib/pulse";

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
        idempotencyKey: `k-${Math.random()}`,
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
});
