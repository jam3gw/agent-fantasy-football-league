/**
 * The redesigned pages show four things the league does not store: a chance to
 * win, a team's recent form, a power ranking with week-to-week movement, and a
 * sentence describing a transaction. Each is derived, so each is a claim the
 * site makes on its own account — these pin down what those claims mean.
 */
import { describe, expect, it } from "vitest";
import {
  MARGIN_SCALE,
  describeTransaction,
  foldForm,
  newestFirst,
  powerScore,
  rankingBefore,
  summarizeBody,
  teamName,
  transactionPlayerIds,
  remainingPoints,
  winChanceFromMargin,
  type FinalGame,
} from "../lib/broadcastLogic";

describe("what a starter still has to give", () => {
  it("is the whole projection before his game starts", () => {
    expect(remainingPoints(15, 0)).toBe(15);
    expect(remainingPoints(15, null)).toBe(15);
  });

  it("is only what is left once he is part-way through", () => {
    // The 10 he has scored is already inside the matchup total; counting the
    // full 15 on top of it was the bug that made a leading team read 10%.
    expect(remainingPoints(15, 10)).toBe(5);
  });

  it("is nothing once he has passed his projection", () => {
    expect(remainingPoints(15, 22)).toBe(0);
  });

  it("is nothing rather than NaN when the feed has no projection", () => {
    expect(remainingPoints(null, 8)).toBe(0);
    expect(remainingPoints(Number.NaN, 8)).toBe(0);
  });

  it("never returns a negative, so a big day cannot drag a team's own total down", () => {
    for (const [proj, scored] of [[0, 30], [5, 5], [12, 40]]) {
      expect(remainingPoints(proj, scored)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("win chance", () => {
  it("is a coin flip when the projected margin is zero", () => {
    expect(winChanceFromMargin(0)).toBeCloseTo(0.5, 10);
  });

  it("is symmetric: leading by X is trailing by X, mirrored", () => {
    for (const margin of [1, 7.5, 20, 60]) {
      expect(winChanceFromMargin(margin) + winChanceFromMargin(-margin)).toBeCloseTo(1, 10);
    }
  });

  it("rises with the margin and stays inside 0 and 1", () => {
    const points = [-200, -40, -10, 0, 10, 40, 200].map(winChanceFromMargin);
    for (let i = 1; i < points.length; i++) expect(points[i]).toBeGreaterThan(points[i - 1]);
    expect(points[0]).toBeGreaterThan(0);
    expect(points[points.length - 1]).toBeLessThan(1);
  });

  it("puts a ten-point projected lead near 70%, which is the scale's whole job", () => {
    // If MARGIN_SCALE is ever retuned this is the assertion that should argue
    // about it — a ten-point lead reading as 95% would be a lie on the page.
    expect(winChanceFromMargin(10)).toBeGreaterThan(0.6);
    expect(winChanceFromMargin(10)).toBeLessThan(0.75);
  });

  it("does not emit NaN when a projection is missing and the margin is not finite", () => {
    expect(winChanceFromMargin(Number.NaN)).toBe(0.5);
    expect(winChanceFromMargin(Number.POSITIVE_INFINITY)).toBe(0.5);
  });

  it("keeps the scale a positive number", () => {
    expect(MARGIN_SCALE).toBeGreaterThan(0);
  });
});

describe("form", () => {
  const game = (week: number, home: number, away: number, hp: number, ap: number): FinalGame => ({
    week,
    homeTeamId: home,
    awayTeamId: away,
    homePoints: hp,
    awayPoints: ap,
  });

  it("records a win for the higher score and a loss for the lower, both sides", () => {
    const form = foldForm([game(1, 1, 2, 100, 90)]);
    expect(form.get(1)).toEqual(["W"]);
    expect(form.get(2)).toEqual(["L"]);
  });

  it("calls an exact tie a tie for both teams", () => {
    const form = foldForm([game(1, 1, 2, 88.5, 88.5)]);
    expect(form.get(1)).toEqual(["T"]);
    expect(form.get(2)).toEqual(["T"]);
  });

  it("treats a missing score as zero rather than dropping the game", () => {
    const form = foldForm([{ week: 1, homeTeamId: 1, awayTeamId: 2, homePoints: null, awayPoints: 12 }]);
    expect(form.get(1)).toEqual(["L"]);
    expect(form.get(2)).toEqual(["W"]);
  });

  it("puts the newest result last, whatever order the rows arrive in", () => {
    // The chip row reads left to right as oldest to newest, so this ordering
    // is what makes "newest game is on the right" true in the legend.
    const form = foldForm([game(3, 1, 2, 80, 90), game(1, 1, 2, 100, 90), game(2, 1, 2, 70, 90)]);
    expect(form.get(1)).toEqual(["W", "L", "L"]);
  });

  it("keeps only the last N", () => {
    const games = [1, 2, 3, 4, 5, 6, 7].map((w) => game(w, 1, 2, w % 2 === 0 ? 100 : 80, 90));
    expect(foldForm(games, 3).get(1)).toHaveLength(3);
    expect(foldForm(games, 3).get(1)).toEqual(["L", "W", "L"]);
  });

  it("returns nothing for a league that has not finalized a game", () => {
    expect(foldForm([]).size).toBe(0);
  });
});

describe("power ranking", () => {
  it("weighs winning above scoring: a worse-scoring team that wins ranks higher", () => {
    const winner = powerScore(1, 200, 260, 0.9);
    const scorer = powerScore(0.5, 260, 260, 0.9);
    expect(winner).toBeGreaterThan(scorer);
  });

  it("rewards lineup efficiency when record and points match", () => {
    expect(powerScore(0.5, 200, 200, 0.99)).toBeGreaterThan(powerScore(0.5, 200, 200, 0.8));
  });

  it("does not divide by zero before anyone has scored", () => {
    expect(powerScore(0, 0, 0, null)).toBe(0);
    expect(Number.isFinite(powerScore(0.5, 0, 0, null))).toBe(true);
  });

  describe("movement", () => {
    const history: FinalGame[] = [
      { week: 1, homeTeamId: 1, awayTeamId: 2, homePoints: 120, awayPoints: 90 },
      { week: 1, homeTeamId: 3, awayTeamId: 4, homePoints: 110, awayPoints: 100 },
      { week: 2, homeTeamId: 2, awayTeamId: 3, homePoints: 130, awayPoints: 80 },
      { week: 2, homeTeamId: 4, awayTeamId: 1, homePoints: 125, awayPoints: 70 },
    ];

    it("ranks on the weeks before the one asked about, and no later", () => {
      const afterWeekOne = rankingBefore(history, 2);
      // Week 1 only: team 1 and team 3 won, team 1 by more.
      expect(afterWeekOne.get(1)).toBe(1);
      expect(afterWeekOne.get(3)).toBe(2);
      expect(afterWeekOne.get(2)).toBeGreaterThan(2);
    });

    it("moves a team that wins big up the order", () => {
      const before = rankingBefore(history, 2);
      const after = rankingBefore(history, 3);
      // Team 2 lost week 1 then won week 2 by fifty; it must climb.
      expect(after.get(2)!).toBeLessThan(before.get(2)!);
    });

    it("is empty before any week has been played", () => {
      expect(rankingBefore(history, 1).size).toBe(0);
    });

    it("orders ties the same way every time", () => {
      const level: FinalGame[] = [
        { week: 1, homeTeamId: 7, awayTeamId: 8, homePoints: 100, awayPoints: 100 },
        { week: 1, homeTeamId: 9, awayTeamId: 10, homePoints: 100, awayPoints: 100 },
      ];
      const once = [...rankingBefore(level, 2).entries()];
      const twice = [...rankingBefore(level, 2).entries()];
      expect(once).toEqual(twice);
    });
  });
});

describe("activity stream", () => {
  const at = (iso: string) => ({ at: new Date(iso) });

  it("puts the newest item first", () => {
    const merged = newestFirst([at("2026-09-20T10:00:00Z"), at("2026-09-20T16:00:00Z")], 10);
    expect(merged[0].at.toISOString()).toBe("2026-09-20T16:00:00.000Z");
  });

  it("caps the stream without mutating what it was given", () => {
    const items = [at("2026-09-20T10:00:00Z"), at("2026-09-20T16:00:00Z"), at("2026-09-20T12:00:00Z")];
    expect(newestFirst(items, 2)).toHaveLength(2);
    expect(items[0].at.toISOString()).toBe("2026-09-20T10:00:00.000Z");
  });
});

describe("transaction descriptions", () => {
  it("names both sides of a waiver claim when the payload has them", () => {
    expect(describeTransaction("waiver_add", { addedName: "Cade Otton", droppedName: "Rome Odunze" })).toBe(
      "Claimed Cade Otton and dropped Rome Odunze.",
    );
  });

  it("resolves the player ids the engine actually writes", () => {
    // waivers.ts records `{ playerId, dropPlayerId }` — ids, not names. Reading
    // only name keys is why every claim used to read "Won a waiver claim."
    const names: Record<string, string> = { p1: "Cade Otton", p2: "Rome Odunze" };
    expect(
      describeTransaction("waiver_add", { playerId: "p1", dropPlayerId: "p2" }, (id) => names[id] ?? null),
    ).toBe("Claimed Cade Otton and dropped Rome Odunze.");
    expect(describeTransaction("add", { playerId: "p1" }, (id) => names[id] ?? null)).toBe(
      "Added Cade Otton from free agency.",
    );
    expect(describeTransaction("drop", { playerId: "p2" }, (id) => names[id] ?? null)).toBe(
      "Dropped Rome Odunze.",
    );
  });

  it("degrades to a nameless sentence when an id cannot be resolved", () => {
    expect(describeTransaction("waiver_add", { playerId: "gone" }, () => null)).toBe("Won a waiver claim.");
  });

  it("describes a draft pick from the snake_case payload the draft paths write", () => {
    // make_pick (packages/agent/src/tools/draft.ts) records `player_id`,
    // `name`, `position`, `nfl_team`, `pick_no`, `round`, `reason` — reading
    // only `playerId` is why every pick used to read "Made a draft pick."
    expect(
      describeTransaction("draft_pick", {
        pick_no: 5,
        round: 1,
        player_id: "p1",
        name: "Bijan Robinson",
        position: "RB",
        nfl_team: "ATL",
        made_by: "agent",
        reason: "Best back on the board.",
      }),
    ).toBe("Drafted Bijan Robinson (RB, ATL) at pick 5 (round 1). “Best back on the board.”");
  });

  it("translates an autopick's marker reason instead of quoting it as agent prose", () => {
    // The auto-pick path (apps/web/lib/draft.ts) records `player_id`, no name,
    // and a marker reason — "auto-pick: deadline" et al. — which must never
    // render inside quotation marks as though the agent wrote it.
    const names: Record<string, string> = { p9: "Tank Bigsby" };
    const payload = (reason: string) => ({
      pick_no: 47,
      round: 4,
      player_id: "p9",
      made_by: "autopick",
      reason,
    });
    const nameOf = (id: string) => names[id] ?? null;
    expect(describeTransaction("draft_pick", payload("auto-pick: deadline"), nameOf)).toBe(
      "Auto-picked Tank Bigsby at pick 47 (round 4) when the clock ran out.",
    );
    expect(
      describeTransaction("draft_pick", payload("auto-pick: session ended without a pick"), nameOf),
    ).toBe("Auto-picked Tank Bigsby at pick 47 (round 4) after its session ended without a pick.");
    expect(describeTransaction("draft_pick", payload("auto-pick: commissioner"), nameOf)).toBe(
      "Auto-picked Tank Bigsby at pick 47 (round 4) on the commissioner's flag.",
    );
    // An unknown marker states the pick and claims nothing about why.
    expect(describeTransaction("draft_pick", payload("auto-pick: ???"), nameOf)).toBe(
      "Auto-picked Tank Bigsby at pick 47 (round 4).",
    );
  });

  it("names both sides of a trade from the id arrays trades.ts writes", () => {
    const names: Record<string, string> = { p1: "Cade Otton", p2: "Rome Odunze", p3: "Jake Ferguson" };
    expect(
      describeTransaction(
        "trade",
        { tradeId: 3, givePlayerIds: ["p1", "p2"], getPlayerIds: ["p3"] },
        (id) => names[id] ?? null,
      ),
    ).toBe("Traded away Cade Otton, Rome Odunze for Jake Ferguson.");
  });

  it("never renders raw ids when a trade's players cannot all be named", () => {
    // The rail's name lookup degrades to an empty map on a failed read; the
    // sentence degrades with it rather than showing Sleeper ids.
    expect(describeTransaction("trade", { givePlayerIds: ["4034"], getPlayerIds: ["7523"] }, () => null)).toBe(
      "A trade went through.",
    );
    const names: Record<string, string> = { p1: "Cade Otton" };
    expect(
      describeTransaction("trade", { givePlayerIds: ["p1"], getPlayerIds: ["gone"] }, (id) => names[id] ?? null),
    ).toBe("Traded away Cade Otton.");
  });

  it("describes a lineup change from its diff and caps the list", () => {
    const names: Record<string, string> = { a: "Puka Nacua", b: "Cooper Kupp", c: "Jayden Reed" };
    expect(
      describeTransaction(
        "lineup",
        { diff: { WR1: { from: "b", to: "a" }, FLEX: { from: null, to: "c" } } },
        (id) => names[id] ?? null,
      ),
    ).toBe("Set its lineup: Puka Nacua in for Cooper Kupp at WR1; Jayden Reed in at FLEX.");
    expect(
      describeTransaction(
        "lineup",
        {
          diff: {
            WR1: { from: "b", to: "a" },
            FLEX: { from: null, to: "c" },
            RB2: { from: "a", to: "b" },
          },
        },
        (id) => names[id] ?? null,
      ),
    ).toBe("Set its lineup: Puka Nacua in for Cooper Kupp at WR1; Jayden Reed in at FLEX; and 1 more change.");
    expect(describeTransaction("lineup", { carried_over: true, slots: {} })).toBe(
      "Carried last week's lineup over.",
    );
    // Ids nobody can resolve still yield a count rather than a blank sentence.
    expect(describeTransaction("lineup", { diff: { WR1: { from: "x", to: "y" } } }, () => null)).toBe(
      "Changed 1 lineup slot.",
    );
  });

  it("collects every id shape the engine writes into payloads", () => {
    expect(transactionPlayerIds({ playerId: "a", dropPlayerId: "b" })).toEqual(["a", "b"]);
    expect(transactionPlayerIds({ player_id: "c" })).toEqual(["c"]);
    expect(transactionPlayerIds({ givePlayerIds: ["d", "e"], getPlayerIds: ["f"] })).toEqual(["d", "e", "f"]);
    expect(transactionPlayerIds({ diff: { WR1: { from: "g", to: "h" }, K: { from: null, to: "i" } } })).toEqual([
      "g",
      "h",
      "i",
    ]);
    expect(transactionPlayerIds({ playerId: 42, givePlayerIds: "not-a-list", diff: [] })).toEqual([]);
  });

  it("still says something useful when the payload is empty", () => {
    // Payloads are free-form JSON written by the engine; the rail must not
    // render "Claimed undefined".
    for (const type of ["waiver_add", "add", "drop", "trade", "ir_move", "lineup", "draft_pick", "commissioner"]) {
      const text = describeTransaction(type, {});
      expect(text).not.toMatch(/undefined|null|NaN/);
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("ignores a blank name rather than printing an empty gap", () => {
    expect(describeTransaction("add", { addedName: "   " })).toBe("Added a free agent.");
  });

  it("ignores a name that is not a string", () => {
    expect(describeTransaction("add", { addedName: 42 })).toBe("Added a free agent.");
  });

  it("falls back to the type for a kind it does not know", () => {
    expect(describeTransaction("some_new_type", {})).toBe("some new type");
  });

  it("uses the commissioner's reason, because that is the public record", () => {
    expect(describeTransaction("commissioner", { reason: "Reversed a trade after an engine bug." })).toBe(
      "Reversed a trade after an engine bug.",
    );
  });
});

describe("body summaries", () => {
  it("leaves a short post alone", () => {
    expect(summarizeBody("Short and done.", 100)).toBe("Short and done.");
  });

  it("collapses the whitespace a multi-line post arrives with", () => {
    expect(summarizeBody("One line.\n\n  Another   line.", 100)).toBe("One line. Another line.");
  });

  it("cuts at a sentence end when there is one late enough to be worth it", () => {
    const text =
      "The kicker is indoors and the receiver is not. This is the most defensible bad idea on the board.";
    // The break falls at 45 of 80, past halfway, so the first sentence stands
    // on its own rather than being cut mid-word.
    expect(summarizeBody(text, 80)).toBe("The kicker is indoors and the receiver is not.");
  });

  it("ellipses instead when the only sentence end comes too early to be worth it", () => {
    // Cutting here would throw away most of what the reader could have had.
    const text = "Short. Then a much longer second sentence that carries all of the actual meaning here.";
    const out = summarizeBody(text, 60);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("Short. Then a much longer")).toBe(true);
  });

  it("ellipses when there is no sentence break to use", () => {
    const text = "a".repeat(200);
    const out = summarizeBody(text, 50);
    expect(out).toHaveLength(51);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("team names", () => {
  it("prefers the name the agent chose", () => {
    expect(teamName({ name: "Silicon Gridiron", modelLabel: "Claude Opus 5", slug: "sg" })).toBe("Silicon Gridiron");
  });

  it("falls back to the model before the slug, because a slug tells a reader nothing", () => {
    expect(teamName({ name: null, modelLabel: "Claude Opus 5", slug: "sg" })).toBe("Claude Opus 5");
    expect(teamName({ name: null, modelLabel: null, slug: "sg" })).toBe("sg");
  });

  it("never renders undefined for a team that is not there", () => {
    expect(teamName(undefined)).toBe("unknown");
  });
});
