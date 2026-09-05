/**
 * Loop guards per session kind (§8.3): tool-call ceiling + deadline window.
 * Settings, not constants — league_settings.extra.sessionGuards overrides.
 * The deadline is the real event when one exists (draft clock, kickoff,
 * review window); otherwise the wall-time window below.
 */
import type { SessionKind } from "./db/schema.ts";
import type { LeagueSettings } from "./settings.ts";

export interface SessionGuard {
  toolCallCeiling: number;
  deadlineMinutes: number | null; // null = the deadline is a real event supplied by the trigger
}

export const DEFAULT_SESSION_GUARDS: Record<SessionKind, SessionGuard> = {
  onboarding: { toolCallCeiling: 60, deadlineMinutes: 60 },
  draft_pick: { toolCallCeiling: 40, deadlineMinutes: null }, // the draft clock
  weekly_review: { toolCallCeiling: 120, deadlineMinutes: 90 },
  post_waivers: { toolCallCeiling: 80, deadlineMinutes: 60 },
  trade_window: { toolCallCeiling: 100, deadlineMinutes: 60 },
  trade_response: { toolCallCeiling: 60, deadlineMinutes: 60 },
  trade_vote: { toolCallCeiling: 30, deadlineMinutes: null }, // the review window end
  lineup_check: { toolCallCeiling: 80, deadlineMinutes: null }, // that window's kickoff
  injury_response: { toolCallCeiling: 60, deadlineMinutes: 60 }, // max(kickoff, now+60min)
  board_reply: { toolCallCeiling: 30, deadlineMinutes: 30 },
  // A check-in the agent booked itself. Deliberately a small budget: it is
  // meant to answer one question it left for itself, not to be a second
  // weekly review — and it must not be worth booking instead of one.
  self_check_in: { toolCallCeiling: 40, deadlineMinutes: 60 },
  manual: { toolCallCeiling: 120, deadlineMinutes: 120 },
  smoke: { toolCallCeiling: 10, deadlineMinutes: 10 },
  reporter_draft_grades: { toolCallCeiling: 100, deadlineMinutes: 90 },
  reporter_recap: { toolCallCeiling: 100, deadlineMinutes: 90 },
  reporter_preview: { toolCallCeiling: 100, deadlineMinutes: 90 },
  reporter_trade_note: { toolCallCeiling: 100, deadlineMinutes: 90 },
  reporter_power_rankings: { toolCallCeiling: 100, deadlineMinutes: 90 },
};

export function sessionGuard(settings: Pick<LeagueSettings, "extra">, kind: SessionKind): SessionGuard {
  const overrides = (settings.extra as { sessionGuards?: Partial<Record<SessionKind, Partial<SessionGuard>>> })
    .sessionGuards;
  return { ...DEFAULT_SESSION_GUARDS[kind], ...(overrides?.[kind] ?? {}) };
}
