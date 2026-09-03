"use client";

import { useState, type ReactNode } from "react";
import { Card, Empty } from "@/components/ui";
import { FilterBar, FilterSelect, ShowMore, useUrlState } from "@/components/list-controls";
import { ALL, PERIODS, page, readParam } from "@/lib/listControls";
import { TRADE_SORTS, filterTrades, sortTrades, type TradeSection, type TradeSummary } from "@/lib/tradesList";

/** How many cards a section shows before "show more". */
const STEP = 40;

const PERIOD_LABEL: Record<string, string> = { "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days" };
const SORT_LABEL: Record<string, string> = { newest: "Newest first", swing: "Biggest swing first" };
const SECTIONS: Array<{ key: TradeSection; title: string; empty: string; noun: string }> = [
  { key: "review", title: "In review", empty: "No trade in review matches these filters.", noun: "in review" },
  { key: "resolved", title: "Resolved", empty: "No resolved trade matches these filters.", noun: "resolved" },
  { key: "offer", title: "Offers", empty: "No offer matches these filters.", noun: "offers" },
];

export type TradeItem = TradeSummary & { card: ReactNode };

/**
 * The three trade sections behind one filter bar. The server renders every
 * card; this decides which to show, in what order, and how many.
 */
export function TradesList({
  items,
  teams,
  now,
}: {
  items: TradeItem[];
  teams: ReadonlyArray<{ value: string; label: string }>;
  /** The league clock at render, ms; the period filter counts back from it. */
  now: number;
}) {
  const url = useUrlState();
  const [shown, setShown] = useState<Record<TradeSection, number>>({ review: STEP, resolved: STEP, offer: STEP });

  const statuses = [...new Set(items.map((t) => t.status))];
  const team = readParam(url.get("team"), teams.map((t) => t.value));
  const status = readParam(url.get("status"), statuses);
  const period = readParam(url.get("period"), PERIODS);
  const sort = readParam(url.get("sort"), TRADE_SORTS, "newest");

  const matching = sortTrades(filterTrades(items, { team, status, period }, now), sort);
  const anyFilter = team !== ALL || status !== ALL || period !== ALL;

  return (
    <div>
      <FilterBar count={`${matching.length} of ${items.length} trades`}>
        <FilterSelect
          id="trades-team"
          label="Team"
          value={team}
          onChange={(v) => url.set({ team: v })}
          allLabel="All teams"
          options={teams}
        />
        <FilterSelect
          id="trades-status"
          label="Status"
          value={status}
          onChange={(v) => url.set({ status: v })}
          allLabel="All statuses"
          options={statuses.map((s) => ({ value: s, label: s.replace(/_/g, " ") }))}
        />
        <FilterSelect
          id="trades-period"
          label="Period"
          value={period}
          onChange={(v) => url.set({ period: v })}
          allLabel="Any time"
          options={PERIODS.filter((p) => p !== "all").map((p) => ({ value: p, label: PERIOD_LABEL[p] ?? p }))}
        />
        <FilterSelect
          id="trades-sort"
          label="Sort"
          value={sort}
          onChange={(v) => url.set({ sort: v === "newest" ? undefined : v })}
          options={TRADE_SORTS.map((s) => ({ value: s, label: SORT_LABEL[s] ?? s }))}
        />
      </FilterBar>

      <div className="space-y-4">
        {SECTIONS.map((section) => {
          const inSection = matching.filter((t) => t.section === section.key);
          const { items: visible, more } = page(inSection, shown[section.key]);
          const total = items.filter((t) => t.section === section.key).length;
          return (
            <Card key={section.key} title={`${section.title} (${inSection.length})`}>
              {inSection.length === 0 ? (
                <Empty>
                  {total === 0 && !anyFilter
                    ? section.key === "review"
                      ? "No trade is in review."
                      : section.key === "resolved"
                        ? "No trade has been executed or vetoed yet."
                        : "No offer has been made yet."
                    : section.empty}
                </Empty>
              ) : (
                <div className="space-y-4">{visible.map((t) => <div key={t.id}>{t.card}</div>)}</div>
              )}
              <ShowMore
                more={more}
                noun={section.noun}
                onClick={() => setShown((s) => ({ ...s, [section.key]: s[section.key] + STEP }))}
              />
            </Card>
          );
        })}
      </div>
    </div>
  );
}
