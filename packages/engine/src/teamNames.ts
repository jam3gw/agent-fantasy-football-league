/** Team naming (§8.4 set_team_name): onboarding only (tool layer enforces the kind), once. */
import { and, eq, ne, sql } from "drizzle-orm";
import type { EngineDb } from "./db/index.ts";
import { teams } from "./db/schema.ts";
import type { EngineResult } from "./errors.ts";
import { fail, ok } from "./errors.ts";

export const MAX_TEAM_NAME_LENGTH = 40;
export const MAX_MOTTO_LENGTH = 120;

function nameTaken(name: string) {
  return fail("name_taken", `another team is already called "${name}"`, {
    hint: "pick a different name",
  });
}

/**
 * Postgres reports a unique violation as SQLSTATE 23505. The driver's error
 * shape differs between postgres-js and PGlite, so both the code and the
 * constraint name are matched loosely rather than through one driver's type.
 */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; constraint_name?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
  const code = String(e.code ?? "");
  const named = String(e.constraint_name ?? e.constraint ?? "");
  const message = String(e.message ?? "");
  if (code === "23505" && (named === constraint || message.includes(constraint))) return true;
  return e.cause !== undefined && e.cause !== err && isUniqueViolation(e.cause, constraint);
}

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
    // woken for every reply.
    //
    // This read is only for the message. It cannot be the guarantee: onboarding
    // runs six sessions at once, and under READ COMMITTED two of them can both
    // read "not taken" and both write. `teams_name_lower_uq` is what actually
    // holds, and the catch below turns its violation into the same clean
    // refusal the agent would have got from the read.
    const taken = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(and(ne(teams.id, teamId), sql`lower(${teams.name}) = lower(${trimmed})`));
    if (taken.length > 0) return nameTaken(trimmed);

    try {
      await tx.update(teams).set({ name: trimmed, motto: motto ?? null }).where(eq(teams.id, teamId));
    } catch (err) {
      if (isUniqueViolation(err, "teams_name_lower_uq")) return nameTaken(trimmed);
      throw err;
    }
    return ok({ name: trimmed, motto: motto ?? null });
  });
}
