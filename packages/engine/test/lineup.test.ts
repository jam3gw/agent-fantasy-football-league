/** setLineup (§7.1, §3.1, §3.3, §3.6, §7.5) — acceptance 15.1.2. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, and } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import {
  makeGame,
  makePlayer,
  rosterPlayer,
  seedFullRoster,
  seedLeague,
  seedTeams,
  setLineupEntry,
} from "./helpers/factories.ts";
import type { LineupSlotsInput, LineupViolation } from "../src/lineup.ts";
import { setLineup } from "../src/lineup.ts";
import { lineupEntries, players, transactions } from "../src/db/schema.ts";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

/** Clock with no KC games seeded → nothing on the default roster locks. */
const clock = new FixedClock("2026-09-10T12:00:00Z");

type FullRoster = Awaited<ReturnType<typeof seedFullRoster>>;

function fullSlots(r: FullRoster): LineupSlotsInput {
  return {
    QB: r.qb,
    RB1: r.rb1,
    RB2: r.rb2,
    WR1: r.wr1,
    WR2: r.wr2,
    TE: r.te,
    FLEX: r.flexRb,
    DST: r.dst,
    K: r.k,
    IR: null,
  };
}

function details(result: { ok: boolean }): LineupViolation[] {
  expect(result.ok).toBe(false);
  const failure = result as { ok: false; details?: unknown };
  return failure.details as LineupViolation[];
}

async function seedTeamWithRoster(): Promise<{ teamId: number; r: FullRoster }> {
  await seedLeague(db);
  const [t1] = await seedTeams(db);
  const r = await seedFullRoster(db, t1!);
  return { teamId: t1!, r };
}

describe("setLineup success path", () => {
  it("stores a full legal lineup, benches the rest, records one lineup transaction with the diff", async () => {
    const { teamId, r } = await seedTeamWithRoster();
    const res = await setLineup(db, clock, teamId, 1, fullSlots(r));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.starters).toEqual({
      QB: r.qb,
      RB1: r.rb1,
      RB2: r.rb2,
      WR1: r.wr1,
      WR2: r.wr2,
      TE: r.te,
      FLEX: r.flexRb,
      DST: r.dst,
      K: r.k,
    });
    expect(res.value.ir).toBeNull();
    expect([...res.value.bench].sort()).toEqual([...r.bench].sort());

    const stored = await db
      .select()
      .from(lineupEntries)
      .where(and(eq(lineupEntries.teamId, teamId), eq(lineupEntries.week, 1)));
    expect(stored).toHaveLength(9);

    const txns = await db.select().from(transactions).where(eq(transactions.type, "lineup"));
    expect(txns).toHaveLength(1);
    expect(txns[0]!.week).toBe(1);
    expect(txns[0]!.teamIds).toEqual([teamId]);
    const payload = txns[0]!.payload as {
      week: number;
      before: Record<string, string | null>;
      after: Record<string, string | null>;
      diff: Record<string, { from: string | null; to: string | null }>;
    };
    expect(payload.week).toBe(1);
    expect(payload.before.QB).toBeNull();
    expect(payload.after.QB).toBe(r.qb);
    expect(payload.diff.QB).toEqual({ from: null, to: r.qb });
    expect(Object.keys(payload.diff)).toHaveLength(9); // 9 slots changed, IR unchanged
  });

  it("replaces the previous non-ghost lineup and diffs only changed slots", async () => {
    const { teamId, r } = await seedTeamWithRoster();
    expect((await setLineup(db, clock, teamId, 1, fullSlots(r))).ok).toBe(true);
    // swap FLEX to a bench RB, empty the K slot
    const res = await setLineup(db, clock, teamId, 1, { ...fullSlots(r), FLEX: r.bench[0]!, K: null });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.starters.FLEX).toBe(r.bench[0]);
    expect(res.value.starters.K).toBeNull();
    expect(res.value.bench).toContain(r.k);
    expect(res.value.bench).toContain(r.flexRb);
    const txns = await db.select().from(transactions).where(eq(transactions.type, "lineup"));
    const payload = txns[1]!.payload as { diff: Record<string, unknown> };
    expect(Object.keys(payload.diff).sort()).toEqual(["FLEX", "K"]);
  });

  it("missing keys mean empty slots; an empty lineup is legal", async () => {
    const { teamId } = await seedTeamWithRoster();
    const res = await setLineup(db, clock, teamId, 1, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.starters.QB).toBeNull();
    expect(res.value.bench).toHaveLength(14);
    expect(res.value.ir).toBeNull();
  });

  it("rejects an unknown team", async () => {
    await seedLeague(db);
    const res = await setLineup(db, clock, 999, 1, {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("not_found");
  });

  it("rejects an unknown slot key with invalid_args", async () => {
    const { teamId, r } = await seedTeamWithRoster();
    const bad = { ...fullSlots(r), BN: r.bench[0] } as unknown as LineupSlotsInput;
    const res = await setLineup(db, clock, teamId, 1, bad);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("invalid_args");
    expect(details(res).some((d) => d.check === "input")).toBe(true);
  });
});

