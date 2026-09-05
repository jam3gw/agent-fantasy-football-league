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

/**
 * The document-level handler, exported so the DOM test can call it without
 * rendering. A nested disclosure inside a card (a tool call's arguments) has
 * its own summary whose parent is not a step card, so it does not count.
 */
export function onDocumentClick(e: Event): void {
  if (!(e.target instanceof Element)) return;
  const summary = e.target.closest("summary");
  const card = summary?.parentElement;
  if (!(card instanceof HTMLDetailsElement)) return;
  if (!countsAsStepOpen({ stepCard: card.hasAttribute("data-step-card"), open: card.open })) return;
  trackEvent(EVENTS.stepOpened, { page: currentPage(), kind: card.dataset.stepKind ?? "turn" });
}

export function StepOpenTracker() {
  useEffect(() => {
    document.addEventListener("click", onDocumentClick, true);
    return () => document.removeEventListener("click", onDocumentClick, true);
  }, []);
  return null;
}
