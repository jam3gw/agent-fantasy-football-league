/**
 * The session loop (SPEC §8.2). One model session for one team.
 *
 * Runs inside a Vercel Workflow so every model call and tool call is a durable
 * step; the step boundaries are the injected `modelStep`/`toolStep` wrappers,
 * so this module stays pure TypeScript and is unit-testable.
 *
 * §8.1 is absolute: no maxOutputTokens, no reasoning/thinking budget, no
 * temperature. Provider defaults. The only guards are the tool-call ceiling
 * and the deadline (§8.3).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb, SessionKind } from "@league/engine";
import { getSettings, modelPrices, sessionGuard, sessionEvents, sessions, teams } from "@league/engine";
import { writeDecisionLog } from "@league/engine";
import type { LeagueTool, ToolContext, ToolResult } from "./tools/types.ts";
import { toolFailure } from "./tools/types.ts";
import type { BilledTo } from "./models.ts";
import { MODEL_PRICE_SEED } from "./models.ts";
import { applyOptionalPause, computeStepCost, evaluateAlarms, recordSpend, toolCallCost, updateRollups } from "./spend.ts";
import type { UsageTokens } from "./spend.ts";

/** The ending tool per session kind (§8.2 step 4). */
export function endingToolFor(kind: SessionKind): string {
  if (kind === "draft_pick") return "make_pick";
  if (kind.startsWith("reporter_")) return "publish_report";
  return "write_decision_log";
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
}

export interface ModelStepRequest {
  modelId: string;
  messages: ModelMessage[];
  tools: LeagueTool[];
}

export interface ModelToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ModelStepResult {
  text: string;
  toolCalls: ModelToolCall[];
  usage: UsageTokens;
  /** Gateway-reported cost when present in provider metadata (§8.7). */
  gatewayCostUsd: number | null;
  billedTo: BilledTo;
  /** Raw assistant message to append to the history. */
  assistantMessage: ModelMessage;
  finishReason?: string;
}

export interface RunSessionDeps {
  db: EngineDb;
  clock: Clock;
  /** One durable step: a single model call. Never sets limits (§8.1). */
  modelStep: (req: ModelStepRequest, stepNo: number) => Promise<ModelStepResult>;
  /** Build the first user message: brief + context snapshot (§8.5). */
  buildContext: (ctx: ToolContext) => Promise<{ brief: string; snapshot: unknown }>;
  buildSystemPrompt: (ctx: ToolContext) => Promise<string>;
  /** Tools available to this session kind (§8.6). */
  tools: LeagueTool[];
  toolConfig: ToolContext["config"];
  /** Optional hook so the draft workflow can stop the loop when the pick is gone. */
  shouldContinue?: () => Promise<boolean>;
  /**
   * Wall-clock budget for this invocation (§4.1: a workflow step is capped at
   * 800 seconds). When it runs out mid-session the loop stops between model
   * calls and returns `interrupted`; the workflow starts another step, which
   * resumes from the transcript. Omit for no budget (tests, inline runs).
   */
  stepBudgetMs?: number;
  /** Notification sink for fired cost alarms; alarms never stop a session. */
  onAlarms?: (alarms: Awaited<ReturnType<typeof evaluateAlarms>>) => Promise<void>;
}

export interface RunSessionResult {
  status: "succeeded" | "failed" | "timed_out" | "skipped" | "queued" | "interrupted";
  endedBy: "ending_tool" | "ceiling" | "deadline" | null;
  toolCalls: number;
  invalidToolCalls: number;
  steps: number;
  error?: string;
}

const INVALID_CALL_NUDGE_AT = 5;

/** Append a transcript row (§6 session_events). */
async function recordEvent(
  db: EngineDb,
  clock: Clock,
  sessionId: number,
  seq: number,
  type: "system" | "user" | "assistant" | "tool_call" | "tool_result" | "error" | "info",
  content: Record<string, unknown>,
): Promise<void> {
  await db.insert(sessionEvents).values({
    sessionId,
    seq,
    type,
    content,
    createdAt: clock.now(),
  });
}

/**
 * Tell the tick this session is still alive (§9.2). `reclaimStuckSessions`
 * fails a `running` row that has gone quiet, and a turn spent on free tool
 * calls writes no ledger row, so `recordSpend`'s bump is not enough on its own.
 *
 * Once per model step, not once per transcript row: the reclaim's cutoff is
 * measured in tens of minutes, and a 120-call session writes ~285 rows, so a
 * per-row bump would be several hundred extra round trips and row versions on
 * the hottest tuple in the schema to move a timestamp nobody reads that often.
 * The status predicate means a session the tick already reclaimed is not
 * quietly made to look fresh.
 */
