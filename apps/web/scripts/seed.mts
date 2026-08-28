/**
 * Seed the league's fixed rows. Runs on every deploy, right after the
 * migrations, so a fresh database — a preview branch, a restored backup, the
 * first production deploy — is complete without anyone touching it. §2's
 * "no manual data entry" applies to setup too.
 *
 * Every step is create-if-absent. Nothing here overwrites a value the league
 * or the commissioner has since changed: not a team's name, not a swapped
 * model, not an edited alarm threshold. Re-running it is a no-op.
 *
 * Uses Neon's HTTP driver for the same reason the migration script does: the
 * build environment has outbound HTTPS and nothing else.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import {
  DEFAULT_IR_ELIGIBLE_STATUSES,
  DEFAULT_ROSTER_SLOTS,
  DEFAULT_SCORING_SETTINGS,
  costAlarmRules,
  leagueSettings,
  modelPrices,
  teams,
  toolCosts,
} from "@league/engine";
import { DEFAULT_ALARM_RULES, LEAGUE_MODELS, MODEL_PRICE_SEED } from "@league/agent";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const season = Number(process.env.LEAGUE_SEASON ?? 2026);

const db = drizzle(neon(url));

/** The league settings singleton (§6). Created once; never overwritten. */
await db
  .insert(leagueSettings)
  .values({
    id: 1,
    season,
    rosterSlots: DEFAULT_ROSTER_SLOTS,
    scoringSettings: DEFAULT_SCORING_SETTINGS,
    irEligibleStatuses: DEFAULT_IR_ELIGIBLE_STATUSES,
  })
  .onConflictDoNothing({ target: leagueSettings.id });

/**
 * The twelve teams (§2). `name` stays null: the agent names its own team in
 * its onboarding session (§8.6), and that is the point of the exercise.
 *
 * `tiebreak_rand` is drawn once here and then fixed for the season — it is the
 * last tiebreak in the standings (§7.6), so it must never change afterwards.
 */
for (const model of LEAGUE_MODELS) {
  await db
    .insert(teams)
    .values({
      slug: `team-${model.slot}`,
      modelId: model.modelId,
      modelLabel: model.label,
      provider: model.provider,
      tiebreakRand: Math.random(),
    })
    .onConflictDoNothing({ target: teams.slug });
}

/** Catalog list prices (§8.7). The gateway's own cost is preferred at runtime. */
for (const [modelId, price] of Object.entries(MODEL_PRICE_SEED)) {
  await db
    .insert(modelPrices)
    .values({
      modelId,
      inputUsdPerM: price.input,
      outputUsdPerM: price.output,
      cachedInputUsdPerM: price.cachedInput ?? null,
      contextWindow: price.contextWindow,
      source: "catalog_seed",
    })
    .onConflictDoNothing({ target: modelPrices.modelId });
}

/** Alarm rules (§8.7). Thresholds are alarm points, never caps. */
const existingRules = await db.select({ id: costAlarmRules.id }).from(costAlarmRules);
if (existingRules.length === 0) {
  await db.insert(costAlarmRules).values(
    DEFAULT_ALARM_RULES.map((r) => ({
      scope: r.scope,
      thresholdUsd: r.thresholdUsd,
      stepUsd: r.stepUsd,
      enabled: true,
      channels: ["email", "site"],
    })),
  );
}

/** Per-call tool prices (§8.7). FantasyPros is free; the rest the commissioner sets. */
for (const [toolName, usdPerCall] of [
  ["web_search", 0],
  ["read_url", 0],
] as const) {
  await db
    .insert(toolCosts)
    .values({ toolName, usdPerCall })
    .onConflictDoNothing({ target: toolCosts.toolName });
}

console.log("seed complete");
