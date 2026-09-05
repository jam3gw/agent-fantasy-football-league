"use client";
/**
 * Reports one "Step opened" event each time a reader opens a step card by
 * hand. The cards are server-rendered `<details>` elements that React never
 * owns (see `SessionRail`), so this listens to `toggle` on the document in the
 * capture phase — the event does not bubble — instead of adding a handler per
 * card. "Expand all" sets `open` from script, which also fires `toggle`; the
 * rail marks those so they are not counted as reading.
 */
import { useEffect } from "react";
import { EVENTS } from "@/lib/analytics";
import { currentPage, trackEvent } from "@/lib/track";

/** Set on a card by `SessionRail` just before it flips `open` from script. */
export const BULK_TOGGLE_FLAG = "data-bulk-toggle";

export function StepOpenTracker() {
  useEffect(() => {
    const onToggle = (e: Event) => {
      const card = e.target;
      if (!(card instanceof HTMLDetailsElement) || !card.hasAttribute("data-step-card")) return;
      const bulk = card.hasAttribute(BULK_TOGGLE_FLAG);
      if (bulk) card.removeAttribute(BULK_TOGGLE_FLAG);
      if (!card.open || bulk) return;
      trackEvent(EVENTS.stepOpened, { page: currentPage(), kind: card.dataset.stepKind ?? "turn" });
    };
    document.addEventListener("toggle", onToggle, true);
    return () => document.removeEventListener("toggle", onToggle, true);
  }, []);
  return null;
}
