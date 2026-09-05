/**
 * Custom events for Vercel Web Analytics — the pure part, with no Vercel
 * import so it is unit-tested in Node.
 *
 * The team is on Vercel Pro without the Web Analytics Plus add-on, so each
 * custom event may carry at most two properties; the dashboard silently drops
 * anything past the plan limit, which is why the limit is enforced here where
 * a test can see it. Every custom event is billed like a page view ($0.03 per
 * 1,000 events on Pro), so events go on deliberate reader actions only, never
 * on scroll, poll, or render.
 */

/** Pro plan without Web Analytics Plus. Plus and Enterprise allow eight. */
export const MAX_PROPERTIES = 2;

/** Vercel's cap on the event name and on every key and value. */
export const MAX_LENGTH = 255;

export type EventValue = string | number | boolean | null;

/**
 * The whole vocabulary. Anything not here is a typo, and a typo is a new row
 * in the dashboard that nobody filters on.
 */
export const EVENTS = {
  /** A list control changed: a filter select, a chip, or a sort. */
  filter: "Filter",
  /** A "show more" button on a long list. */
  showMore: "Show more",
  /** The compare panel on the home page: two models picked. */
  compare: "Compare",
  /** Every step of a session transcript opened or closed at once. */
  toggleSteps: "Toggle steps",
  /** One step card of a transcript opened by hand (never on close). */
  stepOpened: "Step opened",
  /** A reader stayed on a running session or the live draft past the watch threshold. */
  liveWatched: "Live watched",
  /** "Read the full notes" on a team's scratchpad card. */
  notesExpanded: "Notes expanded",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/**
 * Shape an event for `track()`. Returns null when the event would be rejected
 * or truncated by Vercel, so the caller can skip it instead of sending a
 * broken row. Nested objects are not allowed; nor are more than
 * `MAX_PROPERTIES` keys.
 */
export function buildEvent(
  name: EventName,
  properties: Record<string, EventValue> = {},
): { name: EventName; properties: Record<string, EventValue> } | null {
  if (name.length === 0 || name.length > MAX_LENGTH) return null;
  const entries = Object.entries(properties);
  if (entries.length > MAX_PROPERTIES) return null;
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > MAX_LENGTH) return null;
    if (typeof value === "string" && value.length > MAX_LENGTH) return null;
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) return null;
  }
  return { name, properties };
}

/** Seconds on a live page before "Live watched" fires, once per visit. */
export const LIVE_WATCH_SECONDS = 30;

/**
 * The `beforeSend` rule for `<Analytics />`, applied to page views and custom
 * events alike. Returns the URL to report, or null to drop the event.
 *
 * - `/admin/*` is one reader (the commissioner, behind a login) and would be
 *   both paid for and mixed into the public traffic numbers. Dropped.
 * - The query string is filter state (`?team=…&sort=…`), which would make one
 *   page into dozens of dashboard rows. Stripped; the "Filter" event already
 *   records that a filter was used.
 */
export function filterUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.pathname === "/admin" || parsed.pathname.startsWith("/admin/")) return null;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/**
 * Whether a click on a `<details>` summary is a reader opening a step: the
 * card must be a step card and closed at click time. A click that closes a
 * card is not reading, and a card React or the rail opened never goes through
 * here at all.
 */
export function countsAsStepOpen(card: { stepCard: boolean; open: boolean }): boolean {
  return card.stepCard && !card.open;
}

/**
 * Whether a URL-state write changed anything. A chip that is already lit can
 * be clicked again; a select cannot re-fire its own value. Only a real change
 * is a "Filter" event.
 */
export function queryChanged(before: string, after: string): boolean {
  // Both sides re-serialised: a linked-in `?team=a&` or `%20` for `+` is
  // the same state as its canonical form, not a change.
  return new URLSearchParams(before).toString() !== new URLSearchParams(after).toString();
}

/**
 * The page a browser event happened on, as the App Router route where one
 * is known. `/matchups/3` and `/matchups/12` are one page, not two.
 */
export function pageOf(pathname: string): string {
  return pathname
    .replace(/^\/matchups\/\d+$/, "/matchups/[week]")
    .replace(/^\/teams\/[^/]+\/week\/\d+$/, "/teams/[slug]/week/[week]")
    .replace(/^\/teams\/[^/]+$/, "/teams/[slug]")
    .replace(/^\/spend\/[^/]+$/, "/spend/[slug]")
    .replace(/^\/sessions\/[^/]+$/, "/sessions/[id]")
    .replace(/^\/players\/[^/]+$/, "/players/[id]");
}
