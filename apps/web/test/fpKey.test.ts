/**
 * A missing FANTASYPROS_API_KEY used to make `ingest.fp_rankings` return
 * immediately and report `done`. Nothing was ingested, nothing was recorded,
 * and §5.7's rankings gate then blocks the draft with an empty
 * /admin/rankings page as the only evidence. It cost an afternoon on the day
 * the league first came up.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { health, initLeagueSettings } from "@league/engine";
import { createTestDb, type TestDb } from "../../../packages/engine/test/helpers/db";
import { runJob } from "../lib/jobs";

let db: TestDb;
let close: () => Promise<void>;
let clock: FixedClock;
const saved = process.env.FANTASYPROS_API_KEY;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = new FixedClock("2026-08-29T14:00:00Z");
  await initLeagueSettings(db, { season: 2026, phase: "pre_draft", currentWeek: 1 });
  delete process.env.FANTASYPROS_API_KEY;
});
afterEach(async () => {
  if (saved === undefined) delete process.env.FANTASYPROS_API_KEY;
  else process.env.FANTASYPROS_API_KEY = saved;
  await close();
});

describe("a missing FantasyPros key (§5.7, §17)", () => {
  for (const type of ["ingest.fp_rankings", "ingest.fp_injuries"]) {
    it(`${type} fails rather than reporting success`, async () => {
      await expect(runJob(db, clock, type, {})).rejects.toThrow(/FANTASYPROS_API_KEY is not set/);
    });
  }

  it("records what is wrong and how to fix it, so /admin/health shows it", async () => {
    await runJob(db, clock, "ingest.fp_rankings", {}).catch(() => undefined);
    const [row] = await db.select().from(health).where(eq(health.key, "fp.key"));
    expect(row?.lastError).toContain("FANTASYPROS_API_KEY is not set");
    // The two things a person needs: the consequence, and the remedy.
    expect(row?.lastError).toContain("the draft cannot start");
    expect(row?.lastError).toContain("redeploy");
    expect(row?.lastErrorAt).not.toBeNull();
  });
});
