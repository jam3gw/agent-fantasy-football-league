import type { EngineDb } from "./db/index.ts";
import type { TransactionType } from "./db/schema.ts";
import { transactions } from "./db/schema.ts";

/** Record a public transaction row (§6). Every engine write calls this in-transaction. */
export async function recordTransaction(
  db: EngineDb,
  entry: {
    type: TransactionType;
    week: number | null;
    teamIds: number[];
    payload: Record<string, unknown>;
  },
): Promise<number> {
  const rows = await db
    .insert(transactions)
    .values({
      type: entry.type,
      week: entry.week,
      teamIds: entry.teamIds,
      payload: entry.payload,
    })
    .returning({ id: transactions.id });
  return rows[0]!.id;
}
