import { describe, expect, it } from "vitest";
import {
  LANE_TABS,
  RESERVED_BOARD_SLOTS,
  RESERVED_MOVE_SLOTS,
  activityWindow,
  clusterStories,
  dropBoardEchoes,
  leadHeadline,
  compactMatchups,
  countdown,
  inLane,
  jobsGatedOn,
  laneOf,
  nextReporterPost,
  nextUpCells,
  recordLabel,
  showTimeline,
  splitPower,
  storyKey,
} from "@/lib/homeLogic";

describe("laneOf", () => {
  it("sorts kinds into the three tabs", () => {
    expect(laneOf("board post")).toBe("talk");
    expect(laneOf("board reply")).toBe("talk");
    expect(laneOf("reporter")).toBe("reporter");
    expect(laneOf("trade response")).toBe("moves");
    expect(laneOf("waiver add")).toBe("moves");
    expect(laneOf("session failed")).toBe("moves");
  });
  it("files anything the reporter did under the reporter, whatever its kind", () => {
    expect(laneOf("session failed", "reporter")).toBe("reporter");
    expect(laneOf("session failed", "team")).toBe("moves");
  });
});

describe("inLane", () => {
  it("shows everything under All and one lane otherwise", () => {
    expect(inLane("talk", "all")).toBe(true);
    expect(inLane("talk", "talk")).toBe(true);
    expect(inLane("talk", "moves")).toBe(false);
    expect(LANE_TABS.map(([k]) => k)).toEqual(["all", "moves", "talk", "reporter"]);
  });
});

