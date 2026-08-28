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
import { asc, eq } from "drizzle-orm";
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
  /** Provider options for this call (gateway BYOK/only, cache breakpoints). */
  providerOptions?: Record<string, unknown>;
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
      const already = (part.output as { context_trimmed?: boolean } | undefined)?.context_trimmed;
      if (already) continue;
      part.output = {
        context_trimmed: true,
        note: `Result of ${String(part.toolName)} removed to stay inside the context window. Call it again if you still need it.`,
      };
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
  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return;
    messages.push({
      role: "tool",
      content: pendingToolResults.map((r) => ({
        type: "tool-result",
        toolCallId: r.toolCallId,
        toolName: r.toolName,
        output: r.output,
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
        break;
      }
      case "tool_result": {
        const result = content.result as { ok?: boolean; error?: string } | undefined;
        const name = String(content.name ?? "");
        if (result?.error === "invalid_args") restored.invalidToolCalls++;
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

  // Step 2 of §8.2 (wait for a slot) belongs to the workflow; by here we run.
  if (clock.now() > deadlineAt) {
    await db
      .update(sessions)
      .set({ status: "skipped", endedAt: clock.now(), updatedAt: clock.now() })
      .where(eq(sessions.id, sessionId));
    return { status: "skipped", endedBy: "deadline", toolCalls: 0, invalidToolCalls: 0, steps: 0 };
  }

  // The caller may already have claimed a slot and marked the row running
  // (apps/web `claimSlot`); this is a no-op then, and the start for a direct
  // caller that has no concurrency to manage.
  await db
    .update(sessions)
    .set({ status: "running", startedAt: session.startedAt ?? clock.now(), updatedAt: clock.now() })
    .where(eq(sessions.id, sessionId));

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

  // A session interrupted by the step cap picks up exactly where it stopped;
  // a fresh one builds its prompt and context snapshot (§8.2 steps 1 and 3).
  const restored = await restoreSession(db, sessionId, endingTool);
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
    // Step 4 of §8.2.
    for (;;) {
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
        });
        toolResults.push({ toolCallId: call.toolCallId, toolName: call.toolName, result: out });
      }

      messages.push({
        role: "tool",
        content: toolResults.map((r) => ({
          type: "tool-result",
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          output: r.result,
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
      .where(eq(sessions.id, sessionId));

    return {
      status,
      endedBy,
      toolCalls,
      invalidToolCalls,
      steps,
      ...(closing.error ? { error: closing.error } : {}),
    };
  } catch (err) {
    await recordEvent(db, clock, sessionId, seq++, "error", { error: String(err) });
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
      .where(eq(sessions.id, sessionId));
    return { status: "failed", endedBy, toolCalls, invalidToolCalls, steps, error: String(err) };
  }
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
