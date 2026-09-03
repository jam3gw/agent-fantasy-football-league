/**
 * The filter and sort logic for `/trades`, over the summaries the server
 * builds for each card. The cards themselves are server-rendered; only these
 * few fields cross to the client, and the client decides which cards to show.
 */
import { ALL, compareNullable, withinPeriod } from "./listControls";

export type TradeSection = "review" | "resolved" | "offer";

export interface TradeSummary {
  id: number;
  section: TradeSection;
  /** Both teams' slugs. */
  teamSlugs: string[];
  status: string;
  /** The card's headline time, ms since epoch: proposed, accepted, or resolved. */
  at: number;
  /** Net projected swing to the proposer; null when a side has no projection. */
  swing: number | null;
}

export const TRADE_SORTS = ["newest", "swing"] as const;
export type TradeSort = (typeof TRADE_SORTS)[number];

export interface TradeFilters {
  team: string;
  status: string;
  period: string;
}

export function filterTrades<T extends TradeSummary>(items: readonly T[], f: TradeFilters, now: number): T[] {
  return items.filter(
    (t) =>
      (f.team === ALL || t.teamSlugs.includes(f.team)) &&
      (f.status === ALL || t.status === f.status) &&
      withinPeriod(t.at, f.period, now),
  );
}

/** Newest first, or by the size of the swing (either direction), unknown last. */
export function sortTrades<T extends TradeSummary>(items: readonly T[], sort: string): T[] {
  const copy = [...items];
  if (sort === "swing") {
    copy.sort(
      (a, b) =>
        compareNullable(a.swing === null ? null : Math.abs(a.swing), b.swing === null ? null : Math.abs(b.swing)) ||
        b.at - a.at,
    );
  } else {
    copy.sort((a, b) => b.at - a.at);
  }
  return copy;
}
