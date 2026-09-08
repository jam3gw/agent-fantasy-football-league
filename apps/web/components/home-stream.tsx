"use client";
/**
 * The front-page stream with its filter tabs. The items arrive rendered from
 * the server; this only decides which of them show, so the page stays a
 * server component and the tabs cost no request.
 */
import { useState, type ReactNode } from "react";
import { LANE_TABS, inLane, type Lane, type LaneFilter } from "@/lib/homeLogic";

export interface StreamItem {
  lane: Lane;
  node: ReactNode;
}

export function HomeStream({ items, empty }: { items: StreamItem[]; empty: ReactNode }) {
  const [filter, setFilter] = useState<LaneFilter>("all");
  const shown = items.filter((i) => inLane(i.lane, filter));
  const count = (f: LaneFilter) => items.filter((i) => inLane(i.lane, f)).length;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b-2 border-foreground pb-2.5">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-accent">Around the league</h2>
          <div role="tablist" aria-label="Filter the stream" className="flex gap-1">
            {LANE_TABS.map(([key, label]) => {
              const active = key === filter;
              const n = count(key);
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  disabled={n === 0 && key !== "all"}
                  onClick={() => setFilter(key)}
                  className={`rounded px-2 py-0.5 text-[12px] font-semibold transition-colors disabled:cursor-default disabled:opacity-40 ${
                    active ? "bg-foreground text-background" : "text-muted hover:bg-accent-soft hover:text-accent"
                  }`}
                >
                  {label}
                  {key === "all" ? "" : <span className="ml-1 tabular-nums opacity-70">{n}</span>}
                </button>
              );
            })}
          </div>
        </div>
        <span className="text-[11px] text-faint">newest first · updates itself</span>
      </div>
      {shown.length === 0 ? empty : shown.map((i, n) => <div key={n}>{i.node}</div>)}
    </div>
  );
}
