import "server-only";
/**
 * Session briefs (SPEC §8.6): short, plain text, identical for every model.
 *
 * They are authored as markdown in `packages/agent/briefs` so they read as
 * prose rather than as string literals, and compiled into
 * `packages/agent/src/briefs.generated.ts` so they travel in the bundle. They
 * used to be read from disk with a path relative to `process.cwd()`, which
 * does not exist inside a Vercel function — every session would have failed
 * with ENOENT on the first deploy that actually ran one.
 */
import { BRIEFS } from "@league/agent";
import type { SessionKind } from "@league/engine";

export async function readBrief(kind: SessionKind, context: Record<string, unknown> = {}): Promise<string> {
  const text = BRIEFS[kind];
  if (text === undefined) throw new Error(`no brief for session kind: ${kind}`);
  // The commissioner types the objective for a manual session (§8.6).
  if (kind === "manual" && typeof context.objective === "string") {
    return `${text}\n\nObjective: ${context.objective}`;
  }
  // §8.10: the agent's own reason is the brief for the check-in it booked,
  // with the reasoning it gave for booking — the question and its stakes.
  if (kind === "self_check_in" && typeof context.reason === "string") {
    const why =
      typeof context.reasoning === "string" && context.reasoning.length > 0
        ? `\nWhy you booked it: ${context.reasoning}`
        : "";
    return `${text}\n\nYour reason: ${context.reason}${why}`;
  }
  return text;
}
