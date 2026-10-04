/**
 * `/odds` — matchup odds from four methods, and how each has scored (SPEC
 * §11.1, §12.1). The numbers are stored by `odds.run`; the scoreboard is
 * computed on every render from finalized matchups, never stored.
 */
import Link from "next/link";
import type { OddsMethod } from "@league/engine";
import { latestWeekOdds, oddsScoreboard } from "@league/engine";
import { db } from "../../lib/db";
import { allTeams, settings } from "../../lib/queries";
import { Badge, Card, Cell, Empty, PageTitle, Row, Table, TeamLabel } from "../../components/ui";

// §12.1: 300s freshness, like the other pages that change a few times a week.
export const revalidate = 300;

const METHODS: Array<{ key: OddsMethod; label: string; note: string }> = [
  { key: "baseline", label: "Baseline", note: "Projections only; every starter plays." },
  { key: "rule", label: "Injury rule", note: "Questionable 80%, Doubtful 20%, Out 0%; the best healthy bench player fills in." },
  { key: "jev_composite", label: "Jev + math", note: "Jev judges each injured starter's chance to play; the league's math does the rest." },
  { key: "jev_direct", label: "Jev direct", note: "Jev reads both lineups, benches and form, and picks the winner itself." },
];

const SNAPSHOT_LABEL = { thu: "Thursday", sun: "Sunday" } as const;

const pct = (p: number | null | undefined) => (p === null || p === undefined ? "—" : `${Math.round(p * 100)}%`);
const three = (x: number | null) => (x === null ? "—" : x.toFixed(3));

function when(at: Date): string {
  return at.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function OddsPageInner() {
  const s = await settings();
  const [week, board, teams] = await Promise.all([
    latestWeekOdds(db(), s.season, s.currentWeek),
    oddsScoreboard(db(), s.season),
    allTeams(),
  ]);
  const team = (id: number) => teams.find((t) => t.id === id);
  const label = (id: number) => {
    const t = team(id);
    return <TeamLabel slug={t?.slug} name={t?.name ?? null} model={t?.modelLabel} />;
  };
  const shown = METHODS.filter((m) => week?.matchups.some((x) => x.methods[m.key]));

  return (
    <>
      <PageTitle
        title="Matchup odds"
        subtitle="Four ways to call each matchup, stored before the games and scored after them. Two use Jev, TypeSafe AI's decision model; two do not. The agents never see these numbers."
      />

      <div className="mb-4">
        <Card title="The four methods">
          <ul className="space-y-1.5 text-sm">
            {METHODS.map((m) => (
              <li key={m.key}>
                <span className="font-semibold">{m.label}.</span> <span className="text-muted">{m.note}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">
            Odds are taken Thursday at 9:30 AM ET and Sunday at 11:30 AM ET. Lower Brier score is better: 0.25 is a
            coin flip, 0 is perfect.
          </p>
        </Card>
      </div>

      <div className="mb-4">
        <Card
          title={`Week ${s.currentWeek}${week ? `, ${SNAPSHOT_LABEL[week.run.snapshot]} odds` : ""}`}
          action={week ? <span className="text-xs text-muted">{when(week.run.createdAt)} ET</span> : undefined}
        >
          {!week ? (
            <Empty>No odds for this week yet. The first snapshot is Thursday at 9:30 AM ET.</Empty>
          ) : (
            <>
              {week.run.status === "partial" ? (
                <p className="mb-3 text-xs text-muted">
                  <Badge tone="warn">Jev unavailable</Badge> Only the baseline and the injury rule ran for this
                  snapshot.
                </p>
              ) : null}
              <Table head={["Home", "Away", ...shown.map((m) => `${m.label} (home)`)]}>
                {week.matchups.map((m) => (
                  <Row key={m.matchupId}>
                    <Cell>{label(m.homeTeamId)}</Cell>
                    <Cell>{label(m.awayTeamId)}</Cell>
                    {shown.map((meth) => (
                      <Cell key={meth.key} align="right">
                        {pct(m.methods[meth.key]?.homeWinProb)}
                      </Cell>
                    ))}
                  </Row>
                ))}
              </Table>
              {week.players.length > 0 ? (
                <div className="mt-4">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                    Injured starters: chance to play
                  </h3>
                  <Table head={["Player", "Team", "Status", "Rule", "Jev"]}>
                    {week.players.map((p) => (
                      <Row key={p.playerId}>
                        <Cell>
                          <Link href={`/players/${p.playerId}`} className="hover:text-accent">
                            {p.name}
                          </Link>
                        </Cell>
                        <Cell>{label(p.teamId)}</Cell>
                        <Cell>{p.injuryStatus ?? "—"}</Cell>
                        <Cell align="right">{pct(p.ruleProb)}</Cell>
                        <Cell align="right">{pct(p.jevProb)}</Cell>
                      </Row>
                    ))}
                  </Table>
                </div>
              ) : null}
            </>
          )}
        </Card>
      </div>

      <Card title="Season scoreboard">
        {board.matchups.length === 0 ? (
          <Empty>Nothing to score yet. Scores appear once a week with odds is final.</Empty>
        ) : (
          <>
            <Table head={["Method", "Snapshot", "Matchups", "Brier", "Right side"]}>
              {board.matchups.map((b) => (
                <Row key={`${b.method}-${b.snapshot}`}>
                  <Cell>{METHODS.find((m) => m.key === b.method)?.label ?? b.method}</Cell>
                  <Cell>{SNAPSHOT_LABEL[b.snapshot]}</Cell>
                  <Cell align="right">{b.n}</Cell>
                  <Cell align="right">{three(b.brier)}</Cell>
                  <Cell align="right">{pct(b.hitRate)}</Cell>
                </Row>
              ))}
            </Table>
            {board.players.length > 0 ? (
              <div className="mt-4">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                  Did the injured starter play? Rule versus Jev
                </h3>
                <Table head={["Snapshot", "Players", "Rule Brier", "Jev Brier"]}>
                  {board.players.map((b) => (
                    <Row key={b.snapshot}>
                      <Cell>{SNAPSHOT_LABEL[b.snapshot]}</Cell>
                      <Cell align="right">{b.n}</Cell>
                      <Cell align="right">{three(b.ruleBrier)}</Cell>
                      <Cell align="right">{three(b.jevBrier)}</Cell>
                    </Row>
                  ))}
                </Table>
              </div>
            ) : null}
            <p className="mt-3 text-xs text-muted">Weeks scored: {board.weeks.join(", ")}.</p>
          </>
        )}
      </Card>
    </>
  );
}

/**
 * __renderGuarded: pages use ISR, so Next prerenders them at build time. A
 * database that is unreachable or still empty must not fail the deploy, and a
 * blip at request time must not take down a public page.
 */
export default async function OddsPage() {
  try {
    return await OddsPageInner();
  } catch (error) {
    console.error("[odds] render failed", error instanceof Error ? error.message : error);
    return (
      <>
        <PageTitle title="Matchup odds" />
        <Card>
          <Empty>This page could not load its data. It will refresh on its own.</Empty>
        </Card>
      </>
    );
  }
}
