import { and, desc, eq } from "drizzle-orm";
import { getSettings, matchups, playerWeekStats, scoringDiscrepancies } from "@league/engine";
import { Badge, Card, Cell, Empty, PageTitle, Row, Table, points } from "../../../components/ui";
import { db } from "../../../lib/db";
import { correctPlayerPointsAction, refinalizeWeekAction } from "../../../lib/adminActions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Scores" };

const SOURCE_LABEL: Record<string, string> = {
  sleeper: "Sleeper pts_ppr",
  fantasypros: "FantasyPros PPR",
  nflverse: "nflverse + scoring_settings",
  none: "no source reached",
};

export default async function AdminScoresPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; week?: string }>;
}) {
  const { msg, week: weekParam } = await searchParams;
  const database = db();
  const settings = await getSettings(database).catch(() => null);
  const currentWeek = settings?.currentWeek ?? 1;
  const season = settings?.season ?? 0;
  const selectedWeek = Number(weekParam ?? Math.max(1, currentWeek - 1)) || 1;

  const sources = ((settings?.extra as { weekScoringSources?: Record<string, string> } | undefined)
    ?.weekScoringSources ?? {}) as Record<string, string>;

  const finalWeeks = await database
    .select({ week: matchups.week, final: matchups.final })
    .from(matchups)
    .catch(() => []);
  const weeksSeen = new Set<number>([...Object.keys(sources).map(Number), ...finalWeeks.map((m) => m.week)]);
  const weeks = [...weeksSeen].filter((w) => Number.isFinite(w)).sort((a, b) => a - b);
  const finalizedWeeks = new Set(finalWeeks.filter((m) => m.final).map((m) => m.week));

  const weekRows = await database
    .select()
    .from(playerWeekStats)
    .where(and(eq(playerWeekStats.season, season), eq(playerWeekStats.week, selectedWeek)))
    .catch(() => []);
  const recentDiscrepancies = await database
    .select()
    .from(scoringDiscrepancies)
    .orderBy(desc(scoringDiscrepancies.createdAt))
    .limit(10)
    .catch(() => []);

  return (
    <>
      <PageTitle
        title="Scores"
        subtitle="Which source scored each week, re-running finalization, and a single-player correction for an engine bug. No file uploads, ever."
      />
      {msg ? <p className="mb-4 rounded-lg border border-accent/50 bg-accent-soft px-4 py-3 text-sm text-accent">{msg}</p> : null}

      <Card title="Scoring source by week (§13.4)">
        {weeks.length === 0 ? (
          <Empty>No week has been scored yet.</Empty>
        ) : (
          <Table head={["Week", "Source", "State"]}>
            {weeks.map((w) => {
              const src = sources[String(w)] ?? null;
              return (
                <Row key={w}>
                  <Cell>Week {w}</Cell>
                  <Cell>
                    {src ? (
                      <Badge tone={src === "sleeper" ? "accent" : "warn"}>{SOURCE_LABEL[src] ?? src}</Badge>
                    ) : (
                      <span className="text-muted">not recorded</span>
                    )}
                  </Cell>
                  <Cell>{finalizedWeeks.has(w) ? "final" : "open"}</Cell>
                </Row>
              );
            })}
          </Table>
        )}
        <p className="mt-3 text-xs text-muted">
          The engine walks the ladder on its own and never waits for a person. A week scored by anything other than Sleeper is flagged on
          the public matchup page.
        </p>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Re-run finalization">
          <form action={refinalizeWeekAction} className="space-y-3 text-sm">
            <label className="block">
              <span className="mb-1 block text-muted">Week</span>
              <input
                name="week"
                type="number"
                min={1}
                max={18}
                defaultValue={Math.max(1, currentWeek - 1)}
                required
                className="w-full rounded border border-border bg-background px-2 py-1.5"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-muted">Source</span>
              <select name="source" defaultValue="auto" className="w-full rounded border border-border bg-background px-2 py-1.5">
                <option value="auto">auto — walk the §13.4 ladder</option>
                <option value="sleeper">sleeper — pts_ppr</option>
                <option value="fantasypros">fantasypros — PPR player-points</option>
                <option value="nflverse">nflverse — scored through scoring_settings (no D/ST)</option>
              </select>
            </label>
            <button type="submit" className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-background hover:opacity-90">
              Re-finalize
            </button>
            <p className="text-xs text-muted">
              Intended for a feed that recovers later the same day, before Tuesday 9:00 AM ET. After the first agent sessions the week
              stays as scored (§13.4). Re-finalizing an older week never rewinds <span className="font-mono">current_week</span>.
            </p>
          </form>
        </Card>

        <Card title="Correct one player's points">
          <form action={correctPlayerPointsAction} className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-muted">Week</span>
                <input
                  name="week"
                  type="number"
                  min={1}
                  max={18}
                  defaultValue={selectedWeek}
                  required
                  className="w-full rounded border border-border bg-background px-2 py-1.5"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-muted">Points</span>
                <input
                  name="points"
                  type="number"
                  step="0.01"
                  required
                  className="w-full rounded border border-border bg-background px-2 py-1.5"
                />
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-muted">Sleeper player id</span>
              <input
                name="playerId"
                required
                className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs"
                placeholder="e.g. 4034 or SF"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-muted">Reason (required, public)</span>
              <input name="reason" required minLength={3} className="w-full rounded border border-border bg-background px-2 py-1.5" />
            </label>
            <button type="submit" className="rounded border border-border px-3 py-1.5 text-sm hover:border-warn hover:text-warn">
              Correct points
            </button>
            <p className="text-xs text-muted">
              For an engine bug only. The league does not apply NFL stat corrections (§2: scores finalize Tuesday 4:00 AM ET, no later
              corrections). Matchups, winners and team_week_results are recomputed for that week.
            </p>
          </form>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title={`Week ${selectedWeek} — highest scores on record`}>
          {weekRows.length === 0 ? (
            <Empty>No stats stored for week {selectedWeek}.</Empty>
          ) : (
            <Table head={["Player id", "pts_ppr", "engine", "source", "final"]}>
              {weekRows
                .slice()
                .sort((a, b) => (b.ptsPpr ?? 0) - (a.ptsPpr ?? 0))
                .slice(0, 15)
                .map((r) => (
                  <Row key={r.playerId}>
                    <Cell>
                      <span className="font-mono text-xs">{r.playerId}</span>
                    </Cell>
                    <Cell align="right">{points(r.ptsPpr)}</Cell>
                    <Cell align="right">{points(r.enginePts)}</Cell>
                    <Cell>{r.source}</Cell>
                    <Cell>{r.final ? "yes" : "no"}</Cell>
                  </Row>
                ))}
            </Table>
          )}
          <p className="mt-3 text-xs text-muted">{weekRows.length} player rows stored for week {selectedWeek}.</p>
        </Card>

        <Card title="Recent scoring discrepancies">
          {recentDiscrepancies.length === 0 ? (
            <Empty>None logged.</Empty>
          ) : (
            <Table head={["Player id", "Week", "pts_ppr", "engine", "diff"]}>
              {recentDiscrepancies.map((d) => (
                <Row key={d.id}>
                  <Cell>
                    <span className="font-mono text-xs">{d.playerId}</span>
                  </Cell>
                  <Cell align="right">{d.week}</Cell>
                  <Cell align="right">{points(d.ptsPpr)}</Cell>
                  <Cell align="right">{points(d.enginePts)}</Cell>
                  <Cell align="right">{points(d.diff)}</Cell>
                </Row>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