async function heartbeat(db: EngineDb, clock: Clock, sessionId: number): Promise<void> {
  await db
    .update(sessions)
    .set({ updatedAt: clock.now() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.status, "running")));
}


/**
 * The model's context window: the gateway's own figure, kept in `model_prices`
 * by the catalog sync, with the seed table as a fallback. A model we have no
 * figure for is left alone rather than guessed at.
 */
async function contextWindowFor(db: EngineDb, modelId: string): Promise<number | null> {
  const rows = await db.select({ contextWindow: modelPrices.contextWindow }).from(modelPrices).where(eq(modelPrices.modelId, modelId));
  const stored = rows[0]?.contextWindow;
  if (typeof stored === "number" && stored > 0) return stored;
  return MODEL_PRICE_SEED[modelId]?.contextWindow ?? null;
}

/**
 * §8.1 context management. Do nothing until the history approaches the model's
 * context window, then replace the OLDEST tool results with one-line stubs.
 * The model's own messages are never touched — an agent that cannot see what it
 * said stops making sense — and the most recent results stay whole, because
 * those are the ones the next step is reasoning about.
 */
const CONTEXT_KEEP_RECENT_TOOL_MESSAGES = 3;

/** Reserve for the next prompt's growth: a tenth of the window, never under 8k. */
export function contextSafetyMargin(contextWindow: number): number {
  return Math.max(Math.round(contextWindow * 0.1), 8_000);
}

/**
 * Wrap a tool result in the tagged output the SDK requires.
 *
 * `ToolResultPart.output` is a discriminated union — `{type: 'json', value}`,
 * `{type: 'text', value}`, and so on — not a bare object. Passing the result
 * object directly made every session die on its second step with
 * `AI_InvalidPromptError: The messages do not match the ModelMessage[] schema`,
 * once the first step's tool call came back.
 *
 * A failed tool result is `json`, not `error-json`: §8.4 defines
 * `{ok: false, error, message, hint}` as data the agent is meant to read and
 * act on, which is an ordinary turn in the conversation rather than a
 * transport-level error.
 */
export function toolOutput(value: unknown): { type: "json"; value: unknown } {
  // Serialized the same way the transcript stores it, so the model can never
  // be handed a value the transcript cannot show: a Date collapses to its ISO
  // string, NaN and Infinity to null, an undefined disappears. The SDK
  // validates the prompt against a strict JSON schema, and one live Date in a
  // result meta failed every session that touched it (mock draft, 2026-08-29)
  // while every stored copy of the same prompt validated clean.
  if (value === undefined) return { type: "json", value: null };
  try {
    return { type: "json", value: JSON.parse(JSON.stringify(value)) as unknown };
  } catch (err) {
    // A BigInt or a circular reference cannot serialize at all. Failing one
    // tool result beats failing the whole session from outside the per-tool
    // catch — the agent reads this like any other §8.4 failure and moves on.
    return {
      type: "json",
      value: { ok: false, error: "unserializable_result", message: String(err).slice(0, 200) },
    };
  }
}

/**
 * Stub the oldest tool results in place. Returns how many were stubbed, so a
 * caller can record it in the transcript and skip the work when it is zero.
 */
export function stubOldestToolResults(messages: ModelMessage[], keepRecent = CONTEXT_KEEP_RECENT_TOOL_MESSAGES): number {
  const toolMessageIndexes = messages.flatMap((m, i) => (m.role === "tool" ? [i] : []));
  const stubbable = toolMessageIndexes.slice(0, Math.max(0, toolMessageIndexes.length - keepRecent));
  let stubbed = 0;
  for (const index of stubbable) {
    const message = messages[index]!;
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part.type !== "tool-result") continue;
      const already = (part.output as { value?: { context_trimmed?: boolean } } | undefined)?.value
        ?.context_trimmed;
      if (already) continue;
      part.output = toolOutput({
        context_trimmed: true,
        note: `Result of ${String(part.toolName)} removed to stay inside the context window. Call it again if you still need it.`,
      });
      stubbed++;
    }
  }
  return stubbed;
}


