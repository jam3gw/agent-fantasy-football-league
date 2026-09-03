/**
 * The projection summary on `/trades`. The rule under test is "omit rather
 * than fabricate": a player without a week-0 projection is a dash, and a side
 * with no projections at all does not produce a swing.
 */
import { describe, expect, it } from "vitest";
import { formatProjection, sumProjections, swingLabel } from "@/lib/tradeProjection";

describe("sumProjections", () => {
  it("adds the known projections and skips the unknown ones", () => {
    expect(sumProjections([120.5, null, 30.25])).toBeCloseTo(150.75);
  });

  it("is null when nothing is known", () => {
    expect(sumProjections([])).toBeNull();
    expect(sumProjections([null, undefined])).toBeNull();
  });
});

describe("formatProjection", () => {
  it("shows one decimal, or a dash for a missing row", () => {
    expect(formatProjection(12.345)).toBe("12.3");
    expect(formatProjection(0)).toBe("0.0");
    expect(formatProjection(null)).toBe("—");
  });
});

describe("swingLabel", () => {
  it("is what the proposer receives minus what it gives, signed", () => {
    expect(swingLabel(100, 104.2)).toBe("+4.2 proj pts");
    expect(swingLabel(100, 99)).toBe("−1.0 proj pts");
    expect(swingLabel(50, 50.04)).toBe("±0.0 proj pts");
  });

  it("is null when either side has no projection", () => {
    expect(swingLabel(null, 10)).toBeNull();
    expect(swingLabel(10, null)).toBeNull();
  });
});
