/**
 * Draft session attempt numbering (§10.2). A pick resumed after a pause must
 * get a NEW session; reusing attempt 1 would collide with the paused session's
 * idempotency key and drop the pick straight to an auto-pick.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { initLeagueSettings, sessions, teams } from "@league/engine";
import { nextAttemptNumberForTest } from "../lib/draft";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await initLeagueSettings(db, { season: 2026, phase: "drafting", currentWeek: 1 });
});
afterEach(async () => {
  await close();
});

async function seedSession(pickNo: number, attempt: number) {
  const [team] = await db
    .insert(teams)
    .values({
      slug: `t-${pickNo}-${attempt}`,
      // Distinct: team names are unique case-insensitively (teams_name_lower_uq).
      name: `T ${pickNo}-${attempt}`,
      modelId: "m",
      modelLabel: "M",
      provider: "p",
      tiebreakRand: 0.1,
    })
    .returning({ id: teams.id });
  await db.insert(sessions).values({
    teamId: team!.id,
    kind: "draft_pick",
    trigger: "draft",
    idempotencyKey: `draft:${pickNo}:${attempt}`,
    modelId: "m",
    status: "paused",
    context: {},
  });
}

describe("draft attempt numbering (§10.2)", () => {
  it("starts at 1 for a fresh pick", async () => {
    expect(await nextAttemptNumberForTest(db, 42)).toBe(1);
  });

  it("steps past a paused session so a resumed pick gets its own session", async () => {
    await seedSession(42, 1);
    expect(await nextAttemptNumberForTest(db, 42)).toBe(2);
    await seedSession(42, 2);
    expect(await nextAttemptNumberForTest(db, 42)).toBe(3);
  });

  it("counts only the pick it was asked about", async () => {
    await seedSession(7, 1);
    await seedSession(7, 2);
    expect(await nextAttemptNumberForTest(db, 8)).toBe(1);
    // A pick whose number is a prefix of another must not be confused with it.
    await seedSession(70, 1);
    expect(await nextAttemptNumberForTest(db, 7)).toBe(3);
  });
});
