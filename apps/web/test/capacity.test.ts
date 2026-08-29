/**
 * The capacity watchdogs (2026-08-29 audit): database size and gateway
 * credit. Either one exhausting is silent and league-wide — a full database
 * fails writes behind calm admin pages, and a $0 gateway balance fails every
 * session for every team at once — so each check writes its own health row
 * and emails once per ET day while the condition stands. Nothing is stopped.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { FixedClock, etDay } from "@league/shared";
import { health } from "@league/engine";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { checkDbSize, checkGatewayCredits, DB_SIZE_BUDGET_BYTES } from "../lib/capacity";
import { dueForCapacityCheck } from "../lib/tick";

let db: TestDb;
let close: () => Promise<void>;
let clock: FixedClock;
const savedGatewayKey = process.env.AI_GATEWAY_API_KEY;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = new FixedClock("2026-09-15T16:00:00Z");
  delete process.env.AI_GATEWAY_API_KEY;
});
afterEach(async () => {
  if (savedGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
  else process.env.AI_GATEWAY_API_KEY = savedGatewayKey;
  await close();
});

async function row(key: string) {
  return (await db.select().from(health).where(eq(health.key, key)))[0];
}

async function notifyRows(prefix: string) {
  return db.select().from(health).where(like(health.key, `notify:${prefix}:%`));
}

/** A fetch stub for the credits endpoint; the real one is never called in tests. */
function creditsFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("checkDbSize", () => {
  it("is green while the database is under the warn line", async () => {
    const result = await checkDbSize(db, clock, DB_SIZE_BUDGET_BYTES);
    expect(result.alarmed).toBe(false);
    expect(result.bytes).toBeGreaterThan(0);
    const r = await row("db.size");
    expect(r?.lastSuccessAt).not.toBeNull();
    expect(r?.lastErrorAt).toBeNull();
    expect(await notifyRows("db_size")).toHaveLength(0);
  });

  it("alarms over the warn line, names the percentage, and emails once per day", async () => {
    // A budget of 1 KiB puts any real database far over the line.
    const first = await checkDbSize(db, clock, 1024);
    expect(first.alarmed).toBe(true);

    const r = await row("db.size");
    expect(r?.lastError).toContain("% of the");
    expect(r?.lastError).toContain("session_events");

    // Once per ET day, however often the hourly check fires.
    await checkDbSize(db, clock, 1024);
    const notices = await notifyRows("db_size");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.key).toBe(`notify:db_size:${etDay(clock.now())}`);
  });
});

describe("checkGatewayCredits", () => {
  it("records that it cannot read the balance when the key is missing", async () => {
    const result = await checkGatewayCredits(db, clock);
    expect(result).toEqual({ balanceUsd: null, alarmed: false });
    expect((await row("gateway.credits"))?.lastError).toContain("AI_GATEWAY_API_KEY");
  });

  it("is green while the balance clears the alarm line", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    const result = await checkGatewayCredits(db, clock, 100, creditsFetch(200, { balance: "250.00", total_used: "4.50" }));
    expect(result).toEqual({ balanceUsd: 250, alarmed: false });
    const r = await row("gateway.credits");
    expect(r?.lastSuccessAt).not.toBeNull();
    expect(r?.lastErrorAt).toBeNull();
  });

  it("alarms under the line, carries the balance, and emails once per day", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    const result = await checkGatewayCredits(db, clock, 100, creditsFetch(200, { balance: "42.10" }));
    expect(result).toEqual({ balanceUsd: 42.1, alarmed: true });
    expect((await row("gateway.credits"))?.lastError).toContain("$42.10");

    await checkGatewayCredits(db, clock, 100, creditsFetch(200, { balance: "41.00" }));
    expect(await notifyRows("gateway_credits")).toHaveLength(1);
  });

  it("stays gated for an hour even when the check itself failed", async () => {
    const now = clock.now();
    expect(await dueForCapacityCheck(db, now)).toBe(true);
    // The stamp was written by the gate itself, before any check ran — so a
    // check that throws retries on the next hourly turn, not per minute.
    expect(await dueForCapacityCheck(db, new Date(now.getTime() + 60_000))).toBe(false);
    expect(await dueForCapacityCheck(db, new Date(now.getTime() + 59 * 60_000))).toBe(false);
    expect(await dueForCapacityCheck(db, new Date(now.getTime() + 61 * 60_000))).toBe(true);
  });

  it("records a gateway error status without alarming", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    const result = await checkGatewayCredits(db, clock, 100, creditsFetch(401, {}));
    expect(result).toEqual({ balanceUsd: null, alarmed: false });
    expect((await row("gateway.credits"))?.lastError).toContain("401");
  });

  it("records an unusable body shape rather than treating it as $0", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    const result = await checkGatewayCredits(db, clock, 100, creditsFetch(200, { credits: 5 }));
    expect(result).toEqual({ balanceUsd: null, alarmed: false });
    expect((await row("gateway.credits"))?.lastError).toContain("no usable balance");
    expect(await notifyRows("gateway_credits")).toHaveLength(0);
  });

  it("clears the alarm text once the balance recovers", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    await checkGatewayCredits(db, clock, 100, creditsFetch(200, { balance: "42.10" }));
    await checkGatewayCredits(db, clock, 100, creditsFetch(200, { balance: "500.00" }));
    // A stale "$42.10" beside an ok badge would read as a live emergency.
    const r = await row("gateway.credits");
    expect(r?.lastError).toBeNull();
    expect(r?.lastErrorAt).toBeNull();
    expect(r?.lastSuccessAt).not.toBeNull();
  });

  it("survives the fetch itself failing", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    const boom = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await checkGatewayCredits(db, clock, 100, boom);
    expect(result).toEqual({ balanceUsd: null, alarmed: false });
    expect((await row("gateway.credits"))?.lastError).toContain("network down");
  });
});
