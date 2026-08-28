import { eq } from "drizzle-orm";
import type { EngineDb } from "./db/index.ts";
import type { RosterSlots } from "./db/schema.ts";
import { leagueSettings } from "./db/schema.ts";

/** Sleeper default PPR expected values (Appendix A). Final values come from the M2 fit. */
export const DEFAULT_SCORING_SETTINGS: Record<string, number> = {
  pass_yd: 0.04,
  pass_td: 4,
  pass_int: -1,
  pass_2pt: 2,
  rush_yd: 0.1,
  rush_td: 6,
  rush_2pt: 2,
  rec: 1,
  rec_yd: 0.1,
  rec_td: 6,
  rec_2pt: 2,
  fum_lost: -2,
  fum_rec_td: 6,
  xpm: 1,
  xpmiss: -1,
  fgm_0_19: 3,
  fgm_20_29: 3,
  fgm_30_39: 3,
  fgm_40_49: 4,
  fgm_50p: 5,
  fgmiss: -1,
  sack: 1,
  int: 2,
  ff: 1,
  fum_rec: 2,
  safe: 2,
  blk_kick: 2,
  def_td: 6,
  def_st_td: 6,
  def_st_ff: 1,
  def_st_fum_rec: 1,
  st_td: 6,
  st_ff: 1,
  st_fum_rec: 1,
  pts_allow_0: 10,
  pts_allow_1_6: 7,
  pts_allow_7_13: 4,
  pts_allow_14_20: 1,
  pts_allow_21_27: 0,
  pts_allow_28_34: -1,
  pts_allow_35p: -4,
};

export const DEFAULT_ROSTER_SLOTS: RosterSlots = {
  QB: 1,
  RB: 2,
  WR: 2,
  TE: 1,
  FLEX: 1,
  DST: 1,
  K: 1,
  BN: 5,
  IR: 1,
};

/** IR-eligible statuses (§3.6, default; editable in settings). */
export const DEFAULT_IR_ELIGIBLE_STATUSES = ["IR", "PUP", "NFI", "Out", "Sus"];

export type LeagueSettings = typeof leagueSettings.$inferSelect;

/** Insert the singleton settings row with SPEC §2 defaults (id = 1). */
export async function initLeagueSettings(
  db: EngineDb,
  overrides: Partial<typeof leagueSettings.$inferInsert> & { season: number },
): Promise<LeagueSettings> {
  const rows = await db
    .insert(leagueSettings)
    .values({
      id: 1,
      rosterSlots: DEFAULT_ROSTER_SLOTS,
      scoringSettings: DEFAULT_SCORING_SETTINGS,
      irEligibleStatuses: DEFAULT_IR_ELIGIBLE_STATUSES,
      ...overrides,
    })
    .returning();
  return rows[0]!;
}

export async function getSettings(db: EngineDb): Promise<LeagueSettings> {
  const rows = await db.select().from(leagueSettings).where(eq(leagueSettings.id, 1));
  const row = rows[0];
  if (!row) throw new Error("league_settings singleton missing — initLeagueSettings was never run");
  return row;
}

export async function updateSettings(
  db: EngineDb,
  patch: Partial<Omit<typeof leagueSettings.$inferInsert, "id">>,
): Promise<LeagueSettings> {
  const rows = await db
    .update(leagueSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(leagueSettings.id, 1))
    .returning();
  return rows[0]!;
}
