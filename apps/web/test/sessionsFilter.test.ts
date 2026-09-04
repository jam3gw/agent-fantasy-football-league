/**
 * The `/sessions` page's logic: the filters, the grouping by team, and the
 * line each row leads with. The reporter has no team row, so the team filter
 * has to find it by sentinel rather than by slug.
 */
import { describe, expect, it } from "vitest";
import {
  ALL,
  REPORTER,
  filterSessions,
  groupSessions,
  headlineOf,
  isLive,
  matchKind,
  matchStatus,
  relativeTime,
  sessionTitle,
  teamKey,
  type SessionListRow,
} from "@/lib/sessionsFilter";

const rows = [
  { id: 1, teamId: 3, teamSlug: "gemini", status: "succeeded", kind: "weekly_review" },
  { id: 2, teamId: null, teamSlug: null, status: "running", kind: "reporter_recap" },
  { id: 3, teamId: 3, teamSlug: "gemini", status: "failed", kind: "lineup_check" },
  { id: 4, teamId: 5, teamSlug: "grok", status: "queued", kind: "weekly_review" },
  { id: 5, teamId: 5, teamSlug: "grok", status: "timed_out", kind: "trade_vote" },
  { id: 6, teamId: 3, teamSlug: "gemini", status: "succeeded", kind: "post_waivers" },
];

describe("filterSessions", () => {
  it("returns everything when every filter is 'all'", () => {
    expect(filterSessions(rows, ALL, ALL)).toHaveLength(6);
  });

  it("filters by team slug", () => {
    expect(filterSessions(rows, "gemini", ALL).map((r) => r.id)).toEqual([1, 3, 6]);
  });

  it("finds the reporter's sessions by the sentinel", () => {
    expect(filterSessions(rows, REPORTER, ALL).map((r) => r.id)).toEqual([2]);
  });

  it("filters by status, and combines with the team filter", () => {
    expect(filterSessions(rows, ALL, "succeeded").map((r) => r.id)).toEqual([1, 6]);
    expect(filterSessions(rows, "gemini", "failed").map((r) => r.id)).toEqual([3]);
    expect(filterSessions(rows, "grok", "succeeded")).toEqual([]);
  });

  it("folds queued and running into 'live', and a time-out into 'failed'", () => {
    expect(filterSessions(rows, ALL, "live").map((r) => r.id)).toEqual([2, 4]);
    expect(filterSessions(rows, ALL, "failed").map((r) => r.id)).toEqual([3, 5]);
  });

  it("still honours an exact status from an old link", () => {
    expect(filterSessions(rows, ALL, "timed_out").map((r) => r.id)).toEqual([5]);
    expect(filterSessions(rows, ALL, "queued").map((r) => r.id)).toEqual([4]);
  });

  it("filters by kind family, and by an exact kind, and leaves kind open by default", () => {
    expect(filterSessions(rows, ALL, ALL, "weekly_review").map((r) => r.id)).toEqual([1, 4]);
    expect(filterSessions(rows, ALL, ALL, "waivers").map((r) => r.id)).toEqual([1, 4, 6]);
    expect(filterSessions(rows, ALL, ALL, "trade").map((r) => r.id)).toEqual([5]);
    expect(filterSessions(rows, "gemini", ALL, "lineup_check").map((r) => r.id)).toEqual([3]);
    expect(filterSessions(rows, ALL, ALL)).toHaveLength(6);
  });
});

describe("matchStatus and matchKind", () => {
  it("match the chip families and nothing else", () => {
    expect(matchStatus("live", "running")).toBe(true);
    expect(matchStatus("live", "succeeded")).toBe(false);
    expect(matchStatus("failed", "timed_out")).toBe(true);
    expect(matchStatus("skipped", "skipped")).toBe(true);
    expect(matchKind("trade", "trade_response")).toBe(true);
    expect(matchKind("trade", "lineup_check")).toBe(false);
    expect(matchKind("waivers", "post_waivers")).toBe(true);
    expect(matchKind("board_reply", "board_reply")).toBe(true);
  });
});

describe("teamKey and isLive", () => {
  it("keys the reporter as the sentinel and a team by slug", () => {
    expect(teamKey({ teamId: null, teamSlug: null })).toBe(REPORTER);
    expect(teamKey({ teamId: 3, teamSlug: "gemini" })).toBe("gemini");
    expect(teamKey({ teamId: 3, teamSlug: null })).toBe("3");
  });

  it("treats queued and running as live, nothing else", () => {
    expect(isLive("queued")).toBe(true);
    expect(isLive("running")).toBe(true);
    for (const s of ["succeeded", "failed", "timed_out", "skipped", "paused"]) expect(isLive(s)).toBe(false);
  });
});

