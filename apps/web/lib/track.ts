"use client";

import { track } from "@vercel/analytics";
import { buildEvent, pageOf, type EventName, type EventValue } from "@/lib/analytics";

/**
 * Send one custom event to Vercel Web Analytics from the browser.
 *
 * `@vercel/analytics` is already mounted in the root layout, so this needs no
 * setup. In development the package loads its debug script and logs the event
 * to the console instead of recording it. An event the plan would reject is
 * dropped here rather than sent.
 */
export function trackEvent(name: EventName, properties?: Record<string, EventValue>): void {
  const event = buildEvent(name, properties);
  if (!event) return;
  track(event.name, event.properties);
}

/** The current route, for the `page` property on list events. */
export function currentPage(): string {
  return typeof window === "undefined" ? "" : pageOf(window.location.pathname);
}
