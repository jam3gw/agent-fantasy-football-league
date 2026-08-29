import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, isNull, sql } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { seedLeague, seedTeams } from "./helpers/factories.ts";
import { parseMentions, postMessage } from "../src/board.ts";
import { readScratchpad, writeScratchpad, MAX_SCRATCHPAD_LENGTH } from "../src/scratchpad.ts";
import { writeDecisionLog } from "../src/decisionLog.ts";
import { setTeamName } from "../src/teamNames.ts";
import { boardPosts, scratchpadVersions, sessions, teams } from "../src/db/schema.ts";

let db: TestDb;
let close: () => Promise<void>;
const clock = new FixedClock("2026-09-10T15:00:00Z");

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await seedLeague(db);
});
afterEach(async () => {
  await close();
});

describe("board (§post_message)", () => {
  it("posts, threads, parses mentions, and books board_reply sessions for mentioned teams", async () => {
    const ids = await seedTeams(db);
    const [t1, t2] = ids;
    const res = await postMessage(db, clock, t1!, "Bring it on @Team 2, your RBs are cooked");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.mentionTeamIds).toEqual([t2!]);
    // top-level post: rootId = own id, depth 0
    const post = (await db.select().from(boardPosts).where(eq(boardPosts.id, res.value.postId)))[0]!;
    expect(post.rootId).toBe(post.id);
    expect(post.depth).toBe(0);
    // board_reply session created for team 2
    const s = await db.select().from(sessions).where(eq(sessions.teamId, t2!));
    expect(s).toHaveLength(1);
    expect(s[0]!.kind).toBe("board_reply");

    // reply threads correctly
    const reply = await postMessage(db, clock, t2!, "talk is cheap", res.value.postId);
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    const replyRow = (await db.select().from(boardPosts).where(eq(boardPosts.id, reply.value.postId)))[0]!;
    expect(replyRow.rootId).toBe(post.id);
    expect(replyRow.depth).toBe(1);
  });

  it("rejects long posts, empty posts, paused authors; caps board_reply at 3/day and depth ≤ 2", async () => {
    const ids = await seedTeams(db);
    const [t1, t2] = ids;
    expect((await postMessage(db, clock, t1!, "")).ok).toBe(false);
    expect((await postMessage(db, clock, t1!, "x".repeat(1001))).ok).toBe(false);
    await db.update(teams).set({ paused: true }).where(eq(teams.id, t1!));
    const paused = await postMessage(db, clock, t1!, "hello");
    expect(paused.ok).toBe(false);
    if (!paused.ok) expect(paused.error).toBe("team_paused");
    await db.update(teams).set({ paused: false }).where(eq(teams.id, t1!));

    // 3 mention posts -> 3 sessions; the 4th books nothing
    for (let i = 0; i < 4; i++) {
      await postMessage(db, clock, t1!, `round ${i} @Team 2`);
    }
    const s = await db.select().from(sessions).where(eq(sessions.teamId, t2!));
    expect(s.filter((x) => x.kind === "board_reply")).toHaveLength(3);

    // depth chain: reply depth 3 books no session for a mention
    const p0 = await postMessage(db, clock, t2!, "root");
    if (!p0.ok) throw new Error("p0");
    const p1 = await postMessage(db, clock, t1!, "d1", p0.value.postId);
    if (!p1.ok) throw new Error("p1");
    const p2 = await postMessage(db, clock, t2!, "d2", p1.value.postId);
    if (!p2.ok) throw new Error("p2");
    const before = (await db.select().from(sessions)).length;
    const p3 = await postMessage(db, clock, t1!, "deep @Team 3", p2.value.postId); // depth 3
    expect(p3.ok).toBe(true);
    const after = (await db.select().from(sessions)).length;
    expect(after).toBe(before); // no session created at depth 3
  });

  it("parseMentions is case-insensitive exact-name", () => {
    const all = [
      { id: 1, name: "Team 1" },
      { id: 2, name: "The Bots" },
      { id: 3, name: null },
    ];
    expect(parseMentions("yo @the bots and @TEAM 1", all)).toEqual([1, 2]);
    expect(parseMentions("no mentions here", all)).toEqual([]);
  });
});

