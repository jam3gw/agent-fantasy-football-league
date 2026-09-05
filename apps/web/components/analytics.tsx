"use client";

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";
import { filterUrl } from "@/lib/analytics";

/**
 * `<Analytics />` with the site's `beforeSend` rule. The root layout is a
 * server component and `beforeSend` is a function, so the prop is bound here.
 * Mount this once, in the root layout, and nowhere else.
 */
export function SiteAnalytics() {
  return <Analytics beforeSend={beforeSend} />;
}

function beforeSend(event: BeforeSendEvent): BeforeSendEvent | null {
  const url = filterUrl(event.url);
  return url === null ? null : { ...event, url };
}