describe("§7.1 check 1 — named players must be rostered", () => {
  it("rejects a player who is not on the roster", async () => {
    const { teamId, r } = await seedTeamWithRoster();
    const outsider = await makePlayer(db, { playerId: "outsider", position: "QB", nflTeam: "SF" });
    const res = await setLineup(db, clock, teamId, 1, { ...fullSlots(r), QB: outsider });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("not_on_roster");
    const d = details(res);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ check: "on_roster", code: "not_on_roster", playerId: outsider, slot: "QB" });
    // nothing written
    expect(await db.select().from(lineupEntries)).toHaveLength(0);
    expect(await db.select().from(transactions)).toHaveLength(0);
  });
});

describe("§7.1 check 2 — no duplicates", () => {
  it("rejects the same player in two slots", async () => {
    const { teamId, r } = await seedTeamWithRoster();
    const res = await setLineup(db, clock, teamId, 1, { ...fullSlots(r), RB2: r.rb1 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("duplicate_player");
    expect(details(res)[0]).toMatchObject({ check: "duplicate", code: "duplicate_player", playerId: r.rb1 });
  });
});

describe("§7.1 check 3 — slot eligibility", () => {
  it("rejects a QB in FLEX; allows RB, WR, and TE in FLEX", async () => {
    const { teamId, r } = await seedTeamWithRoster();
    const bad = await setLineup(db, clock, teamId, 1, { ...fullSlots(r), FLEX: r.qb, QB: null });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toBe("slot_ineligible");
      expect(details(bad)[0]).toMatchObject({ check: "slot_eligibility", code: "slot_ineligible", playerId: r.qb, slot: "FLEX" });
    }
    // RB in FLEX (default fixture)
    expect((await setLineup(db, clock, teamId, 1, fullSlots(r))).ok).toBe(true);
    // WR in FLEX (bench[1] is a WR)
    expect((await setLineup(db, clock, teamId, 1, { ...fullSlots(r), FLEX: r.bench[1]! })).ok).toBe(true);
    // TE in FLEX
    expect((await setLineup(db, clock, teamId, 1, { ...fullSlots(r), FLEX: r.te, TE: null })).ok).toBe(true);
  });

  it("rejects an RB at QB and a skill player at DST", async () => {
    const { teamId, r } = await seedTeamWithRoster();
    const res = await setLineup(db, clock, teamId, 1, { QB: r.rb1, DST: r.wr1 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const codes = details(res).map((d) => d.code);
    expect(codes).toEqual(["slot_ineligible", "slot_ineligible"]);
  });
});

describe("§7.1 check 4 — IR eligibility and grandfathering (§3.6)", () => {
  it("rejects a healthy player moved into IR; accepts an IR-eligible one", async () => {
    const { teamId, r } = await seedTeamWithRoster();
    const bad = await setLineup(db, clock, teamId, 1, { IR: r.bench[0]! });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toBe("ir_ineligible");
      expect(details(bad)[0]).toMatchObject({ check: "ir_eligibility", code: "ir_ineligible", playerId: r.bench[0], slot: "IR" });
    }
    const hurt = await makePlayer(db, { playerId: "hurt", injuryStatus: "Out", nflTeam: "SF" });
    await rosterPlayer(db, teamId, hurt);
    const good = await setLineup(db, clock, teamId, 1, { IR: hurt });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.value.ir).toBe(hurt);
  });

  it("grandfathers the current IR occupant after he heals, but rejects a different healthy player", async () => {
    const { teamId, r } = await seedTeamWithRoster();
    const hurt = await makePlayer(db, { playerId: "hurt2", injuryStatus: "IR", nflTeam: "SF" });
    await rosterPlayer(db, teamId, hurt);
    expect((await setLineup(db, clock, teamId, 1, { IR: hurt })).ok).toBe(true);
    // he heals
    await db.update(players).set({ injuryStatus: null, status: "Active" }).where(eq(players.playerId, hurt));
    // keeping him in IR is grandfathered
    const keep = await setLineup(db, clock, teamId, 1, { QB: r.qb, IR: hurt });
    expect(keep.ok).toBe(true);
    // swapping IR to a healthy player is not
    const swap = await setLineup(db, clock, teamId, 1, { IR: r.bench[0]! });
    expect(swap.ok).toBe(false);
    if (!swap.ok) expect(swap.error).toBe("ir_ineligible");
  });
});

describe("§7.1 check 5 — active count ≤ 14", () => {
  it("rejects 15 active players; legal again when the new IR slot is filled", async () => {
    const { teamId, r } = await seedTeamWithRoster(); // 14 players
    const hurt = await makePlayer(db, { playerId: "fifteenth", injuryStatus: "IR", nflTeam: "SF" });
    await rosterPlayer(db, teamId, hurt); // 15th player
    const bad = await setLineup(db, clock, teamId, 1, { ...fullSlots(r), IR: null });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toBe("roster_full");
      expect(details(bad)[0]).toMatchObject({ check: "active_count", code: "roster_full" });
    }
    const good = await setLineup(db, clock, teamId, 1, { ...fullSlots(r), IR: hurt });
    expect(good.ok).toBe(true);
  });

  it("moving the IR occupant out with 15 rostered is rejected", async () => {
    const { teamId, r } = await seedTeamWithRoster();
    const hurt = await makePlayer(db, { playerId: "irout", injuryStatus: "IR", nflTeam: "SF" });
    await rosterPlayer(db, teamId, hurt);
    expect((await setLineup(db, clock, teamId, 1, { ...fullSlots(r), IR: hurt })).ok).toBe(true);
    const res = await setLineup(db, clock, teamId, 1, { ...fullSlots(r), IR: null });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("roster_full");
  });
});

