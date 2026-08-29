/**
 * The gateway model call (SPEC §8.1, §8.7).
 *
 * One call to `streamText` per session step. The tools are declared to the
 * model but NOT executed here — the session loop runs each tool as its own
 * durable workflow step, so `stopWhen` is never reached and the SDK returns
 * the tool calls for the loop to handle.
 *
 * Streaming instead of `generateText` exists for one reason: the live
 * transcript (§12.1). Reasoning and text deltas are accumulated as they
 * arrive and staged through the optional `onPartial` sink on a throttle, so
 * the website can show what an agent is thinking while it thinks it. The
 * step's *result* is identical either way — the loop still gets one complete
 * assistant message per step.
 *
 * Absolutely no limits are set: no maxOutputTokens, no temperature, no
 * reasoning or thinking budget or effort flag. Provider defaults throughout.
 * Prompt caching is enabled where the provider needs an explicit breakpoint.
 *
 * The system prompt goes in `instructions`, not in `messages`. AI SDK v7
 * rejects a system-role message inside `messages` outright — every provider
 * answered `AI_InvalidPromptError: System messages are not allowed in the
 * prompt or messages fields` — so this is not a preference. `instructions`
 * accepts the message object rather than only a string, which is what keeps
 * the Anthropic cache breakpoint on the system prompt.
 */
import { streamText, dynamicTool, jsonSchema } from "ai";
import { z } from "zod";
import type { EngineDb } from "@league/engine";
import type { ModelStepRequest, ModelStepResult, ModelMessage } from "./session.ts";
import { supportsExplicitCaching } from "./models.ts";
import type { PartialSink } from "./stream.ts";
import type { UsageTokens } from "./spend.ts";

/**
 * How often the in-flight partial is flushed to the sink, wall clock. This is
 * a mechanical write throttle (one small upsert per running session per
 * interval), not league time, so it does not go through `Clock`.
 */
const PARTIAL_FLUSH_MS = 500;

export interface ModelStepConfig {
  /** Optional override for tests. */
  stream?: typeof streamText;
  /** Receives the accumulated partial output as the step streams (§12.1). */
  onPartial?: PartialSink;
  /** Flush throttle override for tests; defaults to PARTIAL_FLUSH_MS. */
  flushIntervalMs?: number;
}

/** Declare a league tool to the model without giving the SDK an executor. */
function declareTools(req: ModelStepRequest) {
  const out: Record<string, ReturnType<typeof dynamicTool>> = {};
  for (const t of req.tools) {
    out[t.name] = dynamicTool({
      description: t.description,
      inputSchema: jsonSchema(z.toJSONSchema(t.schema) as Record<string, unknown>),
      // No execute: the session loop runs the tool as its own durable step.
    });
  }
  return out;
}

function usageOf(usage: {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
  outputTokenDetails?: { reasoningTokens?: number };
}): UsageTokens {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
  };
}

/**
 * Pull the gateway's own cost out of provider metadata when it is there
 * (§8.7 verify). Shapes differ by gateway version, so several keys are tried;
 * when none is present the caller falls back to the price table.
 */
export function gatewayCostFrom(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const gateway = (metadata as Record<string, unknown>).gateway;
  if (!gateway || typeof gateway !== "object") return null;
  const g = gateway as Record<string, unknown>;
  for (const key of ["cost", "costUsd", "totalCost", "cost_usd"]) {
    const v = g[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * Anthropic prompt caching (§8.1): mark the system prompt and the context
 * snapshot as cache breakpoints. Other providers cache prefixes on their own.
 * Caching changes cost only, never behavior.
 */
function withCaching(messages: ModelMessage[], modelId: string): ModelMessage[] {
  if (!supportsExplicitCaching(modelId)) return messages;
  return messages.map((m, i) => {
    // The system prompt and the first user message (brief + snapshot) are the
    // stable prefix worth caching; later messages change every step.
    if (i > 1 || (m.role !== "system" && m.role !== "user")) return m;
    return {
      ...m,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    } as ModelMessage;
  });
}

/**
 * Split the system messages out of the list. The session loop keeps the system
 * prompt as message 0 — that is how the transcript records it, and how
 * `withCaching` finds the breakpoint — but the SDK will not accept it there.
 *
 * Whole message objects are carried across rather than their text, so the
 * `providerOptions` holding Anthropic's `cacheControl` goes with them.
 */
export function splitInstructions(all: ModelMessage[]): {
  instructions: ModelMessage[];
  messages: ModelMessage[];
} {
  const instructions: ModelMessage[] = [];
  const messages: ModelMessage[] = [];
  for (const m of all) {
    if (m.role === "system") instructions.push(m);
    else messages.push(m);
  }
  return { instructions, messages };
}

/**
 * Build the `modelStep` the session loop calls. Each invocation is one durable
 * workflow step in production.
 */
export function createModelStep(
  _db: EngineDb,
  config: ModelStepConfig = {},
): (req: ModelStepRequest, stepNo: number) => Promise<ModelStepResult> {
  const stream = config.stream ?? streamText;
  const flushIntervalMs = config.flushIntervalMs ?? PARTIAL_FLUSH_MS;

  return async function modelStep(req: ModelStepRequest, stepNo: number): Promise<ModelStepResult> {
    // The session loop keeps its own message and tool types so it can be unit
    // tested without the SDK; this is the one boundary where they meet, so the
    // call options are assembled here and handed over with a single cast.
    // Cache first, then split: withCaching keys off position in the full list,
    // so splitting first would move the breakpoints.
    const { instructions, messages } = splitInstructions(withCaching(req.messages, req.modelId));

    const params = {
      model: req.modelId,
      ...(instructions.length > 0 ? { instructions } : {}),
      messages,
      tools: declareTools(req),
      // No maxOutputTokens, temperature, reasoning budget, or effort flag (§8.1).
    } as unknown as Parameters<typeof streamText>[0];

    const result = stream(params);

    // Accumulate deltas as they arrive and stage them on a throttle. streamText
    // reports provider failures as `error` parts in the stream rather than by
    // throwing, so the error is carried out of the loop and rethrown — the
    // session loop's catch is what marks the session failed.
    let partialReasoning = "";
    let partialText = "";
    let streamError: unknown = null;
    let lastFlush = 0;
    for await (const part of result.fullStream) {
      if (part.type === "reasoning-delta") partialReasoning += part.text;
      else if (part.type === "text-delta") partialText += part.text;
      else if (part.type === "error") streamError = part.error;
      else continue;
      if (!config.onPartial || streamError !== null) continue;
      const now = Date.now();
      if (now - lastFlush < flushIntervalMs) continue;
      lastFlush = now;
      await config.onPartial({ stepNo, reasoning: partialReasoning, text: partialText });
    }
    if (streamError !== null) throw streamError;

    const [text, rawToolCalls, usage, providerMetadata, content, finishReason] = await Promise.all([
      result.text,
      result.toolCalls,
      result.usage,
      result.providerMetadata,
      result.content,
      result.finishReason,
    ]);

    const toolCalls = (rawToolCalls ?? []).map((c) => ({
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      args: (c as { input?: unknown }).input,
    }));

    return {
      text: text ?? "",
      toolCalls,
      usage: usageOf(usage ?? {}),
      gatewayCostUsd: gatewayCostFrom(providerMetadata),
      // Every call bills the gateway (commissioner's decision, 2026-08-28).
      billedTo: "gateway",
      assistantMessage: { role: "assistant", content: content ?? text ?? "" },
      finishReason,
    };
  };
}
