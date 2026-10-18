import { afterEach, describe, expect, it, vi } from "vitest";
import { failBuildOnReadError } from "../lib/buildPhase";

describe("failBuildOnReadError", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is true only while a production deploy is building", () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(failBuildOnReadError()).toBe(true);
  });

  it("is false on a preview build, which has no database", () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(failBuildOnReadError()).toBe(false);
  });

  it("is false at request time and in a local build", () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(failBuildOnReadError()).toBe(false);
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("VERCEL_ENV", "");
    expect(failBuildOnReadError()).toBe(false);
  });
});
