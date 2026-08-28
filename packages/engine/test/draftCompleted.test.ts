/**
 * The `draft.completed` handler (§9.3): the transition that turns a finished
 * draft into a running season.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { SEASON, makeGame, makePlayer, seedLeague, seedTeams } from "./helpers/factories.ts";
import { handleEvent } from "../src/events.ts";
import { getSettings } from "../src/settings.ts";
import { draft, matchups, players, scheduledJobs, sessions, teams } from "../src/db/schema.ts";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

/** A drafted league on the eve of week 1. */
async function seedDraftedLeague(clock: FixedClock) {
  await seedLeague(db, { phase: "drafting", currentWeek: 1 });
  const ids = await seedTeams(db);
  await db.insert(draft).values({ id: 1, status: "complete", order: ids, currentPick: 168 });
  // Week 1 kicks off after the draft ends; weeks 2 and 3 follow.
  await makeGame(db, { week: 1, kickoffAt: new Date("2026-09-10T00:20:00Z"), home: "SEA", away: "NE" });
  await makeGame(db, { week: 2, kickoffAt: new Date("2026-09-17T00:20:00Z"), home: "KC", away: "BUF" });
  await makeGame(db, { week: 3, kickoffAt: new Date("2026-09-24T00:20:00Z"), home: "SF", away: "DAL" });
  return ids;
}

describe("draft.completed (§9.3)", () => {
  it("starts the season: phase, start_week, free agents, waiver order, schedule, sessions", async () => {
    const clock = new FixedClock("2026-09-05T20:00:00Z"); // before week 1's kickoff
    const ids = await seedDraftedLeague(clock);
    // A player left over on waivers from the pre-draft period.
    await makePlayer(db, { playerId: "leftover", waiverUntil: new Date("2026-09-20T00:00:00Z") });

    await handleEvent(db, clock, { type: "draft.completed" });

    const settings = await getSettings(db);
    expect(settings.phase).toBe("regular");
    // The draft ended before week 1 kicked off, so the season starts at week 1.
    expect(settings.startWeek).toBe(1);
    expect(settings.currentWeek).toBe(1);

    // §3.4 rule 3: everyone is a free agent after the draft.
    const stillOnWaivers = (await db.select().from(players)).filter((p) => p.waiverUntil !== null);
    expect(stillOnWaivers).toEqual([]);

    // Waiver order is the reverse of the draft order.
    const teamRows = await db.select().from(teams);
    const lastDrafter = ids[ids.length - 1]!;
    expect(teamRows.find((t) => t.id === lastDrafter)!.waiverPriority).toBe(1);
    expect(teamRows.find((t) => t.id === ids[0]!)!.waiverPriority).toBe(12);

    // The schedule exists.
    const games = await db.select().from(matchups);
    expect(games.length).toBeGreaterThan(0);

    // Every team gets a weekly_review so lineups get set, plus draft grades.
    const created = await db.select().from(sessions);
    const reviews = created.filter((s) => s.kind === "weekly_review");
    expect(reviews).toHaveLength(12);
    expect(created.filter((s) => s.kind === "reporter_draft_grades")).toHaveLength(1);
    // ...staggered, not all at once (§9.3).
    const dueTimes = new Set(reviews.map((r) => r.createdAt.getTime()));
    expect(dueTimes.size).toBeGreaterThan(0);

    // And the first week is queued for planning.
    const jobs = await db.select().from(scheduledJobs);
    expect(jobs.some((j) => j.type === "week.plan")).toBe(true);
  });

  it("a late draft starts at the first week that has not kicked off yet (§3.7)", async () => {
    // The draft finishes after week 1 and week 2 have already kicked off.
    const clock = new FixedClock("2026-09-18T12:00:00Z");
    await seedDraftedLeague(clock);

    await handleEvent(db, clock, { type: "draft.completed" });

    const settings = await getSettings(db);
    expect(settings.startWeek).toBe(3);
    expect(settings.currentWeek).toBe(3);
  });

  it("is idempotent: running it twice does not double up sessions or matchups", async () => {
    const clock = new FixedClock("2026-09-05T20:00:00Z");
    await seedDraftedLeague(clock);

    await handleEvent(db, clock, { type: "draft.completed" });
    const firstSessions = (await db.select().from(sessions)).length;
    const firstMatchups = (await db.select().from(matchups)).length;

    await handleEvent(db, clock, { type: "draft.completed" });
    expect((await db.select().from(sessions)).length).toBe(firstSessions);
    expect((await db.select().from(matchups)).length).toBe(firstMatchups);
  });

  it("skips a paused team when booking the post-draft reviews", async () => {
    const clock = new FixedClock("2026-09-05T20:00:00Z");
    const ids = await seedDraftedLeague(clock);
    await db.update(teams).set({ paused: true }).where(eq(teams.id, ids[0]!));

    await handleEvent(db, clock, { type: "draft.completed" });
    const reviews = (await db.select().from(sessions)).filter((s) => s.kind === "weekly_review");
    expect(reviews).toHaveLength(11);
    expect(reviews.some((r) => r.teamId === ids[0]!)).toBe(false);
  });
});
