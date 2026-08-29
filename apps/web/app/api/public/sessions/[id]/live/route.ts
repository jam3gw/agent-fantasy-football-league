/**
 * Public read-only JSON: one session's live state (SPEC §12.1) — the session
 * header, the transcript events after a cursor, and the in-flight partial
 * model output staged in `session_stream` while a step streams.
 *
 * The live transcript view polls this with `after` set to the last sequence
 * number it has, so steady-state responses carry only what is new. The read
 * itself (and its public-field allowlist) lives in `lib/sessionLive.ts`.
 */
import { db } from "../../../../../../lib/db";
import { readSessionLive } from "../../../../../../lib/sessionLive";
import { publicJson, rateLimitResponse } from "../../../../../../lib/rateLimit";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  // Own bucket: one open transcript tab polls ~24 times a minute, which would
  // otherwise consume most of the shared data-API budget for that IP.
  const limited = rateLimitResponse(request, "live");
  if (limited) return limited;

  const { id: idParam } = await ctx.params;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return publicJson({ error: "not_found", detail: `no session ${idParam}` }, 404);
  }

  const url = new URL(request.url);
  const afterRaw = Number(url.searchParams.get("after") ?? -1);
  const after = Number.isFinite(afterRaw) ? afterRaw : -1;

  const payload = await readSessionLive(db(), id, after);
  if (!payload) return publicJson({ error: "not_found", detail: `no session ${idParam}` }, 404);
  return publicJson(payload);
}
