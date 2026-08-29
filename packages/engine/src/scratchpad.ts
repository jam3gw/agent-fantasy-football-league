/**
 * Private scratchpads (§2, §8.4 write_scratchpad). Free-form, persists all
 * season, public on the website. Every write saves a version.
 */
import { eq } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "./db/index.ts";
import { scratchpadVersions, scratchpads } from "./db/schema.ts";
import type { EngineResult } from "./errors.ts";
import { fail, ok } from "./errors.ts";

export const MAX_SCRATCHPAD_LENGTH = 20_000;

export async function readScratchpad(db: EngineDb, teamId: number): Promise<string> {
  const rows = await db.select().from(scratchpads).where(eq(scratchpads.teamId, teamId));
  return rows[0]?.content ?? "";
}

export async function writeScratchpad(
  db: EngineDb,
  clock: Clock,
  teamId: number,
  mode: "append" | "replace",
  content: string,
  sessionId?: number | null,
): Promise<EngineResult<{ length: number }>> {
  return db.transaction(async (tx) => {
    const current = await readScratchpad(tx, teamId);
    const next = mode === "append" ? (current ? `${current}\n${content}` : content) : content;
    if (next.length > MAX_SCRATCHPAD_LENGTH) {
      return fail(
        "too_long",
        `the scratchpad would be ${next.length} characters; the maximum is ${MAX_SCRATCHPAD_LENGTH}`,
        { hint: mode === "append" ? "use mode=replace to rewrite it shorter" : "shorten the content" },
      );
    }
    await tx
      .insert(scratchpads)
      .values({ teamId, content: next, updatedAt: clock.now() })
      .onConflictDoUpdate({ target: scratchpads.teamId, set: { content: next, updatedAt: clock.now() } });
    await tx
      .insert(scratchpadVersions)
      .values({ teamId, content: next, sessionId: sessionId ?? null, createdAt: clock.now() });
    return ok({ length: next.length });
  });
}
