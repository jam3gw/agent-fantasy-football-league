/**
 * Diagnostic used from the mock-draft preview (2026-08-29): every onboarding
 * session failed `AI_InvalidPromptError` on a prompt whose transcript copy
 * validated clean locally. Rebuilding the messages from the transcript and
 * validating them on the deployed runtime separates "the bundle validates
 * differently" from "the live objects hold values JSON cannot show".
 */
import { z } from "zod";
import { modelMessageSchema } from "ai";
import type { EngineDb } from "@league/engine";
import { flattenIssues, restoreSession } from "./session.ts";

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
