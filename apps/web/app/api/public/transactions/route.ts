/**
 * Public read-only JSON: the transaction log (SPEC §12.1), newest first, with
 * optional `?team=<slug>` and `?type=<transaction type>` filters.
 * Rate limited to 60 requests per minute per IP.
 */
import { and, arrayContains, desc, eq } from "drizzle-orm";
import { teams, transactions, type TransactionType } from "@league/engine";
import { TRANSACTION_TYPES as TYPES } from "../../../../lib/transactionTypes";
import { db } from "../../../../lib/db";
import { publicJson, rateLimitResponse } from "../../../../lib/rateLimit";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function GET(request: Request): Promise<Response> {
  const limited = rateLimitResponse(request);
  if (limited) return limited;

  const params = new URL(request.url).searchParams;
  const rawLimit = Number(params.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT;

  const typeParam = params.get("type");
  if (typeParam && !TYPES.includes(typeParam as TransactionType)) {
    return publicJson({ error: "bad_type", detail: `type must be one of ${TYPES.join(", ")}` }, 400);
  }

  const teamRows = await db().select().from(teams);
  const byId = new Map(teamRows.map((t) => [t.id, t]));

  const slugParam = params.get("team");
  let teamId: number | undefined;
  if (slugParam) {
    const team = (await db().select().from(teams).where(eq(teams.slug, slugParam)))[0];
    if (!team) return publicJson({ error: "not_found", detail: `no team with slug ${slugParam}` }, 404);
    teamId = team.id;
  }

  const rows = await db()
    .select()
    .from(transactions)
    .where(
      and(
        typeParam ? eq(transactions.type, typeParam as TransactionType) : undefined,
        teamId !== undefined ? arrayContains(transactions.teamIds, [teamId]) : undefined,
      ),
    )
    .orderBy(desc(transactions.id))
    .limit(limit);

  return publicJson({
    limit,
    count: rows.length,
    filters: { team: slugParam ?? null, type: typeParam ?? null },
    transactions: rows.map((t) => ({
      id: t.id,
      type: t.type,
      week: t.week,
      teamIds: t.teamIds,
      teams: t.teamIds.map((id) => ({ teamId: id, slug: byId.get(id)?.slug ?? null, name: byId.get(id)?.name ?? null })),
      payload: t.payload,
      createdAt: t.createdAt.toISOString(),
    })),
  });
}
