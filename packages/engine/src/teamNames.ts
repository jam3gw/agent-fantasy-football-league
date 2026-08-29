/** Team naming (§8.4 set_team_name): onboarding only (tool layer enforces the kind), once. */
import { and, eq, ne, sql } from "drizzle-orm";
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
    // Names must be unique, case-insensitively. Board mentions route by
    // matching `@Team Name` against every team's name (board.ts), so two teams
    // with the same name would each receive the other's mentions and both be
    // woken for every reply. The check runs inside the transaction, and the
    // whole write is serialized on the settings row above, so two agents
    // choosing the same name at the same moment cannot both win.
    const taken = await tx
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(and(ne(teams.id, teamId), sql`lower(${teams.name}) = lower(${trimmed})`));
    if (taken.length > 0) {
      return fail("name_taken", `another team is already called "${trimmed}"`, {
        hint: "pick a different name",
      });
    }
    await tx.update(teams).set({ name: trimmed, motto: motto ?? null }).where(eq(teams.id, teamId));
    return ok({ name: trimmed, motto: motto ?? null });
  });
}
