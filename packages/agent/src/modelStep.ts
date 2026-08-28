/**
 * The gateway model call (SPEC §8.1, §8.7, §8.9).
 *
 * One call to `generateText` per session step. The tools are declared to the
 * model but NOT executed here — the session loop runs each tool as its own
 * durable workflow step, so `stopWhen` is never reached and the SDK returns
 * the tool calls for the loop to handle.
 *
 * Absolutely no limits are set: no maxOutputTokens, no temperature, no
 * reasoning or thinking budget or effort flag. Provider defaults throughout.
 * Prompt caching is enabled where the provider needs an explicit breakpoint.
 */
import { generateText, dynamicTool, jsonSchema } from "ai";
import { z } from "zod";
import type { EngineDb } from "@league/engine";
import type { ModelStepRequest, ModelStepResult, ModelMessage } from "./session.ts";
import type { ByokCredentials, ByokProvider } from "./models.ts";
import { gatewayCallOptions, supportsExplicitCaching } from "./models.ts";
import type { UsageTokens } from "./spend.ts";

export interface ModelStepConfig {
  byokRoutes: Record<string, ByokProvider>;
  byokCredentials: ByokCredentials;
  /** Optional override for tests. */
  generate?: typeof generateText;
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
 * Build the `modelStep` the session loop calls. Each invocation is one durable
 * workflow step in production.
 */
export function createModelStep(
  _db: EngineDb,
  config: ModelStepConfig,
): (req: ModelStepRequest, stepNo: number) => Promise<ModelStepResult> {
  const generate = config.generate ?? generateText;

  return async function modelStep(req: ModelStepRequest): Promise<ModelStepResult> {
    const call = gatewayCallOptions(req.modelId, config.byokRoutes, config.byokCredentials);
    const providerOptions = call.providerOptions ?? undefined;

    // The session loop keeps its own message and tool types so it can be unit
    // tested without the SDK; this is the one boundary where they meet, so the
    // call options are assembled here and handed over with a single cast.
    const params = {
      model: req.modelId,
      messages: withCaching(req.messages, req.modelId),
      tools: declareTools(req),
      ...(providerOptions ? { providerOptions } : {}),
      // No maxOutputTokens, temperature, reasoning budget, or effort flag (§8.1).
    } as unknown as Parameters<typeof generateText>[0];

    const result = await generate(params);

    const toolCalls = (result.toolCalls ?? []).map((c) => ({
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      args: (c as { input?: unknown }).input,
    }));

    return {
      text: result.text ?? "",
      toolCalls,
      usage: usageOf(result.usage ?? {}),
      gatewayCostUsd: gatewayCostFrom(result.providerMetadata),
      billedTo: call.billedTo,
      assistantMessage: { role: "assistant", content: result.content ?? result.text ?? "" },
      finishReason: result.finishReason,
    };
  };
}
