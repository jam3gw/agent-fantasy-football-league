/**
 * The `/sessions` page's filters. The reporter has no team row, so the team
 * filter has to find it by sentinel rather than by slug.
 */
import { describe, expect, it } from "vitest";
import { ALL, REPORTER, filterSessions, isLive, teamKey } from "@/lib/sessionsFilter";

const rows = [
  { id: 1, teamId: 3, teamSlug: "gemini", status: "succeeded", kind: "weekly_review" },
  { id: 2, teamId: null, teamSlug: null, status: "running", kind: "reporter_recap" },
  { id: 3, teamId: 3, teamSlug: "gemini", status: "failed", kind: "lineup_check" },
  { id: 4, teamId: 5, teamSlug: "grok", status: "queued", kind: "weekly_review" },
];

describe("filterSessions", () => {
  it("returns everything when both filters are 'all'", () => {
    expect(filterSessions(rows, ALL, ALL)).toHaveLength(4);
  });

  it("filters by team slug", () => {
    expect(filterSessions(rows, "gemini", ALL).map((r) => r.id)).toEqual([1, 3]);
  });

  it("finds the reporter's sessions by the sentinel", () => {
    expect(filterSessions(rows, REPORTER, ALL).map((r) => r.id)).toEqual([2]);
  });

  it("filters by status, and combines with the team filter", () => {
    expect(filterSessions(rows, ALL, "failed").map((r) => r.id)).toEqual([3]);
    expect(filterSessions(rows, "gemini", "failed").map((r) => r.id)).toEqual([3]);
    expect(filterSessions(rows, "grok", "failed")).toEqual([]);
  });

  it("filters by kind, and leaves kind open by default", () => {
    expect(filterSessions(rows, ALL, ALL, "weekly_review").map((r) => r.id)).toEqual([1, 4]);
    expect(filterSessions(rows, "gemini", ALL, "weekly_review").map((r) => r.id)).toEqual([1]);
    expect(filterSessions(rows, ALL, ALL)).toHaveLength(4);
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
