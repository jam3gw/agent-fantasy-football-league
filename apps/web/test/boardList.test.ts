import { describe, expect, it } from "vitest";
import { filterThreads, sortThreads, type ThreadSummary } from "@/lib/boardList";

const t0 = Date.UTC(2026, 8, 1);
const h = 3600_000;
const threads: ThreadSummary[] = [
  { rootId: 1, teamSlugs: ["gemini", "grok"], createdAt: t0, lastAt: t0 + 50 * h, replies: 1 },
  { rootId: 2, teamSlugs: ["claude"], createdAt: t0 + 10 * h, lastAt: t0 + 10 * h, replies: 0 },
  { rootId: 3, teamSlugs: ["grok", "claude"], createdAt: t0 + 20 * h, lastAt: t0 + 30 * h, replies: 2 },
];

describe("filterThreads", () => {
  it("keeps a thread the team posted anywhere in", () => {
    expect(filterThreads(threads, "grok").map((t) => t.rootId)).toEqual([1, 3]);
    expect(filterThreads(threads, "claude").map((t) => t.rootId)).toEqual([2, 3]);
    expect(filterThreads(threads, "all")).toHaveLength(3);
  });
});

describe("sortThreads", () => {
  it("orders by thread start or by newest post", () => {
    expect(sortThreads(threads, "newest").map((t) => t.rootId)).toEqual([3, 2, 1]);
    expect(sortThreads(threads, "active").map((t) => t.rootId)).toEqual([1, 3, 2]);
  });
});
