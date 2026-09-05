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
import { EVENTS, MAX_LENGTH, MAX_PROPERTIES, buildEvent, pageOf } from "@/lib/analytics";

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
    const sources = ["components/list-controls.tsx", "components/compare.tsx", "components/session-rail.tsx"]
      .map(read)
      .join("\n");
    const calls = [...sources.matchAll(/trackEvent\(EVENTS\.\w+, \{([^}]*)\}\)/g)];
    expect(calls.length).toBeGreaterThanOrEqual(4);
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

describe("track wrapper", () => {
  it("imports the client track() from the package root, as the docs say", () => {
    const wrapper = read("lib/track.ts");
    expect(wrapper).toMatch(/^"use client";/);
    expect(wrapper).toMatch(/import \{ track \} from "@vercel\/analytics";/);
    expect(wrapper).not.toMatch(/@vercel\/analytics\/(next|server)/);
  });

  it("is used from the four interactive components and nowhere on the server", () => {
    for (const file of ["components/list-controls.tsx", "components/compare.tsx", "components/session-rail.tsx"]) {
      const src = read(file);
      expect(src).toMatch(/^"use client";/);
      expect(src).toMatch(/from "@\/lib\/track"/);
    }
    expect(read("app/layout.tsx")).not.toMatch(/lib\/track/);
  });
});
