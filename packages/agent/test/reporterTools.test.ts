/**
 * The reporter's power-rankings tools (§8.4 table 3, §11): publish an edition,
 * read it back with movement, and refuse a team session.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "@league/shared";
import type { EngineDb, SessionKind } from "@league/engine";
import { powerRankings } from "@league/engine";
import type { ToolContext } from "../src/tools/types.ts";
import { getPowerRankings, publishPowerRankingsTool } from "../src/tools/reporter.ts";
import { createTestDb } from "./helpers/db.ts";
import type { TestDb } from "./helpers/db.ts";
import { SEASON, seedLeague, seedTeams } from "../../engine/test/helpers/factories.ts";

let db: TestDb;
let close: () => Promise<void>;
let ids: number[];

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await seedLeague(db);
  ids = await seedTeams(db);
});
afterEach(async () => {
  await close();
});

function ctxFor(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    db: db as unknown as EngineDb,
    clock: new FixedClock("2026-09-08T15:00:00.000Z"),
    teamId: null,
    sessionId: 1,
    kind: "reporter_power_rankings" as SessionKind,
    season: SEASON,
    config: {},
    sessionContext: {},
    ...overrides,
  };
}

const full = (order: number[]) => order.map((team_id, i) => ({ team_id, rank: i + 1, reason: `Reason ${i + 1}.` }));

describe("publish_power_rankings", () => {
  it("writes the edition under the session and the current week", async () => {
    const out = await publishPowerRankingsTool.execute({ rankings: full(ids) }, ctxFor({ sessionId: 7 }));
    expect(out).toMatchObject({ published: true, week: 1, count: 12 });
    const rows = await db.select().from(powerRankings);
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.sessionId === 7 && r.week === 1)).toBe(true);
  });

  it("surfaces the engine's refusal as a tool failure", async () => {
    const out = await publishPowerRankingsTool.execute({ rankings: full(ids).slice(0, 11) }, ctxFor());
    expect(out).toMatchObject({ ok: false, error: "invalid_args" });
    expect(await db.select().from(powerRankings)).toHaveLength(0);
  });

  it("is only for the reporter", async () => {
    const out = await publishPowerRankingsTool.execute({ rankings: full(ids) }, ctxFor({ teamId: ids[0]! }));
    expect(out).toMatchObject({ ok: false, error: "wrong_session_kind" });
  });

  it("get_power_rankings returns the newest edition with movement", async () => {
    expect(await getPowerRankings.execute({}, ctxFor())).toMatchObject({ published: false, rankings: [] });
    await publishPowerRankingsTool.execute({ rankings: full(ids) }, ctxFor({ sessionId: 1 }));
    const swapped = [ids[1]!, ids[0]!, ...ids.slice(2)];
    await publishPowerRankingsTool.execute(
      { rankings: full(swapped) },
      ctxFor({ sessionId: 2, clock: new FixedClock("2026-09-15T15:00:00.000Z") }),
    );
    const out = (await getPowerRankings.execute({}, ctxFor())) as {
      published: boolean;
      rankings: Array<{ rank: number; team_id: number; moved: number; reason: string; team: string | null }>;
    };
    expect(out.published).toBe(true);
    expect(out.rankings).toHaveLength(12);
    expect(out.rankings[0]).toMatchObject({ rank: 1, team_id: ids[1], moved: 1, reason: "Reason 1." });
    expect(out.rankings[1]).toMatchObject({ rank: 2, team_id: ids[0], moved: -1 });
    expect(out.rankings[2]).toMatchObject({ rank: 3, moved: 0 });
    expect(out.rankings[0]!.team).not.toBeNull();
  });
});
