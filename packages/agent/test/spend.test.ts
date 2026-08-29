/**
 * §15.1.12 — the cost ledger and the alarms.
 *
 * Rollups have to agree with the ledger they summarise, each alarm rule has to
 * fire exactly once per period when it is crossed (and again at every further
 * step for a stepped rule), and the optional season stop has to actually pause
 * the agent. All of it runs against real Postgres with no provider involved.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import {
  costAlarmRules,
  costAlarms,
  initLeagueSettings,
  sessions,
  spendLedger,
  spendRollups,
  teams,
  updateSettings,
  modelPrices,
} from "@league/engine";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { createModelStep } from "../src/modelStep.ts";
import {
  applyOptionalPause,
  computeStepCost,
  evaluateAlarms,
  recordSpend,
  seedAlarmRules,
  updateRollups,
} from "../src/spend.ts";

let db: TestDb;
let close: () => Promise<void>;
let clock: FixedClock;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = new FixedClock("2026-10-20T15:00:00Z"); // a Tuesday, 11:00 ET
  await initLeagueSettings(db, { season: 2026, phase: "regular", currentWeek: 7 });
});
afterEach(async () => {
  await close();
});

async function makeTeam(slug: string) {
  const [row] = await db
    .insert(teams)
    .values({ slug, name: slug, modelId: "m/x", modelLabel: "X", provider: "t", tiebreakRand: 0.5 })
    .returning({ id: teams.id });
  return row!.id;
}

/** A session booked for `week`, or for no week at all (the draft). */
async function makeSession(teamId: number | null, key: string, week: number | null) {
  const [row] = await db
    .insert(sessions)
    .values({
      teamId,
      kind: week === null ? "draft_pick" : "weekly_review",
      trigger: "test",
      idempotencyKey: key,
      modelId: "m/x",
      status: "running",
      context: week === null ? {} : { week },
    })
    .returning({ id: sessions.id });
  return row!.id;
}

async function spend(sessionId: number, teamId: number | null, costUsd: number, at?: string) {
  const c = at ? new FixedClock(at) : clock;
  await recordSpend(db, c, {
    sessionId,
    teamId,
    kind: "weekly_review",
    modelId: "m/x",
    stepNo: 1,
    usage: { inputTokens: 1000, outputTokens: 100, reasoningTokens: 10, cachedInputTokens: 0 },
    costUsd,
    source: "price_table",
    billedTo: "gateway",
  });
}

async function rollup(
  scope: "agent" | "league",
  scopeKey: string,
  period: "day" | "week" | "season",
  periodStart: string,
) {
  const rows = await db
    .select()
    .from(spendRollups)
    .where(
      and(
        eq(spendRollups.scope, scope),
        eq(spendRollups.scopeKey, scopeKey),
        eq(spendRollups.period, period),
        eq(spendRollups.periodStart, periodStart),
      ),
    );
  return rows[0];
}

