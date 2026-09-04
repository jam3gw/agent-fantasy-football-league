import { describe, expect, it } from "vitest";
import { LEAGUE_MODELS, isContributorTier, modelTierNote } from "../src/models.ts";

describe("Contributor pricing tier note", () => {
  it("names the tier only for a -contributor gateway id", () => {
    expect(isContributorTier("meta/muse-spark-1.2-contributor")).toBe(true);
    expect(isContributorTier("meta/muse-spark-1.2")).toBe(false);
    expect(modelTierNote("meta/muse-spark-1.2")).toBeNull();
    expect(modelTierNote("meta/muse-spark-1.2-contributor")).toMatch(/train/);
  });

  it("slot 11 is the one league seat on that tier", () => {
    const seats = LEAGUE_MODELS.filter((m) => isContributorTier(m.modelId)).map((m) => m.slot);
    expect(seats).toEqual([11]);
  });
});
