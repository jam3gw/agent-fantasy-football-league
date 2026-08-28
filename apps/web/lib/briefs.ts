import "server-only";
/**
 * Session briefs (SPEC §8.6): short, plain text, identical for every model.
 * They live as markdown in packages/agent/briefs so they read as prose rather
 * than as string literals.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SessionKind } from "@league/engine";

const BRIEF_DIR = path.join(process.cwd(), "..", "..", "packages", "agent", "briefs");
const cache = new Map<string, string>();

export async function readBrief(kind: SessionKind, context: Record<string, unknown> = {}): Promise<string> {
  let text = cache.get(kind);
  if (text === undefined) {
    text = await readFile(path.join(BRIEF_DIR, `${kind}.md`), "utf8");
    cache.set(kind, text);
  }
  // The commissioner types the objective for a manual session (§8.6).
  if (kind === "manual" && typeof context.objective === "string") {
    return `${text.trim()}\n\nObjective: ${context.objective}`;
  }
  return text.trim();
}