/**
 * §4.1/§9.2: one model call is one durable step, and a step is capped at 800
 * seconds. A session that reaches its budget stops cleanly and its workflow
 * calls another step, which resumes here — the transcript in `session_events`
 * is the durable state, so nothing is held in memory between steps.
 *
 * Everything the loop needs comes back out of the transcript: the exact
 * messages the model saw, the sequence number to write next, and the counters
 * the loop guards depend on.
 */
export interface RestoredSession {
  messages: ModelMessage[];
  seq: number;
  steps: number;
  toolCalls: number;
  invalidToolCalls: number;
  ceilingNudged: boolean;
  invalidNudged: boolean;
  endingToolSucceeded: boolean;
}

export async function restoreSession(
  db: EngineDb,
  sessionId: number,
  endingTool: string,
): Promise<RestoredSession | null> {
  const rows = await db
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId))
    .orderBy(asc(sessionEvents.seq));
  if (rows.length === 0) return null;

  const messages: ModelMessage[] = [];
  const restored: RestoredSession = {
    messages,
    seq: (rows[rows.length - 1]!.seq ?? 0) + 1,
    steps: 0,
    toolCalls: 0,
    invalidToolCalls: 0,
    ceilingNudged: false,
    invalidNudged: false,
    endingToolSucceeded: false,
  };

  // Tool results are grouped into one message per assistant turn, keyed by the
  // ids the assistant message itself carries.
  let pendingToolResults: Array<{ toolCallId: string; toolName: string; output: unknown }> = [];
  let expectedToolCalls: Array<{ toolCallId: string; toolName: string }> = [];
  const flushToolResults = () => {
    // An invocation killed mid-batch leaves an assistant turn asking for tools
    // whose results were never written. Every provider rejects a tool call
    // without a matching result, so the gap is filled rather than replayed —
    // the tools genuinely did not run, and saying so is both true and the only
    // thing that lets the session continue.
    for (const call of expectedToolCalls) {
      if (pendingToolResults.some((r) => r.toolCallId === call.toolCallId)) continue;
      pendingToolResults.push({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: {
          ok: false,
          error: "not_executed",
          message: "This call was interrupted before it ran. Call it again if you still need it.",
        },
      });
    }
    expectedToolCalls = [];
    if (pendingToolResults.length === 0) return;
    messages.push({
      role: "tool",
      content: pendingToolResults.map((r) => ({
        type: "tool-result",
        toolCallId: r.toolCallId,
        toolName: r.toolName,
        output: toolOutput(r.output),
      })),
    } as ModelMessage);
    pendingToolResults = [];
  };

  for (const row of rows) {
    const content = row.content as Record<string, unknown>;
    switch (row.type) {
      case "system":
        messages.push({ role: "system", content: String(content.prompt ?? "") });
        break;
      case "user": {
        flushToolResults();
        const text =
          typeof content.text === "string"
            ? content.text
            : `${String(content.brief ?? "")}\n\n${JSON.stringify(content.snapshot ?? {})}`;
        messages.push({ role: "user", content: text });
        if (content.nudge === "ceiling") restored.ceilingNudged = true;
        if (content.nudge === "invalid_calls") restored.invalidNudged = true;
        break;
      }
      case "assistant": {
        flushToolResults();
        if (content.closing_step) break; // the closing step is never resumed
        restored.steps++;
        if (content.raw) messages.push(content.raw as unknown as ModelMessage);
        // Remember what this turn asked for, so the next flush can tell which
        // calls never got a result.
        expectedToolCalls = Array.isArray(content.tool_calls)
          ? (content.tool_calls as Array<{ id?: unknown; name?: unknown }>).flatMap((c) =>
              typeof c.id === "string" ? [{ toolCallId: c.id, toolName: String(c.name ?? "") }] : [],
            )
          : [];
        break;
      }
      case "tool_result": {
        const result = content.result as { ok?: boolean; error?: string } | undefined;
        const name = String(content.name ?? "");
        if (content.invalid === true) restored.invalidToolCalls++;
        else restored.toolCalls++;
        if (name === endingTool && result?.ok !== false) restored.endingToolSucceeded = true;
        const id = content.tool_call_id;
        if (typeof id === "string") {
          pendingToolResults.push({ toolCallId: id, toolName: name, output: result });
        }
        break;
      }
      default:
        break; // tool_call, error and info rows are transcript-only
    }
  }
  flushToolResults();

  // Without a system message there is nothing coherent to resume from.
  if (messages.length === 0 || messages[0]!.role !== "system") return null;
  return restored;
}

