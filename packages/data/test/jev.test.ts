import { describe, expect, it, vi } from "vitest";
import type { JevRequest } from "@league/engine";
import { JevCallError } from "@league/engine";
import { JEV_URL, jevClient, parseGatewayCost } from "../src/jev.ts";

const req: JevRequest = {
  state: { player: { name: "A" } },
  questions: { plays: { type: "noul", instructions: "Will `player` play?" } },
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("jevClient (§11.1)", () => {
  it("posts to the gateway's TypeSafe endpoint with the model, state and questions, the key in the header only", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json(200, {
        model: "typesafe-ai/jev",
        answers: { plays: { type: "noul", noul: 0.83 } },
        usage: { input_tokens: 312, output_tokens: 20 },
        provider_metadata: { gateway: { cost: "0.0000131", generationId: "gen_1" } },
      }),
    );
    const ask = jevClient({ apiKey: "sk-secret", fetchImpl: fetchImpl as typeof fetch, backoffMs: 0 });
    const reply = await ask(req);
    expect(reply).toEqual({ model: "typesafe-ai/jev", answers: { plays: { type: "noul", noul: 0.83 } }, inputTokens: 312, costUsd: 0.0000131 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(JEV_URL);
    expect(JEV_URL).toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-secret");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ model: "typesafe-ai/jev", state: req.state, questions: req.questions });
    expect(String(init?.body)).not.toContain("sk-secret");
  });

  it("parses a choice answer", async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, {
        model: "typesafe-ai/jev",
        answers: { winner: { type: "choice", choice: "home", probabilities: { home: 0.64, away: 0.36 }, confidence: 0.28 } },
        usage: { input_tokens: 2100 },
      }),
    );
    const reply = await jevClient({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch })(req);
    expect(reply.answers.winner).toEqual({ type: "choice", choice: "home", probabilities: { home: 0.64, away: 0.36 }, confidence: 0.28 });
    // No gateway cost in the reply: the caller falls back to the price table.
    expect(reply.costUsd).toBeNull();
  });

  it("retries 429 and 529, honouring retry-after, then succeeds", async () => {
    const sleeps: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      sleeps.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(429, { error: "rate" }, { "retry-after": "2" }))
      .mockResolvedValueOnce(json(529, { error: "overloaded" }))
      .mockResolvedValueOnce(json(200, { model: "typesafe-ai/jev", answers: {}, usage: { input_tokens: 1 } }));
    const reply = await jevClient({ apiKey: "k", fetchImpl, backoffMs: 5, retries: 3 })(req);
    expect(reply.model).toBe("typesafe-ai/jev");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2000, 10]);
    vi.restoreAllMocks();
  });

  it("does not retry a 401 or 422, and never puts the key in the error", async () => {
    const fetchImpl = vi.fn(async () => json(401, { error: "invalid key" }));
    const err = await jevClient({ apiKey: "sk-secret", fetchImpl: fetchImpl as typeof fetch, backoffMs: 0 })(req).catch((e: Error) => e);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(err)).toMatch(/HTTP 401 from Jev via AI Gateway/);
    expect(String(err)).not.toContain("sk-secret");
  });

  it("stops retrying once the caller's signal aborts", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort(new Error("jev: the Jev phase ran past its deadline"));
      return json(529, { error: "overloaded" });
    });
    const err = await jevClient({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch, backoffMs: 0, retries: 3 })(req, {
      signal: controller.signal,
    }).catch((e: Error) => e);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // The caller's deadline is the reason, not the 529 it cut short.
    expect(String(err)).toMatch(/deadline/);
  });

  it("aborts a call in flight when the caller's signal fires", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    const pending = jevClient({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch, backoffMs: 0, retries: 3 })(req, {
      signal: controller.signal,
    }).catch((e: Error) => e);
    controller.abort(new Error("jev: the Jev phase ran past its deadline"));
    expect(String(await pending)).toMatch(/deadline/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("an answered but unusable reply carries its usage and cost", async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, { model: "typesafe-ai/jev", usage: { input_tokens: 500 }, provider_metadata: { gateway: { cost: "0.00002" } } }),
    );
    const err = await jevClient({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch, backoffMs: 0 })(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JevCallError);
    expect(err).toMatchObject({ message: "jev: response has no answers", inputTokens: 500, costUsd: 0.00002 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("parseGatewayCost accepts only a non-negative number or numeric string", () => {
    expect(parseGatewayCost("0.00001155")).toBeCloseTo(0.00001155);
    expect(parseGatewayCost(0.5)).toBe(0.5);
    for (const bad of [null, undefined, "", "  ", "abc", "-1", -1, true, {}]) expect(parseGatewayCost(bad), String(bad)).toBeNull();
  });

  it("retries a timeout while the body is read, but not a body that is not JSON", async () => {
    const timeoutBody = () => {
      const r = new Response("{}", { status: 200 });
      vi.spyOn(r, "json").mockRejectedValue(new DOMException("timed out", "TimeoutError"));
      return r;
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(timeoutBody())
      .mockResolvedValueOnce(json(200, { model: "typesafe-ai/jev", answers: {}, usage: { input_tokens: 1 } }));
    const reply = await jevClient({ apiKey: "k", fetchImpl, backoffMs: 0 })(req);
    expect(reply.model).toBe("typesafe-ai/jev");
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const notJson = vi.fn(async () => new Response("<html>", { status: 200 }));
    await expect(jevClient({ apiKey: "k", fetchImpl: notJson as typeof fetch, backoffMs: 0 })(req)).rejects.toThrow("jev: response is not JSON");
    expect(notJson).toHaveBeenCalledTimes(1);
  });

  it("fails fast on a malformed reply", async () => {
    const fetchImpl = vi.fn(async () => json(200, { answers: {} }));
    await expect(jevClient({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch, backoffMs: 0 })(req)).rejects.toThrow("jev: response has no model");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
