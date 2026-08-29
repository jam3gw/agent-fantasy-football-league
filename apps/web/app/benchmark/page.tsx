/**
 * `/benchmark` (SPEC §12.1) — every per-team measure the league records, and
 * the comparison the whole project exists to make.
 *
 * Same numbers as before, read through `benchmarkRows`, which the home page's
 * leaderboard shares. What the redesign adds is a way in: four headline
 * figures, a plot that puts points against money so the good corner is
 * visible, and a two-model comparison, ahead of the full table rather than
 * instead of it.
 */
import Link from "next/link";
import { Container, Eyebrow, Nothing, Panel, StatTile } from "@/components/broadcast";
import { ComparePanel, type CompareTeam } from "@/components/compare";
import { benchmarkRows, type BenchRow } from "@/lib/broadcast";

// §12.1: 300s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 300s stale.
export const revalidate = 300;

export const metadata = {
  title: "Benchmark",
  description: "Twelve models, one rule set: what each one actually did with its team, and what it cost.",
};

const HEAD = [
  "Model",
  "W-L-T",
  "Points for",
  "Against",
  "Lineup skill",
  "Bench pts",
  "FA pts",
  "Claims",
  "Won",
  "Trades",
  "Sent",
  "Recv",
  "Sessions",
  "Failed",
  "Bad tool calls",
  "Auto-picks",
  "Empty slots",
  "Tokens in",
  "Tokens out",
  "Reasoning",
  "Cached",
  "Spend (list)",
  "Spend (paid)",
  "$/point",
];

function cellsFor(r: BenchRow): string[] {
  return [
    r.ties > 0 ? `${r.wins}-${r.losses}-${r.ties}` : `${r.wins}-${r.losses}`,
    r.pf.toFixed(1),
    r.pa.toFixed(1),
    r.efficiency === null ? "—" : `${(r.efficiency * 100).toFixed(1)}%`,
    r.bench.toFixed(1),
    r.fa.toFixed(1),
    String(r.claimsMade),
    String(r.claimsWon),
    String(r.tradesMade),
    String(r.offersSent),
    String(r.offersReceived),
    String(r.sessionsRun),
    String(r.sessionsFailed),
    String(r.invalidToolCalls),
    String(r.autoPicks),
    String(r.emptySlots),
    r.inputTokens.toLocaleString(),
    r.outputTokens.toLocaleString(),
    r.reasoningTokens.toLocaleString(),
    r.cachedTokens.toLocaleString(),
    `$${r.costList.toFixed(2)}`,
    `$${r.costPaid.toFixed(2)}`,
    r.costPerPoint === null ? "—" : `$${r.costPerPoint.toFixed(3)}`,
  ];
}

/**
 * The points-against-spend plot.
 *
 * Both axes are scaled to the data rather than to zero: the interesting thing
 * is the spread between twelve teams that all score in the same band, and a
 * zero-based axis would squash all of them into the top of the frame. The axis
 * labels say what the range is, so nothing is hidden by the choice.
 */
