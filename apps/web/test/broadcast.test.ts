/**
 * The redesigned pages show four things the league does not store: a chance to
 * win, a team's recent form, and a sentence describing a transaction. Each is
 * derived, so each is a claim the site makes on its own account — these pin
 * down what those claims mean. (The power rankings are the reporter's own and
 * are covered in the engine's `powerRankings.test.ts`.)
 */
import { describe, expect, it } from "vitest";
import {
  MARGIN_SCALE,
  cardProgress,
  describeClaimWire,
  describeTradeWire,
  describeTransaction,
  describeWaiverRunWire,
  gameStatus,
  foldForm,
  newestFirst,
  reserveWindow,
  plainExcerpt,
  splitHeadline,
  summarizeBody,
  teamName,
  transactionPlayerIds,
  truncateFlat,
  remainingPoints,
  winChanceFromMargin,
  winChancePercent,
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

describe("win chance as the printed percent", () => {
  it("rounds an ordinary chance to its whole percent", () => {
    expect(winChancePercent(0.5)).toBe(50);
    expect(winChancePercent(0.614)).toBe(61);
  });

  it("never prints a certainty while the game can still be played", () => {
    // A lineup facing nine starters with one of its own left rounded to
    // "100% to win" on the page, which the copy promises never to say.
    expect(winChancePercent(0.9999)).toBe(99);
    expect(winChancePercent(winChanceFromMargin(150))).toBe(99);
    expect(winChancePercent(0.0001)).toBe(1);
    expect(winChancePercent(winChanceFromMargin(-150))).toBe(1);
  });

  it("falls back to a coin flip on a chance that is not a number", () => {
    expect(winChancePercent(Number.NaN)).toBe(50);
  });
});

describe("what state a game card is in", () => {
  it("is upcoming before anything kicks off, however many slots wait", () => {
    expect(gameStatus(false, 18, false)).toBe("upcoming");
  });

  it("is live once the matchup has started and slots remain", () => {
    expect(gameStatus(false, 7, true)).toBe("live");
  });

  it("is final on the engine's flag, whatever the slots say", () => {
    expect(gameStatus(true, 18, false)).toBe("final");
    expect(gameStatus(true, null, false)).toBe("final");
  });

  it("treats zero slots as final only in a week that actually started", () => {
    // Monday night is over but the week finalizes Tuesday: done, not "live".
    expect(gameStatus(false, 0, true)).toBe("final");
    // Two empty lineups before kickoff also count zero slots; that is a
    // lineup gap, not a finished game — "Final 0.0 – 0.0" was the bug here.
    expect(gameStatus(false, 0, false)).toBe("upcoming");
  });

  it("is unknown without a schedule, unless the flag already says final", () => {
    expect(gameStatus(false, null, false)).toBe("unknown");
    expect(gameStatus(false, null, true)).toBe("unknown");
  });
});

describe("started and projected finals on a card", () => {
  const base = {
    over: false,
    scheduleKnown: true,
    projectionsKnown: true,
    awayPoints: 0,
    homePoints: 0,
    anyStarterKickedOff: false,
    awayProjectedFinal: 110.5,
    homeProjectedFinal: 98.2,
  };

  it("carries both projected finals while the game is on", () => {
    expect(cardProgress(base)).toEqual({ started: false, awayProjected: 110.5, homeProjected: 98.2 });
  });

  it("counts a kicked-off starter or points on the board as started", () => {
    expect(cardProgress({ ...base, anyStarterKickedOff: true }).started).toBe(true);
    expect(cardProgress({ ...base, homePoints: 3.4 }).started).toBe(true);
  });

  it("does not call a missing schedule started without points on the board", () => {
    // No schedule means nothing looks kicked off; only points can say so.
    const blind = { ...base, scheduleKnown: false, projectionsKnown: false };
    expect(cardProgress(blind).started).toBe(false);
    expect(cardProgress({ ...blind, awayPoints: 12 }).started).toBe(true);
  });

  it("offers no projection when the week's projections are not ingested", () => {
    const p = cardProgress({ ...base, projectionsKnown: false });
    expect(p.awayProjected).toBeNull();
    expect(p.homeProjected).toBeNull();
  });

  it("offers no projection without the week's schedule", () => {
    expect(cardProgress({ ...base, scheduleKnown: false }).awayProjected).toBeNull();
  });

  it("offers no projection once the game is over — the score is the answer", () => {
    const p = cardProgress({ ...base, over: true, anyStarterKickedOff: true });
    expect(p).toEqual({ started: true, awayProjected: null, homeProjected: null });
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

  it("flattens the agent prose it embeds — a reason is one line by convention only", () => {
    expect(describeTransaction("commissioner", { reason: "## Ruling\n- The pick stands." })).toBe(
      "Ruling The pick stands.",
    );
    expect(
      describeTransaction("draft_pick", { name: "Jahmyr Gibbs", reason: "### Why\n**Zero RB** is dead." }),
    ).toBe("Drafted Jahmyr Gibbs. “Why **Zero RB** is dead.”");
  });

  it("falls back when a reason flattens to nothing rather than showing empty quotes", () => {
    const fenced = "```\ncode only\n```";
    expect(describeTransaction("draft_pick", { name: "Jahmyr Gibbs", reason: fenced })).toBe(
      "Drafted Jahmyr Gibbs.",
    );
    expect(describeTransaction("commissioner", { reason: fenced })).toBe("The commissioner acted.");
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

  it("drops block markdown markers that flattening would strand mid-sentence", () => {
    expect(summarizeBody("## The plan\n- Start **Gibbs**.\n> He said so.\n\n---\n1. Done.", 200)).toBe(
      "The plan Start **Gibbs**. He said so. Done.",
    );
  });

  it("strips nested markers, all the way down", () => {
    expect(summarizeBody("> - a quoted bullet", 200)).toBe("a quoted bullet");
  });

  it("does not mistake a sentence opening with a year for an ordered-list item", () => {
    expect(summarizeBody("2026. That is the year this league runs in.", 200)).toBe(
      "2026. That is the year this league runs in.",
    );
  });

  it("drops fenced code from the excerpt rather than flattening it with stranded backticks", () => {
    expect(summarizeBody("My depth chart:\n```\nRB1 Gibbs\nRB2 Pacheco\n```\nThoughts welcome.", 160)).toBe(
      "My depth chart: Thoughts welcome.",
    );
  });

  it("drops an unclosed fence's marker line and keeps its text as prose", () => {
    expect(summarizeBody("A note.\n```\nstill worth reading", 160)).toBe("A note. still worth reading");
  });

  it("keeps non-tag content from an unclosed fence's opening line, like the renderer", () => {
    expect(summarizeBody('```{"json": 1}\nstill here', 160)).toBe('{"json": 1} still here');
    expect(summarizeBody("```ts\nstill here", 160)).toBe("still here");
  });

  it("drops a one-line fence's code but keeps the prose after it", () => {
    expect(summarizeBody("```quick``` more\nrest.", 160)).toBe("more rest.");
  });

  it("does not pair a one-line fence's marker with a later block's fence", () => {
    expect(summarizeBody("Intro\n```quick``` aside\nMiddle.\n```\ncode\n```\nEnd.", 200)).toBe(
      "Intro aside Middle. End.",
    );
  });

  it("ellipses when the only sentence end sits inside a token the cut retreats from", () => {
    const text = `${"a".repeat(50)} **Bold. Sentence** ${"b".repeat(60)}`;
    const out = summarizeBody(text, 80);
    // The last ". " in the window is inside the bold token; the retreat off
    // the token abandons the sentence break, so the excerpt marks the cut.
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("**");
  });

  it("moves a cut off the middle of an inline token rather than stranding a **", () => {
    const text = `The plan is ${"a".repeat(40)} **a very long bold declaration of intent** and then more`;
    const out = summarizeBody(text, 60);
    // The cut at 60 lands inside the bold token, so it retreats to the token's
    // start — no unbalanced ** survives for the inline renderer to strand.
    expect(out).toBe(`The plan is ${"a".repeat(40)}…`);
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

describe("a headline out of an agent's paragraph", () => {
  it("is the whole thing when it is short enough to set big", () => {
    expect(splitHeadline("Moved Rice into the FLEX over Jennings.")).toMatchObject({
      headline: "Moved Rice into the FLEX over Jennings.",
      body: "",
    });
  });

  it("is the first sentence, with the rest as the body", () => {
    const text =
      "Moved Rashee Rice into the FLEX over Jauan Jennings on a 78% snap-share read. Rice's preseason snap share was 78%; Jennings is a WR3 in a run-first offense.";
    expect(splitHeadline(text)).toMatchObject({
      headline: "Moved Rashee Rice into the FLEX over Jauan Jennings on a 78% snap-share read.",
      body: "Rice's preseason snap share was 78%; Jennings is a WR3 in a run-first offense.",
    });
  });

  it("skips a two-word opener for a sentence that says something", () => {
    // "Respect." over the lead story tells a reader nothing; the next
    // sentence is the one worth 54px.
    const text =
      "Respect. I took a tight end at 1.04 and I would do it again. Ask me in December, when the whole league has seen why it was right.";
    expect(splitHeadline(text)).toMatchObject({
      headline: "Respect. I took a tight end at 1.04 and I would do it again.",
      body: "Ask me in December, when the whole league has seen why it was right.",
    });
  });

  it("cuts a long first sentence at a word with an ellipsis and keeps the rest as the body", () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const { headline, body } = splitHeadline(`${words}.`);
    expect(headline.endsWith("…")).toBe(true);
    expect(headline.length).toBeLessThanOrEqual(111);
    // The cut lands between words, and nothing is said twice: the body
    // picks up exactly where the headline stopped.
    expect(`${headline.slice(0, -1)} ${body}`).toBe(`${words}.`);
  });

  it("does not take a decimal for a sentence end", () => {
    const text =
      "Took a tight end at 1.04 and would do it again, whatever the board says about it this week. Ask me in December, when it has paid off.";
    expect(splitHeadline(text).headline).toBe(
      "Took a tight end at 1.04 and would do it again, whatever the board says about it this week.",
    );
  });

  it("keeps a closing quote with the sentence it closes", () => {
    const text =
      "Kimi to Gemini: “Your bench is thinner than my patience.” Thursday cannot come fast enough, and the two meet in week 1.";
    expect(splitHeadline(text)).toMatchObject({
      headline: "Kimi to Gemini: “Your bench is thinner than my patience.”",
      body: "Thursday cannot come fast enough, and the two meet in week 1.",
    });
  });

  it("does not break inside an inline token, same as the excerpts", () => {
    const text = `${"a".repeat(30)} **Bold sentence. Still bold** and then ${"b".repeat(80)}.`;
    const { headline } = splitHeadline(text);
    expect(headline).not.toMatch(/^[^*]*\*\*[^*]*$/);
  });

  it("treats a line break as a sentence end, so a heading over bullets is not one run-on", () => {
    // Models write summaries as a heading and a list as often as prose;
    // flattening alone joined these with a space and the h1 was cut mid-list.
    const text =
      "## Week 1 plan\n- Start **Gibbs** at RB1 because the matchup is soft\n- Bench Wright until the bye is over\n- Claim Allgeier";
    expect(splitHeadline(text)).toMatchObject({
      headline: "Week 1 plan. Start **Gibbs** at RB1 because the matchup is soft.",
      body: "Bench Wright until the bye is over. Claim Allgeier.",
    });
    expect(splitHeadline("## The plan\n- Start **Gibbs**.").headline).toBe("The plan. Start **Gibbs**.");
  });

  it("leaves a line that runs on by intent alone, and fenced code to the flattener", () => {
    expect(splitHeadline("My plan:\n- Start Gibbs,\n- and bench Wright\n```\nnot prose\n```\nDone").headline).toBe(
      "My plan: Start Gibbs, and bench Wright. Done.",
    );
    expect(splitHeadline("Above\n---\nBelow").headline).toBe("Above. Below.");
  });

  it("does not double a full stop that sits inside a closing token", () => {
    // `**Start Gibbs.**` is already closed; a second stop after the `**`
    // rendered as "Start Gibbs.. Bench Wright." on the lead.
    expect(splitHeadline("**Start Gibbs.**\nBench Wright.").headline).toBe("**Start Gibbs.** Bench Wright.");
    expect(splitHeadline("*Done.*\n`npm test.`\nNext").headline).toBe("*Done.* `npm test.` Next.");
  });

  it("does not let a one-line fence swallow every line after it", () => {
    expect(splitHeadline("Start\n```quick``` aside\nLine one\nLine two").headline).toBe(
      "Start. aside. Line one. Line two.",
    );
  });

  it("leaves marker-only lines and table rows alone", () => {
    expect(splitHeadline("- \n#\n-\n> \nReal line").headline).toBe("Real line.");
    expect(splitHeadline("```only```\nAfter").headline).toBe("After.");
    expect(splitHeadline("| a | b |\n| - | - |\nAfter").headline).toBe("| a | b | | - | - | After.");
  });

  it("ends a sentence on a bare no., and keeps No. 1 whole", () => {
    const yes =
      "Everything on that roster is a no. The rest of the league can stop asking me about it now, and the answer will not change before December.";
    expect(splitHeadline(yes).headline).toBe("Everything on that roster is a no.");
    const pick =
      "Took the No. 1 pick and used it on a tight end, as everybody has now heard. Ask me in December about it, when the whole league has seen why.";
    expect(splitHeadline(pick).headline).toBe(
      "Took the No. 1 pick and used it on a tight end, as everybody has now heard.",
    );
  });

  it("keeps St. Brown whole — St. holds ahead of a capital, which every next sentence starts with", () => {
    const trade =
      "Traded Jahmyr Gibbs for Amon-Ra St. Brown and a bench piece because the swing is worth it. The board can argue.";
    expect(splitHeadline(trade).headline).toBe(
      "Traded Jahmyr Gibbs for Amon-Ra St. Brown and a bench piece because the swing is worth it.",
    );
  });

  it("does not turn a line that is only a number into a list marker that drops the line", () => {
    expect(splitHeadline("Week 12\nSet the lineup\n12\nNext line here").headline).toBe(
      "Week 12. Set the lineup. 12 Next line here.",
    );
  });

  it("does not take an abbreviation for a sentence end", () => {
    const text =
      "Sat Rice over Jennings in the FLEX vs. the Chargers because the snap share favours him. Jennings stays on the bench.";
    expect(splitHeadline(text).headline).toBe(
      "Sat Rice over Jennings in the FLEX vs. the Chargers because the snap share favours him.",
    );
  });

  it("returns an empty headline for text that is all fenced code, for the caller to fill", () => {
    expect(splitHeadline("```\ncode\n```")).toMatchObject({ headline: "", body: "" });
  });

  it("says whether the ellipsis is its own cut, and whether that cut fell inside a word", () => {
    expect(splitHeadline("Moved Rice into the FLEX over Jennings.")).toMatchObject({ cut: false, cutMidWord: false });
    expect(splitHeadline("I weighed it and then… I let it go, for the whole of the window and more besides than that.")).toMatchObject({
      cut: false,
    });
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    expect(splitHeadline(`${words}.`)).toMatchObject({ cut: true, cutMidWord: false });
    // A 120-character run of one word is cut inside it.
    expect(splitHeadline("a".repeat(120))).toMatchObject({ cut: true, cutMidWord: true });
    // A cut that retreats to a bold token's start follows a space: not inside a word.
    const bold = "Declined: **Trade 41 from Five Alarm, the one with Stevenson and Purdy for Kelce and Reed at prio 12** and so on.";
    expect(splitHeadline(bold)).toMatchObject({ cut: true, cutMidWord: false });
  });
});

describe("truncating text that is already one line", () => {
  it("does not strip a marker-shaped opening the way a second flatten would", () => {
    // The body under a headline is a slice of flattened text; the "2." that
    // starts it is what is left of a numbered list, not a list marker.
    expect(truncateFlat("2. Dropped Wright.", 100)).toBe("2. Dropped Wright.");
    expect(truncateFlat("- item one", 100)).toBe("- item one");
  });

  it("cuts the same way the excerpts do", () => {
    expect(truncateFlat("a".repeat(200), 50)).toHaveLength(51);
  });
});

describe("the report's plain excerpt", () => {
  it("reduces links and images to their text and strips inline marks", () => {
    expect(plainExcerpt("See [the board](/board) and ![chart](x.png) — **bold** `code`.")).toBe(
      "See the board and — bold code.",
    );
  });

  it("keeps underscores, which are identifiers here, not marks", () => {
    expect(plainExcerpt("Watch pts_allow_14_20 this week.")).toBe("Watch pts_allow_14_20 this week.");
  });

  it("caps at the word count with an ellipsis", () => {
    expect(plainExcerpt("one two three four five", 3)).toBe("one two three…");
    expect(plainExcerpt("one two three", 3)).toBe("one two three");
  });
});

describe("what the wire says", () => {
  const deal = { proposer: "Second Overall", counterparty: "Terra Nova", give: ["Alvin Kamara"], get: ["Garrett Wilson"] };

  it("reads an offer from the proposer's side", () => {
    expect(describeTradeWire({ ...deal, status: "proposed" })).toBe(
      "Second Overall offers Terra Nova Alvin Kamara for Garrett Wilson",
    );
  });

  it("says a trade is in review once it is accepted, and done once it executes", () => {
    expect(describeTradeWire({ ...deal, status: "accepted" })).toBe(
      "Second Overall and Terra Nova agree Alvin Kamara for Garrett Wilson — in review",
    );
    expect(describeTradeWire({ ...deal, status: "executed" })).toBe(
      "Done: Second Overall sends Alvin Kamara to Terra Nova for Garrett Wilson",
    );
  });

  it("lists several players with an and", () => {
    expect(describeTradeWire({ ...deal, status: "proposed", give: ["A", "B", "C"] })).toBe(
      "Second Overall offers Terra Nova A, B and C for Garrett Wilson",
    );
  });

  it("never prints a raw id: an unnamed side reads as players", () => {
    expect(describeTradeWire({ ...deal, status: "vetoed", give: [], get: [] })).toBe(
      "The league vetoes Second Overall–Terra Nova: players for players",
    );
  });

  it("has a line for every way an offer can end", () => {
    const line = (status: string) => describeTradeWire({ ...deal, status });
    expect(line("rejected")).toBe("Terra Nova turns down Second Overall: Alvin Kamara for Garrett Wilson");
    expect(line("countered")).toBe("Terra Nova counters Second Overall's offer of Alvin Kamara for Garrett Wilson");
    expect(line("cancelled")).toBe("Second Overall withdraws its offer to Terra Nova");
    expect(line("expired")).toBe("Second Overall's offer to Terra Nova expires unanswered");
    expect(line("failed")).toBe("Second Overall–Terra Nova falls through: Alvin Kamara for Garrett Wilson");
    expect(line("new")).toBe("Second Overall and Terra Nova: Alvin Kamara for Garrett Wilson");
  });

  it("does not credit the proposer with an action when the engine supersedes its offer", () => {
    // trades.ts marks an open offer superseded when a different trade in
    // review takes one of its players; nobody replaced anything.
    expect(describeTradeWire({ ...deal, status: "superseded" })).toBe(
      "Second Overall's offer to Terra Nova lapses: a player in it is in a trade under review",
    );
  });

  it("reads a processed claim either way it went", () => {
    expect(describeClaimWire("The Gibbs Factor", "success", "Tyler Allgeier", "Jaylen Wright")).toBe(
      "The Gibbs Factor claims Tyler Allgeier, drops Jaylen Wright",
    );
    expect(describeClaimWire("The Gibbs Factor", "success", "Tyler Allgeier", null)).toBe(
      "The Gibbs Factor claims Tyler Allgeier",
    );
    expect(describeClaimWire("Moonshot Marauders", "failed", "Tyler Allgeier", null)).toBe(
      "Moonshot Marauders loses its claim on Tyler Allgeier",
    );
    expect(describeClaimWire("Moonshot Marauders", "failed", null, null)).toBe(
      "Moonshot Marauders loses a waiver claim",
    );
  });

  it("counts a waiver run", () => {
    expect(describeWaiverRunWire(9, 7)).toBe("Waivers ran: 9 claims, 7 landed");
    expect(describeWaiverRunWire(1, 1)).toBe("Waivers ran: 1 claim, 1 landed");
    expect(describeWaiverRunWire(0, 0)).toBe("Waivers ran: no claims");
  });
});

describe("reserveWindow", () => {
  const at = (iso: string, kind: string) => ({ at: new Date(iso), kind });
  const post = (h: number) => at(`2026-09-08T${String(h).padStart(2, "0")}:30:00Z`, "board post");
  const move = (h: number) => at(`2026-09-08T${String(h).padStart(2, "0")}:00:00Z`, "trade response");

  it("holds slots for each reservation and fills the rest newest first", () => {
    // Fourteen posts newer than every move: without a hold the moves vanish.
    const posts = Array.from({ length: 14 }, (_, i) => post(10 + i));
    const moves = [move(9), move(8), move(7), move(6), move(5)];
    const window = reserveWindow([...posts, ...moves], 14, [
      { match: (i) => i.kind === "board post", slots: 3 },
      { match: (i) => i.kind !== "board post", slots: 4 },
    ]);
    expect(window).toHaveLength(14);
    expect(window.filter((i) => i.kind !== "board post").map((i) => i.at.getUTCHours())).toEqual([9, 8, 7, 6]);
    // Strictly newest first, and the held posts are the newest posts.
    expect(window.map((i) => i.at.getTime())).toEqual([...window].sort((a, b) => b.at.getTime() - a.at.getTime()).map((i) => i.at.getTime()));
    expect(window[0]).toBe(posts[13]);
  });

  it("holds an item matched by two reservations once, and the second hold moves on", () => {
    const items = [post(12), post(11), move(10), move(9), move(8)];
    const window = reserveWindow(items, 3, [
      { match: () => true, slots: 1 }, // the newest of all: post(12)
      { match: (i) => i.kind === "board post", slots: 1 }, // post(12) is held already, so post(11)
      { match: (i) => i.kind !== "board post", slots: 1 }, // move(10)
    ]);
    expect(window).toEqual([post(12), post(11), move(10)]);
  });

  it("keeps the newest item when the limit is below the reservations' total", () => {
    const newest = move(13);
    const window = reserveWindow([newest, post(12), post(11), post(10)], 3, [
      { match: () => true, slots: 1 },
      { match: (i) => i.kind === "board post", slots: 3 },
      { match: (i) => i.kind !== "board post", slots: 4 },
    ]);
    expect(window).toHaveLength(3);
    expect(window[0]).toBe(newest);
  });

  it("never exceeds the limit and copes with nothing to hold", () => {
    const window = reserveWindow([post(10), post(11)], 1, [
      { match: (i) => i.kind === "board post", slots: 3 },
      { match: (i) => i.kind !== "board post", slots: 4 },
    ]);
    expect(window).toEqual([post(11)]);
    expect(reserveWindow([], 5, [{ match: () => true, slots: 2 }])).toEqual([]);
  });
});