describe("sessionTitle", () => {
  const base = { kind: "lineup_check", status: "succeeded", summary: null };

  it("leads with the first sentence of the decision log", () => {
    const summary =
      "Started Bijan Robinson over Kenneth Walker at RB2. Walker is questionable and the Seahawks play late, so the swap keeps a healthy body in the slot.";
    expect(sessionTitle({ ...base, summary })).toBe("Started Bijan Robinson over Kenneth Walker at RB2.");
  });

  it("cuts a long first sentence at a word", () => {
    const summary = `${"Kept every starter where he was because ".repeat(6)}nothing changed.`;
    const title = sessionTitle({ ...base, summary });
    expect(title.length).toBeLessThanOrEqual(121);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });

  it("falls back to the kind when there is no log", () => {
    expect(sessionTitle(base)).toBe("Lineup check");
    expect(sessionTitle({ ...base, kind: "reporter_recap" })).toBe("Weekly recap");
    expect(sessionTitle({ ...base, summary: "   " })).toBe("Lineup check");
  });

  it("says what happened when the session made no call", () => {
    expect(sessionTitle({ ...base, status: "queued" })).toBe("Queued — waiting for a turn");
    expect(sessionTitle({ ...base, status: "running" })).toBe("Working through the lineup check…");
    expect(sessionTitle({ ...base, status: "failed" })).toMatch(/error/);
    expect(sessionTitle({ ...base, status: "timed_out" })).toMatch(/time/);
    expect(sessionTitle({ ...base, status: "skipped" })).toMatch(/^Skipped/);
  });

  it("prefers the log even when the session then timed out", () => {
    expect(sessionTitle({ ...base, status: "timed_out", summary: "Held the lineup." })).toBe("Held the lineup.");
  });

  it("collapses whitespace and keeps a sentence with no terminal stop", () => {
    expect(headlineOf("Added  Tank\nBigsby")).toBe("Added Tank Bigsby");
    expect(headlineOf("Voted yes on the 2.5 pick swap. Then more.")).toBe("Voted yes on the 2.5 pick swap.");
  });
});

describe("groupSessions", () => {
  const at = (minutesAgo: number) => new Date(Date.UTC(2026, 8, 4, 14, 0) - minutesAgo * 60_000);
  const row = (
    id: number,
    team: { id: number | null; slug: string | null; name: string | null; model: string | null },
    minutesAgo: number,
    status = "succeeded",
  ): SessionListRow => ({
    id,
    teamId: team.id,
    teamSlug: team.slug,
    teamName: team.name,
    modelLabel: team.model,
    kind: "lineup_check",
    status,
    startedAt: status === "queued" ? null : at(minutesAgo),
    createdAt: at(minutesAgo + 1),
    toolCalls: 3,
    costUsd: 0.1,
    summary: null,
  });
  const gurus = { id: 1, slug: "gridiron-gurus", name: "Gridiron Gurus", model: "Claude Opus 4" };
  const foxes = { id: 2, slug: "tundra-foxes", name: "Tundra Foxes", model: "GPT-5" };
  const reporter = { id: null, slug: null, name: null, model: null };

  it("groups by team, most recently active team first, rows in the order given", () => {
    const groups = groupSessions([
      row(10, foxes, 5),
      row(9, gurus, 20),
      row(8, foxes, 30),
      row(7, reporter, 40),
      row(6, gurus, 50),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["tundra-foxes", "gridiron-gurus", REPORTER]);
    expect(groups[0].rows.map((r) => r.id)).toEqual([10, 8]);
    expect(groups[1].rows.map((r) => r.id)).toEqual([9, 6]);
  });

  it("names the group after the team, with its model, and links its page", () => {
    const [g] = groupSessions([row(1, gurus, 1)]);
    expect(g.name).toBe("Gridiron Gurus");
    expect(g.model).toBe("Claude Opus 4");
    expect(g.teamSlug).toBe("gridiron-gurus");
  });

  it("gives the reporter a name, no model line and no team page", () => {
    const [g] = groupSessions([row(1, reporter, 1)]);
    expect(g.name).toBe("League reporter");
    expect(g.model).toBeNull();
    expect(g.teamSlug).toBeNull();
  });

  it("orders a queued session, which has not started, by when it was created", () => {
    const groups = groupSessions([row(2, foxes, 0, "queued"), row(1, gurus, 3)]);
    expect(groups.map((g) => g.key)).toEqual(["tundra-foxes", "gridiron-gurus"]);
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-09-04T14:05:00Z");
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  it("is relative while recent and a stamp once it is not", () => {
    expect(relativeTime(ago(0), now)).toBe("just now");
    expect(relativeTime(ago(12), now)).toBe("12 min ago");
    expect(relativeTime(ago(3 * 60 + 20), now)).toBe("3 h ago");
    expect(relativeTime(ago(30 * 60), now)).toBe("Yesterday 4:05 AM");
    expect(relativeTime(ago(5 * 24 * 60), now)).toBe("Aug 30, 10:05 AM");
  });
});
