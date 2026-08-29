"use client";
/**
 * Site-wide auto-refresh (SPEC §12.1): polls the public pulse stamp with SWR
 * and calls `router.refresh()` when it moves, so server-rendered pages pick up
 * new league state without a manual reload. SWR handles the cadence: polling
 * pauses while the tab is hidden and revalidates on focus, so a wall of open
 * tabs does not hammer the API.
 *
 * Renders nothing. Mounted once in the root layout.
 */
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";

const DEFAULT_INTERVAL_MS = 20_000;

async function fetchStamp(url: string): Promise<{ stamp: string }> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`pulse ${res.status}`);
  return (await res.json()) as { stamp: string };
}

export function AutoRefresh({ intervalMs = DEFAULT_INTERVAL_MS }: { intervalMs?: number }) {
  const router = useRouter();
  const last = useRef<string | null>(null);

  const { data } = useSWR("/api/public/pulse", fetchStamp, {
    refreshInterval: intervalMs,
    revalidateOnFocus: true,
    dedupingInterval: Math.floor(intervalMs / 2),
  });

  useEffect(() => {
    if (!data) return;
    // The first stamp is the baseline for the page as rendered; only a later
    // movement means the page may be behind.
    if (last.current !== null && last.current !== data.stamp) router.refresh();
    last.current = data.stamp;
  }, [data, router]);

  return null;
}
