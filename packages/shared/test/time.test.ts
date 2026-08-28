import { describe, expect, it } from "vitest";
import {
  etDay,
  nextEtTime,
  nextEtWeekdayTime,
  tzOffsetMs,
  wallClockParts,
  zonedTimeToUtc,
} from "../src/time.ts";

describe("tzOffsetMs", () => {
  it("is -5h in winter (EST) and -4h in summer (EDT)", () => {
    expect(tzOffsetMs("America/New_York", new Date("2026-01-15T12:00:00Z"))).toBe(-5 * 3600_000);
    expect(tzOffsetMs("America/New_York", new Date("2026-07-15T12:00:00Z"))).toBe(-4 * 3600_000);
  });
});

describe("zonedTimeToUtc", () => {
  it("converts ET wall time to UTC in both DST regimes", () => {
    // Sep 8, 2026 4:00 AM EDT = 08:00 UTC
    expect(zonedTimeToUtc(2026, 9, 8, 4, 0).toISOString()).toBe("2026-09-08T08:00:00.000Z");
    // Dec 15, 2026 4:00 AM EST = 09:00 UTC
    expect(zonedTimeToUtc(2026, 12, 15, 4, 0).toISOString()).toBe("2026-12-15T09:00:00.000Z");
  });

  it("handles the DST fall-back day (Nov 1, 2026)", () => {
    // 4:30 AM ET on Nov 1 2026 is after the 2AM fall-back → EST (UTC-5) = 09:30 UTC
    expect(zonedTimeToUtc(2026, 11, 1, 4, 30).toISOString()).toBe("2026-11-01T09:30:00.000Z");
    // 12:30 AM ET is before the transition → EDT (UTC-4) = 04:30 UTC
    expect(zonedTimeToUtc(2026, 11, 1, 0, 30).toISOString()).toBe("2026-11-01T04:30:00.000Z");
  });

  it("handles the DST spring-forward day (Mar 8, 2026)", () => {
    // 4:30 AM ET on Mar 8 2026 is after the 2AM spring-forward → EDT = 08:30 UTC
    expect(zonedTimeToUtc(2026, 3, 8, 4, 30).toISOString()).toBe("2026-03-08T08:30:00.000Z");
  });
});

describe("nextEtWeekdayTime", () => {
  it("finds next Wednesday 4:30 AM ET from a Monday", () => {
    // Mon Sep 7, 2026 10:00 ET
    const from = zonedTimeToUtc(2026, 9, 7, 10, 0);
    const next = nextEtWeekdayTime(from, 3, 4, 30);
    expect(next.toISOString()).toBe(zonedTimeToUtc(2026, 9, 9, 4, 30).toISOString());
  });

  it("returns the same instant when `from` is exactly the target and strict=false", () => {
    const at = zonedTimeToUtc(2026, 9, 9, 4, 30); // a Wednesday
    expect(nextEtWeekdayTime(at, 3, 4, 30).getTime()).toBe(at.getTime());
    expect(nextEtWeekdayTime(at, 3, 4, 30, { strict: true }).toISOString()).toBe(
      zonedTimeToUtc(2026, 9, 16, 4, 30).toISOString(),
    );
  });

  it("rolls to next week when today's target time has passed", () => {
    const from = zonedTimeToUtc(2026, 9, 9, 5, 0); // Wed 5:00 AM ET
    expect(nextEtWeekdayTime(from, 3, 4, 30).toISOString()).toBe(
      zonedTimeToUtc(2026, 9, 16, 4, 30).toISOString(),
    );
  });

  it("crosses the DST boundary correctly (Sat before fall-back → Wed after)", () => {
    const from = zonedTimeToUtc(2026, 10, 31, 12, 0); // Sat Oct 31 noon EDT
    const next = nextEtWeekdayTime(from, 3, 4, 30); // Wed Nov 4, EST
    expect(next.toISOString()).toBe("2026-11-04T09:30:00.000Z");
  });
});

describe("nextEtTime", () => {
  it("same day when still ahead, next day when passed", () => {
    const morning = zonedTimeToUtc(2026, 9, 8, 3, 0);
    expect(nextEtTime(morning, 4, 30).toISOString()).toBe(zonedTimeToUtc(2026, 9, 8, 4, 30).toISOString());
    const later = zonedTimeToUtc(2026, 9, 8, 5, 0);
    expect(nextEtTime(later, 4, 30).toISOString()).toBe(zonedTimeToUtc(2026, 9, 9, 4, 30).toISOString());
  });
});

describe("etDay / wallClockParts", () => {
  it("ET day flips at midnight ET, not UTC", () => {
    // 03:30 UTC on Sep 9 is 11:30 PM ET on Sep 8
    expect(etDay(new Date("2026-09-09T03:30:00Z"))).toBe("2026-09-08");
    expect(etDay(new Date("2026-09-09T04:30:00Z"))).toBe("2026-09-09");
  });

  it("weekday matches the ET calendar", () => {
    const p = wallClockParts(new Date("2026-09-09T03:30:00Z")); // Tue Sep 8 ET evening
    expect(p.dow).toBe(2);
    expect(p.d).toBe(8);
  });
});
