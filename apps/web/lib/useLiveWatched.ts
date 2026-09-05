"use client";

import { useEffect } from "react";
import { EVENTS, LIVE_WATCH_SECONDS } from "@/lib/analytics";
import { currentPage, trackEvent } from "@/lib/track";

/**
 * Fire "Live watched" once when a reader has stayed on a live page for
 * `LIVE_WATCH_SECONDS` while it is actually live. Leaving earlier, or the
 * session finishing earlier, cancels the timer. One event per page visit,
 * never per poll.
 */
export function useLiveWatched(kind: "session" | "draft", live: boolean): void {
  useEffect(() => {
    if (!live) return;
    const timer = setTimeout(
      () => trackEvent(EVENTS.liveWatched, { page: currentPage(), kind }),
      LIVE_WATCH_SECONDS * 1000,
    );
    return () => clearTimeout(timer);
  }, [kind, live]);
}
