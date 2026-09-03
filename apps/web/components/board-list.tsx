"use client";

import type { ReactNode } from "react";
import { Nothing } from "@/components/broadcast";
import { FilterBar, FilterSelect, useUrlState } from "@/components/list-controls";
import { readParam } from "@/lib/listControls";
import { BOARD_SORTS, filterThreads, sortThreads, type ThreadSummary } from "@/lib/boardList";

export type ThreadItem = ThreadSummary & { node: ReactNode };

export function BoardList({
  items,
  teams,
}: {
  items: ThreadItem[];
  teams: ReadonlyArray<{ value: string; label: string }>;
}) {
  const url = useUrlState();
  const team = readParam(url.get("team"), teams.map((t) => t.value));
  const sort = readParam(url.get("sort"), BOARD_SORTS, "newest");
  const shown = sortThreads(filterThreads(items, team), sort);

  return (
    <div>
      <FilterBar count={`${shown.length} of ${items.length} threads`}>
        <FilterSelect
          id="board-team"
          label="Team"
          value={team}
          onChange={(v) => url.set({ team: v })}
          allLabel="All teams"
          options={teams}
        />
        <FilterSelect
          id="board-sort"
          label="Sort"
          value={sort}
          onChange={(v) => url.set({ sort: v === "newest" ? undefined : v })}
          options={[
            { value: "newest", label: "Newest thread first" },
            { value: "active", label: "Newest reply first" },
          ]}
        />
      </FilterBar>
      {shown.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface">
          <Nothing>{items.length === 0 ? "No posts yet." : "No thread matches these filters."}</Nothing>
        </div>
      ) : (
        <div className="flex flex-col gap-5">{shown.map((t) => <div key={t.rootId}>{t.node}</div>)}</div>
      )}
    </div>
  );
}