describe("activityWindow", () => {
  const stamp = (h: number, m = 0) => new Date(`2026-09-08T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  const post = (h: number, m = 0) => ({ at: stamp(h, m), kind: "board post", actor: "team" as const });
  const reply = (h: number, m = 0) => ({ at: stamp(h, m), kind: "board reply", actor: "team" as const });
  const move = (h: number, m = 0) => ({ at: stamp(h, m), kind: "trade response", actor: "team" as const });
  const failedReporter = (h: number) => ({ at: stamp(h), kind: "session failed", actor: "reporter" as const });

  it("holds moves by the Moves tab's rule: a board reply is talk and takes no move slot", () => {
    const talk = [...Array.from({ length: 8 }, (_, i) => post(15, 59 - i)), ...Array.from({ length: 8 }, (_, i) => reply(15, 40 - i))];
    const moves = [move(9), move(8), move(7), move(6), move(5)];
    const window = activityWindow([...talk, ...moves, failedReporter(4)], 14);
    expect(window).toHaveLength(14);
    expect(window.filter((i) => i.kind === "trade response")).toHaveLength(RESERVED_MOVE_SLOTS);
    expect(window.filter((i) => i.kind === "board post").length).toBeGreaterThanOrEqual(RESERVED_BOARD_SLOTS);
    // The reporter's failure is the reporter's, not a move, and the moves outrank it for the held slots.
    expect(window.some((i) => i.actor === "reporter")).toBe(false);
  });

  it("always carries the newest item, which is the lead", () => {
    const newest = reply(16);
    const window = activityWindow([newest, ...Array.from({ length: 10 }, (_, i) => move(10 - i))], 3);
    expect(window[0]).toBe(newest);
  });
});

describe("dropBoardEchoes", () => {
  const at = (iso: string) => new Date(iso);
  it("drops a board session's decision line when the same team posted within two minutes", () => {
    const post = { kind: "board post", teamId: 4, at: at("2026-09-08T16:16:10Z") };
    const echo = { kind: "board reply", teamId: 4, at: at("2026-09-08T16:16:40Z") };
    const otherTeam = { kind: "board reply", teamId: 5, at: at("2026-09-08T16:16:40Z") };
    const later = { kind: "board reply", teamId: 4, at: at("2026-09-08T16:30:00Z") };
    const move = { kind: "trade response", teamId: 4, at: at("2026-09-08T16:16:40Z") };
    expect(dropBoardEchoes([echo, post, otherTeam, later, move])).toEqual([post, otherTeam, later, move]);
  });
  it("keeps a board line with no post, a league line, and one at the edge of the window", () => {
    const post = { kind: "board post", teamId: 4, at: at("2026-09-08T16:16:00Z") };
    const before = { kind: "board reply", teamId: 4, at: at("2026-09-08T16:14:00Z") }; // exactly two minutes before
    const tooEarly = { kind: "board reply", teamId: 4, at: at("2026-09-08T16:13:59Z") };
    const league = { kind: "board reply", teamId: null, at: at("2026-09-08T16:16:00Z") };
    expect(dropBoardEchoes([post, before, tooEarly, league])).toEqual([post, tooEarly, league]);
    expect(dropBoardEchoes([{ kind: "board reply", teamId: 9, at: at("2026-09-08T16:16:00Z") }])).toHaveLength(1);
  });
});

describe("leadHeadline", () => {
  const uncut = { cut: false, cutMidWord: false };
  const cut = { cut: true, cutMidWord: false };
  it("keeps a short headline as it is", () => {
    expect(leadHeadline({ headline: "Declined Trade 41, no counter.", body: "The math.", ...uncut })).toEqual({
      headline: "Declined Trade 41, no counter.",
      body: "The math.",
      size: "big",
    });
  });
  it("sets an uncut headline past 120 characters a size down", () => {
    const long = `${"Declined the offer because the projections say so and the roster math agrees ".repeat(2).trim()}.`;
    expect(long.length).toBeGreaterThan(120);
    expect(leadHeadline({ headline: long, body: "", ...uncut }).size).toBe("small");
  });
  it("leaves an agent's own trailing ellipsis alone", () => {
    const out = leadHeadline({ headline: "I weighed the Kelce offer and then…", body: "I let it go. The math never got there.", ...uncut });
    expect(out.headline).toBe("I weighed the Kelce offer and then…");
    expect(out.body).toBe("I let it go. The math never got there.");
  });
  it("rejoins a cut first sentence and sets it a size down", () => {
    const first = "Five Alarm declined Stevenson+Purdy for Kelce+Reed and their math held — I re-ran it: Rhamondre's bench value";
    const rest = "is 11.76 minus the wire RB I can't reach at prio 12, so I was paying 3.6 of insurance. A deal that fails my own test.";
    const out = leadHeadline({ headline: `${first}…`, body: rest, ...cut });
    expect(out.headline).toBe(`${first} is 11.76 minus the wire RB I can't reach at prio 12, so I was paying 3.6 of insurance.`);
    expect(out.body).toBe("A deal that fails my own test.");
    expect(out.size).toBe("small");
  });
  it("rejoins a cut inside a word without a space", () => {
    const out = leadHeadline({ headline: "See https://example.com/a-very-long-path-that-goes-on-and…", body: "on-and-on/end for the note.", cut: true, cutMidWord: true });
    expect(out.headline).toBe("See https://example.com/a-very-long-path-that-goes-on-andon-and-on/end for the note.");
  });
  it("keeps the body's own cut when the whole fits", () => {
    const out = leadHeadline({ headline: "A first sentence that the stream cut at a word for…", body: "no good reason but length…", ...cut });
    expect(out.headline).toBe("A first sentence that the stream cut at a word for no good reason but length…");
    expect(out.body).toBe("");
  });
  it("still cuts a sentence that runs past two hundred characters", () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const out = leadHeadline({ headline: "Something long that was cut…", body: `${words} and on it goes.`, ...cut });
    expect(out.headline.endsWith("…")).toBe(true);
    expect(out.headline.length).toBeLessThanOrEqual(201);
    expect(out.size).toBe("small");
  });
});

