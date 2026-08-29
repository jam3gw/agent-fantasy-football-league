/**
 * Diagnostic used from the mock-draft preview (2026-08-29): every onboarding
 * session failed `AI_InvalidPromptError` on a prompt whose transcript copy
 * validated clean locally. Rebuilding the messages from the transcript and
 * validating them on the deployed runtime separates "the bundle validates
 * differently" from "the live objects hold values JSON cannot show".
 */
import { z } from "zod";
import type { Clock } from "@league/shared";
import { modelMessageSchema } from "ai";
import type { EngineDb } from "@league/engine";
import { flattenIssues, restoreSession } from "./session.ts";

/**
 * Run the read tools live and validate each output the way the SDK will when
 * it rides back in a tool message. The transcript cannot show a NaN, an
 * Infinity, a Date, or an undefined — JSON.stringify erases all four — so the
 * only place to catch one is the live object, on the runtime that serves it.
 */
export async function debugProbeTools(
  db: EngineDb,
  clock: Clock,
  tools: Array<{ name: string; execute: (args: unknown, ctx: unknown) => Promise<unknown> }>,
  calls: Array<{ tool: string; args: unknown }>,
): Promise<Record<string, unknown>> {
  const ctx = {
    db,
    clock,
    teamId: 1,
    sessionId: 0,
    kind: "onboarding",
    season: 2026,
    config: {},
    extra: {},
  };
  const results: unknown[] = [];
  for (const call of calls) {
    const tool = tools.find((t) => t.name === call.tool);
    if (!tool) {
      results.push({ tool: call.tool, error: "unknown tool" });
      continue;
    }
    try {
      const out = await tool.execute(call.args, ctx);
      const message = {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "probe", toolName: call.tool, output: { type: "json", value: out } }],
      };
      const parsed = modelMessageSchema.safeParse(message);
      results.push({
        tool: call.tool,
        args: call.args,
        valid: parsed.success,
        issues: parsed.success ? undefined : flattenIssues(parsed.error.issues).slice(0, 30),
      });
    } catch (error) {
      results.push({ tool: call.tool, args: call.args, error: String(error) });
    }
  }
  return { ok: true, results };
}

export async function debugValidateSession(db: EngineDb, sessionId: number): Promise<Record<string, unknown>> {
  const restored = await restoreSession(db, sessionId, "write_decision_log");
  if (!restored) return { ok: false, error: "no transcript" };
  const bad = restored.messages
    .map((message, index) => {
      const parsed = modelMessageSchema.safeParse(message);
      return parsed.success
        ? null
        : { index, role: message.role, issues: flattenIssues(parsed.error.issues).slice(0, 20) };
    })
    .filter((r) => r !== null);
  const whole = z.array(modelMessageSchema).safeParse(restored.messages);
  return { ok: true, messages: restored.messages.length, wholeArrayValid: whole.success, invalid: bad };
}
