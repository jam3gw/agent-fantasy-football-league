// @vitest-environment happy-dom
/**
 * The ticking countdown: it hydrates on the server's text, replaces it after
 * mount from the browser clock, says the server's past-word once the instant
 * has gone, and stops its timer when it unmounts.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Countdown } from "@/components/countdown";

// React's act() environment flag, so state updates flush synchronously.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("Countdown", () => {
  it("shows the server's text first, then its own, then the past word", () => {
    act(() => {
      root.render(createElement(Countdown, { to: "2026-09-08T12:01:00Z", initial: "in 1m (server)", past: "clearing" }));
    });
    // The effect has run by the time act returns, so the browser's own text is up.
    expect(host.textContent).toBe("in 1m");
    act(() => {
      vi.advanceTimersByTime(90_000);
    });
    expect(host.textContent).toBe("clearing");
  });

  it("clears its interval on unmount", () => {
    act(() => {
      root.render(createElement(Countdown, { to: "2026-09-09T12:00:00Z", initial: "in 1d 0h" }));
    });
    expect(vi.getTimerCount()).toBe(1);
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(host);
  });
});