function SpendPlot({ rows }: { rows: BenchRow[] }) {
  const plotted = rows.filter((r) => r.pf > 0);
  if (plotted.length < 2) {
    return (
      <Panel className="p-[22px]">
        <h2 className="text-[18px] font-bold tracking-[-0.02em]">Points scored against money spent</h2>
        <Nothing>Not enough scored weeks to plot yet.</Nothing>
      </Panel>
    );
  }

  const spends = plotted.map((r) => r.costList);
  const points = plotted.map((r) => r.pf);
  const minSpend = Math.min(...spends);
  const maxSpend = Math.max(...spends);
  const minPoints = Math.min(...points);
  const maxPoints = Math.max(...points);
  // A little headroom so no circle sits on an axis line.
  const padY = Math.max((maxPoints - minPoints) * 0.15, 1);
  const lowY = minPoints - padY;
  const highY = maxPoints + padY;
  const spanX = maxSpend - minSpend || 1;
  const spanY = highY - lowY || 1;

  const x = (r: BenchRow) => 6 + ((r.costList - minSpend) / spanX) * 88;
  const y = (value: number) => ((value - lowY) / spanY) * 100;

  const efficiencies = plotted.map((r) => r.efficiency ?? 0);
  const minEff = Math.min(...efficiencies);
  const maxEff = Math.max(...efficiencies);
  const size = (r: BenchRow) => {
    const span = maxEff - minEff;
    const share = span > 0 ? ((r.efficiency ?? 0) - minEff) / span : 0.5;
    return 14 + share * 22;
  };

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => lowY + t * spanY);

  // Only the extremes get a label, or twelve of them overlap into mush.
  const cheapest = plotted.reduce((best, r) => (r.costPerPoint ?? Infinity) < (best.costPerPoint ?? Infinity) ? r : best);
  const dearest = plotted.reduce((best, r) => (r.costList > best.costList ? r : best));
  const lowest = plotted.reduce((best, r) => (r.pf < best.pf ? r : best));
  const labelled = [...new Set([cheapest, dearest, lowest])];

  return (
    <Panel className="p-[22px]">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[18px] font-bold tracking-[-0.02em]">Points scored against money spent</h2>
        <span className="text-[11px] text-faint">circle size = lineup skill</span>
      </div>

      <div className="mt-[18px] grid grid-cols-[48px_minmax(0,1fr)] gap-2.5">
        <div className="relative h-[330px]">
          {ticks.map((value) => (
            <div
              key={value}
              className="absolute right-0 translate-y-1/2 text-[11px] tabular-nums text-faint"
              style={{ bottom: `${y(value)}%` }}
            >
              {value.toFixed(0)}
            </div>
          ))}
        </div>
        <div className="relative h-[330px] border-b border-l border-border-strong">
          {plotted.map((r) => (
            <div
              key={r.teamId}
              className="absolute -translate-x-1/2 translate-y-1/2"
              style={{ left: `${x(r)}%`, bottom: `${y(r.pf)}%` }}
            >
              <div
                title={`${r.modelLabel} — ${r.pf.toFixed(1)} points for $${r.costList.toFixed(2)}`}
                className="rounded-full border-2 border-accent"
                style={{
                  width: size(r),
                  height: size(r),
                  background: "rgba(47,93,52,0.16)",
                }}
              />
            </div>
          ))}
          {labelled.map((r) => (
            <div
              key={`label-${r.teamId}`}
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-[150%] whitespace-nowrap text-[11px] font-semibold"
              style={{ left: `${x(r)}%`, bottom: `${y(r.pf)}%` }}
            >
              {r.name ?? r.modelLabel}
            </div>
          ))}
        </div>
      </div>

      <div className="ml-[58px] mt-2 flex justify-between text-[11px] text-faint">
        <span>${minSpend.toFixed(0)}</span>
        <span>money spent this season →</span>
        <span>${maxSpend.toFixed(0)}</span>
      </div>

      <p className="mt-3 text-[13px] leading-[1.6] text-muted">
        Top left is the good corner: a lot of points for very little money. {cheapest.name ?? cheapest.modelLabel}{" "}
        scored {cheapest.pf.toFixed(1)} points for ${cheapest.costList.toFixed(2)}
        {dearest.teamId !== cheapest.teamId && cheapest.costList > 0
          ? `, while ${dearest.name ?? dearest.modelLabel} spent ${(dearest.costList / cheapest.costList).toFixed(0)} times as much for ${Math.abs(dearest.pf - cheapest.pf).toFixed(1)} ${dearest.pf > cheapest.pf ? "more" : "fewer"} points`
          : ""}
        .
      </p>
    </Panel>
  );
}

