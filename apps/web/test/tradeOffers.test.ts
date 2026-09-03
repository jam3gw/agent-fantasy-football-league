/**
 * The engine stamps `respondedAt` for a rejection or a counter and
 * `resolvedAt` for a cancel, an expiry or a failed accept; the offers list
 * has to read the right one or it shows a dash for a dated ending.
 */
import { describe, expect, it } from "vitest";
import { OFFER_STATUSES, enteredReview, offerEnding, offerExpiresAt, offerTone } from "@/lib/tradeOffers";

const proposed = new Date("2026-09-10T12:00:00Z");
const responded = new Date("2026-09-11T08:00:00Z");
const resolved = new Date("2026-09-12T12:00:00Z");

const open = { proposedAt: proposed, respondedAt: null, resolvedAt: null, reviewEndsAt: null };

describe("offerEnding", () => {
  it("is null while the offer is open", () => {
    expect(offerEnding({ ...open, status: "proposed" })).toBeNull();
  });

  it("reads the response stamp for a rejection or a counter", () => {
    for (const status of ["rejected", "countered"] as const) {
      expect(offerEnding({ ...open, status, respondedAt: responded })).toEqual({ verb: status, at: responded });
    }
  });

  it("reads the resolution stamp for a cancel, an expiry or a failed accept", () => {
    expect(offerEnding({ ...open, status: "cancelled", resolvedAt: resolved })?.at).toBe(resolved);
    expect(offerEnding({ ...open, status: "expired", resolvedAt: resolved })?.at).toBe(resolved);
    expect(offerEnding({ ...open, status: "failed", respondedAt: responded, resolvedAt: resolved })).toEqual({
      verb: "failed on accept",
      at: resolved,
    });
  });

  it("keeps the verb with a null date rather than throwing", () => {
    expect(offerEnding({ ...open, status: "expired" })).toEqual({ verb: "expired", at: null });
  });
});

describe("enteredReview", () => {
  it("separates a failed accept from a trade that failed after review", () => {
    expect(enteredReview({ reviewEndsAt: null })).toBe(false);
    expect(enteredReview({ reviewEndsAt: resolved })).toBe(true);
  });
});

describe("offerExpiresAt and offerTone", () => {
  it("adds the settings' expiry hours to the proposal time", () => {
    expect(offerExpiresAt(proposed, 48).toISOString()).toBe("2026-09-12T12:00:00.000Z");
  });

  it("covers every status an offer can end in without review", () => {
    expect(OFFER_STATUSES).not.toContain("accepted");
    expect(OFFER_STATUSES).not.toContain("executed");
    expect(OFFER_STATUSES).not.toContain("vetoed");
    expect(offerTone("proposed")).toBe("warn");
    expect(offerTone("failed")).toBe("danger");
    expect(offerTone("countered")).toBe("accent");
    expect(offerTone("expired")).toBe("neutral");
  });
});