describe("§8.7 rollups agree with the ledger", () => {
  it("writes day, week and season rows per agent and for the league", async () => {
    const a = await makeTeam("a");
    const b = await makeTeam("b");
    const sa = await makeSession(a, "s-a", 7);
    const sb = await makeSession(b, "s-b", 7);
    // Last week, and a day before today: in the season but not the week or day.
    const saOld = await makeSession(a, "s-a-old", 6);
    await spend(sa, a, 2);
    await spend(sa, a, 3);
    await spend(sb, b, 1.5);
    await spend(saOld, a, 10, "2026-10-13T15:00:00Z");

    await updateRollups(db, clock);

    expect((await rollup("agent", String(a), "season", "2026"))!.costUsd).toBeCloseTo(15, 6);
    expect((await rollup("agent", String(a), "week", "W7"))!.costUsd).toBeCloseTo(5, 6);
    expect((await rollup("agent", String(a), "day", "2026-10-20"))!.costUsd).toBeCloseTo(5, 6);
    expect((await rollup("agent", String(b), "week", "W7"))!.costUsd).toBeCloseTo(1.5, 6);

    // The league rows are the sum of the agents', per period — not the season
    // total repeated under every key.
    expect((await rollup("league", "league", "season", "2026"))!.costUsd).toBeCloseTo(16.5, 6);
    expect((await rollup("league", "league", "week", "W7"))!.costUsd).toBeCloseTo(6.5, 6);
    expect((await rollup("league", "league", "day", "2026-10-20"))!.costUsd).toBeCloseTo(6.5, 6);

    // Token and session counts come from the same rows.
    const seasonA = (await rollup("agent", String(a), "season", "2026"))!;
    expect(seasonA.inputTokens).toBe(3000);
    expect(seasonA.sessions).toBe(2);
    expect((await rollup("agent", String(a), "week", "W7"))!.sessions).toBe(1);
  });

  it("counts the reporter under its own scope key", async () => {
    const s = await makeSession(null, "s-rep", 7);
    await spend(s, null, 4);
    await updateRollups(db, clock);
    expect((await rollup("agent", "reporter", "week", "W7"))!.costUsd).toBeCloseTo(4, 6);
  });

  it("leaves draft and onboarding steps out of every week, but in the season", async () => {
    const a = await makeTeam("a");
    const s = await makeSession(a, "s-draft", null);
    await spend(s, a, 7);
    await updateRollups(db, clock);
    expect((await rollup("agent", String(a), "season", "2026"))!.costUsd).toBeCloseTo(7, 6);
    expect((await rollup("agent", String(a), "week", "W7"))!.costUsd).toBeCloseTo(0, 6);
  });

  it("is idempotent: recomputing does not double a total", async () => {
    const a = await makeTeam("a");
    const s = await makeSession(a, "s-a", 7);
    await spend(s, a, 3);
    await updateRollups(db, clock);
    await updateRollups(db, clock);
    expect((await rollup("agent", String(a), "season", "2026"))!.costUsd).toBeCloseTo(3, 6);
  });
});

