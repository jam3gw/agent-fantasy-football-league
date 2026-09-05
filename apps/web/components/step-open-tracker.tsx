"use client";
/**
 * Reports one "Step opened" event each time a reader opens a step card by
 * hand. The cards are server-rendered `<details>` elements that React never
 * owns (see `SessionRail`), so this is one delegated listener on the document
 * rather than a handler per card.
 *
 * It listens for `click`, not `toggle`: `toggle` also fires when script or a
 * React re-render sets `open` — the rail's "Expand all", and the live view
 * moving the anchored decision card as steps arrive every poll — none of which
 * is a reader reading. A click on the summary of a card that is closed at
 * click time is. Keyboard activation of a `<summary>` dispatches a synthetic
 * click, so Enter and Space are covered.
 */
import { useEffect } from "react";
import { EVENTS, countsAsStepOpen } from "@/lib/analytics";
import { currentPage, trackEvent } from "@/lib/track";

export function StepOpenTracker() {
  useEffect(() => {
    const onClick = (e: Event) => {
      if (!(e.target instanceof Element)) return;
      const summary = e.target.closest("summary");
      const card = summary?.parentElement;
      if (!(card instanceof HTMLDetailsElement)) return;
      if (!countsAsStepOpen({ stepCard: card.hasAttribute("data-step-card"), open: card.open })) return;
      trackEvent(EVENTS.stepOpened, { page: currentPage(), kind: card.dataset.stepKind ?? "turn" });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return null;
}