describe("§7.1 check 6 — locks (§3.3)", () => {
  /** Roster: locked BUF players + free KC players; only BUF's game has kicked off. */
  async function seedLockScenario() {
    await seedLeague(db);
    const [t1] = await seedTeams(db);
    const teamId = t1!;
    const lockedRb = await makePlayer(db, { playerId: "lkd-rb", position: "RB", nflTeam: "BUF" });
    const lockedRb2 = await makePlayer(db, { playerId: "lkd-rb2", position: "RB", nflTeam: "BUF" });
    const lockedHurt = await makePlayer(db, { playerId: "lkd-hurt", position: "WR", nflTeam: "BUF", injuryStatus: "IR" });
    const freeRb = await makePlayer(db, { playerId: "free-rb", position: "RB", nflTeam: "KC" });
    for (const pid of [lockedRb, lockedRb2, lockedHurt, freeRb]) await rosterPlayer(db, teamId, pid);
    await makeGame(db, { week: 1, kickoffAt: new Date("2026-09-13T17:00:00Z"), home: "BUF", away: "MIA" });
    const before = new FixedClock("2026-09-13T16:00:00Z");
    const after = new FixedClock("2026-09-13T18:00:00Z");
    return { teamId, lockedRb, lockedRb2, lockedHurt, freeRb, before, after };
  }

  it("a locked starter cannot move to the bench, but the same move works before kickoff", async () => {
    const s = await seedLockScenario();
    await setLineupEntry(db, s.teamId, 1, s.lockedRb, "RB1");
    const res = await setLineup(db, s.after, s.teamId, 1, { RB1: null, RB2: s.freeRb });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("locked");
      expect(details(res)[0]).toMatchObject({ check: "lock", code: "locked", playerId: s.lockedRb, slot: "RB1" });
    }
    expect((await setLineup(db, s.before, s.teamId, 1, { RB1: null, RB2: s.freeRb })).ok).toBe(true);
  });

  it("a locked starter must stay in THAT slot (RB1 → RB2 rejected; staying put allowed)", async () => {
    const s = await seedLockScenario();
    await setLineupEntry(db, s.teamId, 1, s.lockedRb, "RB1");
    const res = await setLineup(db, s.after, s.teamId, 1, { RB1: s.freeRb, RB2: s.lockedRb });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(details(res)[0]).toMatchObject({ code: "locked", playerId: s.lockedRb });
    expect((await setLineup(db, s.after, s.teamId, 1, { RB1: s.lockedRb, RB2: s.freeRb })).ok).toBe(true);
  });

  it("a locked benched player cannot enter a starting slot", async () => {
    const s = await seedLockScenario();
    const res = await setLineup(db, s.after, s.teamId, 1, { RB1: s.lockedRb2 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("locked");
      expect(details(res)[0]).toMatchObject({ playerId: s.lockedRb2, slot: "RB1" });
    }
    expect((await setLineup(db, s.before, s.teamId, 1, { RB1: s.lockedRb2 })).ok).toBe(true);
  });

  it("a locked player cannot move into IR (even when IR-eligible)", async () => {
    const s = await seedLockScenario();
    const res = await setLineup(db, s.after, s.teamId, 1, { IR: s.lockedHurt });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("locked");
      expect(details(res)[0]).toMatchObject({ check: "lock", playerId: s.lockedHurt, slot: "IR" });
    }
    expect((await setLineup(db, s.before, s.teamId, 1, { IR: s.lockedHurt })).ok).toBe(true);
  });

  it("a locked player cannot move out of IR", async () => {
    const s = await seedLockScenario();
    await setLineupEntry(db, s.teamId, 1, s.lockedHurt, "IR");
    const res = await setLineup(db, s.after, s.teamId, 1, { IR: null });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(details(res)[0]).toMatchObject({ code: "locked", playerId: s.lockedHurt, slot: "IR" });
    expect((await setLineup(db, s.after, s.teamId, 1, { IR: s.lockedHurt })).ok).toBe(true);
  });

  it("locks do not apply to week + 1 (no week-2 kickoffs yet)", async () => {
    const s = await seedLockScenario();
    await setLineupEntry(db, s.teamId, 1, s.lockedRb, "RB1");
    // week 2: the week-1-locked player can be benched or started freely
    const res = await setLineup(db, s.after, s.teamId, 2, { RB1: null, RB2: s.lockedRb });
    expect(res.ok).toBe(true);
  });
});

