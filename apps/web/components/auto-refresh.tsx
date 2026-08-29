"use client";
/**
 * Site-wide auto-refresh (SPEC §12.1): polls the public pulse stamp with SWR
 * and re-renders the page while the stamp says the world has moved. SWR
 * handles the cadence: polling pauses while the tab is hidden and revalidates
 * on focus, so a wall of open tabs does not hammer the API.
 *
 * `router.refresh()` re-fetches the RSC payload but does NOT invalidate the
 * server-side ISR cache (Next 16 use-router docs), and every public page here
 * carries a §12.1 revalidate window of up to 300 s. A single refresh on a
 * stamp movement would therefore usually re-serve the same cached payload and
 * then go quiet — the change would never appear without a manual reload. So a
 * movement opens a refresh window instead: keep refreshing on each poll until
 * the longest revalidate window has certainly lapsed since the last movement,
 * by which point one of those refreshes has both triggered the background
 * regeneration and picked it up. An idle league costs one tiny query per open
 * tab per interval and no re-renders.
 *
 * Renders nothing. Mounted once in the root layout.
 */
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";

const DEFAULT_INTERVAL_MS = 20_000;

/** The longest §12.1 revalidate window (300 s), plus slack for regeneration. */
const REFRESH_WINDOW_MS = 300_000 + 30_000;

async function fetchStamp(url: string): Promise<{ stamp: string }> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`pulse ${res.status}`);
  return (await res.json()) as { stamp: string };
}

export function AutoRefresh({ intervalMs = DEFAULT_INTERVAL_MS }: { intervalMs?: number }) {
  const router = useRouter();
  const last = useRef<string | null>(null);
  /** Wall-clock time of the last stamp movement; null = nothing pending. */
  const movedAt = useRef<number | null>(null);

  const { data } = useSWR("/api/public/pulse", fetchStamp, {
    refreshInterval: intervalMs,
    revalidateOnFocus: true,
    dedupingInterval: Math.floor(intervalMs / 2),
  });

  useEffect(() => {
    if (!data) return;
    // The first stamp is the baseline for the page as rendered; only a later
    // movement means the page may be behind.
    if (last.current !== null && last.current !== data.stamp) movedAt.current = Date.now();
    last.current = data.stamp;
    if (movedAt.current === null) return;
    router.refresh();
    if (Date.now() - movedAt.current > REFRESH_WINDOW_MS) movedAt.current = null;
  }, [data, router]);

  return null;
}
