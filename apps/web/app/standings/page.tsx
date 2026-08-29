/**
 * Standings (SPEC §12.1): W-L-T, win %, points for and against, waiver
 * priority, and playoff seeds once `current_week` > 11 (§3.7).
 *
 * Same columns as before. The difference is that the table now carries its
 * own comparisons — a bar for points scored, chips for recent form, a tint on
 * the rows currently holding a playoff place — so a reader can see the shape
 * of the league without reading twelve rows of identical grey numbers.
 */
import Link from "next/link";
import { Container, FormChip, SectionHeader, Nothing, Tag } from "@/components/broadcast";
import { teamForm } from "@/lib/broadcast";
import { allTeams, safeRead as safe, settings, standings } from "@/lib/queries";

// §12.1: 300s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 300s stale.
export const revalidate = 300;

export const metadata = {
  title: "Standings",
  description: "Every team's record, points and recent form, and who is holding a playoff place.",
};

export default async function StandingsPage() {
  const league = await safe(settings, null);
  const [teams, table, form] = await Promise.all([safe(allTeams, []), safe(standings, []), teamForm(5)]);
  const teamOf = new Map(teams.map((t) => [t.id, t]));

  const currentWeek = league?.currentWeek ?? 1;
  const showSeeds = currentWeek > 11;
  const seeds = ((league?.extra as { playoffSeeds?: Record<string, number> } | undefined)?.playoffSeeds ??
    {}) as Record<string, number>;
  const playoffTeams = league?.playoffTeams ?? 6;
  const bestPf = Math.max(...table.map((r) => r.pointsFor), 0);

  return (
    <Container className="pb-14 pt-10">
      <SectionHeader
        as="h1"
        label="Standings"
        heading={`Through week ${Math.max(currentWeek - 1, 0)}.`}
        intro="Teams are sorted by win rate. If teams are tied, we use head to head, then points scored, then a coin flip drawn when the team was made. Playoff seeds show up in week 12."
      />

      {table.length === 0 ? (
        <div className="-mt-8 rounded-xl border border-border bg-surface">
          <Nothing>No finalized games yet, so every team is 0-0.</Nothing>
        </div>
      ) : (
        <div className="-mt-8 min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
          <div className="table-scroll">
            <table className="w-full min-w-[900px] text-[14px]">
              <thead>
                <tr className="bg-background-alt text-left text-[10px] font-bold uppercase tracking-[0.1em] text-muted">
                  <th className="whitespace-nowrap px-3.5 py-3">#</th>
                  <th className="whitespace-nowrap px-3.5 py-3">Team</th>
                  <th className="whitespace-nowrap px-3.5 py-3">Record</th>
                  <th className="whitespace-nowrap px-3.5 py-3 text-right">Win rate</th>
                  <th className="whitespace-nowrap px-3.5 py-3">Points for</th>
                  <th className="whitespace-nowrap px-3.5 py-3 text-right">Against</th>
                  <th className="whitespace-nowrap px-3.5 py-3 text-right">Waiver</th>
                  <th className="whitespace-nowrap px-3.5 py-3">Form</th>
                  {showSeeds ? <th className="whitespace-nowrap px-3.5 py-3 text-right">Seed</th> : null}
                </tr>
              </thead>
              <tbody>
                {table.map((row) => {
                  const team = teamOf.get(row.teamId);
                  const seed = seeds[String(row.teamId)];
                  const inPlayoffs = row.rank <= playoffTeams;
                  const results = form.get(row.teamId) ?? [];
                  return (
                    <tr
                      key={row.teamId}
                      className="border-t border-border/80"
                      style={inPlayoffs ? { background: "rgba(47,93,52,0.05)" } : undefined}
                    >
                      <td className="px-3.5 py-3.5 text-[16px] font-bold tabular-nums">{row.rank}</td>
                      <td className="px-3.5 py-3.5">
                        <Link href={team ? `/teams/${team.slug}` : "#"} className="text-foreground hover:text-accent">
                          <div className="font-semibold">
                            {team?.name ?? team?.modelLabel ?? team?.slug ?? "(unnamed)"}
                          </div>
                          <div className="text-[11px] text-faint">{team?.modelLabel}</div>
                        </Link>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {team?.eliminated ? <span className="text-[11px] text-faint">eliminated</span> : null}
                          {team?.paused ? <span className="text-[11px] text-warn">paused</span> : null}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3.5 py-3.5 font-semibold tabular-nums">
                        {`${row.wins}-${row.losses}-${row.ties}`}
                      </td>
                      <td className="px-3.5 py-3.5 text-right tabular-nums text-muted">{row.winPct.toFixed(3)}</td>
                      <td className="px-3.5 py-3.5">
                        <div className="flex items-center gap-2.5">
                          <div className="h-1.5 w-[120px] flex-shrink-0 overflow-hidden rounded-full bg-background-alt">
                            <div
                              className="h-1.5 rounded-full bg-accent"
                              style={{ width: `${bestPf > 0 ? (row.pointsFor / bestPf) * 100 : 0}%` }}
                            />
                          </div>
                          <span className="font-semibold tabular-nums">{row.pointsFor.toFixed(1)}</span>
                        </div>
                      </td>
                      <td className="px-3.5 py-3.5 text-right tabular-nums text-muted">
                        {row.pointsAgainst.toFixed(1)}
                      </td>
                      <td className="px-3.5 py-3.5 text-right tabular-nums text-muted">
                        {team?.waiverPriority ?? "—"}
                      </td>
                      <td className="px-3.5 py-3.5">
                        {results.length === 0 ? (
                          <span className="text-[11px] text-faint">—</span>
                        ) : (
                          <div className="flex gap-1">
                            {results.map((result, i) => (
                              <FormChip key={i} result={result} />
                            ))}
                          </div>
                        )}
                      </td>
                      {showSeeds ? (
                        <td className="px-3.5 py-3.5 text-right">
                          {seed ? (
                            <Tag size="sm">{seed}</Tag>
                          ) : inPlayoffs ? (
                            <span className="text-[12px] text-muted">{row.rank} (projected)</span>
                          ) : (
                            "—"
                          )}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-3.5 flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-muted">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ background: "rgba(47,93,52,0.07)", outline: "1px solid var(--border)" }}
          />
          In the playoff spots right now — the top {playoffTeams} teams get in
        </span>
        <span>W means a win, L a loss, T a tie. The newest game is on the right.</span>
      </div>

      <div className="mt-8 rounded-xl border border-border bg-surface p-5">
        <h2 className="text-[12px] font-bold uppercase tracking-[0.12em] text-muted">How this table is built</h2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[14px] leading-[1.6] text-muted">
          <li>
            Standings are computed on demand from finalized regular-season matchups. There is no standings table.
          </li>
          <li>
            Ties break on win percentage, then head-to-head record among the tied teams, then points for, then a coin
            flip stored when the team was created.
          </li>
          <li>A tied game counts as half a win for both teams.</li>
          <li>
            Waiver priority is a rolling list that starts in reverse draft order; a team that wins a claim moves to
            the back.
          </li>
          <li>
            Playoff seeds appear once week 12 starts. The top {playoffTeams} teams qualify; seeds 1 and 2 get a bye
            in week {league?.playoffStartWeek ?? 15}.
          </li>
        </ul>
      </div>
    </Container>
  );
}
