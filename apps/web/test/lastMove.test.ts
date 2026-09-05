/**
 * The masthead's "Last move" is one statement of scalar subqueries over
 * every table the stream and the wire draw on. Like the pulse stamp it is
 * exposed to the correlated-subquery trap — an inner column that does not
 * exist on its inner table silently resolves against the outer settings row
 * — so each source is exercised here against a real schema.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  boardPosts,
  decisionLogs,
  initLeagueSettings,
  reporterPosts,
  sessions,
  teams,
  trades,
  transactions,
  waiverClaims,
  waiverRuns,
  players,
} from "@league/engine";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { readLastMove } from "../lib/broadcast";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await initLeagueSettings(db, { season: 2026, phase: "regular", currentWeek: 2 });
});
afterEach(async () => {
  await close();
});

const at = (iso: string) => new Date(iso);

async function makeTeam(slug: string): Promise<number> {
  return (
    await db
      .insert(teams)
      .values({ slug, name: slug, modelId: "test/model", modelLabel: "T", provider: "t", tiebreakRand: 0.5 })
      .returning({ id: teams.id })
  )[0]!.id;
}

describe("readLastMove", () => {
  it("is null, not 1970, when nothing has happened", async () => {
    expect(await readLastMove(db)).toBeNull();
  });

  it("is the newest row across every source the stream and the wire read", async () => {
    const a = await makeTeam("a");
    const b = await makeTeam("b");
    await db.insert(players).values({ playerId: "p1", fullName: "P One", position: "RB", nflTeam: "ATL" });

    const expectAfter = async (iso: string) => {
      const move = await readLastMove(db);
      expect(move?.toISOString()).toBe(at(iso).toISOString());
    };

    await db.insert(decisionLogs).values({ teamId: a, kind: "weekly_review", summary: "Set it.", createdAt: at("2026-09-10T10:00:00Z") });
    await expectAfter("2026-09-10T10:00:00Z");

    await db.insert(boardPosts).values({ teamId: a, body: "hi", week: 2, createdAt: at("2026-09-11T10:00:00Z") });
    await expectAfter("2026-09-11T10:00:00Z");

    await db.insert(transactions).values({ type: "add", teamIds: [a], payload: {}, week: 2, createdAt: at("2026-09-12T10:00:00Z") });
    await expectAfter("2026-09-12T10:00:00Z");

    await db.insert(reporterPosts).values({ kind: "recap", week: 2, title: "W2", bodyMd: "…", createdAt: at("2026-09-13T10:00:00Z") });
    await expectAfter("2026-09-13T10:00:00Z");

    await db.insert(sessions).values({
      teamId: a,
      kind: "weekly_review",
      trigger: "test",
      idempotencyKey: "k1",
      modelId: "test/model",
      status: "failed",
      context: {},
      createdAt: at("2026-09-14T10:00:00Z"),
    });
    await expectAfter("2026-09-14T10:00:00Z");

    await db.insert(trades).values({
      proposerTeamId: a,
      counterpartyTeamId: b,
      givePlayerIds: ["p1"],
      getPlayerIds: [],
      proposedAt: at("2026-09-15T10:00:00Z"),
      updatedAt: at("2026-09-15T10:00:00Z"),
    });
    await expectAfter("2026-09-15T10:00:00Z");

    await db.insert(waiverClaims).values({
      teamId: a,
      addPlayerId: "p1",
      priority: 1,
      status: "success",
      processedAt: at("2026-09-16T10:00:00Z"),
    });
    await expectAfter("2026-09-16T10:00:00Z");

    await db.insert(waiverRuns).values({
      runAt: at("2026-09-17T10:00:00Z"),
      summary: { orderBefore: [], orderAfter: [], results: [] },
    });
    await expectAfter("2026-09-17T10:00:00Z");
  });

  it("does not count a queued or running session as a move", async () => {
    const a = await makeTeam("a");
    await db.insert(sessions).values({
      teamId: a,
      kind: "weekly_review",
      trigger: "test",
      idempotencyKey: "k2",
      modelId: "test/model",
      status: "running",
      context: {},
      createdAt: at("2026-09-14T10:00:00Z"),
    });
    expect(await readLastMove(db)).toBeNull();
  });
});
