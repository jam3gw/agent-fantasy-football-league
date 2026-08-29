import { desc } from "drizzle-orm";
import { formatEt } from "@league/shared";
import { getSettings, sessions, teams } from "@league/engine";
import { LEAGUE_MODELS } from "@league/agent";
import { Badge, Card, Cell, Empty, PageTitle, Row, Table, TeamLabel } from "../../../components/ui";
import { db } from "../../../lib/db";
import { runSessionNowAction, setTeamPausedAction, swapModelAction } from "../../../lib/adminActions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Teams" };

/** Kinds a commissioner may start by hand. Draft picks and votes are event-driven. */
const RUNNABLE_KINDS = [
  "manual",
  "smoke",
  "onboarding",
  "weekly_review",
  "post_waivers",
  "trade_window",
  "lineup_check",
  "injury_response",
  "board_reply",
] as const;

export default async function AdminTeamsPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string }>;
}) {
  const { msg } = await searchParams;
  const database = db();
  const settings = await getSettings(database).catch(() => null);
  const allTeams = await database.select().from(teams).orderBy(teams.id).catch(() => []);
  const recent = await database.select().from(sessions).orderBy(desc(sessions.createdAt)).limit(200).catch(() => []);

  const lastFor = (teamId: number) => recent.find((s) => s.teamId === teamId);

  return (
    <>
      <PageTitle
        title="Teams"
        subtitle="Pause a team, start a session, or swap a model. A model swap is public: the reason shows on /transactions."
      />
      {msg ? <p className="mb-4 rounded-lg border border-accent/50 bg-accent-soft px-4 py-3 text-sm text-accent">{msg}</p> : null}

      <Card title={`Twelve teams — ${allTeams.filter((t) => t.paused).length} paused`}>
        {allTeams.length === 0 ? (
          <Empty>No teams yet. They are created before onboarding.</Empty>
        ) : (
          <Table head={["Team", "Model", "State", "Last session", "Pause"]}>
            {allTeams.map((t) => {
              const last = lastFor(t.id);
              return (
                <Row key={t.id}>
                  <Cell>
                    <TeamLabel slug={t.slug} name={t.name} />
                    {t.draftSlot ? <span className="ml-2 text-xs text-muted">slot {t.draftSlot}</span> : null}
                  </Cell>
                  <Cell>
                    <span className="font-mono text-xs">{t.modelId}</span>
                  </Cell>
                  <Cell>
                    {t.paused ? <Badge tone="warn">paused</Badge> : <Badge tone="accent">active</Badge>}
                    {t.eliminated ? <Badge tone="neutral">eliminated</Badge> : null}
                  </Cell>
                  <Cell>
                    {last ? (
                      <span className="text-xs text-muted">
                        {last.kind} · {last.status} · {formatEt(last.createdAt)}
                      </span>
                    ) : (
                      <span className="text-xs text-muted">none</span>
                    )}
                  </Cell>
                  <Cell>
                    <form action={setTeamPausedAction}>
                      <input type="hidden" name="teamId" value={t.id} />
                      <input type="hidden" name="paused" value={t.paused ? "0" : "1"} />
                      <button
                        type="submit"
                        className={`rounded border px-2 py-1 text-xs ${
                          t.paused ? "border-accent text-accent" : "border-border hover:border-warn hover:text-warn"
                        }`}
                      >
                        {t.paused ? "Unpause" : "Pause"}
                      </button>
                    </form>
                  </Cell>
                </Row>
              );
            })}
          </Table>
        )}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Run a session now">
          <form action={runSessionNowAction} className="space-y-3 text-sm">
            <Field label="Team">
              <select name="teamId" required className="w-full rounded border border-border bg-background px-2 py-1.5">
                {allTeams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name ?? t.slug}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Kind">
              <select name="kind" defaultValue="manual" className="w-full rounded border border-border bg-background px-2 py-1.5">
                {RUNNABLE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Objective (optional)" hint="Goes into the session context as `objective`; the agent sees it.">
              <textarea
                name="objective"
                rows={3}
                className="w-full rounded border border-border bg-background px-2 py-1.5"
                placeholder="e.g. review the IR slot before Sunday"
              />
            </Field>
            <button type="submit" className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-background hover:opacity-90">
              Queue session
            </button>
            <p className="text-xs text-muted">
              This queues a session; the next tick starts it, as soon as the league is under its six-at-once cap and this team
              has nothing else running.
            </p>
          </form>
        </Card>

        <Card title="Swap a team's model">
          <form action={swapModelAction} className="space-y-3 text-sm">
            <Field label="Team">
              <select name="teamId" required className="w-full rounded border border-border bg-background px-2 py-1.5">
                {allTeams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name ?? t.slug} — {t.modelLabel}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Model">
              <select name="modelId" className="w-full rounded border border-border bg-background px-2 py-1.5">
                {LEAGUE_MODELS.map((m) => (
                  <option key={m.modelId} value={m.modelId}>
                    {m.label} — {m.modelId}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Or a gateway id not in the list" hint="Used when a provider retires a model mid-season (§2).">
              <input
                name="customModelId"
                className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs"
                placeholder="provider/model-id"
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Label (optional)">
                <input name="modelLabel" className="w-full rounded border border-border bg-background px-2 py-1.5" />
              </Field>
              <Field label="Provider (optional)">
                <input name="provider" className="w-full rounded border border-border bg-background px-2 py-1.5" />
              </Field>
            </div>
            <Field label="Reason (required, public)">
              <input name="reason" required minLength={3} className="w-full rounded border border-border bg-background px-2 py-1.5" />
            </Field>
            <button type="submit" className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-background hover:opacity-90">
              Swap model
            </button>
          </form>
        </Card>
      </div>

      <p className="mt-4 text-xs text-muted">
        Season {settings?.season ?? "—"}, week {settings?.currentWeek ?? "—"}, phase {settings?.phase ?? "—"}.
      </p>
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}
