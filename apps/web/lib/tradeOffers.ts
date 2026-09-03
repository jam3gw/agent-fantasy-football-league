/**
 * How `/trades` describes an offer that never reached league review
 * (SPEC §3.5): proposed, rejected, countered, cancelled, expired, or failed.
 * The engine stamps a different column for each ending, so the page needs
 * one place that knows which.
 */
import type { TradeStatus } from "@league/engine";

/** The statuses an offer can hold without ever entering review. */
export const OFFER_STATUSES: readonly TradeStatus[] = [
  "proposed",
  "rejected",
  "countered",
  "cancelled",
  "expired",
  "failed",
];

export interface OfferTimes {
  status: TradeStatus;
  proposedAt: Date;
  respondedAt: Date | null;
  resolvedAt: Date | null;
  reviewEndsAt: Date | null;
}

/**
 * Whether the trade ever entered league review. The engine sets
 * `review_ends_at` exactly once, on accept, so it is the marker. `failed`
 * has two producers — a re-check at accept time, and execution after a
 * review — and only the second belongs with the resolved trades, votes
 * and all.
 */
export function enteredReview(t: Pick<OfferTimes, "reviewEndsAt">): boolean {
  return t.reviewEndsAt !== null;
}

/** When an offer stops being open (§3.5: no response for `expiryHours`). */
export function offerExpiresAt(proposedAt: Date, expiryHours: number): Date {
  return new Date(proposedAt.getTime() + expiryHours * 3600_000);
}

/**
 * The moment the offer ended, and the verb for it. Rejections and counters
 * are the counterparty's response; a cancel, an expiry or a failed accept
 * is a resolution. An open offer has neither.
 */
export function offerEnding(t: OfferTimes): { verb: string; at: Date | null } | null {
  switch (t.status) {
    case "proposed":
      return null;
    case "rejected":
      return { verb: "rejected", at: t.respondedAt };
    case "countered":
      return { verb: "countered", at: t.respondedAt };
    case "cancelled":
      return { verb: "cancelled", at: t.resolvedAt };
    case "expired":
      return { verb: "expired", at: t.resolvedAt };
    case "failed":
      return { verb: "failed on accept", at: t.resolvedAt ?? t.respondedAt };
    default:
      return { verb: t.status, at: t.resolvedAt ?? t.respondedAt };
  }
}

/** The badge tone for an offer's status, matching the vote badges' palette. */
export function offerTone(status: TradeStatus): "neutral" | "accent" | "warn" | "danger" {
  if (status === "proposed") return "warn";
  if (status === "failed") return "danger";
  if (status === "countered") return "accent";
  return "neutral";
}
