import { describe, expect, it } from "vitest";
import {
  clusterStories,
  compactMatchups,
  countdown,
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
});

describe("storyKey", () => {
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
      item("Thanks for the accept", "Trade 38 is clean need-for-need"),
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
});

describe("nextUpCells", () => {
  const now = new Date("2026-09-08T14:45:00Z");
  const format = (d: Date) => d.toISOString();
  it("lists only what is ahead, soonest first", () => {
    const cells = nextUpCells({
      now,
      week: 1,
      kickoff: new Date("2026-09-10T00:20:00Z"),
      waiverRun: new Date("2026-09-09T08:30:00Z"),
      review: { count: 2, soonest: new Date("2026-09-09T14:27:00Z") },
      reporter: { at: new Date("2026-09-08T15:00:00Z"), label: "weekly recap" },
      format,
    });
    expect(cells.map((c) => c.label)).toEqual(["Reporter files", "Waivers run", "2 trades in review", "Week 1 kickoff"]);
    expect(cells[3]!.value).toBe("in 1d 9h");
    expect(cells[2]!.href).toBe("/trades");
  });
  it("drops a past kickoff, an absent waiver run and an empty review", () => {
    const cells = nextUpCells({
      now,
      week: 1,
      kickoff: new Date("2026-09-08T00:20:00Z"),
      waiverRun: null,
      review: { count: 0, soonest: null },
      reporter: null,
      format,
    });
    expect(cells).toEqual([]);
  });
  it("keeps a review whose clock has already run out as 'clearing'", () => {
    const [cell] = nextUpCells({
      now,
      week: 1,
      kickoff: null,
      waiverRun: null,
      review: { count: 1, soonest: new Date("2026-09-08T14:00:00Z") },
      reporter: null,
      format,
    });
    expect(cell).toMatchObject({ label: "Trade in review", value: "clearing" });
  });
});

describe("layout decisions", () => {
  it("compacts the matchup column only while nothing has begun", () => {
    expect(compactMatchups(["upcoming", "upcoming"])).toBe(true);
    expect(compactMatchups(["upcoming", "live"])).toBe(false);
    expect(compactMatchups(["final", "final"])).toBe(false);
    expect(compactMatchups([])).toBe(false);
  });
  it("shows the timeline once it has four cards", () => {
    expect(showTimeline(2)).toBe(false);
    expect(showTimeline(4)).toBe(true);
  });
  it("labels a record once a game has been played", () => {
    expect(recordLabel(undefined)).toBeNull();
    expect(recordLabel({ wins: 0, losses: 0, ties: 0 })).toBeNull();
    expect(recordLabel({ wins: 1, losses: 0, ties: 0 })).toBe("1-0");
    expect(recordLabel({ wins: 0, losses: 1, ties: 1 })).toBe("0-1-1");
  });
});
