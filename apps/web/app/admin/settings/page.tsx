import { costAlarmRules, getSettings, reporterModelId, toolCosts, tradeWindowDays, DEFAULT_SESSION_GUARDS } from "@league/engine";
import { Badge, Card, Cell, Empty, PageTitle, Row, Table } from "../../../components/ui";
import { db } from "../../../lib/db";
import {
  saveAlarmRulesAction,
  savePauseAgentAtAction,
  saveSettingsAction,
  saveToolCostsAction,
  seedAlarmRulesAction,
} from "../../../lib/adminActions";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

const SCOPE_NOTE: Record<string, string> = {
  session: "while a session runs, once per multiple of the step",
  agent_day: "once per agent per ET day",
  agent_week: "once per agent per fantasy week",
  agent_season: "once per agent per step",
  league_day: "once per ET day",
  league_season: "once per step",
};

export default async function AdminSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string }>;
}) {
  const { msg } = await searchParams;
  const database = db();
  const settings = await getSettings(database).catch(() => null);
  const rules = await database.select().from(costAlarmRules).orderBy(costAlarmRules.id).catch(() => []);
  const tools = await database.select().from(toolCosts).orderBy(toolCosts.toolName).catch(() => []);

  if (!settings) {
    return (
      <>
        <PageTitle title="Settings" />
        <Card>
          <Empty>The league_settings row does not exist yet, so there is nothing to edit.</Empty>
        </Card>
      </>
    );
  }

  const extra = settings.extra as Record<string, unknown>;
  const structureLocked = settings.phase !== "pre_draft";
  const guards = { ...DEFAULT_SESSION_GUARDS, ...((extra.sessionGuards as Record<string, unknown>) ?? {}) };
  const pauseAt = extra.pause_agent_at_usd;
  const reporterModel = reporterModelId(settings);
  const draftScheduledAt = (settings.extra as Record<string, unknown>).draftScheduledAt;
  // datetime-local wants ET wall-clock, no zone suffix.
  const draftScheduledLocal =
    typeof draftScheduledAt === "string" && !Number.isNaN(Date.parse(draftScheduledAt))
      ? new Date(draftScheduledAt).toLocaleString("sv-SE", { timeZone: "America/New_York" }).slice(0, 16).replace(" ", "T")
      : "";
  const tradeNotesOn = extra.reporterTradeNotes !== false;

  return (
    <>
      <PageTitle
        title="Settings"
        subtitle="Only the §2 items marked default are editable. Fixed decisions are not settings, and roster and scoring freeze once the draft starts."
      />
      {msg ? <p className="mb-4 rounded-lg border border-accent/50 bg-accent-soft px-4 py-3 text-sm text-accent">{msg}</p> : null}

      <Card title="League settings">
        <form action={saveSettingsAction} className="space-y-5 text-sm">
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Waivers</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Num name="waiverClearHours" label="Waiver clear hours" value={settings.waiverClearHours} />
              <Text name="waiverRunTimeEt" label="Waiver run time (ET, HH:MM)" value={settings.waiverRunTimeEt} />
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Trades</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Num name="tradeReviewHours" label="Review hours" value={settings.tradeReviewHours} />
              <Num name="tradeVetoVotes" label="Veto votes needed" value={settings.tradeVetoVotes} />
              <Num name="tradeMaxOffersPerDay" label="Offers per team per day" value={settings.tradeMaxOffersPerDay} />
              <Num name="tradeOfferExpiryHours" label="Offer expiry hours" value={settings.tradeOfferExpiryHours} />
              <Num name="tradeDeadlineWeek" label="Deadline week" value={settings.tradeDeadlineWeek} />
              <label className="block">
                <span className="mb-1 block text-muted">Trade window days</span>
                <input
                  name="tradeWindowDays"
                  defaultValue={tradeWindowDays(settings).map((d) => WEEKDAY[d]).join(", ")}
                  className="w-full rounded border border-border bg-background px-2 py-1.5"
                />
                <span className="mt-1 block text-xs text-muted">
                  Comma separated weekdays; a session per team at noon ET on each. Two since 2026-09-05 (§2).
                </span>
              </label>
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Draft</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Num name="draftClockSeconds" label="Draft clock (seconds)" value={settings.draftClockSeconds} />
              <Num name="draftRounds" label="Draft rounds" value={settings.draftRounds} />
              <label className="block">
                <span className="mb-1 block text-muted">Draft scheduled for (ET)</span>
                <input
                  type="datetime-local"
                  name="draftScheduledEt"
                  defaultValue={draftScheduledLocal}
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
                />
                <span className="mt-1 block text-xs text-muted">
                  Shown to every agent before the draft so they can plan onboarding and check-ins around it. Informational —
                  the draft still starts from /admin/draft. Blank means &ldquo;not scheduled yet&rdquo;.
                </span>
              </label>
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Reporter (§11)</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-muted">Reporter model (gateway id)</span>
                <input
                  name="reporterModelId"
                  defaultValue={reporterModel}
                  className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs"
                />
                <span className="mt-1 block text-xs text-muted">
                  Checked against the gateway catalog before it is saved. This is the only way to move the reporter off a
                  retired model without a deploy.
                </span>
              </label>
              <label className="flex items-start gap-2 pt-6">
                <input type="checkbox" name="reporterTradeNotes" defaultChecked={tradeNotesOn} className="mt-0.5" />
                <span>
                  <span className="block">Reporter writes a note on every trade</span>
                  <span className="block text-xs text-muted">On by default (§11). Turn it off to cut reporter spend.</span>
                </span>
              </label>
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">IR-eligible statuses</h3>
            <input
              name="irEligibleStatuses"
              defaultValue={settings.irEligibleStatuses.join(", ")}
              className="w-full rounded border border-border bg-background px-2 py-1.5"
            />
            <p className="mt-1 text-xs text-muted">
              Comma separated. Matched against a player&apos;s <span className="font-mono">injury_status</span> or{" "}
              <span className="font-mono">status</span> (§3.6).
            </p>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Loop guards <span className="font-normal normal-case">(extra.sessionGuards, §8.3)</span>
            </h3>
            <textarea
              name="sessionGuards"
              rows={10}
              defaultValue={JSON.stringify(guards, null, 2)}
              className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs"
            />
            <p className="mt-1 text-xs text-muted">
              Per session kind: <span className="font-mono">toolCallCeiling</span> and{" "}
              <span className="font-mono">deadlineMinutes</span> (null means the deadline is a real event — a draft clock, a kickoff, a
              review window). Ceilings are guards, not budgets: keep them high.
            </p>
          </section>

          <section>
            <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Roster and scoring
              {structureLocked ? <Badge tone="warn">locked — phase is {settings.phase}</Badge> : <Badge tone="accent">editable</Badge>}
            </h3>
            <div className="grid gap-3 lg:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-muted">roster_slots</span>
                <textarea
                  name="rosterSlots"
                  rows={12}
                  disabled={structureLocked}
                  defaultValue={JSON.stringify(settings.rosterSlots, null, 2)}
                  className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs disabled:opacity-50"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-muted">scoring_settings</span>
                <textarea
                  name="scoringSettings"
                  rows={12}
                  disabled={structureLocked}
                  defaultValue={JSON.stringify(settings.scoringSettings, null, 2)}
                  className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs disabled:opacity-50"
                />
              </label>
            </div>
            <p className="mt-1 text-xs text-muted">
              Blocked after the draft (§12.2). The block is enforced on the server too — these fields are ignored once the phase leaves{" "}
              <span className="font-mono">pre_draft</span>.
            </p>
          </section>

          <button type="submit" className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-background hover:opacity-90">
            Save settings
          </button>
        </form>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Cost alarm rules (§8.7)">
          {rules.length === 0 ? (
            <>
              <Empty>No alarm rules yet.</Empty>
              <form action={seedAlarmRulesAction}>
                <button type="submit" className="rounded border border-border px-3 py-1.5 text-sm hover:border-accent hover:text-accent">
                  Create the default rules
                </button>
              </form>
            </>
          ) : (
            <form action={saveAlarmRulesAction} className="space-y-3 text-sm">
              <Table head={["Scope", "Threshold $", "Step $", "On", "Channels"]}>
                {rules.map((r) => (
                  <Row key={r.id}>
                    <Cell>
                      <input type="hidden" name="ruleId" value={r.id} />
                      <div>{r.scope}</div>
                      <div className="text-xs text-muted">{SCOPE_NOTE[r.scope] ?? ""}</div>
                    </Cell>
                    <Cell>
                      <input
                        name={`threshold_${r.id}`}
                        type="number"
                        step="0.01"
                        defaultValue={r.thresholdUsd}
                        className="w-24 rounded border border-border bg-background px-2 py-1"
                      />
                    </Cell>
                    <Cell>
                      <input
                        name={`step_${r.id}`}
                        type="number"
                        step="0.01"
                        defaultValue={r.stepUsd ?? ""}
                        placeholder="none"
                        className="w-24 rounded border border-border bg-background px-2 py-1"
                      />
                    </Cell>
                    <Cell>
                      <input type="checkbox" name={`enabled_${r.id}`} value="1" defaultChecked={r.enabled} />
                    </Cell>
                    <Cell>
                      <div className="flex gap-2 text-xs">
                        {["email", "site", "webhook"].map((ch) => (
                          <label key={ch} className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              name={`channel_${ch}_${r.id}`}
                              value="1"
                              defaultChecked={r.channels.includes(ch)}
                            />
                            {ch}
                          </label>
                        ))}
                      </div>
                    </Cell>
                  </Row>
                ))}
              </Table>
              <button type="submit" className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-background hover:opacity-90">
                Save alarm rules
              </button>
              <p className="text-xs text-muted">Thresholds are alarm points, not caps. An alarm never stops a session (§8.1).</p>
            </form>
          )}
        </Card>

        <Card title="Tool costs and the optional hard stop">
          <form action={saveToolCostsAction} className="space-y-3 text-sm">
            <Table head={["Tool", "$ per call"]}>
              {tools.length === 0 ? (
                <Row>
                  <Cell>
                    <span className="text-muted">No tool prices stored — every tool call currently costs $0.</span>
                  </Cell>
                  <Cell>—</Cell>
                </Row>
              ) : (
                tools.map((t) => (
                  <Row key={t.toolName}>
                    <Cell>
                      <input type="hidden" name="toolName" value={t.toolName} />
                      <span className="font-mono text-xs">{t.toolName}</span>
                    </Cell>
                    <Cell>
                      <input
                        name={`cost_${t.toolName}`}
                        type="number"
                        step="0.000001"
                        defaultValue={t.usdPerCall}
                        className="w-32 rounded border border-border bg-background px-2 py-1"
                      />
                    </Cell>
                  </Row>
                ))
              )}
            </Table>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-muted">Add a tool</span>
                <input
                  name="newToolName"
                  placeholder="web_search"
                  className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-muted">$ per call</span>
                <input
                  name="newToolCost"
                  type="number"
                  step="0.000001"
                  className="w-full rounded border border-border bg-background px-2 py-1.5"
                />
              </label>
            </div>
            <button type="submit" className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-background hover:opacity-90">
              Save tool costs
            </button>
            <p className="text-xs text-muted">FantasyPros is $0. A priced tool call writes a ledger row with source `tool` (§8.7).</p>
          </form>

          <hr className="my-4 border-border" />

          <form action={savePauseAgentAtAction} className="space-y-3 text-sm">
            <label className="block">
              <span className="mb-1 block text-muted">pause_agent_at_usd (per season, blank = off)</span>
              <input
                name="pauseAgentAtUsd"
                type="number"
                step="0.01"
                defaultValue={typeof pauseAt === "number" ? pauseAt : ""}
                className="w-full rounded border border-border bg-background px-2 py-1.5"
              />
            </label>
            <button type="submit" className="rounded border border-border px-3 py-1.5 text-sm hover:border-warn hover:text-warn">
              Save hard stop
            </button>
            <p className="text-xs text-muted">
              Default off (§8.7). When on, an agent crossing it is paused and an alarm says so. Off means no dollar amount ever stops an
              agent.
            </p>
          </form>
        </Card>
      </div>
    </>
  );
}

function Num({ name, label, value }: { name: string; label: string; value: number }) {
  return (
    <label className="block">
      <span className="mb-1 block text-muted">{label}</span>
      <input
        name={name}
        type="number"
        defaultValue={value}
        className="w-full rounded border border-border bg-background px-2 py-1.5"
      />
    </label>
  );
}

function Text({ name, label, value }: { name: string; label: string; value: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-muted">{label}</span>
      <input name={name} defaultValue={value} className="w-full rounded border border-border bg-background px-2 py-1.5" />
    </label>
  );
}