describe("scratchpad", () => {
  it("append/replace with versioning and the 20k cap", async () => {
    const [t1] = await seedTeams(db);
    expect(await readScratchpad(db, t1!)).toBe("");
    const w1 = await writeScratchpad(db, clock, t1!, "append", "plan A", 1);
    expect(w1.ok).toBe(true);
    const w2 = await writeScratchpad(db, clock, t1!, "append", "plan B");
    expect(w2.ok).toBe(true);
    expect(await readScratchpad(db, t1!)).toBe("plan A\nplan B");
    const w3 = await writeScratchpad(db, clock, t1!, "replace", "fresh");
    expect(w3.ok).toBe(true);
    expect(await readScratchpad(db, t1!)).toBe("fresh");
    const versions = await db.select().from(scratchpadVersions).where(eq(scratchpadVersions.teamId, t1!));
    expect(versions).toHaveLength(3);

    const over = await writeScratchpad(db, clock, t1!, "replace", "x".repeat(MAX_SCRATCHPAD_LENGTH + 1));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toBe("too_long");
    expect(await readScratchpad(db, t1!)).toBe("fresh"); // unchanged
  });
});

describe("decision log", () => {
  it("writes with week stamp; rejects empty and oversized", async () => {
    const [t1] = await seedTeams(db);
    const r = await writeDecisionLog(db, t1!, "weekly_review", "Benched the bye-week RB, claimed a kicker.");
    expect(r.ok).toBe(true);
    expect((await writeDecisionLog(db, t1!, "manual", "")).ok).toBe(false);
    expect((await writeDecisionLog(db, t1!, "manual", "x".repeat(801))).ok).toBe(false);
  });
});

describe("team names", () => {
  it("sets once; rejects a second set and oversizes", async () => {
    const [t1] = await seedTeams(db);
    // factories name teams; clear to simulate onboarding
    await db.update(teams).set({ name: null }).where(eq(teams.id, t1!));
    const r = await setTeamName(db, t1!, "Gridiron Gradient", "descend on them");
    expect(r.ok).toBe(true);
    const again = await setTeamName(db, t1!, "Other Name");
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toBe("name_already_set");
    expect((await setTeamName(db, t1!, "x".repeat(41))).ok).toBe(false);
  });

  it("refuses a name another team already holds, whatever the casing", async () => {
    const [t1, t2] = await seedTeams(db);
    await db.update(teams).set({ name: null }).where(inArray(teams.id, [t1!, t2!]));

    expect((await setTeamName(db, t1!, "Gridiron Gradient")).ok).toBe(true);
    const clash = await setTeamName(db, t2!, "  gridiron GRADIENT ");
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.error).toBe("name_taken");

    // The loser is still unnamed, so it can pick something else.
    const second = await setTeamName(db, t2!, "Regression to the Mean");
    expect(second.ok).toBe(true);
  });

  it("lets the other eleven teams sit unnamed without colliding on null", async () => {
    const ids = await seedTeams(db);
    await db.update(teams).set({ name: null }).where(inArray(teams.id, ids));
    // A partial unique index; nulls are not values, so every team may hold one.
    for (const id of ids.slice(0, 3)) {
      expect((await setTeamName(db, id, `Team ${id}`)).ok).toBe(true);
    }
    const stillNull = await db.select().from(teams).where(isNull(teams.name));
    expect(stillNull.length).toBe(ids.length - 3);
  });

  it("holds when two onboarding sessions race on the same name", async () => {
    const [t1, t2] = await seedTeams(db);
    await db.update(teams).set({ name: null }).where(inArray(teams.id, [t1!, t2!]));

    // Both start before either commits, which is exactly what six concurrent
    // onboarding sessions can do. The friendly pre-check cannot see the other
    // transaction's uncommitted row under READ COMMITTED; `teams_name_lower_uq`
    // is what actually decides it.
    const results = await Promise.allSettled([
      setTeamName(db, t1!, "The Algorithms"),
      setTeamName(db, t2!, "The Algorithms"),
    ]);

    const named = await db.select().from(teams).where(sql`lower(${teams.name}) = 'the algorithms'`);
    expect(named).toHaveLength(1);

    // Whichever lost must have been told why, not crashed with a driver error.
    const outcomes = results.map((r) => (r.status === "fulfilled" ? r.value : { ok: false as const, error: "threw" }));
    const failures = outcomes.filter((o) => !o.ok);
    expect(failures).toHaveLength(1);
    expect((failures[0] as { error: string }).error).toBe("name_taken");
  });
});
