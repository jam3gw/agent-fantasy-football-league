import "server-only";
/**
 * The heartbeat behind /api/healthz (RUNBOOK "External uptime monitoring").
 * Every channel that can raise an alarm — email, webhook, the /admin/health
 * banner — is produced by the tick itself, so none of them can report the tick
 * dying. This is the one signal built to be read from outside: point an
 * external uptime monitor at /api/healthz and it learns what the league's own
 * alerting never can.
 */
import { eq } from "drizzle-orm";
import type { EngineDb } from "@league/engine";
import { health } from "@league/engine";

/** Three missed one-minute ticks is an outage, not a blip — the same rule as /admin/health's banner. */
export const TICK_STALE_MS = 3 * 60_000;

export interface Heartbeat {
  ok: boolean;
  lastTickAt: Date | null;
}

export async function heartbeat(database: EngineDb, now: Date): Promise<Heartbeat> {
  const rows = await database
    .select({ at: health.lastSuccessAt })
    .from(health)
    .where(eq(health.key, "cron.tick"));
  const lastTickAt = rows[0]?.at ?? null;
  return {
    ok: lastTickAt !== null && now.getTime() - lastTickAt.getTime() <= TICK_STALE_MS,
    lastTickAt,
  };
}