describe("§7.1 check 7 — week window", () => {
  it("accepts current_week and current_week + 1; rejects past and + 2", async () => {
    await seedLeague(db, { currentWeek: 2 });
    const [t1] = await seedTeams(db);
    const r = await seedFullRoster(db, t1!);
    expect((await setLineup(db, clock, t1!, 2, fullSlots(r))).ok).toBe(true);
    expect((await setLineup(db, clock, t1!, 3, fullSlots(r))).ok).toBe(true);
    const past = await setLineup(db, clock, t1!, 1, fullSlots(r));
    expect(past.ok).toBe(false);
    if (!past.ok) {
      expect(past.error).toBe("bad_week");
      expect(details(past)[0]).toMatchObject({ check: "week", code: "bad_week" });
    }
    const far = await setLineup(db, clock, t1!, 4, fullSlots(r));
    expect(far.ok).toBe(false);
    if (!far.ok) expect(far.error).toBe("bad_week");
  });

  it("week + 1 entries are stored under that week and leave the current week alone", async () => {
    const { teamId, r } = await seedTeamWithRoster();
    expect((await setLineup(db, clock, teamId, 2, fullSlots(r))).ok).toBe(true);
    const w1 = await db
      .select()
      .from(lineupEntries)
      .where(and(eq(lineupEntries.teamId, teamId), eq(lineupEntries.week, 1)));
    const w2 = await db
      .select()
      .from(lineupEntries)
      .where(and(eq(lineupEntries.teamId, teamId), eq(lineupEntries.week, 2)));
    expect(w1).toHaveLength(0);
    expect(w2).toHaveLength(9);
  });
});

