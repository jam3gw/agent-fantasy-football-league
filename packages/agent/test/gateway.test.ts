/**
 * The gateway catalog and the weekly price sync (§8.1, §8.7).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FixedClock } from "@league/shared";
import type { EngineDb } from "@league/engine";
import { modelPrices } from "@league/engine";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { checkGatewayModelId, syncModelPrices } from "../src/gateway.ts";
import { LEAGUE_MODELS } from "../src/models.ts";

let db: TestDb;
let close: () => Promise<void>;
const clock = new FixedClock("2026-09-07T07:00:00Z");

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

function catalog(models: Array<Record<string, unknown>>): typeof fetch {
  return (async () => new Response(JSON.stringify({ data: models }), { status: 200 })) as unknown as typeof fetch;
}

const CATALOG = [
  {
    id: "mistral/mistral-large-3",
    context_window: 256000,
    pricing: { input: "0.0000005", output: "0.0000015" },
  },
  {
    id: "anthropic/claude-fable-5",
    context_window: 1000000,
    pricing: { input: "0.00001", output: "0.00005", input_cache_read: "0.000001", regional: { us: { input: "0.000011" } } },
  },
  { id: "zai/glm-5.3-promo-50", context_window: 1048576, pricing: { input: "0.0000007", output: "0.0000022", input_cache_read: "0.00000013" } },
];

describe("checkGatewayModelId", () => {
  it("answers ok / not_found from the catalog, and unknown when it cannot be read", async () => {
    const fetchImpl = catalog(CATALOG);
    expect(await checkGatewayModelId("zai/glm-5.3-promo-50", { apiKey: "k", fetchImpl })).toBe("ok");
    expect(await checkGatewayModelId("zai/glm-9", { apiKey: "k", fetchImpl })).toBe("not_found");
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect(await checkGatewayModelId("zai/glm-5.3-promo-50", { apiKey: "k", fetchImpl: down })).toBe("unknown");
  });
});

describe("syncModelPrices (§8.7 weekly refresh)", () => {
  it("rewrites the table from the catalog's base price, per million, and leaves unlisted ids alone", async () => {
    const engineDb = db as unknown as EngineDb;
    await db.insert(modelPrices).values([
      { modelId: "mistral/mistral-large-3", inputUsdPerM: 2, outputUsdPerM: 6, cachedInputUsdPerM: 0.5, contextWindow: 128000, source: "catalog_seed" },
      { modelId: "meta/muse-spark-1.2", inputUsdPerM: 1.25, outputUsdPerM: 4.25, cachedInputUsdPerM: 0.15, contextWindow: 1048576, source: "catalog_seed" },
    ]);

    const result = await syncModelPrices(engineDb, clock, { apiKey: "k", fetchImpl: catalog(CATALOG), modelIds: [] });
    expect(result.ok).toBe(true);

    const mistral = (await db.select().from(modelPrices).where(eq(modelPrices.modelId, "mistral/mistral-large-3")))[0]!;
    expect(mistral.inputUsdPerM).toBe(0.5);
    expect(mistral.outputUsdPerM).toBe(1.5);
    expect(mistral.cachedInputUsdPerM).toBeNull();
    expect(mistral.contextWindow).toBe(256000);
    expect(mistral.source).toBe("catalog_sync");

    // The base rate, never the region-pinned one.
    const fable = (await db.select().from(modelPrices).where(eq(modelPrices.modelId, "anthropic/claude-fable-5")))[0]!;
    expect(fable.inputUsdPerM).toBe(10);
    expect(fable.cachedInputUsdPerM).toBe(1);

    // League models with no row yet are added when the catalog has them...
    expect(result.updated).toContain("zai/glm-5.3-promo-50");
    // ...and every id the catalog lacks is reported, with its row untouched.
    expect(result.missing).toContain("meta/muse-spark-1.2");
    for (const m of LEAGUE_MODELS) {
      if (!CATALOG.some((c) => c.id === m.modelId)) expect(result.missing).toContain(m.modelId);
    }
    const muse = (await db.select().from(modelPrices).where(eq(modelPrices.modelId, "meta/muse-spark-1.2")))[0]!;
    expect(muse.inputUsdPerM).toBe(1.25);
    expect(muse.source).toBe("catalog_seed");
  });

  it("skips an entry with no usable price, keeps a stored context window the catalog omits, and moves the stamp on a resync", async () => {
    const engineDb = db as unknown as EngineDb;
    await db.insert(modelPrices).values([
      { modelId: "moonshotai/kimi-k3", inputUsdPerM: 3, outputUsdPerM: 15, contextWindow: 1000000, source: "catalog_seed" },
      { modelId: "spacexai/grok-4.6", inputUsdPerM: 2, outputUsdPerM: 6, contextWindow: 500000, source: "catalog_seed" },
    ]);
    const odd = [
      { id: "moonshotai/kimi-k3", context_window: 1000000, pricing: { input: "n/a", output: "0.000015" } }, // unusable price
      { id: "spacexai/grok-4.6", pricing: { input: "0.000002", output: "0.000006" } }, // no context window
    ];
    const first = await syncModelPrices(engineDb, clock, { apiKey: "k", fetchImpl: catalog(odd), modelIds: [] });
    expect(first.ok).toBe(true);
    expect(first.missing).toContain("moonshotai/kimi-k3");
    expect(first.missingInUse).toContain("moonshotai/kimi-k3"); // a seat runs on it

    const kimi = (await db.select().from(modelPrices).where(eq(modelPrices.modelId, "moonshotai/kimi-k3")))[0]!;
    expect(kimi.inputUsdPerM).toBe(3);
    expect(kimi.source).toBe("catalog_seed");

    const grok = (await db.select().from(modelPrices).where(eq(modelPrices.modelId, "spacexai/grok-4.6")))[0]!;
    expect(grok.source).toBe("catalog_sync");
    expect(grok.contextWindow).toBe(500000); // kept, not nulled
    const stamp = grok.updatedAt.getTime();

    const later = new FixedClock("2026-09-14T07:00:00Z");
    await syncModelPrices(engineDb, later, { apiKey: "k", fetchImpl: catalog(odd), modelIds: [] });
    const again = (await db.select().from(modelPrices).where(eq(modelPrices.modelId, "spacexai/grok-4.6")))[0]!;
    expect(again.updatedAt.getTime()).toBeGreaterThan(stamp);
    expect(again.inputUsdPerM).toBe(2);
  });

  it("changes nothing when the catalog cannot be read", async () => {
    const engineDb = db as unknown as EngineDb;
    await db.insert(modelPrices).values({ modelId: "mistral/mistral-large-3", inputUsdPerM: 2, outputUsdPerM: 6, source: "catalog_seed" });
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const result = await syncModelPrices(engineDb, clock, { apiKey: "k", fetchImpl: down });
    expect(result.ok).toBe(false);
    const row = (await db.select().from(modelPrices).where(eq(modelPrices.modelId, "mistral/mistral-large-3")))[0]!;
    expect(row.inputUsdPerM).toBe(2);
  });
});
