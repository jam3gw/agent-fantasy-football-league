import "server-only";
import { env } from "./env";

/**
 * Why the commissioner login cannot work, or null when it can.
 *
 * `/admin/health` is where a missing variable would normally show up, but it
 * sits behind the very login these variables power — so a missing one used to
 * render a bare HTTP 500 with no way in and nothing to read. The login page
 * asks this first and prints the answer.
 *
 * The message names the variable and the remedy. It never contains a value.
 */
export function adminConfigProblem(): string | null {
  for (const read of [() => env.commissionerPassword, () => env.sessionSecret]) {
    try {
      read();
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  return null;
}
