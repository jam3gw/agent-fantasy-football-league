"use client";

import { useId, useState } from "react";
import { EVENTS } from "@/lib/analytics";
import { trackEvent } from "@/lib/track";

/**
 * Pick two models and see the gap.
 *
 * Twelve teams' worth of numbers is a table nobody reads across. This turns
 * the comparison people actually want — this model against that one — into two
 * selects and seven mirrored bars.
 */
export interface CompareTeam {
  teamId: number;
  model: string;
  name: string;
  pf: number;
  efficiency: number | null;
  costPerPoint: number | null;
  spend: number;
  bench: number;
  claimsWon: number;
  invalidToolCalls: number;
}

interface Measure {
  label: string;
  get: (t: CompareTeam) => number | null;
  format: (v: number) => string;
  /** Lower wins — spend, cost per point, bench points, bad tool calls. */
  lowerIsBetter?: boolean;
}

const MEASURES: Measure[] = [
  { label: "Points for", get: (t) => t.pf, format: (v) => v.toFixed(1) },
  {
    label: "Lineup skill",
    get: (t) => t.efficiency,
    format: (v) => `${(v * 100).toFixed(1)}%`,
  },
  {
    label: "Cost per point",
    get: (t) => t.costPerPoint,
    format: (v) => `$${v.toFixed(3)}`,
    lowerIsBetter: true,
  },
  { label: "Spend", get: (t) => t.spend, format: (v) => `$${v.toFixed(2)}`, lowerIsBetter: true },
  { label: "Points left on bench", get: (t) => t.bench, format: (v) => v.toFixed(1), lowerIsBetter: true },
  { label: "Claims won", get: (t) => t.claimsWon, format: (v) => String(v) },
  {
    label: "Bad tool calls",
    get: (t) => t.invalidToolCalls,
    format: (v) => String(v),
    lowerIsBetter: true,
  },
];

export function ComparePanel({ teams }: { teams: CompareTeam[] }) {
  const leftId = useId();
  const rightId = useId();
  const [leftIndex, setLeftIndex] = useState(0);
  const [rightIndex, setRightIndex] = useState(teams.length > 1 ? 1 : 0);

  if (teams.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-band p-[22px] text-band-text">
        <h2 className="text-[18px] font-bold tracking-[-0.02em]">Compare two models</h2>
        <p className="mt-1.5 text-[13px] text-band-muted">No teams yet. This fills in once the league is set up.</p>
      </div>
    );
  }

  const left = teams[Math.min(leftIndex, teams.length - 1)];
  const right = teams[Math.min(rightIndex, teams.length - 1)];

  const select = (
    id: string,
    label: string,
    value: number,
    onChange: (next: number) => void,
  ) => (
    <div>
      <label htmlFor={id} className="text-[10px] font-bold uppercase tracking-[0.12em] text-band-faint">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1.5 w-full rounded-lg border border-[rgba(250,248,243,0.18)] bg-band-alt px-2.5 py-2.5 text-[14px] font-semibold text-band-text"
      >
        {teams.map((t, i) => (
          <option key={t.teamId} value={i}>
            {t.model}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="rounded-xl border border-border bg-band p-[22px] text-band-text">
      <h2 className="text-[18px] font-bold tracking-[-0.02em]">Compare two models</h2>
      <p className="mt-1.5 text-[13px] text-band-muted">Same league. Same facts. Pick any two.</p>

      <div className="mt-[18px] grid grid-cols-2 gap-3">
        {select(leftId, "Left", leftIndex, (i) => {
          setLeftIndex(i);
          trackEvent(EVENTS.compare, { left: teams[i]?.model ?? "", right: right.model });
        })}
        {select(rightId, "Right", rightIndex, (i) => {
          setRightIndex(i);
          trackEvent(EVENTS.compare, { left: left.model, right: teams[i]?.model ?? "" });
        })}
      </div>

      <div className="mt-5 flex flex-col gap-3.5">
        {MEASURES.map((measure) => {
          const a = measure.get(left);
          const b = measure.get(right);
          const known = a !== null && b !== null;
          const top = known ? Math.max(a, b) : 0;
          const aWins = known ? (measure.lowerIsBetter ? a <= b : a >= b) : false;
          const bWins = known ? (measure.lowerIsBetter ? b <= a : b >= a) : false;
          return (
            <div key={measure.label}>
              <div className="flex items-baseline justify-between gap-2.5 text-[13px]">
                <span
                  className={`font-bold tabular-nums ${aWins ? "text-accent-bright" : "text-band-faint"}`}
                >
                  {a === null ? "—" : measure.format(a)}
                </span>
                <span className="text-center text-[10px] font-bold uppercase tracking-[0.1em] text-band-muted">
                  {measure.label}
                </span>
                <span
                  className={`font-bold tabular-nums ${bWins ? "text-accent-bright" : "text-band-faint"}`}
                >
                  {b === null ? "—" : measure.format(b)}
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-[3px]">
                <div className="flex h-2 flex-1 justify-end overflow-hidden rounded-[3px] bg-band-fill">
                  <div
                    className="h-2 rounded-[3px]"
                    style={{
                      width: `${known && top > 0 ? (a / top) * 100 : 0}%`,
                      background: aWins ? "var(--green-lighter)" : "var(--band-faint)",
                    }}
                  />
                </div>
                <div className="flex h-2 flex-1 overflow-hidden rounded-[3px] bg-band-fill">
                  <div
                    className="h-2 rounded-[3px]"
                    style={{
                      width: `${known && top > 0 ? (b / top) * 100 : 0}%`,
                      background: bWins ? "var(--green-lighter)" : "var(--band-faint)",
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-[18px] text-[13px] leading-[1.6] text-band-muted">
        {left.teamId === right.teamId
          ? "Pick two different models to see the gap."
          : `${left.model} scored ${Math.abs(left.pf - right.pf).toFixed(1)} ${
              left.pf > right.pf ? "more" : "fewer"
            } points than ${right.model}, and spent $${Math.abs(left.spend - right.spend).toFixed(2)} ${
              left.spend > right.spend ? "more" : "less"
            } doing it.`}
      </p>
    </div>
  );
}
