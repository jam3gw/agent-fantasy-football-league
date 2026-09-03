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
import { billedToFor, supportsExplicitCaching } from "./models.ts";
import type { PartialSink } from "./stream.ts";
import type { UsageTokens } from "./spend.ts";

/**
 * How often the in-flight partial is flushed to the sink, wall clock. This is
 * a mechanical write throttle, not league time, so it does not go through
 * `Clock`. Each flush rewrites the whole accumulated partial (the sink is an
 * upsert of one row), so the interval backs off as the partial grows —
 * otherwise a long reasoning step would rewrite tens of kilobytes twice a
 * second for minutes on end.
 */
export function partialFlushIntervalMs(accumulatedChars: number): number {
  if (accumulatedChars > 32_000) return 5_000;
  if (accumulatedChars > 8_000) return 2_000;
  return 500;
}

export interface ModelStepConfig {
  /** Optional override for tests. */
  stream?: typeof streamText;
  /** Receives the accumulated partial output as the step streams (§12.1). */
  onPartial?: PartialSink;
  /** Fixed flush throttle override for tests; defaults to the adaptive tiers. */
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
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  outputTokenDetails?: { reasoningTokens?: number };
}): UsageTokens {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    // Anthropic bills a cache write above the input rate; the ledger needs
    // the count to price a price-table step honestly (§8.7).
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
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
 * Reasoning visibility (§12.1). Some providers run their default reasoning but
 * return the text only when asked: Anthropic's current models default to
 * `display: "omitted"` (empty thinking blocks), Gemini returns thought
 * summaries only with `includeThoughts`, and OpenAI returns reasoning
 * summaries only when a summary mode is requested. These options change what
 * the response *carries*, never how the model thinks — like prompt caching,
 * they are not limits, budgets, effort flags, or toggles, so §8.1 stands.
 * Anthropic's `type: "adaptive"` is spelled out because `display` cannot be
 * sent alone — so it is only sent to the exact models where adaptive is
 * verified to BE the default (docs/VERIFIED.md), never by prefix: on a swap
 * to some other Anthropic model it would otherwise force a thinking mode,
 * which §8.1 forbids. Add a swapped-in Anthropic model here only after
 * verifying its default.
 */
const ANTHROPIC_ADAPTIVE_BY_DEFAULT = new Set([
  "anthropic/claude-fable-5",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-5",
]);

export function reasoningVisibilityOptions(
  modelId: string,
): Record<string, Record<string, unknown>> | null {
  if (ANTHROPIC_ADAPTIVE_BY_DEFAULT.has(modelId)) {
    return { anthropic: { thinking: { type: "adaptive", display: "summarized" } } };
  }
  if (modelId.startsWith("google/")) {
    return { google: { thinkingConfig: { includeThoughts: true } } };
  }
  if (modelId.startsWith("openai/")) {
    return { openai: { reasoningSummary: "auto" } };
  }
  return null;
}

/**
 * Anthropic prompt caching (§8.1): mark the system prompt, the context
 * snapshot, and the newest turns as cache breakpoints. Other providers cache
 * prefixes on their own. Caching changes cost only, never behavior.
 *
 * Why the newest turns too: a breakpoint caches everything *before* it, and
 * Anthropic reads a hit from the longest previously cached prefix. With the
 * breakpoints only on the first two messages, step N re-sent every tool
 * result since the snapshot at full price — measured 2026-09-03 across 233
 * Anthropic steps, the cached share of a step never rose above the snapshot
 * (docs/VERIFIED.md). A breakpoint on the last message caches the whole
 * conversation for the next step, whose new content is one assistant turn and
 * its tool results. The previous breakpoint is kept too (four is the
 * provider's maximum) so a hit is found even when a step adds more content
 * blocks than the provider's automatic lookback covers.
 */
const CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

function withCaching(messages: ModelMessage[], modelId: string): ModelMessage[] {
  if (!supportsExplicitCaching(modelId)) return messages;
  // The two newest user/tool turns after the stable prefix.
  const tail = new Set(
    messages
      .map((m, i) => ({ m, i }))
      .filter(({ m, i }) => i > 1 && (m.role === "user" || m.role === "tool"))
      .slice(-2)
      .map(({ i }) => i),
  );
  return messages.map((m, i) => {
    const stablePrefix = i <= 1 && (m.role === "system" || m.role === "user");
    if (!stablePrefix && !tail.has(i)) return m;
    // A tool message is a list of tool-result parts; the breakpoint goes on
    // the last part as well as the message, since a provider may read either.
    const content = Array.isArray(m.content)
      ? (m.content as Array<Record<string, unknown>>).map((part, j, all) =>
          j === all.length - 1 ? { ...part, providerOptions: CACHE_BREAKPOINT } : part,
        )
      : m.content;
    return { ...m, content, providerOptions: CACHE_BREAKPOINT } as ModelMessage;
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

  return async function modelStep(req: ModelStepRequest, stepNo: number): Promise<ModelStepResult> {
    // The session loop keeps its own message and tool types so it can be unit
    // tested without the SDK; this is the one boundary where they meet, so the
    // call options are assembled here and handed over with a single cast.
    // Cache first, then split: withCaching keys off position in the full list,
    // so splitting first would move the breakpoints.
    const { instructions, messages } = splitInstructions(withCaching(req.messages, req.modelId));

    // One attempt: call the provider and accumulate deltas as they arrive,
    // staging them on a throttle. streamText reports provider failures as
    // `error` parts in the stream rather than by throwing, so the error is
    // carried out of the loop for the caller to act on — the session loop's
    // catch is what marks the session failed.
    const attempt = async (providerOptions: ReturnType<typeof reasoningVisibilityOptions>) => {
      const params = {
        model: req.modelId,
        ...(instructions.length > 0 ? { instructions } : {}),
        messages,
        tools: declareTools(req),
        ...(providerOptions ? { providerOptions } : {}),
        // No maxOutputTokens, temperature, reasoning budget, or effort flag (§8.1).
      } as unknown as Parameters<typeof streamText>[0];

      const result = stream(params);
      let partialReasoning = "";
      let partialText = "";
      let streamError: unknown = null;
      // Whether the provider produced ANY content — tool calls included, which
      // stream as their own part types and are the whole output of a routine
      // step for several models. This is what the retry below gates on.
      let sawOutput = false;
      // A new reasoning block after an earlier one gets a blank line, appended
      // lazily on its first delta: a final block whose text is withheld
      // (Anthropic's omitted display) must not leave a trailing separator.
      let pendingSeparator = false;
      let lastFlush = 0;
      for await (const part of result.fullStream) {
        if (part.type === "tool-input-start" || part.type === "tool-input-delta" || part.type === "tool-call") {
          sawOutput = true;
          continue;
        }
        if (part.type === "reasoning-start") {
          pendingSeparator = partialReasoning !== "";
          continue;
        }
        if (part.type === "reasoning-delta") {
          if (pendingSeparator) {
            partialReasoning += "\n\n";
            pendingSeparator = false;
          }
          partialReasoning += part.text;
          sawOutput = true;
        } else if (part.type === "text-delta") {
          partialText += part.text;
          sawOutput = true;
        } else if (part.type === "error") streamError = part.error;
        else continue;
        if (!config.onPartial || streamError !== null) continue;
        const interval =
          config.flushIntervalMs ?? partialFlushIntervalMs(partialReasoning.length + partialText.length);
        const now = Date.now();
        if (now - lastFlush < interval) continue;
        lastFlush = now;
        await config.onPartial({ stepNo, reasoning: partialReasoning, text: partialText });
      }
      return { result, partialReasoning, partialText, streamError, sawOutput };
    };

    const providerOptions = reasoningVisibilityOptions(req.modelId);
    let run = await attempt(providerOptions);
    // Defensive fallback: if the very first thing back was an error — before
    // any output at all — and we had sent a visibility option, retry once
    // without it. A gateway or provider that starts rejecting the option must
    // cost the league its thinking display, never its sessions. An error after
    // real output (reasoning, text, or a tool call) is a genuine provider
    // failure and is not retried here (the tick's requeue owns that). The drop
    // is carried on the result so the session loop can record it — a silently
    // degraded step would read as "this model just shows no reasoning".
    let visibilityOptionDropped: string | null = null;
    if (run.streamError !== null && providerOptions !== null && !run.sawOutput) {
      visibilityOptionDropped = String(run.streamError);
      run = await attempt(null);
    }
    if (run.streamError !== null) throw run.streamError;
    const { result, partialReasoning } = run;

    const [text, rawToolCalls, usage, providerMetadata, responseMessages, finishReason] = await Promise.all([
      result.text,
      result.toolCalls,
      result.usage,
      result.providerMetadata,
      result.responseMessages,
      result.finishReason,
    ]);

    const toolCalls = (rawToolCalls ?? []).map((c) => ({
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      args: (c as { input?: unknown }).input,
    }));

    return {
      text: text ?? "",
      // The reasoning deltas accumulated above ARE the thinking log: the same
      // text the live stream shows, made durable by the session loop (§12.1).
      reasoning: partialReasoning,
      ...(visibilityOptionDropped !== null ? { visibilityOptionDropped } : {}),
      toolCalls,
      usage: usageOf(usage ?? {}),
      gatewayCostUsd: gatewayCostFrom(providerMetadata),
      // Who pays depends on the provider: gateway-held BYOK keys for
      // Anthropic, OpenAI and xAI (2026-08-29); everyone else the gateway.
      billedTo: billedToFor(req.modelId),
      // The SDK's own response message, never the raw `content` parts: a
      // hallucinated or unparsable tool call arrives in `content` as a
      // dynamic part carrying `invalid`, `error` and `dynamic` fields the
      // ModelMessage schema rejects, so replaying raw content killed the next
      // step of any session whose model invented a tool name (session 1014,
      // draft night). `toResponseMessages` also maps each part's
      // providerMetadata to providerOptions — what carries Gemini's
      // thoughtSignature back on replay, whose absence the gateway warned
      // about on every Gemini step.
      //
      // Taking the last assistant message is safe only while tools carry no
      // `execute` and stopWhen stays at its one-step default: under those,
      // responseMessages holds at most one assistant message, plus possibly
      // a tool message answering an invalid call — which must be dropped,
      // because the session loop answers every call itself and a duplicate
      // tool result fails at the provider.
      assistantMessage:
        [...responseMessages].reverse().find((m) => m.role === "assistant") ??
        ({ role: "assistant", content: text ?? "" } as ModelMessage),
      finishReason,
    };
  };
}
