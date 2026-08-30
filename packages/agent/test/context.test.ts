/**
 * The context snapshot (§8.5) and the on-demand refresh hooks: every session
 * opens on live projections and injury statuses, so the hooks must run
 * BEFORE the roster and projection reads — a refresh after them would hand
 * the model a snapshot staler than the table it just updated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import type { EngineDb, SessionKind } from "@league/engine";
import { playerWeekProj, players } from "@league/engine";
import { buildContextSnapshot } from "../src/context.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { SEASON, makePlayer, rosterPlayer, seedLeague, seedTeams } from "../../engine/test/helpers/factories.ts";

const NOW = "2026-09-13T15:00:00.000Z";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

function ctxFor(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    db: db as unknown as EngineDb,
    clock: new FixedClock(NOW),
    teamId: null,
    sessionId: 1,
    kind: "lineup_check" as SessionKind,
    season: SEASON,
    config: {},
    sessionContext: {},
    ...overrides,
  };
}

describe("context snapshot refresh hooks (§5.1/§5.4)", () => {
  it("refreshes projections and the player feed before reading the roster", async () => {
    await seedLeague(db);
    const [a] = (await seedTeams(db)) as [number];
    const kc = await makePlayer(db, { nflTeam: "KC", position: "RB" });
    await rosterPlayer(db, a, kc);

    const refreshProjections = vi.fn(async (season: number, week: number) => {
      await db.insert(playerWeekProj).values({ playerId: kc, season, week, projPtsPpr: 14.2 });
    });
    const refreshPlayerFeed = vi.fn(async () => {
      await db.update(players).set({ injuryStatus: "Questionable" }).where(eq(players.playerId, kc));
    });

    const snapshot = await buildContextSnapshot(
      ctxFor({ teamId: a, refreshProjections, refreshPlayerFeed }),
    );
    expect(refreshProjections).toHaveBeenCalledExactlyOnceWith(SEASON, 1);
    expect(refreshPlayerFeed).toHaveBeenCalledOnce();
    const roster = snapshot.my_team!.roster;
    expect(roster[0]!.proj_pts_ppr).toBe(14.2);
    expect(roster[0]!.injury_status).toBe("Questionable");
  });

  it("builds without the hooks (unit-test / offline mode) and for the reporter", async () => {
    await seedLeague(db);
    const [a] = (await seedTeams(db)) as [number];
    const kc = await makePlayer(db, { nflTeam: "KC", position: "RB" });
    await rosterPlayer(db, a, kc);

    const withTeam = await buildContextSnapshot(ctxFor({ teamId: a }));
    expect(withTeam.my_team!.roster[0]!.proj_pts_ppr).toBeNull();

    const reporter = await buildContextSnapshot(ctxFor({ teamId: null }));
    expect(reporter.my_team).toBeUndefined();
  });
});
