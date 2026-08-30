/** Idempotency key builders (SPEC §9.2). */

export function sessionKey(
  teamId: number | "reporter",
  kind: string,
  season: number,
  week: number,
  suffix: string | number,
): string {
  return `session:${teamId}:${kind}:${season}:${week}:${suffix}`;
}

export function jobKey(type: string, dueAtIso: string): string {
  return `job:${type}:${dueAtIso}`;
}

export function retryKey(baseKey: string, attempt: number): string {
  return attempt === 0 ? baseKey : `${baseKey}:retry${attempt}`;
}

export function draftSessionKey(pickNo: number, attempt: number): string {
  return `draft:${pickNo}:${attempt}`;
}

export function injurySessionKey(teamId: number, playerId: string, status: string, week: number): string {
  return `injury:${teamId}:${playerId}:${status}:${week}`;
}

/** An agent-booked check-in, keyed to the minute so a re-ask is idempotent. */
export function checkInKey(teamId: number, atIso: string): string {
  return `check_in:${teamId}:${atIso.slice(0, 16)}`;
}
