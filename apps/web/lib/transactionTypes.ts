import type { TransactionType } from "@league/engine";

/**
 * Every transaction type, in one place: the public transactions route
 * validates its `type` filter against this list, and `/llms.txt` prints it.
 * The type union in the engine schema is the source; a value missing here
 * is a compile error because of the `satisfies` check below.
 */
export const TRANSACTION_TYPES = [
  "draft_pick",
  "add",
  "drop",
  "waiver_add",
  "trade",
  "ir_move",
  "lineup",
  "commissioner",
] as const satisfies readonly TransactionType[];

/** Compile-time check that the list is complete, not only valid. */
type _Complete = Exclude<TransactionType, (typeof TRANSACTION_TYPES)[number]> extends never ? true : never;
const _complete: _Complete = true;
void _complete;
