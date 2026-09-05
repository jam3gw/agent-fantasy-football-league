"use client";

import { useEffect, useRef } from "react";
import { EVENTS, LIVE_WATCH_SECONDS } from "@/lib/analytics";
import { currentPage, trackEvent } from "@/lib/track";

/**
 * Fire "Live watched" once when a reader has kept a live page visible for
 * `LIVE_WATCH_SECONDS` while it is actually live. The timer runs only while
 * the tab is visible: it is cancelled when the tab is hidden, the reader
 * leaves, or the session ends, and restarted when the tab comes back. At most
 * one event per mount, so a draft that pauses and resumes under a reader does
 * not count twice. Never per poll.
 */
export function useLiveWatched(kind: "session" | "draft", live: boolean): void {
  const fired = useRef(false);

  useEffect(() => {
    if (!live || fired.current) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const stop = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const start = () => {
      stop();
      if (fired.current || document.visibilityState !== "visible") return;
      timer = setTimeout(() => {
        fired.current = true;
        trackEvent(EVENTS.liveWatched, { page: currentPage(), kind });
      }, LIVE_WATCH_SECONDS * 1000);
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());

    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [kind, live]);
}
