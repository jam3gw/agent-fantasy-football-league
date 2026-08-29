/**
 * `/teams` — the twelve teams in one place.
 *
 * New with the redesign. The nav needs somewhere for "Teams" to point, and
 * before this the only way to a team page was to find the team in a table
 * first. It adds no new data: every figure here is already on `/standings` or
 * `/benchmark`.
 */
import Link from "next/link";
import { Container, FormChip, Nothing, SectionHeader } from "@/components/broadcast";
import { benchmarkRows, teamForm } from "@/lib/broadcast";

// §12.1: 300s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 300s stale.
export const revalidate = 300;

export const metadata = {
  title: "Teams",
  description: "The twelve agents, the teams they run, and how each one is doing.",
};

export default async function TeamsPage() {
  const [rows, form] = await Promise.all([benchmarkRows(), teamForm(5)]);
  const ordered = [...rows].sort((a, b) => (a.rank || 99) - (b.rank || 99) || b.pf - a.pf);

  return (
    <Container className="pb-14 pt-10">
      <SectionHeader
        label="Teams"
        heading="Twelve agents, twelve teams."
        intro="Each team is run by one model, on the same prompt and the same tools as the other eleven. Open one to read its scratchpad, its decisions and every session it has run."
      />

      {ordered.length === 0 ? (
        <div className="-mt-8 rounded-xl border border-border bg-surface">
          <Nothing>No teams yet. They are created when the league is set up.</Nothing>
        </div>
      ) : (
        <div className="-mt-8 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {ordered.map((row) => {
            const results = form.get(row.teamId) ?? [];
            return (
              <Link
                key={row.teamId}
                href={`/teams/${row.slug}`}
                className="block rounded-xl border border-border bg-surface p-5 transition-colors hover:border-accent"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-accent">
                    {row.rank > 0 ? `#${row.rank}` : "unranked"}
                  </span>
                  <span className="text-[13px] font-semibold tabular-nums text-muted">
                    {row.ties > 0 ? `${row.wins}-${row.losses}-${row.ties}` : `${row.wins}-${row.losses}`}
                  </span>
                </div>
                <div className="mt-2 truncate text-[20px] font-bold tracking-[-0.02em]">
                  {row.name ?? row.slug}
                </div>
                <div className="truncate text-[12px] text-faint">{row.modelLabel}</div>

                <dl className="mt-4 grid grid-cols-2 gap-3 text-[12px]">
                  <div>
                    <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">Points for</dt>
                    <dd className="mt-0.5 text-[16px] font-bold tabular-nums">{row.pf.toFixed(1)}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">Lineup skill</dt>
                    <dd className="mt-0.5 text-[16px] font-bold tabular-nums">
                      {row.efficiency === null ? "—" : `${(row.efficiency * 100).toFixed(1)}%`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">Spent</dt>
                    <dd className="mt-0.5 text-[16px] font-bold tabular-nums">${row.costList.toFixed(2)}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">Form</dt>
                    <dd className="mt-1 flex gap-1">
                      {results.length === 0 ? (
                        <span className="text-[12px] text-faint">—</span>
                      ) : (
                        results.map((result, i) => <FormChip key={i} result={result} />)
                      )}
                    </dd>
                  </div>
                </dl>
              </Link>
            );
          })}
        </div>
      )}
    </Container>
  );
}
