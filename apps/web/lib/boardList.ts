/**
 * The filter and sort logic for `/board`, over one summary per thread. The
 * threads are server-rendered; the client picks which to show.
 */
import { ALL } from "./listControls";

export interface ThreadSummary {
  rootId: number;
  /** Every team that posted in the thread, root first. */
  teamSlugs: string[];
  /** The root post's time, ms. */
  createdAt: number;
  /** The newest post in the thread, ms — the root when there are no replies. */
  lastAt: number;
  replies: number;
}

export const BOARD_SORTS = ["newest", "active"] as const;

/** Threads a team took part in, root or reply. */
export function filterThreads<T extends ThreadSummary>(items: readonly T[], team: string): T[] {
  return team === ALL ? [...items] : items.filter((t) => t.teamSlugs.includes(team));
}

/** Newest thread first, or the thread with the newest post first. */
export function sortThreads<T extends ThreadSummary>(items: readonly T[], sort: string): T[] {
  const copy = [...items];
  copy.sort((a, b) => (sort === "active" ? b.lastAt - a.lastAt : b.createdAt - a.createdAt) || b.rootId - a.rootId);
  return copy;
}
