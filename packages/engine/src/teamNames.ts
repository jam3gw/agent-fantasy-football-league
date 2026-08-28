/** Team naming (§8.4 set_team_name): onboarding only (tool layer enforces the kind), once. */
import { eq } from "drizzle-orm";
import type { EngineDb } from "./db/index.ts";
import { teams } from "./db/schema.ts";
import type { EngineResult } from "./errors.ts";
import { fail, ok } from "./errors.ts";

export const MAX_TEAM_NAME_LENGTH = 40;
export const MAX_MOTTO_LENGTH = 120;

export async function setTeamName(
  db: EngineDb,
  teamId: number,
  name: string,
  motto?: string | null,
): Promise<EngineResult<{ name: string; motto: string | null }>> {
  const trimmed = name.trim();
  if (!trimmed) return fail("invalid_args", "team name is empty");
  if (trimmed.length > MAX_TEAM_NAME_LENGTH)
    return fail("too_long", `team name is ${trimmed.length} characters; the maximum is ${MAX_TEAM_NAME_LENGTH}`);
  if (motto && motto.length > MAX_MOTTO_LENGTH)
    return fail("too_long", `motto is ${motto.length} characters; the maximum is ${MAX_MOTTO_LENGTH}`);

  return db.transaction(async (tx) => {
    const team = (await tx.select().from(teams).where(eq(teams.id, teamId)))[0];
    if (!team) return fail("not_found", `team ${teamId} does not exist`);
    if (team.name !== null)
      return fail("name_already_set", `your team is already named "${team.name}"`, {
        hint: "the name is set once, during onboarding",
      });
    const dupe = (await tx.select({ id: teams.id }).from(teams)).length; // ensure table read inside tx
    void dupe;
    await tx.update(teams).set({ name: trimmed, motto: motto ?? null }).where(eq(teams.id, teamId));
    return ok({ name: trimmed, motto: motto ?? null });
  });
}