describe("ghost entries (§7.5)", () => {
  async function seedGhost() {
    const seeded = await seedTeamWithRoster();
    // a player NOT on this team's roster with a lineup entry = ghost (traded while locked)
    const ghost = await makePlayer(db, { playerId: "ghosty", position: "WR", nflTeam: "SF" });
    await setLineupEntry(db, seeded.teamId, 1, ghost, "WR1");
    return { ...seeded, ghost };
  }

  it("a successful setLineup leaves the ghost row untouched and off the bench list", async () => {
    const { teamId, r, ghost } = await seedGhost();
    const res = await setLineup(db, clock, teamId, 1, { ...fullSlots(r), WR1: null });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.starters.WR1).toBeNull();
    expect(res.value.bench).not.toContain(ghost);
    const rows = await db
      .select()
      .from(lineupEntries)
      .where(and(eq(lineupEntries.teamId, teamId), eq(lineupEntries.week, 1)));
    const ghostRow = rows.find((row) => row.playerId === ghost);
    expect(ghostRow).toMatchObject({ playerId: ghost, slot: "WR1" });
    expect(rows).toHaveLength(9); // 8 starters + ghost
  });

  it("a ghost-occupied slot cannot be filled (locked, message names the ghost)", async () => {
    const { teamId, r, ghost } = await seedGhost();
    const res = await setLineup(db, clock, teamId, 1, { ...fullSlots(r) }); // names WR1
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("locked");
    const d = details(res);
    expect(d[0]).toMatchObject({ check: "ghost_slot", code: "locked", playerId: r.wr1, slot: "WR1" });
    expect(d[0]!.message).toContain("ghost");
    expect(d[0]!.message).toContain(ghost);
  });

  it("a second setLineup replaces non-ghost entries but never deletes the ghost", async () => {
    const { teamId, r, ghost } = await seedGhost();
    expect((await setLineup(db, clock, teamId, 1, { ...fullSlots(r), WR1: null })).ok).toBe(true);
    expect((await setLineup(db, clock, teamId, 1, { QB: r.qb })).ok).toBe(true);
    const rows = await db
      .select()
      .from(lineupEntries)
      .where(and(eq(lineupEntries.teamId, teamId), eq(lineupEntries.week, 1)));
    expect(rows.map((row) => row.playerId).sort()).toEqual([ghost, r.qb].sort());
  });
});

describe("multiple simultaneous failures", () => {
  it("reports every violation in details and uses the first code at top level", async () => {
    const { teamId, r } = await seedTeamWithRoster();
    const outsider = await makePlayer(db, { playerId: "multi-out", position: "QB", nflTeam: "SF" });
    const res = await setLineup(db, clock, teamId, 1, {
      QB: outsider, // not_on_roster
      RB1: r.rb1,
      RB2: r.rb1, // duplicate_player
      FLEX: r.dst, // slot_ineligible (DEF in FLEX)
      IR: r.bench[0]!, // ir_ineligible (healthy)
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const d = details(res);
    const codes = d.map((v) => v.code);
    expect(codes).toContain("not_on_roster");
    expect(codes).toContain("duplicate_player");
    expect(codes).toContain("slot_ineligible");
    expect(codes).toContain("ir_ineligible");
    expect(d).toHaveLength(4);
    expect(res.error).toBe(d[0]!.code);
  });
});
