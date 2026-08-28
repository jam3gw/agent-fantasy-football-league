/**
 * 15.1.1 — scoring fit: dot product of scoring_settings and Sleeper stats
 * reproduces pts_ppr (±0.01) for every player in the 2025 W1–3 fixtures.
 * The four known Sleeper-side inconsistencies (docs/VERIFIED.md) are asserted
 * explicitly so any NEW unexplained key fails the test.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCORING_SETTINGS } from "@league/engine";
import { computeEnginePts } from "../src/ingest/stats.ts";
import type { SleeperStatsEntry } from "../src/sleeper.ts";

function loadWeek(w: number): SleeperStatsEntry[] {
  const path = fileURLToPath(new URL(`../../../fixtures/sleeper/stats_2025_w${w}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Sleeper rows whose own pts_ppr contradicts their own stats (VERIFIED.md 2026-08-28). */
const KNOWN_SLEEPER_INCONSISTENCIES = new Set(["5:2374", "5:TEN", "16:JAX", "18:1945"]);

describe("scoring fit (15.1.1)", () => {
  it("reproduces pts_ppr for every scored player, W1–3", () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const w of [1, 2, 3]) {
      for (const e of loadWeek(w)) {
        const pts = e.stats?.pts_ppr;
        if (typeof pts !== "number") continue;
        checked++;
        const engine = computeEnginePts(DEFAULT_SCORING_SETTINGS, e.stats);
        if (Math.abs(engine - pts) > 0.01) mismatches.push(`${w}:${e.player_id}`);
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(mismatches).toEqual([]);
  });

  it("holds across all 18 weeks except the four documented Sleeper inconsistencies", () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (let w = 1; w <= 18; w++) {
      for (const e of loadWeek(w)) {
        const pts = e.stats?.pts_ppr;
        if (typeof pts !== "number") continue;
        checked++;
        const engine = computeEnginePts(DEFAULT_SCORING_SETTINGS, e.stats);
        if (Math.abs(engine - pts) > 0.01) mismatches.push(`${w}:${e.player_id}`);
      }
    }
    expect(checked).toBeGreaterThan(6000);
    expect(new Set(mismatches)).toEqual(KNOWN_SLEEPER_INCONSISTENCIES);
  });

  it("computeEnginePts: missing keys are 0, negatives apply, rounding to 2 decimals", () => {
    expect(computeEnginePts(DEFAULT_SCORING_SETTINGS, {})).toBe(0);
    expect(
      computeEnginePts(DEFAULT_SCORING_SETTINGS, { rec: 5, rec_yd: 63, rec_td: 1, fum_lost: 1, unknown_key: 99 }),
    ).toBe(5 + 6.3 + 6 - 2);
    expect(computeEnginePts({ rec_yd: 0.1 }, { rec_yd: 7 })).toBe(0.7);
  });
});
