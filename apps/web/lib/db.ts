import "server-only";
import { getDb } from "@league/engine";
import type { EngineDb } from "@league/engine";
import { clockOverride } from "@league/engine";
import type { Clock } from "@league/shared";
import { systemClock } from "@league/shared";
import { eq } from "drizzle-orm";
import { env } from "./env";

export function db(): EngineDb {
  return getDb({ url: env.databaseUrl });
}

/**
 * The league clock (§4.3). In production it is the system clock; in
 * simulation it reads the `clock_override` row so a 2025 week can be replayed.
 */
export async function leagueClock(): Promise<Clock> {
  if (!env.simulationMode) return systemClock;
  const rows = await db().select().from(clockOverride).where(eq(clockOverride.id, 1));
  const at = rows[0]?.nowAt;
  if (!at) return systemClock;
  return { now: () => new Date(at) };
}
