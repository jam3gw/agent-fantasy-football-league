/**
 * The small pure pieces behind every filter bar on the site: reading a
 * query value against an allowed set, a "since" period, and comparators
 * that keep unknown values at the bottom whichever way the sort runs.
 */

export const ALL = "all";

/** A query value, or the fallback when it is missing or not allowed. */
export function readParam(value: string | null | undefined, allowed: readonly string[], fallback = ALL): string {
  return value && allowed.includes(value) ? value : fallback;
}

export const PERIODS = ["all", "24h", "7d", "30d"] as const;
export type Period = (typeof PERIODS)[number];

const PERIOD_MS: Record<Exclude<Period, "all">, number> = {
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
};

/** Whether `at` (ms) falls inside the period ending at `now` (ms). */
export function withinPeriod(at: number, period: string, now: number): boolean {
  if (period === "all") return true;
  const span = PERIOD_MS[period as Exclude<Period, "all">];
  return span === undefined ? true : now - at <= span;
}

/**
 * Descending by a number, with nulls last. `dir` flips the order of the
 * known values only; an unknown value never rises to the top.
 */
export function compareNullable(a: number | null, b: number | null, dir: "asc" | "desc" = "desc"): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return dir === "desc" ? b - a : a - b;
}

/** The first `shown` items, and whether there are more behind them. */
export function page<T>(items: readonly T[], shown: number): { items: T[]; more: number } {
  return { items: items.slice(0, shown), more: Math.max(0, items.length - shown) };
}

/** A week from a query value: an integer in 1..maxWeek, else undefined. */
export function readWeek(value: string | null | undefined, maxWeek: number): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const week = Number(value);
  return week >= 1 && week <= maxWeek ? week : undefined;
}
