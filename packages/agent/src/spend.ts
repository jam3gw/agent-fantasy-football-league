/**
 * Cost recording, rollups, and alarms (SPEC §8.7).
 * Alarms notify; they never stop a session (§8.1). The optional
 * `pause_agent_at_usd` setting is the single exception and is off by default.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Clock } from "@league/shared";
import { etDay, zonedTimeToUtc } from "@league/shared";
import type { EngineDb, SessionKind } from "@league/engine";
import {
  costAlarmRules,
  costAlarms,
  getSettings,
  modelPrices,
  sessions,
  spendLedger,
  spendRollups,
  teams,
  toolCosts,
  tstz,
} from "@league/engine";
import type { BilledTo } from "./models.ts";

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
}

export interface ModelStepCost {
  costUsd: number;
  source: "gateway" | "price_table";
}

/**
 * Cost of one model step. The gateway's own cost is preferred when the
 * provider metadata carries it (§8.7 verify); otherwise the price table.
 * Cached input tokens are billed at the cache-read rate and are NOT also
 * billed as ordinary input.
 */
export async function computeStepCost(
  db: EngineDb,
  modelId: string,
  usage: UsageTokens,
  gatewayCost: number | null,
): Promise<ModelStepCost> {
  if (gatewayCost !== null && Number.isFinite(gatewayCost)) {
    return { costUsd: round6(gatewayCost), source: "gateway" };
  }
  const rows = await db.select().from(modelPrices).where(eq(modelPrices.modelId, modelId));
  const p = rows[0];
  if (!p) return { costUsd: 0, source: "price_table" };
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cost =
    (uncachedInput * p.inputUsdPerM) / 1_000_000 +
    (usage.cachedInputTokens * (p.cachedInputUsdPerM ?? p.inputUsdPerM)) / 1_000_000 +
    (usage.outputTokens * p.outputUsdPerM) / 1_000_000 +
    (usage.reasoningTokens * (p.reasoningUsdPerM ?? p.outputUsdPerM)) / 1_000_000;
  return { costUsd: round6(cost), source: "price_table" };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export interface LedgerEntry {
  sessionId: number;
  teamId: number | null;
  kind: SessionKind;
  modelId: string | null;
  stepNo: number;
  usage: UsageTokens;
  costUsd: number;
  source: "gateway" | "price_table" | "tool";
  billedTo: BilledTo;
  toolName?: string | null;
}

/**
 * Record one ledger row and keep `sessions.cost_usd` current so a long
 * session's spend is visible while it runs (§8.7).
 */
export async function recordSpend(db: EngineDb, clock: Clock, entry: LedgerEntry): Promise<void> {
  await db.insert(spendLedger).values({
    sessionId: entry.sessionId,
    teamId: entry.teamId,
    kind: entry.kind,
    modelId: entry.modelId,
    stepNo: entry.stepNo,
    inputTokens: entry.usage.inputTokens,
    outputTokens: entry.usage.outputTokens,
    reasoningTokens: entry.usage.reasoningTokens,
    cachedInputTokens: entry.usage.cachedInputTokens,
    costUsd: entry.costUsd,
    source: entry.source,
    toolName: entry.toolName ?? null,
    billedTo: entry.billedTo,
    createdAt: clock.now(),
  });
  await db
    .update(sessions)
    .set({
      costUsd: sql`${sessions.costUsd} + ${entry.costUsd}`,
      inputTokens: sql`${sessions.inputTokens} + ${entry.usage.inputTokens}`,
      outputTokens: sql`${sessions.outputTokens} + ${entry.usage.outputTokens}`,
      reasoningTokens: sql`${sessions.reasoningTokens} + ${entry.usage.reasoningTokens}`,
      updatedAt: clock.now(),
    })
    .where(eq(sessions.id, entry.sessionId));
}

/** Price of a paid tool call, or 0 when the tool is free (player_research is $0). */
export async function toolCallCost(db: EngineDb, toolName: string): Promise<number> {
  const rows = await db.select().from(toolCosts).where(eq(toolCosts.toolName, toolName));
  return rows[0]?.usdPerCall ?? 0;
}

// ---------------------------------------------------------------- rollups

export type RollupScope = "agent" | "league";
export type RollupPeriod = "day" | "week" | "season";

/** Period key for a scope: ET day, fantasy week, or season. */
export function periodStartKey(period: RollupPeriod, now: Date, week: number, season: number): string {
  if (period === "day") return etDay(now);
  if (period === "week") return `W${week}`;
  return String(season);
}

/**
 * Recompute the rollups a ledger row touches (§8.7): per agent and for the
 * league, for today, this fantasy week, and the season.
 *
 * All three periods come from one pass over the ledger. The week a step
 * belongs to is the week its session was booked for (`sessions.context.week`)
 * rather than the calendar — a Tuesday review and the Sunday lineup check it
 * leads to are the same fantasy week. `createSession` stamps that on every
 * in-season booking, and deliberately leaves it off the draft and onboarding
 * sessions: §8.7 counts those under "plus the draft" in the projection, not
 * against a week, so they appear in the season totals and in no week.
 */
export async function updateRollups(db: EngineDb, clock: Clock): Promise<void> {
  const settings = await getSettings(db);
  const now = clock.now();
  const dayKey = etDay(now);
  const weekKey = `W${settings.currentWeek}`;
  const seasonKey = String(settings.season);
  const dayStart = etDayStartUtc(now);

  const sessionWeek = sql<number>`(${sessions.context} ->> 'week')::int`;
  // Raw template: the timestamp must go over as a cast string, not a Date.
  const inDay = sql`${spendLedger.createdAt} >= ${tstz(dayStart)}`;
  const inWeek = sql`${sessionWeek} = ${settings.currentWeek}`;

  const rows = await db
    .select({
      teamId: spendLedger.teamId,
      seasonCost: sql<number>`coalesce(sum(${spendLedger.costUsd}), 0)::float8`,
      seasonInput: sql<number>`coalesce(sum(${spendLedger.inputTokens}), 0)::int`,
      seasonOutput: sql<number>`coalesce(sum(${spendLedger.outputTokens}), 0)::int`,
      seasonReasoning: sql<number>`coalesce(sum(${spendLedger.reasoningTokens}), 0)::int`,
      seasonSessions: sql<number>`count(distinct ${spendLedger.sessionId})::int`,
      dayCost: sql<number>`coalesce(sum(${spendLedger.costUsd}) filter (where ${inDay}), 0)::float8`,
      dayInput: sql<number>`coalesce(sum(${spendLedger.inputTokens}) filter (where ${inDay}), 0)::int`,
      dayOutput: sql<number>`coalesce(sum(${spendLedger.outputTokens}) filter (where ${inDay}), 0)::int`,
      dayReasoning: sql<number>`coalesce(sum(${spendLedger.reasoningTokens}) filter (where ${inDay}), 0)::int`,
      daySessions: sql<number>`count(distinct ${spendLedger.sessionId}) filter (where ${inDay})::int`,
      weekCost: sql<number>`coalesce(sum(${spendLedger.costUsd}) filter (where ${inWeek}), 0)::float8`,
      weekInput: sql<number>`coalesce(sum(${spendLedger.inputTokens}) filter (where ${inWeek}), 0)::int`,
      weekOutput: sql<number>`coalesce(sum(${spendLedger.outputTokens}) filter (where ${inWeek}), 0)::int`,
      weekReasoning: sql<number>`coalesce(sum(${spendLedger.reasoningTokens}) filter (where ${inWeek}), 0)::int`,
      weekSessions: sql<number>`count(distinct ${spendLedger.sessionId}) filter (where ${inWeek})::int`,
    })
    .from(spendLedger)
    .innerJoin(sessions, eq(sessions.id, spendLedger.sessionId))
    .groupBy(spendLedger.teamId);

  const pick = (r: (typeof rows)[number], p: "season" | "day" | "week"): RollupNumbers => ({
    cost: r[`${p}Cost`],
    input: r[`${p}Input`],
    output: r[`${p}Output`],
    reasoning: r[`${p}Reasoning`],
    sessionCount: r[`${p}Sessions`],
  });

  const scopeKeyOf = (teamId: number | null) => (teamId === null ? "reporter" : String(teamId));

  for (const r of rows) {
    const key = scopeKeyOf(r.teamId);
    await upsertRollup(db, clock, "agent", key, "day", dayKey, pick(r, "day"));
    await upsertRollup(db, clock, "agent", key, "week", weekKey, pick(r, "week"));
    await upsertRollup(db, clock, "agent", key, "season", seasonKey, pick(r, "season"));
  }

  await upsertRollup(db, clock, "league", "league", "day", dayKey, sumRows(rows.map((r) => pick(r, "day"))));
  await upsertRollup(db, clock, "league", "league", "week", weekKey, sumRows(rows.map((r) => pick(r, "week"))));
  await upsertRollup(db, clock, "league", "league", "season", seasonKey, sumRows(rows.map((r) => pick(r, "season"))));
}

interface RollupNumbers {
  cost: number;
  input: number;
  output: number;
  reasoning: number;
  sessionCount: number;
}

function sumRows(rows: RollupNumbers[]): RollupNumbers {
  return rows.reduce(
    (acc, r) => ({
      cost: acc.cost + r.cost,
      input: acc.input + r.input,
      output: acc.output + r.output,
      reasoning: acc.reasoning + r.reasoning,
      sessionCount: acc.sessionCount + r.sessionCount,
    }),
    { cost: 0, input: 0, output: 0, reasoning: 0, sessionCount: 0 },
  );
}

async function upsertRollup(
  db: EngineDb,
  clock: Clock,
  scope: RollupScope,
  scopeKey: string,
  period: RollupPeriod,
  periodStart: string,
  n: RollupNumbers,
): Promise<void> {
  const values = {
    scope,
    scopeKey,
    period,
    periodStart,
    costUsd: round6(n.cost),
    inputTokens: n.input,
    outputTokens: n.output,
    reasoningTokens: n.reasoning,
    sessions: n.sessionCount,
    updatedAt: clock.now(),
  };
  await db
    .insert(spendRollups)
    .values(values)
    .onConflictDoUpdate({
      target: [spendRollups.scope, spendRollups.scopeKey, spendRollups.period, spendRollups.periodStart],
      set: values,
    });
}

function etDayStartUtc(now: Date): Date {
  const [y, m, d] = etDay(now).split("-").map(Number);
  return zonedTimeToUtc(y!, m!, d!, 0, 0);
}

// ---------------------------------------------------------------- alarms

export interface FiredAlarm {
  ruleId: number;
  scope: string;
  scopeKey: string;
  periodStart: string;
  amountUsd: number;
  thresholdUsd: number;
  channels: string[];
}

/** Default alarm rules (§8.7). Thresholds are alarm points, never caps. */
export const DEFAULT_ALARM_RULES: Array<{
  scope: "session" | "agent_day" | "agent_week" | "agent_season" | "league_day" | "league_season";
  thresholdUsd: number;
  stepUsd: number | null;
}> = [
  { scope: "session", thresholdUsd: 5, stepUsd: 5 },
  { scope: "agent_day", thresholdUsd: 10, stepUsd: null },
  { scope: "agent_week", thresholdUsd: 40, stepUsd: null },
  { scope: "agent_season", thresholdUsd: 300, stepUsd: 100 },
  { scope: "league_day", thresholdUsd: 100, stepUsd: null },
  { scope: "league_season", thresholdUsd: 2500, stepUsd: 500 },
];

export async function seedAlarmRules(db: EngineDb): Promise<void> {
  const existing = await db.select().from(costAlarmRules);
  if (existing.length > 0) return;
  await db.insert(costAlarmRules).values(
    DEFAULT_ALARM_RULES.map((r) => ({
      scope: r.scope,
      thresholdUsd: r.thresholdUsd,
      stepUsd: r.stepUsd,
      enabled: true,
      channels: ["email", "site"],
    })),
  );
}

/**
 * Evaluate alarm rules after a ledger write. Returns the alarms that fired
 * (the caller notifies). Idempotent per rule, scope key, period, and
 * threshold via the `cost_alarms` unique index, so one crossing fires once.
 * For a stepped rule the highest crossed multiple fires.
 */
export async function evaluateAlarms(
  db: EngineDb,
  clock: Clock,
  ctx: { sessionId: number; teamId: number | null },
): Promise<FiredAlarm[]> {
  const settings = await getSettings(db);
  const now = clock.now();
  const rules = (await db.select().from(costAlarmRules)).filter((r) => r.enabled);
  if (rules.length === 0) return [];

  const scopeKey = ctx.teamId === null ? "reporter" : String(ctx.teamId);
  const dayKey = etDay(now);
  const weekKey = `W${settings.currentWeek}`;
  const seasonKey = String(settings.season);

  const amounts = new Map<string, { amount: number; key: string; periodStart: string }>();

  const sessionRow = (await db.select().from(sessions).where(eq(sessions.id, ctx.sessionId)))[0];
  amounts.set("session", {
    amount: sessionRow?.costUsd ?? 0,
    key: String(ctx.sessionId),
    periodStart: seasonKey,
  });

  const agentDay = await rollupAmount(db, "agent", scopeKey, "day", dayKey);
  const agentWeek = await rollupAmount(db, "agent", scopeKey, "week", weekKey);
  const agentSeason = await rollupAmount(db, "agent", scopeKey, "season", seasonKey);
  const leagueDay = await rollupAmount(db, "league", "league", "day", dayKey);
  const leagueSeason = await rollupAmount(db, "league", "league", "season", seasonKey);
  amounts.set("agent_day", { amount: agentDay, key: scopeKey, periodStart: dayKey });
  amounts.set("agent_week", { amount: agentWeek, key: scopeKey, periodStart: weekKey });
  amounts.set("agent_season", { amount: agentSeason, key: scopeKey, periodStart: seasonKey });
  amounts.set("league_day", { amount: leagueDay, key: "league", periodStart: dayKey });
  amounts.set("league_season", { amount: leagueSeason, key: "league", periodStart: seasonKey });

  const fired: FiredAlarm[] = [];
  for (const rule of rules) {
    const a = amounts.get(rule.scope);
    if (!a || a.amount < rule.thresholdUsd) continue;

    // Stepped rules fire again at every further multiple.
    const threshold = rule.stepUsd
      ? rule.thresholdUsd + Math.floor((a.amount - rule.thresholdUsd) / rule.stepUsd) * rule.stepUsd
      : rule.thresholdUsd;

    const inserted = await db
      .insert(costAlarms)
      .values({
        ruleId: rule.id,
        scopeKey: a.key,
        periodStart: a.periodStart,
        amountUsd: a.amount,
        thresholdUsd: threshold,
        firedAt: now,
        notifiedVia: [],
      })
      .onConflictDoNothing({
        target: [costAlarms.ruleId, costAlarms.scopeKey, costAlarms.periodStart, costAlarms.thresholdUsd],
      })
      .returning({ id: costAlarms.id });
    if (inserted.length > 0) {
      fired.push({
        ruleId: rule.id,
        scope: rule.scope,
        scopeKey: a.key,
        periodStart: a.periodStart,
        amountUsd: a.amount,
        thresholdUsd: threshold,
        channels: rule.channels,
      });
    }
  }
  return fired;
}

async function rollupAmount(
  db: EngineDb,
  scope: RollupScope,
  scopeKey: string,
  period: RollupPeriod,
  periodStart: string,
): Promise<number> {
  const rows = await db
    .select({ cost: spendRollups.costUsd })
    .from(spendRollups)
    .where(
      and(
        eq(spendRollups.scope, scope),
        eq(spendRollups.scopeKey, scopeKey),
        eq(spendRollups.period, period),
        eq(spendRollups.periodStart, periodStart),
      ),
    );
  return rows[0]?.cost ?? 0;
}

/**
 * Optional hard stop (§8.7, default OFF): pause an agent that crosses
 * `pause_agent_at_usd` for the season. Returns true when a team was paused.
 */
export async function applyOptionalPause(db: EngineDb, clock: Clock, teamId: number): Promise<boolean> {
  const settings = await getSettings(db);
  const limit = (settings.extra as { pause_agent_at_usd?: number }).pause_agent_at_usd;
  if (!limit || limit <= 0) return false;
  const season = await rollupAmount(db, "agent", String(teamId), "season", String(settings.season));
  if (season < limit) return false;
  const team = (await db.select().from(teams).where(eq(teams.id, teamId)))[0];
  if (!team || team.paused) return false;
  await db.update(teams).set({ paused: true }).where(eq(teams.id, teamId));
  void clock;
  return true;
}