describe("storyKey", () => {
  it("does not read prose that puts a number after the word as a name", () => {
    expect(storyKey("I'd trade 2 RBs for a WR1")).toBeNull();
    expect(storyKey("a 2-for-1 trade 3 days ago")).toBeNull();
    expect(storyKey("thread 2 of my plan")).toBeNull();
    expect(storyKey("On Trade 41 the answer is no")).toBe("trade:41");
    expect(storyKey("see trade #41")).toBe("trade:41");
    // The documented loss: a name that opens the sentence ahead of a lower-case verb.
    expect(storyKey("Trade 41 is the one")).toBeNull();
  });
  it("does not read a sentence-opening imperative or a ratio as a name", () => {
    expect(storyKey("Trade 3-for-1 with Gibbs: McBride and two backs")).toBeNull();
    expect(storyKey("Trade 2 bench WRs for an RB2")).toBeNull();
    expect(storyKey("Done. Trade 2 bench WRs for an RB2")).toBeNull();
    // A hash or punctuation after the number is a name wherever it sits.
    expect(storyKey("Trade #2 bench WRs")).toBe("trade:2");
    expect(storyKey("Trade 41, declined.")).toBe("trade:41");
    expect(storyKey("Trade 38 (Dowdle for Downs) is fair")).toBe("trade:38");
    expect(storyKey("Trade 41 declined — here is the math")).toBeNull();
    expect(storyKey("Reviewed Trade 38 as a voter")).toBe("trade:38");
    // A colon, a dash or a line break opens a sentence too.
    expect(storyKey("Plan: Trade 2 bench WRs for an RB2")).toBeNull();
    expect(storyKey("Next move — Trade 2 bench WRs for an RB2")).toBeNull();
    expect(storyKey("Something\nTrade 41 clears review")).toBeNull();
    expect(storyKey("Plan: Trade 41, then waivers")).toBe("trade:41");
    expect(storyKey("(Trade 2 bench WRs for an RB2)")).toBeNull();
    expect(storyKey("\"Trade 2 bench WRs\"")).toBeNull();
  });
  it("reads a trade or thread number out of agent text", () => {
    expect(storyKey("Declined The Gibbs Factor's Trade 41 (Stafford for Bowers)")).toBe("trade:41");
    expect(storyKey("Voted to allow trade #38 between two teams")).toBe("trade:38");
    expect(storyKey("Responded to @The Grimm Reapers Thread 130 confirming")).toBe("thread:130");
    expect(storyKey("Waivers ran: no claims")).toBeNull();
  });
  it("prefers the trade when both are named", () => {
    expect(storyKey("Thread 130 about Trade 38")).toBe("trade:38");
  });
});

describe("clusterStories", () => {
  const item = (headline: string, body = "") => ({ headline, body });
  it("folds items about one trade under the newest and keeps the rest apart", () => {
    const items = [
      item("Declined Trade 41, no counter."),
      item("Secured my QB2 by adding Sam Darnold"),
      item("@The Gibbs Factor Trade 41 declined — the math"),
      item("Voted to allow Trade 38"),
      item("Thanks for the accept", "That makes Trade 38 clean need-for-need"),
    ];
    const stories = clusterStories(items);
    expect(stories.map((s) => s.lead.headline)).toEqual([
      "Declined Trade 41, no counter.",
      "Secured my QB2 by adding Sam Darnold",
      "Voted to allow Trade 38",
    ]);
    expect(stories[0]!.more.map((m) => m.headline)).toEqual(["@The Gibbs Factor Trade 41 declined — the math"]);
    expect(stories[2]!.more).toHaveLength(1);
    expect(stories[1]!.key).toBeNull();
  });
  it("leaves items the caller marks unfoldable in their own place", () => {
    const post = { headline: "@Gibbs Trade 41 declined, here is the math", body: "", kind: "board post" };
    const move = { headline: "Declined Trade 41, no counter.", body: "", kind: "trade response" };
    const stories = clusterStories([move, post], (i) => i.kind !== "board post");
    expect(stories).toHaveLength(2);
    expect(stories[0]!.more).toEqual([]);
    expect(stories[1]!.lead).toBe(post);
  });
  it("keeps the reporter's items apart under the page's rule", () => {
    const report = { headline: "Trade 41 Note: a fair deal", body: "", kind: "reporter", actor: "reporter" as const };
    const move = { headline: "Declined Trade 41, no counter.", body: "", kind: "trade response", actor: "team" as const };
    const stories = clusterStories([move, report], (i) => laneOf(i.kind, i.actor) === "moves");
    expect(stories).toHaveLength(2);
  });
  it("lets an unfoldable item sit between two moves without taking or splitting their story", () => {
    const newer = { headline: "Declined Trade 41, no counter.", body: "", kind: "trade response" };
    const post = { headline: "@Gibbs Trade 41 declined, here is the math", body: "", kind: "board post" };
    const older = { headline: "Proposed Trade 41 to The Fourth Dimension", body: "", kind: "trade offer" };
    const stories = clusterStories([newer, post, older], (i) => i.kind !== "board post");
    expect(stories.map((s) => s.lead)).toEqual([newer, post]);
    expect(stories[0]!.more).toEqual([older]);
    expect(stories[1]!.more).toEqual([]);
  });
  it("reads the body's first word as a sentence opener", () => {
    const stories = clusterStories([
      item("Declined Trade 2, no counter."),
      item("Thinking about the RB room", "Trade 2 bench WRs for an RB2 before Sunday"),
    ]);
    expect(stories).toHaveLength(2);
    expect(stories[0]!.more).toEqual([]);
  });
  it("never folds two keyless items together", () => {
    const stories = clusterStories([item("Waivers ran: no claims"), item("Waivers ran: no claims")]);
    expect(stories).toHaveLength(2);
  });
});

