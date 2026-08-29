/**
 * Public freshness stamp (SPEC §12.1): the auto-refresh poll target. Returns
 * an opaque stamp that changes whenever spectator-visible league state does;
 * the `AutoRefresh` client component re-renders the page when it moves.
 * Rate limited to 60 requests per minute per IP like the rest of the API.
 */
import { db } from "../../../../lib/db";
import { computePulseStamp } from "../../../../lib/pulse";
import { publicJson, rateLimitResponse } from "../../../../lib/rateLimit";

export async function GET(request: Request): Promise<Response> {
  const limited = rateLimitResponse(request);
  if (limited) return limited;
  return publicJson({ stamp: await computePulseStamp(db()) });
}
