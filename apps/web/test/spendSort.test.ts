import { describe, expect, it } from "vitest";
import { sortSpendRows, type SpendRow } from "@/lib/spendSort";

const row = (name: string, season: number, perPoint: number | null): SpendRow => ({
  key: name,
  href: `/spend/${name}`,
  name,
  model: "m",
  alarms: 0,
  today: 0,
  week: 0,
  season,
  paid: 0,
  sessions: 1,
  perSession: season,
  perPoint,
  perWin: null,
  input: 0,
  output: 0,
  reasoning: 0,
  cached: 0,
  cacheWrites: 0,
});
const rows = [row("b", 5, null), row("a", 9, 0.2), row("c", 1, 0.1)];

describe("sortSpendRows", () => {
  it("defaults to season descending for an unknown column", () => {
    expect(sortSpendRows(rows, "bogus", "desc").map((r) => r.name)).toEqual(["a", "b", "c"]);
  });
  it("flips direction, keeping unknown values last", () => {
    expect(sortSpendRows(rows, "perPoint", "desc").map((r) => r.name)).toEqual(["a", "c", "b"]);
    expect(sortSpendRows(rows, "perPoint", "asc").map((r) => r.name)).toEqual(["c", "a", "b"]);
  });
  it("sorts by name alphabetically", () => {
    expect(sortSpendRows(rows, "name", "asc").map((r) => r.name)).toEqual(["a", "b", "c"]);
  });
});

describe("sortSpendRows before any spend", () => {
  it("orders by name when every column ties", () => {
    const zero = [row("b", 0, null), row("a", 0, null), row("c", 0, null)];
    expect(sortSpendRows(zero, "season", "desc").map((r) => r.name)).toEqual(["a", "b", "c"]);
  });
});
