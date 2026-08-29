/**
 * The §15.5-critical property of /api/healthz: a public 503 carries nothing
 * but the heartbeat. That guarantee lives in a four-line catch in the route,
 * which no lint, type check, or lib test would defend — this is the
 * regression guard for the day someone helpfully adds `error: String(err)`
 * to the body of a public, unauthenticated endpoint.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/db", () => ({
  db: () => {
    // Realistic failure detail — exactly what must never reach the response.
    throw new Error("connect ECONNREFUSED db.internal:5432 (password authentication)");
  },
  leagueClock: async () => ({ now: () => new Date() }),
}));

import { GET } from "../app/api/healthz/route";

describe("/api/healthz with the database unreachable", () => {
  it("answers 503 with exactly {ok, lastTickAt} and no error detail", async () => {
    const res = await GET(new Request("https://example.com/api/healthz"));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // toEqual is exact for plain objects: any added key fails here.
    expect(await res.json()).toEqual({ ok: false, lastTickAt: null });
  });
});
