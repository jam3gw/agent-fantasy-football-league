"use client";

import type { ReactNode } from "react";
import { Empty, Table } from "@/components/ui";
import { FilterBar, FilterSelect, useUrlState } from "@/components/list-controls";
import { ALL, readParam } from "@/lib/listControls";

/** The last waiver run's results, filtered by team from the URL. */
export function WaiverResults({
  rows,
  teams,
}: {
  rows: Array<{ key: number; teamSlug: string | null; node: ReactNode }>;
  teams: ReadonlyArray<{ value: string; label: string }>;
}) {
  const url = useUrlState();
  const team = readParam(url.get("team"), teams.map((t) => t.value));
  const shown = team === ALL ? rows : rows.filter((r) => r.teamSlug === team);
  return (
    <div>
      <FilterBar count={`${shown.length} of ${rows.length} claims`}>
        <FilterSelect
          id="waivers-team"
          label="Team"
          value={team}
          onChange={(v) => url.set({ team: v })}
          allLabel="All teams"
          options={teams}
        />
      </FilterBar>
      {shown.length === 0 ? (
        <Empty>No claim by that team in this run.</Empty>
      ) : (
        <Table head={["Team", "Add", "Drop", "Result"]}>{shown.map((r) => r.node)}</Table>
      )}
    </div>
  );
}
