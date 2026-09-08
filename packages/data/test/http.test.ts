import { afterEach, describe, expect, it, vi } from "vitest";
import { RETRY_POLICY, fetchWithRetry } from "../src/http.ts";

const ORIGINAL = { ...RETRY_POLICY };
afterEach(() => {
  Object.assign(RETRY_POLICY, ORIGINAL);
  vi.unstubAllGlobals();
});

describe("fetchWithRetry", () => {
  it("reads RETRY_POLICY at call time: retries that many times, sleeping backoffMs doubling", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("down");
    });
    vi.stubGlobal("fetch", fetch);
    const sleeps: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      sleeps.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    RETRY_POLICY.retries = 2;
    RETRY_POLICY.backoffMs = 5;
    await expect(fetchWithRetry("https://example.test/a")).rejects.toThrow("down");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([5, 10]);
  });

  it("defaults to three retries and a one-second first backoff", () => {
    expect(ORIGINAL).toEqual({ retries: 3, backoffMs: 1_000 });
  });
});