export async function runSession(sessionId: number, deps: RunSessionDeps): Promise<RunSessionResult> {
  const { db, clock } = deps;
  const settings = await getSettings(db);
  const session = (await db.select().from(sessions).where(eq(sessions.id, sessionId)))[0];
  if (!session) throw new Error(`session ${sessionId} not found`);

  const guard = sessionGuard(settings, session.kind);
  const ceiling =
    typeof session.context.tool_call_ceiling === "number"
      ? session.context.tool_call_ceiling
      : guard.toolCallCeiling;
  const deadlineAt = new Date(String(session.context.deadline_at));
  const endingTool = endingToolFor(session.kind);

  // A session interrupted by the step cap picks up exactly where it stopped;
  // a fresh one builds its prompt and context snapshot below (§8.2 steps 1, 3).
  const restored = await restoreSession(db, sessionId, endingTool);

  // Step 2 of §8.2 (wait for a slot) belongs to the workflow; by here we run.
  // A resumed session that already reached its ending tool is finished, and
  // must not be recorded `skipped` just because its window has since closed —
  // its decision log or report is already published.
  if (!restored?.endingToolSucceeded && clock.now() > deadlineAt) {
    await db
      .update(sessions)
      .set({ status: "skipped", endedAt: clock.now(), updatedAt: clock.now() })
      .where(and(eq(sessions.id, sessionId), inArray(sessions.status, ["queued", "running"])));
    return { status: "skipped", endedBy: "deadline", toolCalls: 0, invalidToolCalls: 0, steps: 0 };
  }

  // The caller may already have claimed a slot and marked the row running
  // (apps/web `claimSlot`); this is a no-op then, and the start for a direct
  // caller that has no concurrency to manage.
  //
  // The status predicate is what keeps the tick's reclaim authoritative: if
  // `reclaimStuckSessions` has already declared this row dead and handed its
  // team's slot to another session, an unguarded write here would put it back
  // to `running` and give the team two live runners (§9.2).
  const claimed = await db
    .update(sessions)
    .set({ status: "running", startedAt: session.startedAt ?? clock.now(), updatedAt: clock.now() })
    .where(and(eq(sessions.id, sessionId), inArray(sessions.status, ["queued", "running"])))
    .returning({ id: sessions.id });
  if (claimed.length === 0) {
    const current = (await db.select().from(sessions).where(eq(sessions.id, sessionId)))[0];
    return {
      status: (current?.status as RunSessionResult["status"]) ?? "failed",
      endedBy: null,
      toolCalls: 0,
      invalidToolCalls: 0,
      steps: 0,
    };
  }

  const ctx: ToolContext = {
    db,
    clock,
    teamId: session.teamId,
    sessionId,
    kind: session.kind,
    season: settings.season,
    config: deps.toolConfig,
    sessionContext: session.context,
  };

  const toolsByName = new Map(deps.tools.map((t) => [t.name, t]));

  let messages: ModelMessage[];
  let seq: number;
  if (restored) {
    messages = restored.messages;
    seq = restored.seq;
    await recordEvent(db, clock, sessionId, seq++, "info", { resumed: true, steps_so_far: restored.steps });
  } else {
    const systemPrompt = await deps.buildSystemPrompt(ctx);
    const { brief, snapshot } = await deps.buildContext(ctx);
    messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `${brief}\n\n${JSON.stringify(snapshot)}` },
    ];
    seq = 0;
    await recordEvent(db, clock, sessionId, seq++, "system", { prompt: systemPrompt });
    await recordEvent(db, clock, sessionId, seq++, "user", { brief, snapshot });
  }

  let toolCalls = restored?.toolCalls ?? 0;
  let invalidToolCalls = restored?.invalidToolCalls ?? 0;
  let steps = restored?.steps ?? 0;
  let endedBy: RunSessionResult["endedBy"] = null;
  let endingToolSucceeded = restored?.endingToolSucceeded ?? false;
  let ceilingNudged = restored?.ceilingNudged ?? false;
  let invalidNudged = restored?.invalidNudged ?? false;
  let lastInputTokens = 0;
  const contextWindow = await contextWindowFor(db, session.modelId);
  const budgetEndsAt =
    deps.stepBudgetMs === undefined ? null : new Date(clock.now().getTime() + deps.stepBudgetMs);

  try {
    // The interrupted invocation got as far as a successful ending tool: the
    // session is done, and another model step would publish a second report or
    // write a second decision log, and charge for it.
    if (endingToolSucceeded) endedBy = "ending_tool";

    // Step 4 of §8.2.
    while (!endingToolSucceeded) {
      if (clock.now() > deadlineAt) {
        endedBy = "deadline";
        break;
      }
      if (deps.shouldContinue && !(await deps.shouldContinue())) break;
      if (budgetEndsAt !== null && clock.now() >= budgetEndsAt) {
        // Out of step budget between model calls, which is the only safe place
        // to stop: every call and result so far is already in the transcript.
        await recordEvent(db, clock, sessionId, seq++, "info", { interrupted: "step_budget", steps });
        return { status: "interrupted", endedBy: null, toolCalls, invalidToolCalls, steps };
      }

      // §8.1: the previous step's input tokens are the real measure of how big
      // this prompt has grown, so compaction happens only once it actually
      // nears the window — never pre-emptively.
      if (contextWindow !== null && lastInputTokens > contextWindow - contextSafetyMargin(contextWindow)) {
        const stubbed = stubOldestToolResults(messages);
        if (stubbed > 0) {
          await recordEvent(db, clock, sessionId, seq++, "info", {
            context_trimmed: stubbed,
            input_tokens: lastInputTokens,
            context_window: contextWindow,
          });
        }
      }

      // Before the call, not after: a model call is the one span of a live
      // session that writes nothing, and §8.1 forbids capping its length.
      await heartbeat(db, clock, sessionId);
      const result = await deps.modelStep(
        { modelId: session.modelId, messages, tools: deps.tools },
        steps,
      );
      steps++;
      lastInputTokens = result.usage.inputTokens + result.usage.cachedInputTokens;

      const { costUsd, source } = await computeStepCost(
        db,
        session.modelId,
        result.usage,
        result.gatewayCostUsd,
      );
      await recordSpend(db, clock, {
        sessionId,
        teamId: session.teamId,
        kind: session.kind,
        modelId: session.modelId,
        stepNo: steps,
        usage: result.usage,
        costUsd,
        source,
        billedTo: result.billedTo,
      });
      await updateRollups(db, clock);
      const alarms = await evaluateAlarms(db, clock, { sessionId, teamId: session.teamId });
      // Alarms notify; they never stop a session (§8.1).
      if (alarms.length > 0 && deps.onAlarms) await deps.onAlarms(alarms);
      // The one exception, off by default (§8.7): a commissioner-set season
      // limit pauses the agent. It takes effect from the next session — this
      // one still finishes, because a session cut off mid-way leaves the
      // league without the decision it was booked to make.
      if (session.teamId !== null) await applyOptionalPause(db, clock, session.teamId);

      await recordEvent(db, clock, sessionId, seq++, "assistant", {
        text: result.text,
        tool_calls: result.toolCalls.map((c) => ({ name: c.toolName, args: c.args, id: c.toolCallId })),
        usage: result.usage,
        cost_usd: costUsd,
        billed_to: result.billedTo,
        // Kept verbatim so a session interrupted by the 800-second step cap can
        // be replayed exactly as the model saw it (§4.1, §9.2).
        raw: result.assistantMessage as unknown as Record<string, unknown>,
      });
      messages.push(result.assistantMessage);

      if (result.toolCalls.length === 0) break;

      const toolResults: Array<{ toolCallId: string; toolName: string; result: ToolResult }> = [];
      for (const call of result.toolCalls) {
        const tool = toolsByName.get(call.toolName);
        const invalidBefore = invalidToolCalls;
        let out: ToolResult;
        if (!tool) {
          invalidToolCalls++;
          out = toolFailure(
            "invalid_args",
            `There is no tool named ${call.toolName}.`,
            "Use one of the tools listed in this session.",
          );
        } else {
          const parsed = tool.schema.safeParse(call.args);
          if (!parsed.success) {
            invalidToolCalls++;
            out = toolFailure(
              "invalid_args",
              `${call.toolName}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
              "Read the tool schema and try again.",
            );
          } else {
            toolCalls++;
            try {
              out = await tool.execute(parsed.data, ctx);
            } catch (err) {
              out = toolFailure("tool_error", `${call.toolName} failed: ${String(err)}`);
              await recordEvent(db, clock, sessionId, seq++, "error", {
                tool: call.toolName,
                error: String(err),
              });
            }
            const price = await toolCallCost(db, call.toolName);
            if (price > 0) {
              await recordSpend(db, clock, {
                sessionId,
                teamId: session.teamId,
                kind: session.kind,
                modelId: null,
                stepNo: steps,
                usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
                costUsd: price,
                source: "tool",
                billedTo: "gateway",
                toolName: call.toolName,
              });
            }
            if (tool.ending && out.ok !== false) endingToolSucceeded = true;
          }
        }
        await recordEvent(db, clock, sessionId, seq++, "tool_call", {
          name: call.toolName,
          args: call.args,
          tool_call_id: call.toolCallId,
        });
        await recordEvent(db, clock, sessionId, seq++, "tool_result", {
          name: call.toolName,
          result: out,
          tool_call_id: call.toolCallId,
          // Whether this counted against the invalid-call guard (§8.8). A tool
          // may return `invalid_args` from its own body after a clean schema
          // parse, so the code alone cannot tell the two apart on a resume.
          invalid: invalidBefore !== invalidToolCalls,
        });
        toolResults.push({ toolCallId: call.toolCallId, toolName: call.toolName, result: out });
      }

      messages.push({
        role: "tool",
        content: toolResults.map((r) => ({
          type: "tool-result",
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          output: toolOutput(r.result),
        })),
      });

      if (endingToolSucceeded) {
        endedBy = "ending_tool";
        break;
      }

      // §8.8: nudge after five invalid tool calls.
      if (invalidToolCalls >= INVALID_CALL_NUDGE_AT && !invalidNudged) {
        invalidNudged = true;
        const text = "Five invalid tool calls. Read the tool schemas and try once more, or write your decision log.";
        messages.push({ role: "user", content: text });
        await recordEvent(db, clock, sessionId, seq++, "user", { text, nudge: "invalid_calls" });
      }

      // §8.3: at the ceiling, one final message and one more model step.
      if (toolCalls >= ceiling) {
        if (ceilingNudged) {
          endedBy = "ceiling";
          break;
        }
        ceilingNudged = true;
        const text = `Tool-call ceiling reached. Call ${endingTool} now.`;
        messages.push({ role: "user", content: text });
        await recordEvent(db, clock, sessionId, seq++, "user", { text, nudge: "ceiling", ceiling_reached: ceiling });
      }
    }

    // Step 5 of §8.2: closing.
    const closing = await closeSession(db, clock, {
      sessionId,
      session,
      endingToolSucceeded,
      endingTool,
      deps,
      ctx,
      messages,
      seq,
    });
    seq = closing.seq;

    const status: RunSessionResult["status"] = closing.failed
      ? "failed"
      : endedBy === "deadline"
        ? "timed_out"
        : "succeeded";

    // Only a row this invocation still owns. A session the tick reclaimed while
    // this one was quiet is `failed` and its slot has been handed on; writing
    // `succeeded` over it would erase the reclaim and hide the duplicate run.
    await db
      .update(sessions)
      .set({
        status,
        endedAt: clock.now(),
        toolCalls,
        invalidToolCalls,
        endedBy,
        error: closing.error ?? null,
        updatedAt: clock.now(),
      })
      .where(and(eq(sessions.id, sessionId), eq(sessions.status, "running")));

    return {
      status,
      endedBy,
      toolCalls,
      invalidToolCalls,
      steps,
      ...(closing.error ? { error: closing.error } : {}),
    };
  } catch (err) {
    await recordEvent(db, clock, sessionId, seq++, "error", { error: String(err), ...errorDetail(err) });
    await db
      .update(sessions)
      .set({
        status: "failed",
        endedAt: clock.now(),
        toolCalls,
        invalidToolCalls,
        error: String(err),
        updatedAt: clock.now(),
      })
      .where(and(eq(sessions.id, sessionId), eq(sessions.status, "running")));
    return { status: "failed", endedBy, toolCalls, invalidToolCalls, steps, error: String(err) };
  }
}

/**
 * The one string `AI_InvalidPromptError` shows names the schema but not the
 * field: the zod error rides in `cause`, and its issue paths say exactly which
 * message and part failed. Losing that cost a day of guessing once (mock
 * draft, 2026-08-29), so the transcript keeps the first few issues.
 */
function errorDetail(err: unknown): Record<string, unknown> {
  // The zod error may sit one or two causes deep (InvalidPromptError wraps
  // TypeValidationError wraps ZodError), so follow the chain to the issues.
  let cause: unknown = err;
  let issues: unknown;
  for (let depth = 0; depth < 3; depth++) {
    if (!cause || typeof cause !== "object" || !("cause" in cause)) break;
    cause = (cause as { cause?: unknown }).cause;
    if (cause && typeof cause === "object" && Array.isArray((cause as { issues?: unknown }).issues) ) {
      issues = (cause as { issues: unknown }).issues;
      break;
    }
  }
  if (!cause || typeof cause !== "object") return {};
  if (Array.isArray(issues)) {
    return { cause_issues: flattenIssues(issues).slice(0, 20) };
  }
  return { cause: String(cause).slice(0, 500) };
}

/**
 * A union failure's real reason hides in its sub-errors — zod v4 nests them
 * under `errors`, v3 under `unionErrors` — and the top-level issue alone reads
 * "Invalid input" with a path and nothing else.
 */
export function flattenIssues(issues: unknown, depth = 0): unknown[] {
  if (!Array.isArray(issues) || depth > 3) return [];
  return issues.slice(0, 5).flatMap((raw) => {
    const issue = raw as Record<string, unknown>;
    const base = { code: issue.code, path: issue.path, message: issue.message };
    const nested = [
      ...(Array.isArray(issue.errors) ? (issue.errors as unknown[][]).flat() : []),
      ...(Array.isArray(issue.unionErrors)
        ? (issue.unionErrors as Array<{ issues?: unknown[] }>).flatMap((e) => e.issues ?? [])
        : []),
    ];
    return [base, ...flattenIssues(nested, depth + 1)];
  });
}

/**
 * §8.2 step 5. draft_pick: the draft workflow auto-picks (handled there).
 * reporter_*: nothing published is a failure. Everything else: one extra model
 * step asking for the decision log, then a placeholder if still none.
 */
async function closeSession(
  db: EngineDb,
  clock: Clock,
  args: {
    sessionId: number;
    session: typeof sessions.$inferSelect;
    endingToolSucceeded: boolean;
    endingTool: string;
    deps: RunSessionDeps;
    ctx: ToolContext;
    messages: ModelMessage[];
    seq: number;
  },
): Promise<{ seq: number; failed: boolean; error?: string }> {
  const { session, endingToolSucceeded, endingTool, deps, messages } = args;
  let seq = args.seq;
  if (endingToolSucceeded) return { seq, failed: false };

  if (session.kind === "draft_pick") {
    // The draft workflow auto-picks and marks the session timed_out (§10.2).
    return { seq, failed: false };
  }

  if (session.kind.startsWith("reporter_")) {
    return { seq, failed: true, error: "no_report" };
  }

  // One extra model step with the instruction.
  messages.push({ role: "user", content: `Call ${endingTool} now with a short summary of this session.` });
  try {
    const extra = await deps.modelStep(
      { modelId: session.modelId, messages, tools: deps.tools },
      -1,
    );
    await recordEvent(db, clock, args.sessionId, seq++, "assistant", {
      text: extra.text,
      closing_step: true,
    });
    for (const call of extra.toolCalls) {
      const tool = deps.tools.find((t) => t.name === call.toolName);
      if (!tool) continue;
      const parsed = tool.schema.safeParse(call.args);
      if (!parsed.success) continue;
      const out = await tool.execute(parsed.data, args.ctx);
      await recordEvent(db, clock, args.sessionId, seq++, "tool_result", {
        name: call.toolName,
        result: out,
      });
      if (tool.ending && out.ok !== false) return { seq, failed: false };
    }
  } catch (err) {
    await recordEvent(db, clock, args.sessionId, seq++, "error", { closing_step: String(err) });
  }

  // Still nothing: insert the placeholder so every session has a public summary.
  if (session.teamId !== null) {
    await writeDecisionLog(db, session.teamId, session.kind, "(no summary written)", args.sessionId);
    await recordEvent(db, clock, args.sessionId, seq++, "info", { decision_log: "placeholder" });
  }
  return { seq, failed: false };
}

/** Teams eligible to run sessions (§9.1: not paused, not eliminated). */
export async function activeTeamIds(db: EngineDb): Promise<number[]> {
  const rows = await db.select().from(teams);
  return rows.filter((t) => !t.paused && !t.eliminated).map((t) => t.id);
}
