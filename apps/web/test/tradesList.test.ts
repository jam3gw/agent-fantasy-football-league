import { describe, expect, it } from "vitest";
import { filterTrades, sortTrades, type TradeSummary } from "@/lib/tradesList";

const now = Date.UTC(2026, 8, 10, 12);
const day = 24 * 3600_000;
const items: TradeSummary[] = [
  { id: 1, section: "review", teamSlugs: ["gemini", "grok"], status: "accepted", at: now - day, swing: 4.2 },
  { id: 2, section: "offer", teamSlugs: ["claude", "gemini"], status: "rejected", at: now - 10 * day, swing: -9.5 },
  { id: 3, section: "resolved", teamSlugs: ["grok", "gpt"], status: "executed", at: now - 40 * day, swing: null },
  { id: 4, section: "offer", teamSlugs: ["gpt", "claude"], status: "proposed", at: now - 3600_000, swing: 0.5 },
];

describe("filterTrades", () => {
  it("matches a team on either side", () => {
    expect(filterTrades(items, { team: "gemini", status: "all", period: "all" }, now).map((t) => t.id)).toEqual([1, 2]);
  });
  it("combines status and period", () => {
    expect(filterTrades(items, { team: "all", status: "proposed", period: "24h" }, now).map((t) => t.id)).toEqual([4]);
    expect(filterTrades(items, { team: "all", status: "all", period: "7d" }, now).map((t) => t.id)).toEqual([1, 4]);
  });
});

describe("sortTrades", () => {
  it("defaults to newest first", () => {
    expect(sortTrades(items, "newest").map((t) => t.id)).toEqual([4, 1, 2, 3]);
  });
  it("sorts by the size of the swing in either direction, unknown last", () => {
    expect(sortTrades(items, "swing").map((t) => t.id)).toEqual([2, 1, 4, 3]);
  });
  it("breaks a swing tie by recency", () => {
    const tied = [
      { ...items[0]!, id: 10, swing: 2, at: 1 },
      { ...items[0]!, id: 11, swing: -2, at: 2 },
    ];
    expect(sortTrades(tied, "swing").map((t) => t.id)).toEqual([11, 10]);
  });

  it("does not mutate its input", () => {
    const before = items.map((t) => t.id);
    sortTrades(items, "swing");
    expect(items.map((t) => t.id)).toEqual(before);
  });
});
