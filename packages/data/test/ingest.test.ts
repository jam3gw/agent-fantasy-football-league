import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import {
  initLeagueSettings,
  lineupEntries,
  nflGames,
  players,
  rosterEntries,
  scoringDiscrepancies,
  sessions,
  playerWeekStats,
  teams,
} from "@league/engine";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { upsertPlayers, upsertTrending } from "../src/ingest/players.ts";
import { upsertGames } from "../src/ingest/schedule.ts";
import { upsertWeekStats } from "../src/ingest/stats.ts";
import type { SleeperPlayerRaw } from "../src/sleeper.ts";

let db: TestDb;
let close: () => Promise<void>;
const clock = new FixedClock("2026-09-10T15:00:00Z");

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await initLeagueSettings(db, { season: 2026, phase: "regular", currentWeek: 1 });
});
afterEach(async () => {
  await close();
});

function rawPlayer(id: string, overrides: Partial<SleeperPlayerRaw> = {}): SleeperPlayerRaw {
  return {
    player_id: id,
    full_name: `Player ${id}`,
    position: "RB",
    fantasy_positions: ["RB"],
    team: "KC",
    status: "Active",
    injury_status: null,
    active: true,
    yahoo_id: 1000 + Number(id.replace(/\D/g, "") || 0),
    ...overrides,
  };
}

describe("players ingest (§5.1)", () => {
  it("upserts and emits injury.changed only for starters gaining an event status", async () => {
    const [team] = await db
      .insert(teams)
      .values({ slug: "t1", name: "T1", modelId: "m", modelLabel: "m", provider: "p", tiebreakRand: 0.1 })
      .returning({ id: teams.id });
    await upsertPlayers(db, clock, { p1: rawPlayer("p1"), p2: rawPlayer("p2"), p3: rawPlayer("p3") });
    await db.insert(rosterEntries).values([
      { teamId: team!.id, playerId: "p1", acquiredVia: "draft", acquiredAt: clock.now() },
      { teamId: team!.id, playerId: "p2", acquiredVia: "draft", acquiredAt: clock.now() },
    ]);
    // p1 starts; p2 benched. Game within 72h so the session books.
    await db.insert(lineupEntries).values({ teamId: team!.id, week: 1, playerId: "p1", slot: "RB1" });
    await db.insert(nflGames).values({
      gameId: "g1",
      season: 2026,
      week: 1,
      kickoffAt: new Date("2026-09-12T17:00:00Z"),
      home: "KC",
      away: "PHI",
    });

    const res = await upsertPlayers(db, clock, {
      p1: rawPlayer("p1", { injury_status: "Out" }),
      p2: rawPlayer("p2", { injury_status: "Out" }), // benched — no event
      p3: rawPlayer("p3", { injury_status: "Questionable" }), // not an event status
    });
    expect(res.injuryChanges).toEqual([{ teamId: team!.id, playerId: "p1", from: null, to: "Out" }]);
    const s = await db.select().from(sessions);
    expect(s).toHaveLength(1);
    expect(s[0]!.kind).toBe("injury_response");

    // same status again → no duplicate event
    const res2 = await upsertPlayers(db, clock, { p1: rawPlayer("p1", { injury_status: "Out" }) });
    expect(res2.injuryChanges).toEqual([]);
  });

  it("trending: clears old counts and sets new ones", async () => {
    await upsertPlayers(db, clock, { p1: rawPlayer("p1"), p2: rawPlayer("p2") });
    await upsertTrending(db, [{ player_id: "p1", count: 900 }]);
    await upsertTrending(db, [{ player_id: "p2", count: 40 }]);
    const rows = await db.select().from(players);
    expect(rows.find((r) => r.playerId === "p1")!.trendingAdds).toBeNull();
    expect(rows.find((r) => r.playerId === "p2")!.trendingAdds).toBe(40);
  });
});

describe("schedule ingest (§5.5)", () => {
  it("inserts, updates scores, never demotes live", async () => {
    const base = {
      gameId: "2026_01_NE_SEA",
      season: 2026,
      week: 1,
      gameType: "REG",
      kickoffAt: new Date("2026-09-10T00:20:00Z"),
      home: "SEA",
      away: "NE",
      homeScore: null,
      awayScore: null,
      final: false,
    };
    await upsertGames(db, [base]);
    await db.update(nflGames).set({ status: "live" }).where(eq(nflGames.gameId, base.gameId));
    await upsertGames(db, [{ ...base, homeScore: 3, awayScore: 0 }]);
    let g = (await db.select().from(nflGames))[0]!;
    expect(g.status).toBe("live");
    expect(g.homeScore).toBe(3);
    await upsertGames(db, [{ ...base, homeScore: 24, awayScore: 17, final: true }]);
    g = (await db.select().from(nflGames))[0]!;
    expect(g.status).toBe("final");
    // playoffs rows skipped
    const n = await upsertGames(db, [{ ...base, gameId: "post1", gameType: "POST" }]);
    expect(n).toBe(0);
  });
});

describe("stats ingest (§5.3, §3.2)", () => {
  it("stores pts_ppr + engine_pts; logs discrepancies only at finalization", async () => {
    const entries = [
      { player_id: "a", season: 2026, week: 1, stats: { rec: 4, rec_yd: 50, pts_ppr: 9.0 } },
      { player_id: "b", season: 2026, week: 1, stats: { rec: 2, rec_yd: 10, pts_ppr: 99.0 } }, // discrepancy
    ];
    const live = await upsertWeekStats(db, { season: 2026, week: 1, entries, markFinal: false });
    expect(live.discrepancies).toBe(0);
    const final = await upsertWeekStats(db, { season: 2026, week: 1, entries, markFinal: true });
    expect(final.discrepancies).toBe(1);
    const rows = await db.select().from(playerWeekStats);
    const a = rows.find((r) => r.playerId === "a")!;
    expect(a.enginePts).toBe(9);
    expect(a.final).toBe(true);
    const d = await db.select().from(scoringDiscrepancies);
    expect(d).toHaveLength(1);
    expect(d[0]!.playerId).toBe("b");
  });
});