describe("§8.7 alarms", () => {
  it("fires each rule once per period when crossed", async () => {
    await seedAlarmRules(db);
    const a = await makeTeam("a");
    const s = await makeSession(a, "s-a", 7);

    // $12 in one day: crosses agent_day ($10) but not agent_week ($40).
    await spend(s, a, 12);
    await updateRollups(db, clock);
    const first = await evaluateAlarms(db, clock, { sessionId: s, teamId: a });
    expect(first.map((f) => f.scope).sort()).toEqual(["agent_day", "session"]);

    // Same period, more spend, still under the next step: nothing fires again.
    await spend(s, a, 1);
    await updateRollups(db, clock);
    const second = await evaluateAlarms(db, clock, { sessionId: s, teamId: a });
    expect(second.map((f) => f.scope)).not.toContain("agent_day");
  });

  it("fires agent_week once the week total crosses $40", async () => {
    // The regression that mattered: with no agent/week rollup this rule could
    // never fire, however much an agent spent.
    await seedAlarmRules(db);
    const a = await makeTeam("a");
    const s1 = await makeSession(a, "s1", 7);
    const s2 = await makeSession(a, "s2", 7);
    await spend(s1, a, 25, "2026-10-19T15:00:00Z");
    await spend(s2, a, 20);
    await updateRollups(db, clock);

    const fired = await evaluateAlarms(db, clock, { sessionId: s2, teamId: a });
    const week = fired.find((f) => f.scope === "agent_week");
    expect(week, "agent_week must fire at $45 in week 7").toBeDefined();
    expect(week!.periodStart).toBe("W7");
    expect(week!.amountUsd).toBeCloseTo(45, 6);
    expect(week!.thresholdUsd).toBe(40);
  });

  it("a stepped rule fires again at each further multiple", async () => {
    await seedAlarmRules(db);
    const a = await makeTeam("a");
    const s = await makeSession(a, "s-a", 7);

    await spend(s, a, 6); // session rule: $5 threshold, $5 step
    await updateRollups(db, clock);
    const at6 = await evaluateAlarms(db, clock, { sessionId: s, teamId: a });
    expect(at6.find((f) => f.scope === "session")!.thresholdUsd).toBe(5);

    await spend(s, a, 5); // now $11 → the $10 multiple
    await updateRollups(db, clock);
    const at11 = await evaluateAlarms(db, clock, { sessionId: s, teamId: a });
    expect(at11.find((f) => f.scope === "session")!.thresholdUsd).toBe(10);

    // One row per crossed multiple, never a duplicate. Match on the rule, not
    // the scope key: a team id and a session id are both small integers.
    const sessionRule = (await db.select().from(costAlarmRules).where(eq(costAlarmRules.scope, "session")))[0]!;
    const rows = await db.select().from(costAlarms).where(eq(costAlarms.ruleId, sessionRule.id));
    expect(rows.map((r) => r.thresholdUsd).sort((x, y) => x - y)).toEqual([5, 10]);
  });

  it("a disabled rule never fires", async () => {
    await seedAlarmRules(db);
    await db.update(costAlarmRules).set({ enabled: false }).where(eq(costAlarmRules.scope, "agent_day"));
    const a = await makeTeam("a");
    const s = await makeSession(a, "s-a", 7);
    await spend(s, a, 50);
    await updateRollups(db, clock);
    const fired = await evaluateAlarms(db, clock, { sessionId: s, teamId: a });
    expect(fired.map((f) => f.scope)).not.toContain("agent_day");
  });

  it("alarms notify but never stop a session", async () => {
    // Nothing in the alarm path touches teams.paused or sessions.status.
    await seedAlarmRules(db);
    const a = await makeTeam("a");
    const s = await makeSession(a, "s-a", 7);
    await spend(s, a, 5000);
    await updateRollups(db, clock);
    await evaluateAlarms(db, clock, { sessionId: s, teamId: a });
    expect((await db.select().from(teams).where(eq(teams.id, a)))[0]!.paused).toBe(false);
    expect((await db.select().from(sessions).where(eq(sessions.id, s)))[0]!.status).toBe("running");
  });
});

describe("§8.7 the optional season stop", () => {
  it("is off by default", async () => {
    const a = await makeTeam("a");
    const s = await makeSession(a, "s-a", 7);
    await spend(s, a, 10_000);
    await updateRollups(db, clock);
    expect(await applyOptionalPause(db, clock, a)).toBe(false);
    expect((await db.select().from(teams).where(eq(teams.id, a)))[0]!.paused).toBe(false);
  });

  it("pauses the agent once the season total crosses the commissioner's limit", async () => {
    await updateSettings(db, { extra: { pause_agent_at_usd: 100 } });
    const a = await makeTeam("a");
    const s = await makeSession(a, "s-a", 7);

    await spend(s, a, 99);
    await updateRollups(db, clock);
    expect(await applyOptionalPause(db, clock, a)).toBe(false);

    await spend(s, a, 2);
    await updateRollups(db, clock);
    expect(await applyOptionalPause(db, clock, a)).toBe(true);
    expect((await db.select().from(teams).where(eq(teams.id, a)))[0]!.paused).toBe(true);
    // Already paused: it does not report a second pause.
    expect(await applyOptionalPause(db, clock, a)).toBe(false);
  });
});

describe("the ledger itself", () => {
  it("writes one row per step and keeps sessions.cost_usd in step with it", async () => {
    const a = await makeTeam("a");
    const s = await makeSession(a, "s-a", 7);
    await spend(s, a, 1.25);
    await spend(s, a, 2.5);
    const rows = await db.select().from(spendLedger).where(eq(spendLedger.sessionId, s));
    expect(rows.length).toBe(2);
    const session = (await db.select().from(sessions).where(eq(sessions.id, s)))[0]!;
    expect(session.costUsd).toBeCloseTo(3.75, 6);
    expect(session.inputTokens).toBe(2000);
  });
});

