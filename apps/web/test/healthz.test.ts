/**
 * The external heartbeat (/api/healthz). Everything else that alerts is
 * produced by the tick itself, so a dead tick silences its own alarm; this is
 * the one signal an outside monitor can read. Same three-minute rule as the
 * /admin/health banner, deliberately: the two must never disagree about
 * whether the league is alive.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { health } from "@league/engine";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { heartbeat, TICK_STALE_MS } from "../lib/healthz";

let db: TestDb;
let close: () => Promise<void>;

const NOW = new Date("2026-09-15T16:00:00Z");

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

async function stampTick(at: Date) {
  await db.insert(health).values({ key: "cron.tick", lastSuccessAt: at });
}

describe("heartbeat", () => {
  it("is down when the tick has never run", async () => {
    const beat = await heartbeat(db, NOW);
    expect(beat.ok).toBe(false);
    expect(beat.lastTickAt).toBeNull();
  });

  it("is up while the tick is fresh", async () => {
    const at = new Date(NOW.getTime() - 60_000);
    await stampTick(at);
    const beat = await heartbeat(db, NOW);
    expect(beat.ok).toBe(true);
    expect(beat.lastTickAt?.getTime()).toBe(at.getTime());
  });

  it("turns down exactly past the admin banner's three-minute rule", async () => {
    await stampTick(new Date(NOW.getTime() - TICK_STALE_MS));
    expect((await heartbeat(db, NOW)).ok).toBe(true);

    await db.delete(health);
    await stampTick(new Date(NOW.getTime() - TICK_STALE_MS - 1000));
    const beat = await heartbeat(db, NOW);
    expect(beat.ok).toBe(false);
    // The stamp still comes back, so a monitor's alert can say how stale.
    expect(beat.lastTickAt).not.toBeNull();
  });
});
