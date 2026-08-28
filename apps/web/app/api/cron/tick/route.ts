/**
 * The per-minute scheduler tick (SPEC §9.1). Protected by CRON_SECRET.
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
 */
import { timingSafeEqual } from "node:crypto";
import { runTick } from "../../../../lib/tick";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

/**
 * Constant-time comparison. A missing or misconfigured CRON_SECRET is treated
 * as "not authorized" rather than an error: an unauthenticated endpoint must
 * never answer 500, which would both leak that something is misconfigured and
 * look like a server fault to Vercel Cron's retry logic.
 */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const presented = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const summary = await runTick();
    return Response.json({ ok: true, ...summary });
  } catch (error) {
    // The tick is a background job: report the failure without a stack trace.
    console.error("[cron.tick] failed", error);
    return Response.json({ ok: false, error: "tick_failed" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  return GET(request);
}