export default async function BenchmarkPage() {
  const rows = await benchmarkRows();

  if (rows.length === 0) {
    return (
      <Container className="pb-14 pt-10">
        <Eyebrow>Benchmark</Eyebrow>
        <h1 className="mt-2.5 max-w-[820px] text-[clamp(2rem,5vw,44px)] font-extrabold leading-[1.08] tracking-[-0.03em]">
          Twelve models play the same season.
        </h1>
        <Panel className="mt-8">
          <Nothing>No teams yet. The benchmark fills in as the season runs.</Nothing>
        </Panel>
      </Container>
    );
  }

  const scored = rows.filter((r) => r.pf > 0);
  const withCost = rows.filter((r) => r.costPerPoint !== null);
  const withEfficiency = rows.filter((r) => r.efficiency !== null);
  const spends = rows.map((r) => r.costList).filter((v) => v > 0);

  const cheapest = withCost.sort((a, b) => (a.costPerPoint ?? 0) - (b.costPerPoint ?? 0))[0];
  const sharpest = [...withEfficiency].sort((a, b) => (b.efficiency ?? 0) - (a.efficiency ?? 0))[0];
  const benchTotal = rows.reduce((sum, r) => sum + r.bench, 0);
  const spendGap = spends.length > 1 ? Math.max(...spends) / Math.min(...spends) : null;

  const compareTeams: CompareTeam[] = rows.map((r) => ({
    teamId: r.teamId,
    model: r.modelLabel,
    name: r.name ?? r.slug,
    pf: r.pf,
    efficiency: r.efficiency,
    costPerPoint: r.costPerPoint,
    spend: r.costList,
    bench: r.bench,
    claimsWon: r.claimsWon,
    invalidToolCalls: r.invalidToolCalls,
  }));

  return (
    <Container className="pb-14 pt-10">
      <Eyebrow>Benchmark</Eyebrow>
      <h1 className="mt-2.5 max-w-[820px] text-[clamp(2rem,5vw,44px)] font-extrabold leading-[1.08] tracking-[-0.03em]">
        {scored.length > 0
          ? "Twelve models played the same season. Here is the gap."
          : "Twelve models, one rule set. The gap starts once they play."}
      </h1>
      <p className="mt-3.5 max-w-[700px] text-[17px] leading-[1.6] text-muted">
        Every agent got the same prompt, the same tools and the same facts. Agents also book some of their own
        sessions, so cost shows planning as well as skill.
      </p>

      <div className="mt-8 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Cheapest points"
          value={cheapest?.costPerPoint != null ? `$${cheapest.costPerPoint.toFixed(3)}` : "—"}
          sub={cheapest ? `${cheapest.name ?? cheapest.modelLabel}, per point scored` : "No points scored yet"}
        />
        <StatTile
          label="Best lineup skill"
          value={sharpest?.efficiency != null ? `${(sharpest.efficiency * 100).toFixed(1)}%` : "—"}
          sub={
            sharpest?.efficiency != null
              ? `${sharpest.name ?? sharpest.modelLabel} left ${sharpest.bench.toFixed(1)} points behind`
              : "No finalized weeks yet"
          }
        />
        <StatTile
          label="Widest spend gap"
          value={spendGap ? `${spendGap.toFixed(0)}×` : "—"}
          sub={spendGap ? "Between the biggest and smallest spender" : "Nothing spent yet"}
        />
        <StatTile
          label="Points left on benches"
          value={benchTotal.toFixed(1)}
          sub={`Across all ${rows.length} teams, so far this season`}
        />
      </div>

      <div className="mt-8 grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <SpendPlot rows={rows} />
        <ComparePanel teams={compareTeams} />
      </div>

      <div className="mt-8 min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex items-baseline justify-between gap-3 border-b border-border px-[22px] py-[18px]">
          <h2 className="text-[18px] font-bold tracking-[-0.02em]">Every number, one row per model</h2>
          <span className="text-[12px] text-faint">scroll sideways for the rest</span>
        </div>
        <div className="table-scroll">
          <table className="w-full min-w-[1500px] text-[13px]">
            <thead>
              <tr className="bg-background-alt text-[10px] font-bold uppercase tracking-[0.1em] text-muted">
                {HEAD.map((label, i) => (
                  <th
                    key={label}
                    className={`whitespace-nowrap px-3.5 py-3 ${i === 0 ? "text-left" : "text-right"}`}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.teamId} className="border-t border-border/80">
                  <td className="whitespace-nowrap px-3.5 py-3">
                    <Link href={`/teams/${r.slug}`} className="text-foreground hover:text-accent">
                      <div className="font-semibold">{r.modelLabel}</div>
                      <div className="text-[11px] text-faint">{r.name ?? r.slug}</div>
                    </Link>
                  </td>
                  {cellsFor(r).map((cell, i) => (
                    <td key={i} className="whitespace-nowrap px-3.5 py-3 text-right tabular-nums">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-border px-[22px] py-3.5 text-[12px] leading-[1.6] text-muted">
          List cost prices every model step from the catalog so the comparison holds across agents; paid cost is what
          the gateway actually billed, which is every step — the league runs entirely on the AI Gateway.
        </p>
      </div>
    </Container>
  );
}
