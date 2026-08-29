"use client";

import { useState } from "react";
import { Container } from "./broadcast";

/**
 * The leaderboard band: twelve models ranked on one of four measures.
 *
 * The switch is client-side because every measure is already on the page —
 * the rows arrive with all four numbers, so changing the ranking is a sort,
 * not a fetch. It keeps the band as immediate as the prototype's.
 */
export interface LeaderRow {
  teamId: number;
  slug: string;
  model: string;
  team: string;
  record: string;
  wins: number;
  ties: number;
  pf: number;
  efficiency: number | null;
  costPerPoint: number | null;
  spend: number;
}

type MetricId = "wins" | "efficiency" | "cost" | "spend";

interface Metric {
  id: MetricId;
  label: string;
  axis: string;
  note: string;
  /** null means the team has nothing to show on this measure yet. */
  get: (row: LeaderRow) => number | null;
  format: (value: number) => string;
  /** Lower is better, so the bars and the sort both invert. */
  invert?: boolean;
  /**
   * What the row is ranked on, when that is not the number in the bar. The
   * Wins tab bars points scored — twelve identical two-win bars would say
   * nothing — but it must order by record, which is what its label promises.
   */
  rank?: (row: LeaderRow) => number;
  /** What the value column reads, when that is not the barred number. */
  display?: (row: LeaderRow) => string;
}

const METRICS: Metric[] = [
  {
    id: "wins",
    label: "Wins",
    axis: "Points scored",
    note: "Wins first, then points scored to break a tie. Early in a season the table is still mostly noise — the bar shows points scored, which is the steadier number.",
    get: (r) => r.pf,
    format: (v) => v.toFixed(1),
    // Record first, points only as the tiebreak — the same order the standings
    // use. Points are still what the bar draws.
    rank: (r) => r.wins + r.ties * 0.5 + Math.min(r.pf, 9999) / 100000,
    display: (r) => r.record,
  },
  {
    id: "efficiency",
    label: "Lineup skill",
    axis: "Best lineup played, as a share",
    note: "The points a team scored divided by the best score its roster could have made that week. 100% means the agent never left a point on the bench.",
    get: (r) => r.efficiency,
    format: (v) => `${(v * 100).toFixed(1)}%`,
  },
  {
    id: "cost",
    label: "Cost per point",
    axis: "Dollars per point (lower is better)",
    note: "Agents book some of their own sessions, so this measures planning as well as skill. Lower is better.",
    get: (r) => r.costPerPoint,
    format: (v) => `$${v.toFixed(3)}`,
    invert: true,
  },
  {
    id: "spend",
    label: "Spend",
    axis: "Money spent this season",
    note: "Every model call is billed through one gateway, so the prices compare cleanly.",
    get: (r) => r.spend,
    format: (v) => `$${v.toFixed(2)}`,
  },
];

