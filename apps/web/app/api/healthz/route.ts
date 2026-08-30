/**
 * Public heartbeat for an external uptime monitor. 200 while the scheduler
 * tick is fresh; 503 when it is stale, has never run, or the database cannot
 * be reached. The body carries nothing but the heartbeat — no error text, no
 * configuration, no internals — because this answers on the public site with
 * no auth. The *reason* lives on /admin/health.
 */
import { heartbeat } from "../../../lib/healthz";
import { db, leagueClock } from "../../../lib/db";
import { rateLimitResponse } from "../../../lib/rateLimit";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const limited = rateLimitResponse(request, "healthz");
  if (limited) return limited;
  try {
    const clock = await leagueClock();
    const beat = await heartbeat(db(), clock.now());
    return Response.json(
      { ok: beat.ok, lastTickAt: beat.lastTickAt?.toISOString() ?? null },
      { status: beat.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // A database that cannot be reached is a dead league too; the monitor only
    // needs the 503, and the cause is already reported everywhere else.
    return Response.json(
      { ok: false, lastTickAt: null },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
