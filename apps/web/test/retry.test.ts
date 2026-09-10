/**
 * Session retry policy and provider-outage detection (§8.8).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { initLeagueSettings, sessions, teams } from "@league/engine";
import { MAX_SESSION_RETRIES, detectModelOutages, requeueFailedSessions } from "../lib/retry";

let db: TestDb;
let close: () => Promise<void>;
let clock: FixedClock;
let teamId: number;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = new FixedClock("2026-09-15T12:00:00Z");
  await initLeagueSettings(db, { season: 2026, phase: "regular", currentWeek: 2 });
  const [t] = await db
    .insert(teams)
    .values({ slug: "t1", name: "T1", modelId: "test/model", modelLabel: "M", provider: "test", tiebreakRand: 0.5 })
    .returning({ id: teams.id });
  teamId = t!.id;
});
afterEach(async () => {
  await close();
});

async function failedSession(opts: {
  key: string;
  kind?: string;
  deadlineOffsetMs?: number;
  status?: "failed" | "succeeded" | "timed_out" | "skipped";
  modelId?: string;
}) {
  const deadline = new Date(clock.now().getTime() + (opts.deadlineOffsetMs ?? 60 * 60_000));
  const rows = await db
    .insert(sessions)
    .values({
      teamId,
      kind: (opts.kind ?? "weekly_review") as never,
      trigger: "test",
      idempotencyKey: opts.key,
      modelId: opts.modelId ?? "test/model",
      status: opts.status ?? "failed",
      endedAt: clock.now(),
      createdAt: clock.now(),
      context: { deadline_at: deadline.toISOString() },
    })
    .returning({ id: sessions.id });
  return rows[0]!.id;
}

describe("session retries (§8.8)", () => {
  it("never re-queues a draft pick: the draft owns its own retries", async () => {
    // A retry booked here would be a `queued` draft_pick, and the tick refuses
    // to start those (the draft workflow runs each pick inline, §10.2). It
    // would sit in the queue for the rest of the season. `runDraftPick` takes
    // the next attempt number itself, or the clock auto-picks (§10.4).
    await failedSession({ key: "draft:47:1", kind: "draft_pick", deadlineOffsetMs: 120_000 });
    const result = await requeueFailedSessions(db, clock);
    expect(result.requeued).toBe(0);
    expect(result.abandoned).toBe(1);
    const queued = await db.select().from(sessions).where(eq(sessions.status, "queued"));
    expect(queued).toEqual([]);
  });

  it("re-queues a failed session with a :retry1 key", async () => {
    await failedSession({ key: "session:1:weekly_review:2026:2:x" });
    const result = await requeueFailedSessions(db, clock);
    expect(result.requeued).toBe(1);
    const all = await db.select().from(sessions);
    const retry = all.find((s) => s.idempotencyKey.endsWith(":retry1"));
    expect(retry).toBeDefined();
    expect(retry!.status).toBe("queued");
    expect(retry!.context.retry_attempt).toBe(1);
  });

  it("stops after two retries", async () => {
    await failedSession({ key: "session:1:weekly_review:2026:2:x:retry2" });
    const result = await requeueFailedSessions(db, clock);
    expect(result.requeued).toBe(0);
    expect(result.abandoned).toBe(1);
  });

  it("does not retry once the session's window has passed", async () => {
    await failedSession({
      key: "session:1:lineup_check:2026:2:kick",
      kind: "lineup_check",
      deadlineOffsetMs: -60_000, // kickoff already happened
    });
    const result = await requeueFailedSessions(db, clock);
    expect(result.requeued).toBe(0);
    expect(result.abandoned).toBe(1);
  });

  it("is idempotent: a second sweep does not double-queue", async () => {
    await failedSession({ key: "session:1:weekly_review:2026:2:y" });
    expect((await requeueFailedSessions(db, clock)).requeued).toBe(1);
    expect((await requeueFailedSessions(db, clock)).requeued).toBe(0);
    const retries = (await db.select().from(sessions)).filter((s) => s.idempotencyKey.includes(":retry"));
    expect(retries).toHaveLength(1);
  });

  it("MAX_SESSION_RETRIES matches the spec's two extra attempts", () => {
    expect(MAX_SESSION_RETRIES).toBe(2);
  });
});

describe("provider outage detection (§8.8)", () => {
  it("flags a model after three consecutive failures", async () => {
    for (let i = 0; i < 3; i++) await failedSession({ key: `f${i}` });
    const outages = await detectModelOutages(db, clock);
    expect(outages).toHaveLength(1);
    expect(outages[0]!.modelId).toBe("test/model");
    expect(outages[0]!.consecutiveFailures).toBe(3);
  });

  it("does not flag when a success breaks the streak", async () => {
    await failedSession({ key: "a" });
    await failedSession({ key: "b" });
    clock.advance(1000);
    await failedSession({ key: "c", status: "succeeded" });
    clock.advance(1000);
    await failedSession({ key: "d" });
    expect(await detectModelOutages(db, clock)).toEqual([]);
  });

  it("ignores skipped sessions, which never reached the provider", async () => {
    await failedSession({ key: "s1", status: "skipped" });
    await failedSession({ key: "e1" });
    await failedSession({ key: "e2" });
    await failedSession({ key: "e3" });
    const outages = await detectModelOutages(db, clock);
    expect(outages).toHaveLength(1);
  });

  it("keeps models separate", async () => {
    await db
      .insert(teams)
      .values({ slug: "t2", name: "T2", modelId: "other/model", modelLabel: "O", provider: "test", tiebreakRand: 0.4 });
    for (let i = 0; i < 3; i++) await failedSession({ key: `x${i}`, modelId: "other/model" });
    await failedSession({ key: "y0" });
    const outages = await detectModelOutages(db, clock);
    expect(outages.map((o) => o.modelId)).toEqual(["other/model"]);
  });

  it("does not flag a model id no seat runs any more (a swapped-away seat)", async () => {
    // Three failures on the promo id, then the commissioner swaps the seat.
    for (let i = 0; i < 3; i++) await failedSession({ key: `p${i}`, modelId: "zai/glm-5.3-promo-50" });
    await db.update(teams).set({ modelId: "zai/glm-5.3" }).where(eq(teams.id, teamId));
    expect(await detectModelOutages(db, clock)).toEqual([]);
  });

  it("still judges the reporter, which has no seat, by its streak", async () => {
    for (let i = 0; i < 3; i++) {
      await db.insert(sessions).values({
        teamId: null,
        kind: "reporter_power_rankings" as never,
        trigger: "test",
        idempotencyKey: `r${i}`,
        modelId: "reporter/model",
        status: "failed",
        endedAt: clock.now(),
        createdAt: clock.now(),
        context: {},
      });
    }
    const outages = await detectModelOutages(db, clock);
    expect(outages.map((o) => o.modelId)).toEqual(["reporter/model"]);
  });
});
