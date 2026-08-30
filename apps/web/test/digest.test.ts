/**
 * §12.3 — the commissioner digest builds against real driver types.
 *
 * The production failure this guards: `sum(cost_usd)` comes back from the
 * driver as a string (numeric has no lossless JS number), and the draft
 * digest called `.toFixed` on it — so the one email that reports the draft
 * died with `toFixed is not a function` and was never sent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "@league/shared";
import { initLeagueSettings, sessions, spendLedger, teams } from "@league/engine";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { buildWeeklyDigest } from "../lib/digest";

let db: TestDb;
let close: () => Promise<void>;
let clock: FixedClock;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = new FixedClock("2026-08-30T22:30:00Z");
  await initLeagueSettings(db, { season: 2026, phase: "pre_draft", currentWeek: 1 });
});
afterEach(async () => {
  await close();
});

describe("§12.3 — the draft digest", () => {
  it("totals the draft's spend from the ledger without tripping on numeric strings", async () => {
    const [team] = await db
      .insert(teams)
      .values({ slug: "t1", name: "Team 1", modelId: "m/1", modelLabel: "M1", provider: "t", tiebreakRand: 0 })
      .returning({ id: teams.id });
    const [session] = await db
      .insert(sessions)
      .values({
        teamId: team!.id,
        kind: "draft_pick",
        trigger: "draft",
        idempotencyKey: "pick-1",
        modelId: "m/1",
        status: "succeeded",
        context: {},
      })
      .returning({ id: sessions.id });
    await db.insert(spendLedger).values([
      { sessionId: session!.id, teamId: team!.id, kind: "draft_pick", stepNo: 1, costUsd: 1.25, source: "gateway" },
      { sessionId: session!.id, teamId: team!.id, kind: "onboarding", stepNo: 2, costUsd: 0.5, source: "gateway" },
    ]);

    const { subject, html } = await buildWeeklyDigest(db, clock, { week: 1, reason: "draft" });
    expect(subject).toContain("Draft digest");
    expect(html).toContain("$1.75");
  });

  it("builds the weekly digest on an empty week", async () => {
    const { subject } = await buildWeeklyDigest(db, clock, { week: 1 });
    expect(subject).toContain("Week 1 digest");
  });
});
