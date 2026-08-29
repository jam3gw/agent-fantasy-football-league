/**
 * A fake `streamText` result for model-step tests: yields the given stream
 * parts, then resolves the same promise fields the real StreamTextResult
 * exposes. Only the fields `createModelStep` reads are provided.
 */
import type { streamText } from "ai";

export type FakePart =
  | { type: "reasoning-delta"; text: string }
  | { type: "text-delta"; text: string }
  | { type: "error"; error: unknown }
  | { type: string };

export interface FakeStreamInput {
  parts?: FakePart[];
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; input?: unknown }>;
  usage?: Record<string, unknown>;
  providerMetadata?: unknown;
  content?: unknown;
  finishReason?: string;
}

export function fakeStreamResult(input: FakeStreamInput = {}): ReturnType<typeof streamText> {
  async function* fullStream() {
    for (const part of input.parts ?? []) yield { id: "part", ...part };
  }
  return {
    fullStream: fullStream(),
    text: Promise.resolve(input.text ?? ""),
    toolCalls: Promise.resolve(input.toolCalls ?? []),
    usage: Promise.resolve(input.usage ?? { inputTokens: 1, outputTokens: 1 }),
    providerMetadata: Promise.resolve(input.providerMetadata),
    content: Promise.resolve(input.content ?? input.text ?? ""),
    finishReason: Promise.resolve(input.finishReason ?? "stop"),
  } as unknown as ReturnType<typeof streamText>;
}