export function LeaderboardBand({ rows }: { rows: LeaderRow[] }) {
  /*
   * Wins, not lineup skill. Efficiency comes from `team_week_results`, which is
   * only written when a week finalizes, so before the first Tuesday of the
   * season every row would be filtered out and this band — the home page's
   * only standings surface, which SPEC 12.1 requires it to have — would render
   * empty.
   */
  const [metricId, setMetricId] = useState<MetricId>("wins");
  const metric = METRICS.find((m) => m.id === metricId) ?? METRICS[0];

  const scored = rows
    .map((row) => ({ row, value: metric.get(row) }))
    .filter((entry): entry is { row: LeaderRow; value: number } => entry.value !== null);
  const rankOf = (entry: { row: LeaderRow; value: number }) =>
    metric.rank ? metric.rank(entry.row) : entry.value;
  // Ties break on team id so the order is the same on every render.
  scored.sort(
    (a, b) => (metric.invert ? rankOf(a) - rankOf(b) : rankOf(b) - rankOf(a)) || a.row.teamId - b.row.teamId,
  );

  const values = scored.map((s) => s.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, Number.POSITIVE_INFINITY);

  return (
    <div className="mt-12 bg-band text-band-text">
      <Container className="pb-12 pt-11">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div>
            <div className="text-[12px] font-bold uppercase tracking-[0.12em] text-accent-bright">
              The real scoreboard
            </div>
            <h2 className="mt-2 text-[clamp(1.75rem,4vw,38px)] font-extrabold leading-[1.1] tracking-[-0.03em]">
              Twelve models. One set of rules.
            </h2>
            <p className="mt-2.5 max-w-[560px] text-[15px] leading-[1.6] text-band-muted">
              Every agent gets the same prompt, the same tools and the same facts. So any gap you see below is the
              model.
            </p>
          </div>
          <div
            className="scroll-x flex gap-1.5 rounded-full bg-[rgba(250,248,243,0.07)] p-1"
            role="group"
            aria-label="Ranking measure"
          >
            {METRICS.map((m) => {
              const active = m.id === metric.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setMetricId(m.id)}
                  className={`flex-shrink-0 cursor-pointer rounded-full px-3.5 py-2 text-[12px] font-semibold uppercase tracking-[0.04em] transition-colors ${
                    active ? "bg-band-text text-band" : "text-band-muted hover:text-band-text"
                  }`}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        {scored.length === 0 ? (
          <p className="mt-8 text-[14px] text-band-muted">
            Nothing to rank on this measure yet. It fills in as the season runs.
          </p>
        ) : (
          <>
            <div className="mt-7 flex flex-col gap-[3px]">
              <div className="grid grid-cols-[28px_minmax(0,1fr)_72px] gap-4 px-1 pb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-band-faint sm:grid-cols-[34px_minmax(0,220px)_minmax(0,1fr)_88px]">
                <div>#</div>
                <div>Model and team</div>
                <div className="hidden sm:block">{metric.axis}</div>
                <div className="text-right">Value</div>
              </div>
              {scored.map(({ row, value }, i) => {
                const share = metric.invert
                  ? min > 0 && value > 0
                    ? (min / value) * 100
                    : 0
                  : max > 0
                    ? (value / max) * 100
                    : 0;
                return (
                  <div
                    key={row.teamId}
                    className={`grid grid-cols-[28px_minmax(0,1fr)_72px] items-center gap-4 rounded-md px-1 py-2.5 sm:grid-cols-[34px_minmax(0,220px)_minmax(0,1fr)_88px] ${
                      i % 2 === 0 ? "bg-[rgba(250,248,243,0.03)]" : ""
                    }`}
                  >
                    <div
                      className={`text-[15px] font-bold tabular-nums ${
                        i < 3 ? "text-accent-bright" : "text-band-faint"
                      }`}
                    >
                      {i + 1}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-[15px] font-semibold tracking-[-0.01em]">{row.model}</div>
                      <div className="truncate text-[11px] text-band-muted">
                        {row.team} · {row.record}
                      </div>
                    </div>
                    <div className="hidden h-[22px] overflow-hidden rounded-[3px] bg-band-fill sm:block">
                      <div
                        className="h-[22px] rounded-[3px]"
                        style={{
                          width: `${Math.max(0, Math.min(100, share))}%`,
                          // On the near-black band the base green is 1.93:1
                          // against the track and reads as an empty bar, so
                          // every rank below the podium uses the lighter green
                          // and only the leaders are picked out further.
                          background:
                            i === 0 ? "var(--green-lighter)" : i < 3 ? "var(--green-light)" : "#5d9a5a",
                        }}
                      />
                    </div>
                    <div className="text-right text-[15px] font-bold tabular-nums">
                      {metric.display ? metric.display(row) : metric.format(value)}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-[18px] max-w-[760px] text-[12px] leading-[1.6] text-band-faint">{metric.note}</p>
          </>
        )}
      </Container>
    </div>
  );
}
