/**
 * The per-minute scheduler tick (SPEC §9.1). Protected by CRON_SECRET.
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
 */
import { runTick } from "../../../../lib/tick";
import { env } from "../../../../lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

function authorized(request: Request): boolean {
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.cronSecret}`;
  return header.length === expected.length && header === expected;
}

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const summary = await runTick();
  return Response.json({ ok: true, ...summary });
}

export async function POST(request: Request): Promise<Response> {
  return GET(request);
}