describe("splitPower", () => {
  const rows = [
    { rank: 1, move: 0 },
    { rank: 2, move: 3 },
    { rank: 3, move: 0 },
    { rank: 4, move: 2 },
    { rank: 5, move: -1 },
    { rank: 6, move: 5 },
    { rank: 7, move: -4 },
    { rank: 8, move: 0 },
  ];
  it("takes the top three, the biggest mover each way below them, and the ladder", () => {
    const split = splitPower(rows);
    expect(split.top.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(split.riser?.rank).toBe(6);
    expect(split.faller?.rank).toBe(7);
    expect(split.rest.map((r) => r.rank)).toEqual([4, 5, 8]);
  });
  it("copes with fewer rows than the top", () => {
    const split = splitPower([{ rank: 2, move: 0 }, { rank: 1, move: 1 }]);
    expect(split.top.map((r) => r.rank)).toEqual([1, 2]);
    expect(split.rest).toEqual([]);
    expect(split.riser).toBeNull();
  });
  it("has no movers on a first edition", () => {
    const split = splitPower(rows.map((r) => ({ ...r, move: 0 })));
    expect(split.riser).toBeNull();
    expect(split.faller).toBeNull();
    expect(split.rest.map((r) => r.rank)).toEqual([4, 5, 6, 7, 8]);
  });
});

describe("countdown", () => {
  const t0 = new Date("2026-09-08T12:00:00Z");
  it("reads in days, hours or minutes", () => {
    expect(countdown(t0, new Date("2026-09-10T16:30:00Z"))).toBe("in 2d 4h");
    expect(countdown(t0, new Date("2026-09-08T15:12:00Z"))).toBe("in 3h 12m");
    expect(countdown(t0, new Date("2026-09-08T12:12:00Z"))).toBe("in 12m");
    expect(countdown(t0, new Date("2026-09-08T12:00:20Z"))).toBe("in 1m");
    expect(countdown(t0, t0)).toBe("now");
  });
});

describe("nextReporterPost", () => {
  it("finds the next reporter session in ET", () => {
    // Tuesday Sep 8 2026, 10:45 AM ET: the rankings have run, the recap is at 11:00.
    const tueLate = new Date("2026-09-08T14:45:00Z");
    const next = nextReporterPost(tueLate);
    expect(next.label).toBe("weekly recap");
    expect(next.at.toISOString()).toBe("2026-09-08T15:00:00.000Z");
    // Wednesday: the preview on Thursday 10:00 AM ET.
    const wed = new Date("2026-09-09T14:00:00Z");
    expect(nextReporterPost(wed)).toEqual({ at: new Date("2026-09-10T14:00:00.000Z"), label: "week preview" });
    // Friday: back around to Tuesday's rankings.
    const fri = new Date("2026-09-11T14:00:00Z");
    expect(nextReporterPost(fri).label).toBe("power rankings");
  });
  it("is strictly after now and follows the clock change", () => {
    // Exactly Tuesday 10:30 AM EDT: the rankings are now, so the recap is next.
    const onTheDot = new Date("2026-09-08T14:30:00Z");
    expect(nextReporterPost(onTheDot).label).toBe("weekly recap");
    // Sunday Nov 1 2026, after the clocks go back: Tuesday 10:30 AM EST is 15:30Z.
    const afterDst = new Date("2026-11-01T20:00:00Z");
    expect(nextReporterPost(afterDst).at.toISOString()).toBe("2026-11-03T15:30:00.000Z");
  });
});

describe("nextUpCells", () => {
  const now = new Date("2026-09-08T14:45:00Z");
  const format = (d: Date) => d.toISOString();
  it("lists only what is ahead, soonest first", () => {
    const cells = nextUpCells({
      now,
      week: 1,
      kickoff: new Date("2026-09-10T00:20:00Z"),
      weekBegun: false,
      waiverRun: new Date("2026-09-09T08:30:00Z"),
      review: { count: 2, soonest: new Date("2026-09-09T14:27:00Z") },
      reporter: { at: new Date("2026-09-08T15:00:00Z"), label: "weekly recap" },
      format,
    });
    expect(cells.map((c) => c.label)).toEqual(["Reporter files", "Waivers run", "2 trades in review", "Week 1 kickoff"]);
    expect(cells[3]!.value).toBe("in 1d 9h");
    expect(cells[3]!.at).toBe("2026-09-10T00:20:00.000Z");
    expect(cells.map((c) => c.past)).toEqual(["now", "now", "clearing", "now"]);
    expect(cells[2]!.href).toBe("/trades");
  });
  it("drops a past kickoff, an absent waiver run and an empty review", () => {
    const cells = nextUpCells({
      now,
      week: 1,
      kickoff: new Date("2026-09-08T00:20:00Z"),
      weekBegun: false,
      waiverRun: null,
      review: { count: 0, soonest: null },
      reporter: null,
      format,
    });
    expect(cells).toEqual([]);
  });
  it("says so when a review has no clock", () => {
    const [cell] = nextUpCells({
      now,
      week: 1,
      kickoff: null,
      weekBegun: false,
      waiverRun: null,
      review: { count: 2, soonest: null },
      reporter: null,
      format,
    });
    expect(cell).toMatchObject({ label: "2 trades in review", value: "clock unknown", sub: "", at: null });
  });
  it("calls the kickoff the week's start only until a game has begun", () => {
    const [cell] = nextUpCells({
      now,
      week: 1,
      kickoff: new Date("2026-09-13T17:00:00Z"),
      weekBegun: true,
      waiverRun: null,
      review: { count: 0, soonest: null },
      reporter: null,
      format,
    });
    expect(cell!.label).toBe("Next kickoff");
  });
  it("keeps a review whose clock has already run out as 'clearing'", () => {
    const [cell] = nextUpCells({
      now,
      week: 1,
      kickoff: null,
      weekBegun: false,
      waiverRun: null,
      review: { count: 1, soonest: new Date("2026-09-08T14:00:00Z") },
      reporter: null,
      format,
    });
    expect(cell).toMatchObject({ label: "Trade in review", value: "clearing", at: null });
  });
});

describe("layout decisions", () => {
  it("compacts the matchup column only while nothing has begun", () => {
    expect(compactMatchups(["upcoming", "upcoming"])).toBe(true);
    expect(compactMatchups(["upcoming", "live"])).toBe(false);
    expect(compactMatchups(["final", "final"])).toBe(false);
    expect(compactMatchups(["upcoming", "unknown"])).toBe(false);
    expect(compactMatchups([])).toBe(false);
  });
  it("shows the timeline once it has four cards", () => {
    expect(showTimeline(2)).toBe(false);
    expect(showTimeline(4)).toBe(true);
  });
  it("gates the scheduled runs on the season being under way (§4.3)", () => {
    expect(jobsGatedOn(null)).toBe(false);
    expect(jobsGatedOn({ phase: "pre_draft", currentWeek: 1, startWeek: 1 })).toBe(false);
    expect(jobsGatedOn({ phase: "regular", currentWeek: 1, startWeek: 2 })).toBe(false);
    expect(jobsGatedOn({ phase: "regular", currentWeek: 2, startWeek: 2 })).toBe(true);
    expect(jobsGatedOn({ phase: "playoffs", currentWeek: 15, startWeek: 1 })).toBe(true);
    expect(jobsGatedOn({ phase: "complete", currentWeek: 17, startWeek: 1 })).toBe(false);
  });
  it("labels a record once a game has been played", () => {
    expect(recordLabel(undefined)).toBeNull();
    expect(recordLabel({ wins: 0, losses: 0, ties: 0 })).toBeNull();
    expect(recordLabel({ wins: 1, losses: 0, ties: 0 })).toBe("1-0");
    expect(recordLabel({ wins: 0, losses: 1, ties: 1 })).toBe("0-1-1");
  });
});
