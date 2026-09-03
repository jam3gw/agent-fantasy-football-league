import { describe, expect, it } from "vitest";
import { compareNullable, page, readParam, readWeek, withinPeriod } from "@/lib/listControls";

describe("readParam", () => {
  it("accepts an allowed value and falls back otherwise", () => {
    expect(readParam("failed", ["failed", "queued"])).toBe("failed");
    expect(readParam("nope", ["failed"])).toBe("all");
    expect(readParam(null, ["failed"], "newest")).toBe("newest");
    expect(readParam("", ["failed"])).toBe("all");
  });
});

describe("withinPeriod", () => {
  const now = Date.UTC(2026, 8, 10, 12);
  it("keeps everything for 'all' and an unknown period", () => {
    expect(withinPeriod(0, "all", now)).toBe(true);
    expect(withinPeriod(0, "bogus", now)).toBe(true);
  });
  it("cuts at the period boundary", () => {
    expect(withinPeriod(now - 23 * 3600_000, "24h", now)).toBe(true);
    expect(withinPeriod(now - 25 * 3600_000, "24h", now)).toBe(false);
    expect(withinPeriod(now - 8 * 24 * 3600_000, "7d", now)).toBe(false);
    expect(withinPeriod(now - 8 * 24 * 3600_000, "30d", now)).toBe(true);
  });
});

describe("compareNullable and page", () => {
  it("keeps nulls last in both directions", () => {
    const sorted = [3, null, 1, 2].sort((a, b) => compareNullable(a, b));
    expect(sorted).toEqual([3, 2, 1, null]);
    const asc = [3, null, 1, 2].sort((a, b) => compareNullable(a, b, "asc"));
    expect(asc).toEqual([1, 2, 3, null]);
  });
  it("pages and counts the rest", () => {
    expect(page([1, 2, 3, 4, 5], 2)).toEqual({ items: [1, 2], more: 3 });
    expect(page([1], 5)).toEqual({ items: [1], more: 0 });
  });
});

describe("readWeek", () => {
  it("accepts a week inside the season and nothing else", () => {
    expect(readWeek("3", 18)).toBe(3);
    expect(readWeek("0", 18)).toBeUndefined();
    expect(readWeek("19", 18)).toBeUndefined();
    expect(readWeek("3.5", 18)).toBeUndefined();
    expect(readWeek("abc", 18)).toBeUndefined();
    expect(readWeek(undefined, 18)).toBeUndefined();
  });
});