describe("every step bills the AI Gateway", () => {
  it("createModelStep reports `gateway`, and sets no provider options at all", async () => {
    // The commissioner's decision on 2026-08-28: one billing path, so one
    // price list and one balance. Asserted on the model step's own output —
    // asserting it on a ledger row a test helper wrote would only restate the
    // helper's input.
    let seen: Record<string, unknown> | null = null;
    const step = createModelStep({} as never, {
      generate: (async (params: Record<string, unknown>) => {
        seen = params;
        return {
          text: "hello",
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 2 },
          providerMetadata: undefined,
          content: "hello",
          finishReason: "stop",
        };
      }) as never,
    });

    // Real messages, so the assertions below can actually see what the step
    // sends: with `messages: []` nothing is emitted per message and the
    // provider-options checks pass whatever the code does.
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "brief" },
      { role: "assistant" as const, content: "later turn" },
    ];
    const result = await step({ modelId: "openai/gpt-5.6-sol", messages, tools: [] }, 0);
    // The commissioner's OpenAI key is held INSIDE the gateway (2026-08-29),
    // so the ledger says byok:openai...
    expect(result.billedTo).toBe("byok:openai");
    // ...while the request still carries no credential and no `only` pinning,
    // at the top level or hidden on a message.
    expect(seen).not.toBeNull();
    expect(Object.keys(seen!)).not.toContain("providerOptions");
    expect(JSON.stringify(seen)).not.toContain("byok");
    expect(JSON.stringify(seen)).not.toContain("only");
    // A non-Anthropic model gets no explicit breakpoints: those providers cache
    // prefixes on their own (§8.1).
    for (const m of seen!.messages as Array<Record<string, unknown>>) {
      expect(m.providerOptions).toBeUndefined();
    }
  });

  it("keeps Anthropic prompt caching on, and only on the stable prefix", async () => {
    // §8.1 / CLAUDE.md: "Prompt caching on." It is the one provider option the
    // runner still sets, so removing BYOK must not have taken it with it — and
    // nothing else in the suite exercises `withCaching`.
    let seen: Record<string, unknown> | null = null;
    const step = createModelStep({} as never, {
      generate: (async (params: Record<string, unknown>) => {
        seen = params;
        return { text: "", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, content: "" };
      }) as never,
    });

    await step(
      {
        modelId: "anthropic/claude-sonnet-5",
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "brief + snapshot" },
          { role: "assistant", content: "a later turn" },
          { role: "user", content: "a later user turn" },
        ],
        tools: [],
      },
      0,
    );

    const sent = seen!.messages as Array<Record<string, unknown>>;
    const instructions = seen!.instructions as Array<Record<string, unknown>>;
    const breakpoint = { anthropic: { cacheControl: { type: "ephemeral" } } };
    // The system prompt and the brief are the stable prefix worth caching. The
    // system prompt now travels in `instructions`, and the breakpoint has to go
    // with it — passing its text alone would silently drop the caching.
    expect(instructions[0]!.providerOptions).toEqual(breakpoint);
    expect(sent[0]!.providerOptions).toEqual(breakpoint);
    // Everything after it changes every step, so caching it would only cost.
    expect(sent[1]!.providerOptions).toBeUndefined();
    expect(sent[2]!.providerOptions).toBeUndefined();
    // Caching changes cost, never routing.
    expect(JSON.stringify(seen)).not.toContain("byok");
  });

  it("sends the system prompt as instructions, never inside messages", async () => {
    // Caught on production by the pre-draft smoke test, after every one of the
    // first six models answered:
    //
    //   AI_InvalidPromptError: Invalid prompt: System messages are not allowed
    //   in the prompt or messages fields. Use the instructions option instead.
    //
    // AI SDK v7 rejects a system-role message in `messages` outright, so this
    // was not a provider quirk or a bad model id — no session of any kind could
    // have run, and the draft would have failed on the day.
    for (const modelId of ["anthropic/claude-opus-5", "openai/gpt-5.6-sol", "google/gemini-3.1-pro-preview"]) {
      let seen: Record<string, unknown> | null = null;
      const step = createModelStep({} as never, {
        generate: (async (params: Record<string, unknown>) => {
          seen = params;
          return { text: "", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, content: "" };
        }) as never,
      });

      await step(
        {
          modelId,
          messages: [
            { role: "system", content: "the league rules" },
            { role: "user", content: "brief" },
            { role: "assistant", content: "a turn" },
          ],
          tools: [],
        },
        0,
      );

      const sent = seen!.messages as Array<Record<string, unknown>>;
      expect(sent.some((m) => m.role === "system"), modelId).toBe(false);
      // And it is actually carried, not dropped on the floor: losing it would
      // leave every agent with no rules and no team identity at all.
      expect(JSON.stringify(seen!.instructions), modelId).toContain("the league rules");
      expect(sent.map((m) => m.role), modelId).toEqual(["user", "assistant"]);
    }
  });

  it("billed_to names the payer: gateway-held BYOK providers vs the gateway", async () => {
    // The commissioner's own Anthropic, OpenAI and xAI keys live in the
    // gateway (2026-08-29); the other providers bill the gateway itself.
    const expected: Array<[string, string]> = [
      ["anthropic/claude-fable-5", "byok:anthropic"],
      ["openai/gpt-5.6-terra", "byok:openai"],
      ["spacexai/grok-4.6", "byok:xai"],
      ["google/gemini-3.1-pro-preview", "gateway"],
      ["zai/glm-5.3", "gateway"],
      ["moonshotai/kimi-k3", "gateway"],
    ];
    for (const [modelId, billedTo] of expected) {
      const step = createModelStep({} as never, {
        generate: (async () => ({
          text: "",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          content: "",
        })) as never,
      });
      const result = await step({ modelId, messages: [], tools: [] }, 0);
      expect(result.billedTo, modelId).toBe(billedTo);
    }
  });

  it("a $0 gateway cost against real tokens is priced from the table, not recorded as free", async () => {
    // The gateway reports cost 0 for a BYOK call. Trusting that 0 recorded
    // six teams' entire spend as $0.00 in the mock draft (2026-08-29).
    await db.insert(modelPrices).values({
      modelId: "test/model",
      inputUsdPerM: 1,
      outputUsdPerM: 10,
      cachedInputUsdPerM: 0.1,
      source: "test",
    });
    const priced = await computeStepCost(
      db,
      "test/model",
      { inputTokens: 1000, outputTokens: 100, reasoningTokens: 0, cachedInputTokens: 0 },
      0,
    );
    expect(priced.source).toBe("price_table");
    expect(priced.costUsd).toBeGreaterThan(0);

    // A 0 with no tokens at all is genuinely free — a skipped call, not BYOK.
    const free = await computeStepCost(
      db,
      "test/model",
      { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
      0,
    );
    expect(free.source).toBe("gateway");
    expect(free.costUsd).toBe(0);

    // A positive gateway cost is still authoritative.
    const billed = await computeStepCost(
      db,
      "test/model",
      { inputTokens: 1000, outputTokens: 100, reasoningTokens: 0, cachedInputTokens: 0 },
      0.123456,
    );
    expect(billed.source).toBe("gateway");
    expect(billed.costUsd).toBe(0.123456);
  });

  it("and the ledger row actually persists it", async () => {
    // The step reporting `gateway` is only half of it: `recordSpend` is what
    // writes `billed_to`, and /spend, /spend/[slug] and /benchmark all filter
    // on that column. Without this, dropping the field from the insert would
    // leave every one of those pages reading $0 with the suite still green.
    const a = await makeTeam("a");
    const s = await makeSession(a, "s-a", 7);
    await spend(s, a, 1);
    const rows = await db.select().from(spendLedger);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.billedTo === "gateway")).toBe(true);
  });
});
