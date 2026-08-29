/**
 * The commissioner login went down on production twice in one afternoon, both
 * times because a required variable was absent from the deployment's build-time
 * environment snapshot. The page that would have explained it, /admin/health,
 * sits behind the same login — so the commissioner got a bare HTTP 500 and no
 * way in.
 *
 * Two guarantees here: SESSION_SECRET is no longer required (it is derived from
 * the commissioner password), and whatever is still missing is named on the one
 * page anonymous visitors can reach.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const saved = { ...process.env };

async function freshEnv() {
  // env.ts reads process.env through getters, but the module caches nothing we
  // need to reset; adminConfig is imported fresh so "server-only" stays happy.
  const mod = await import("../lib/adminConfig");
  return mod;
}

beforeEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.COMMISSIONER_PASSWORD;
});
afterEach(() => {
  process.env = { ...saved };
});

describe("commissioner auth configuration", () => {
  it("needs no SESSION_SECRET when the password is long enough", async () => {
    process.env.COMMISSIONER_PASSWORD = "a-sufficiently-long-commissioner-password";
    const { adminConfigProblem } = await freshEnv();
    expect(adminConfigProblem()).toBeNull();
  });

  it("derives a stable, non-obvious cookie key from the password", async () => {
    process.env.COMMISSIONER_PASSWORD = "a-sufficiently-long-commissioner-password";
    const { env } = await import("../lib/env");
    const first = env.sessionSecret;
    const second = env.sessionSecret;
    // Stable across reads, or every request would invalidate the last cookie.
    expect(first).toBe(second);
    // Never the password itself: the cookie must not carry password material.
    expect(first).not.toContain("commissioner-password");
    expect(first.length).toBeGreaterThan(20);
  });

  it("refuses to derive a key from a short password, and says both remedies", async () => {
    process.env.COMMISSIONER_PASSWORD = "short";
    const { adminConfigProblem } = await freshEnv();
    const problem = adminConfigProblem();
    expect(problem).toMatch(/COMMISSIONER_PASSWORD/);
    expect(problem).toMatch(/SESSION_SECRET/);
  });

  it("lets an explicit SESSION_SECRET override the length rule", async () => {
    process.env.COMMISSIONER_PASSWORD = "short";
    process.env.SESSION_SECRET = "an-explicit-random-signing-secret";
    const { adminConfigProblem } = await freshEnv();
    expect(adminConfigProblem()).toBeNull();
  });

  it("names the missing variable rather than throwing", async () => {
    const { adminConfigProblem } = await freshEnv();
    expect(adminConfigProblem()).toMatch(/COMMISSIONER_PASSWORD is not set/);
  });
});
