/**
 * Custom events for Vercel Web Analytics. The team is on Pro without Web
 * Analytics Plus, which allows two properties per event; Vercel drops the rest
 * without an error, so the cap is enforced in `buildEvent` and guarded here.
 * The component checks are source-level: the events fire from click handlers
 * the suite never renders.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EVENTS,
  LIVE_WATCH_SECONDS,
  MAX_LENGTH,
  MAX_PROPERTIES,
  buildEvent,
  countsAsStepOpen,
  filterUrl,
  pageOf,
  queryChanged,
} from "@/lib/analytics";
import { beforeSend } from "@/components/analytics";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(`${appRoot}${p}`, "utf8");

describe("buildEvent", () => {
  it("passes a well-formed event through unchanged", () => {
    expect(buildEvent(EVENTS.filter, { page: "/trades", key: "team" })).toEqual({
      name: "Filter",
      properties: { page: "/trades", key: "team" },
    });
    expect(buildEvent(EVENTS.toggleSteps, { open: true, steps: 6 })).not.toBeNull();
    expect(buildEvent(EVENTS.showMore)).toEqual({ name: "Show more", properties: {} });
  });

  it("caps properties at the Pro plan limit", () => {
    expect(MAX_PROPERTIES).toBe(2);
    expect(buildEvent(EVENTS.filter, { a: "1", b: "2", c: "3" })).toBeNull();
  });

  it("rejects names, keys and values past 255 characters", () => {
    const long = "x".repeat(MAX_LENGTH + 1);
    expect(buildEvent(long as never)).toBeNull();
    expect(buildEvent(EVENTS.filter, { [long]: "v" })).toBeNull();
    expect(buildEvent(EVENTS.filter, { page: long })).toBeNull();
    expect(buildEvent(EVENTS.filter, { page: "x".repeat(MAX_LENGTH) })).not.toBeNull();
  });

  it("allows only strings, numbers, booleans and null", () => {
    expect(buildEvent(EVENTS.filter, { n: null })).not.toBeNull();
    expect(buildEvent(EVENTS.filter, { o: {} as never })).toBeNull();
    expect(buildEvent(EVENTS.filter, { u: undefined as never })).toBeNull();
  });

  it("every event in the vocabulary sends at most two properties from its call sites", () => {
    // Each `trackEvent(EVENTS.x, { ... })` literal in the components.
    const sources = [
      "components/list-controls.tsx",
      "components/compare.tsx",
      "components/session-rail.tsx",
      "components/step-open-tracker.tsx",
      "components/team-page.tsx",
      "components/sessions-list.tsx",
      "lib/useLiveWatched.ts",
    ]
      .map(read)
      .join("\n");
    const calls = [...sources.matchAll(/trackEvent\(EVENTS\.\w+, \{([^}]*)\}\)/g)];
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const [, props] of calls) {
      const keys = props.split(",").filter((s) => s.trim().length > 0);
      expect(keys.length).toBeLessThanOrEqual(MAX_PROPERTIES);
    }
  });
});

describe("pageOf", () => {
  it("folds dynamic segments into one route", () => {
    expect(pageOf("/matchups/3")).toBe("/matchups/[week]");
    expect(pageOf("/teams/claude")).toBe("/teams/[slug]");
    expect(pageOf("/sessions/abc-123")).toBe("/sessions/[id]");
    expect(pageOf("/players/42")).toBe("/players/[id]");
    expect(pageOf("/trades")).toBe("/trades");
  });
});

describe("filterUrl (beforeSend)", () => {
  it("drops every admin page, and only admin pages", () => {
    expect(filterUrl("https://league.example/admin")).toBeNull();
    expect(filterUrl("https://league.example/admin/health")).toBeNull();
    expect(filterUrl("https://league.example/admin/login?next=/admin")).toBeNull();
    expect(filterUrl("https://league.example/administrivia")).toBe("https://league.example/administrivia");
    expect(filterUrl("https://league.example/")).toBe("https://league.example/");
  });

  it("strips filter state and anchors from the reported URL", () => {
    expect(filterUrl("https://league.example/trades?team=claude&status=open")).toBe("https://league.example/trades");
    expect(filterUrl("https://league.example/sessions/12#step-4")).toBe("https://league.example/sessions/12");
  });

  it("drops a URL it cannot parse instead of throwing", () => {
    expect(filterUrl("not a url")).toBeNull();
  });
});

describe("live watch", () => {
  it("waits long enough that a bounce does not count, once per mount, visible tab only", () => {
    expect(LIVE_WATCH_SECONDS).toBeGreaterThanOrEqual(30);
    const hook = read("lib/useLiveWatched.ts");
    expect(hook).toMatch(/setTimeout/);
    expect(hook).not.toMatch(/setInterval/);
    expect(hook).toMatch(/const fired = useRef\(false\)/);
    expect(hook).toMatch(/fired\.current = true/);
    expect(hook).toMatch(/document\.visibilityState !== "visible"\) return;/);
    expect(hook).toMatch(/addEventListener\("visibilitychange"/);
    expect(read("app/sessions/[id]/live.tsx")).toMatch(/useLiveWatched\("session", summary\.status === "running"\)/);
    expect(read("app/draft/live.tsx")).toMatch(/useLiveWatched\("draft", state\?\.status === "running"\)/);
  });
});

describe("step opened", () => {
  it("counts a click on a closed step card's summary and nothing else", () => {
    expect(countsAsStepOpen({ stepCard: true, open: false })).toBe(true);
    expect(countsAsStepOpen({ stepCard: true, open: true })).toBe(false);
    expect(countsAsStepOpen({ stepCard: false, open: false })).toBe(false);
  });

  it("listens for clicks, not toggle, so React and the rail opening cards are not counted", () => {
    expect(read("components/session-view.tsx")).toMatch(/<StepOpenTracker \/>/);
    expect(read("components/session-steps.tsx")).toMatch(/data-step-kind=/);
    const tracker = read("components/step-open-tracker.tsx");
    expect(tracker).toMatch(/addEventListener\("click", onDocumentClick, true\)/);
    expect(tracker).not.toMatch(/"toggle"/);
    expect(tracker).toMatch(/closest\("summary"\)/);
    expect(read("components/session-rail.tsx")).not.toMatch(/step-open-tracker/);
  });
});

describe("filter change", () => {
  it("fires only when the URL state actually changed", () => {
    expect(queryChanged("?team=a", "team=a")).toBe(false);
    expect(queryChanged("", "")).toBe(false);
    expect(queryChanged("?team=a", "team=b")).toBe(true);
    expect(queryChanged("", "team=a")).toBe(true);
    expect(read("components/list-controls.tsx")).toMatch(/if \(key && queryChanged\(before, query\)\) trackEvent/);
  });
});

describe("beforeSend", () => {
  it("drops admin events and rewrites the URL on the rest, keeping the event type", () => {
    expect(beforeSend({ type: "event", url: "https://x/admin/health" })).toBeNull();
    expect(beforeSend({ type: "pageview", url: "https://x/admin" })).toBeNull();
    expect(beforeSend({ type: "pageview", url: "https://x/trades?team=a" })).toEqual({
      type: "pageview",
      url: "https://x/trades",
    });
    expect(beforeSend({ type: "event", url: "https://x/sessions/3#step-2" })).toEqual({
      type: "event",
      url: "https://x/sessions/3",
    });
  });
});

describe("track wrapper", () => {
  it("imports the client track() from the package root, as the docs say", () => {
    const wrapper = read("lib/track.ts");
    expect(wrapper).toMatch(/^"use client";/);
    expect(wrapper).toMatch(/import \{ track \} from "@vercel\/analytics";/);
    expect(wrapper).not.toMatch(/@vercel\/analytics\/(next|server)/);
  });

  it("is used from the interactive client components and nowhere on the server", () => {
    for (const file of [
      "components/list-controls.tsx",
      "components/compare.tsx",
      "components/session-rail.tsx",
      "components/step-open-tracker.tsx",
      "components/team-page.tsx",
      "components/sessions-list.tsx",
    ]) {
      const src = read(file);
      expect(src).toMatch(/^"use client";/);
      expect(src).toMatch(/from "@\/lib\/track"/);
    }
    expect(read("app/layout.tsx")).not.toMatch(/lib\/track/);
  });
});
