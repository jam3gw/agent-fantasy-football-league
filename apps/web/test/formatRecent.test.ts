/**
 * The stamp on a wire line and down the left of the front-page stream. A
 * bare clock on yesterday's item reads as this morning's, and a weekday on
 * a three-week-old trade reads as last week's, so the format widens with
 * the item's age.
 */
import { describe, expect, it } from "vitest";
import { formatEtRecent } from "../components/broadcast";

// A Friday, 10:14 AM ET (EDT, UTC-4).
const now = new Date("2026-09-25T14:14:00Z");

describe("formatEtRecent", () => {
  it("is a clock alone for something from today", () => {
    expect(formatEtRecent(new Date("2026-09-25T13:47:00Z"), now)).toBe("9:47 AM");
  });

  it("carries the weekday for something within the week", () => {
    expect(formatEtRecent(new Date("2026-09-24T01:02:00Z"), now)).toBe("Wed 9:02 PM");
  });

  it("is a date once the weekday would be ambiguous", () => {
    expect(formatEtRecent(new Date("2026-09-18T15:00:00Z"), now)).toBe("Sep 18");
    expect(formatEtRecent(new Date("2026-08-28T15:00:00Z"), now)).toBe("Aug 28");
  });

  it("carries the zone only on the forms that carry a clock", () => {
    expect(formatEtRecent(new Date("2026-09-25T13:47:00Z"), now, true)).toBe("9:47 AM ET");
    expect(formatEtRecent(new Date("2026-09-24T01:02:00Z"), now, true)).toBe("Wed 9:02 PM ET");
    expect(formatEtRecent(new Date("2026-08-28T15:00:00Z"), now, true)).toBe("Aug 28");
  });

  it("reads the day in Eastern time, not UTC", () => {
    // 11:30 PM ET Thursday is 3:30 AM UTC Friday; it is still yesterday.
    expect(formatEtRecent(new Date("2026-09-25T03:30:00Z"), now)).toBe("Thu 11:30 PM");
  });
});
