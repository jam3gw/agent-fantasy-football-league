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
import { eq } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb, SessionKind } from "@league/engine";
import { getSettings, sessionGuard, sessionEvents, sessions, teams } from "@league/engine";
import { writeDecisionLog } from "@league/engine";
import type { LeagueTool, ToolContext, ToolResult } from "./tools/types.ts";
import { toolFailure } from "./tools/types.ts";
import type { BilledTo } from "./models.ts";
import { computeStepCost, evaluateAlarms, recordSpend, toolCallCost, updateRollups } from "./spend.ts";
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
  /** Notification sink for fired cost alarms; alarms never stop a session. */
  onAlarms?: (alarms: Awaited<ReturnType<typeof evaluateAlarms>>) => Promise<void>;
}

export interface RunSessionResult {
  status: "succeeded" | "failed" | "timed_out" | "skipped";
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

  await db
    .update(sessions)
    .set({ status: "running", startedAt: clock.now(), updatedAt: clock.now() })
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
  const systemPrompt = await deps.buildSystemPrompt(ctx);
  const { brief, snapshot } = await deps.buildContext(ctx);

  const messages: ModelMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `${brief}\n\n${JSON.stringify(snapshot)}` },
  ];

  let seq = 0;
  await recordEvent(db, clock, sessionId, seq++, "system", { prompt: systemPrompt });
  await recordEvent(db, clock, sessionId, seq++, "user", { brief, snapshot });

  let toolCalls = 0;
  let invalidToolCalls = 0;
  let steps = 0;
  let endedBy: RunSessionResult["endedBy"] = null;
  let endingToolSucceeded = false;
  let ceilingNudged = false;
  let invalidNudged = false;

  try {
    // Step 4 of §8.2.
    for (;;) {
      if (clock.now() > deadlineAt) {
        endedBy = "deadline";
        break;
      }
      if (deps.shouldContinue && !(await deps.shouldContinue())) break;

      const result = await deps.modelStep(
        { modelId: session.modelId, messages, tools: deps.tools },
        steps,
      );
      steps++;

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

      await recordEvent(db, clock, sessionId, seq++, "assistant", {
        text: result.text,
        tool_calls: result.toolCalls.map((c) => ({ name: c.toolName, args: c.args })),
        usage: result.usage,
        cost_usd: costUsd,
        billed_to: result.billedTo,
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
        await recordEvent(db, clock, sessionId, seq++, "tool_call", { name: call.toolName, args: call.args });
        await recordEvent(db, clock, sessionId, seq++, "tool_result", { name: call.toolName, result: out });
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
        messages.push({
          role: "user",
          content:
            "Five invalid tool calls. Read the tool schemas and try once more, or write your decision log.",
        });
      }

      // §8.3: at the ceiling, one final message and one more model step.
      if (toolCalls >= ceiling) {
        if (ceilingNudged) {
          endedBy = "ceiling";
          break;
        }
        ceilingNudged = true;
        messages.push({
          role: "user",
          content: `Tool-call ceiling reached. Call ${endingTool} now.`,
        });
        await recordEvent(db, clock, sessionId, seq++, "info", { ceiling_reached: ceiling });
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
