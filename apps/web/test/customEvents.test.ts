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
import { EVENTS, LIVE_WATCH_SECONDS, MAX_LENGTH, MAX_PROPERTIES, buildEvent, filterUrl, pageOf } from "@/lib/analytics";

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
      "lib/useLiveWatched.ts",
    ]
      .map(read)
      .join("\n");
    const calls = [...sources.matchAll(/trackEvent\(EVENTS\.\w+, \{([^}]*)\}\)/g)];
    expect(calls.length).toBeGreaterThanOrEqual(7);
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
  it("waits long enough that a bounce does not count, once per visit", () => {
    expect(LIVE_WATCH_SECONDS).toBeGreaterThanOrEqual(30);
    const hook = read("lib/useLiveWatched.ts");
    expect(hook).toMatch(/setTimeout/);
    expect(hook).not.toMatch(/setInterval/);
    expect(read("app/sessions/[id]/live.tsx")).toMatch(/useLiveWatched\("session", active\)/);
    expect(read("app/draft/live.tsx")).toMatch(/useLiveWatched\("draft", state\?\.status === "running"\)/);
  });
});

describe("step opened", () => {
  it("is mounted on the transcript and skips bulk toggles from the rail", () => {
    expect(read("components/session-view.tsx")).toMatch(/<StepOpenTracker \/>/);
    expect(read("components/session-steps.tsx")).toMatch(/data-step-kind=/);
    const rail = read("components/session-rail.tsx");
    expect(rail).toMatch(/card\.setAttribute\(BULK_TOGGLE_FLAG, ""\);\n\s+card\.open = next;/);
    const tracker = read("components/step-open-tracker.tsx");
    expect(tracker).toMatch(/card\.hasAttribute\(BULK_TOGGLE_FLAG\)/);
    expect(tracker).toMatch(/card\.removeAttribute\(BULK_TOGGLE_FLAG\)/);
    expect(tracker).toMatch(/if \(!card\.open \|\| bulk\) return;/);
  });
});

describe("track wrapper", () => {
  it("imports the client track() from the package root, as the docs say", () => {
    const wrapper = read("lib/track.ts");
    expect(wrapper).toMatch(/^"use client";/);
    expect(wrapper).toMatch(/import \{ track \} from "@vercel\/analytics";/);
    expect(wrapper).not.toMatch(/@vercel\/analytics\/(next|server)/);
  });

  it("is used from the four interactive components and nowhere on the server", () => {
    for (const file of [
      "components/list-controls.tsx",
      "components/compare.tsx",
      "components/session-rail.tsx",
      "components/step-open-tracker.tsx",
      "components/team-page.tsx",
    ]) {
      const src = read(file);
      expect(src).toMatch(/^"use client";/);
      expect(src).toMatch(/from "@\/lib\/track"/);
    }
    expect(read("app/layout.tsx")).not.toMatch(/lib\/track/);
  });
});
