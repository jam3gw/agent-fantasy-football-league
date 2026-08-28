import { desc, eq } from "drizzle-orm";
import { formatEt } from "@league/shared";
import { draftPicks, getSettings, sessions, teams } from "@league/engine";
import { Badge, Card, Cell, Empty, PageTitle, Row, Table } from "../../../components/ui";
import { db, leagueClock } from "../../../lib/db";
import { getDraft, snakeSlot } from "../../../lib/draft";
import {
  autoPickCount,
  drawDraftOrderAction,
  draftGateStatus,
  emergencyAutoPickAction,
  pauseDraftAction,
  resumeDraftAction,
  runOnboardingAction,
  startDraftAction,
} from "../../../lib/adminActions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Draft" };

export default async function AdminDraftPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string }>;
}) {
  const { msg } = await searchParams;
  const database = db();
  const clock = await leagueClock();
  const now = clock.now();

  const [settings, state, allTeams, picks, gate, autoPicks, onboarding] = await Promise.all([
    getSettings(database).catch(() => null),
    getDraft(database).catch(() => undefined),
    database.select().from(teams).orderBy(teams.id).catch(() => []),
    database.select().from(draftPicks).orderBy(desc(draftPicks.pickNo)).limit(12).catch(() => []),
    draftGateStatus().catch(() => ({ ranked: 0, unmatchedTop200: 0, ok: false })),
    autoPickCount().catch(() => 0),
    database.select().from(sessions).where(eq(sessions.kind, "onboarding")).catch(() => []),
  ]);

  const order = state?.order ?? [];
  const teamName = (id: number) => allTeams.find((t) => t.id === id)?.name ?? `Team ${id}`;
  const totalPicks = (settings?.draftRounds ?? 14) * Math.max(1, order.length);
  const onClock =
    state?.currentPick && order.length > 0 ? order[snakeSlot(state.currentPick, order.length).orderIndex]! : null;
  const secondsLeft = state?.clockEndsAt ? Math.max(0, Math.round((state.clockEndsAt.getTime() - now.getTime()) / 1000)) : null;
  const onboardingDone = onboarding.filter((s) => s.status === "succeeded").length;

  return (
    <>
      <PageTitle
        title="Draft"
        subtitle="Setup in order (§10.1): rankings, onboarding, draw the order, then start. Buttons only — the draft never waits for a person beyond a pause."
      />
      {msg ? <p className="mb-4 rounded-lg border border-accent/50 bg-accent-soft px-4 py-3 text-sm text-accent">{msg}</p> : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Stat label="Status" value={state?.status ?? "not started"} />
        <Stat label="Pick" value={state?.currentPick ? `${state.currentPick} of ${totalPicks}` : "—"} />
        <Stat label="On the clock" value={onClock ? teamName(onClock) : "—"} note={secondsLeft === null ? undefined : `${secondsLeft}s left`} />
        <Stat label="Auto-picks" value={String(autoPicks)} />
      </div>

      <div
        className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
          gate.ok ? "border-accent/50 bg-accent-soft text-accent" : "border-warn/50 text-warn"
        }`}
      >
        <strong>Rankings gate (§5.7):</strong> {gate.ranked} ranked (need 200), {gate.unmatchedTop200} unmatched in the top 200 (need 0).
        {gate.ok ? " Cleared." : " Resolve this on /admin/rankings before starting."}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="1 — Onboarding">
          <p className="mb-3 text-sm text-muted">
            One <span className="font-mono">onboarding</span> session per team: each names its team and writes its plan. Sessions are
            staggered a minute apart. Re-running is safe — the idempotency key means a team that already ran is skipped.
          </p>
          <p className="mb-3 text-sm">
            {onboardingDone} of {allTeams.length} teams have a succeeded onboarding session ({onboarding.length} created).
          </p>
          <form action={runOnboardingAction}>
            <button type="submit" className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-background hover:opacity-90">
              Run onboarding for all teams
            </button>
          </form>
        </Card>

        <Card title="2 — Draw the order">
          <p className="mb-3 text-sm text-muted">
            A random permutation, stored on the draft row and shown publicly. It can only be drawn before the draft starts.
          </p>
          {order.length === 0 ? (
            <Empty>No order drawn yet.</Empty>
          ) : (
            <ol className="mb-3 grid grid-cols-2 gap-x-4 text-sm sm:grid-cols-3">
              {order.map((id, i) => (
                <li key={id} className="py-0.5">
                  <span className="text-muted">{i + 1}.</span> {teamName(id)}
                </li>
              ))}
            </ol>
          )}
          <form action={drawDraftOrderAction}>
            <button
              type="submit"
              disabled={!!state && state.status !== "not_started"}
              className="rounded border border-border px-3 py-1.5 text-sm hover:border-accent hover:text-accent disabled:opacity-40"
            >
              {order.length === 0 ? "Draw the order" : "Redraw the order"}
            </button>
          </form>
        </Card>

        <Card title="3 — Run the draft">
          <div className="flex flex-wrap gap-2">
            <form action={startDraftAction}>
              <button
                type="submit"
                disabled={state?.status === "complete"}
                className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-40"
              >
                {state?.status === "running" ? "Continue running" : "Start the draft"}
              </button>
            </form>
            <form action={pauseDraftAction}>
              <button
                type="submit"
                disabled={state?.status !== "running"}
                className="rounded border border-border px-3 py-1.5 text-sm hover:border-warn hover:text-warn disabled:opacity-40"
              >
                Pause
              </button>
            </form>
            <form action={resumeDraftAction}>
              <button
                type="submit"
                disabled={state?.status !== "paused"}
                className="rounded border border-border px-3 py-1.5 text-sm hover:border-accent hover:text-accent disabled:opacity-40"
              >
                Resume
              </button>
            </form>
          </div>
          <p className="mt-3 text-xs text-muted">
            Start books the <span className="font-mono">draft.run</span> job; the next tick begins the durable draft workflow, which is
            far longer-lived than a single function (§4.1, §9.2). It resumes from <span className="font-mono">draft.current_pick</span>{" "}
            and skips picks already recorded, so nothing is ever duplicated. A pause stores the remaining clock and the resumed pick gets
            those seconds back (§10.2).
          </p>
          {state?.clockRemainingSeconds ? (
            <p className="mt-2 text-xs text-warn">Paused with {state.clockRemainingSeconds}s stored on pick {state.currentPick}.</p>
          ) : null}
        </Card>

        <Card title="Emergency auto-pick">
          <p className="mb-3 text-sm text-muted">
            Sets the flag the pick loop checks before each model step. The current session ends and the pick is made from the draft
            rankings with reason <span className="font-mono">auto-pick: commissioner</span> (§10.4).
          </p>
          <form action={emergencyAutoPickAction}>
            <button
              type="submit"
              disabled={state?.status !== "running"}
              className="rounded border border-border px-3 py-1.5 text-sm hover:border-danger hover:text-danger disabled:opacity-40"
            >
              Auto-pick the current selection
            </button>
          </form>
        </Card>
      </div>

      <div className="mt-4">
        <Card title="Last picks">
          {picks.length === 0 ? (
            <Empty>No picks yet.</Empty>
          ) : (
            <Table head={["#", "Round", "Team", "Player", "Made by", "When"]}>
              {picks.map((p) => (
                <Row key={p.pickNo}>
                  <Cell>{p.pickNo}</Cell>
                  <Cell align="right">{p.round}</Cell>
                  <Cell>{teamName(p.teamId)}</Cell>
                  <Cell>
                    <span className="font-mono text-xs">{p.playerId}</span>
                  </Cell>
                  <Cell>{p.madeBy === "autopick" ? <Badge tone="warn">autopick</Badge> : <Badge tone="accent">agent</Badge>}</Cell>
                  <Cell>{formatEt(p.pickedAt)}</Cell>
                </Row>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
      {note ? <div className="mt-1 text-xs text-muted">{note}</div> : null}
    </div>
  );
}
