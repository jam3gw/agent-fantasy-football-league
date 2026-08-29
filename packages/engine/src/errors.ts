/**
 * Engine error model. Engine functions never throw domain failures — they
 * return a Result whose error carries a stable code (§8.4: tools surface
 * `{ ok: false, error, message, hint? }` straight from these).
 * Unexpected conditions (bugs, DB failures) still throw.
 */

export type EngineErrorCode =
  | "invalid_args"
  | "not_found"
  | "not_on_roster"
  | "duplicate_player"
  | "slot_ineligible"
  | "ir_ineligible"
  | "ir_illegal"
  | "roster_full"
  | "locked"
  | "bad_week"
  | "not_on_waivers"
  | "already_rostered"
  | "invalid_drop"
  | "frozen"
  | "team_paused"
  | "offer_limit"
  | "deadline_passed"
  | "player_moved"
  | "roster_illegal"
  | "not_your_trade"
  | "bad_status"
  | "already_voted"
  | "not_eligible_to_vote"
  | "name_already_set"
  | "too_long"
  | "position_cap"
  | "must_fill_starters"
  | "not_your_pick"
  | "already_drafted"
  | "draft_not_running"
  | "fantasypros_quota"
  | "fantasypros_unavailable"
  | "check_in_limit"
  | "bad_time";

export interface EngineFailure {
  ok: false;
  error: EngineErrorCode;
  message: string;
  hint?: string;
  /** Structured details, e.g. every failed lineup check (§7.1 returns all failures). */
  details?: unknown;
}

export interface EngineSuccess<T> {
  ok: true;
  value: T;
}

export type EngineResult<T> = EngineSuccess<T> | EngineFailure;

export function ok<T>(value: T): EngineSuccess<T> {
  return { ok: true, value };
}

export function fail(
  error: EngineErrorCode,
  message: string,
  extra: { hint?: string; details?: unknown } = {},
): EngineFailure {
  return { ok: false, error, message, ...extra };
}
