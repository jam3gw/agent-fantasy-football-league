import { lastEtWeekdayTime } from "@league/shared";

/**
 * §13.4: "before Tuesday 9:00 AM (the first agent sessions). After that the
 * week stays as scored."
 *
 * The window is the five hours between the week's own finalization (Tuesday
 * 4:00 AM) and the weekly reviews (Tuesday 9:00 AM), so it is anchored to the
 * most recent finalization rather than to the calendar week: on a Wednesday
 * the anchor is yesterday's 4:00 AM and the window closed yesterday at 9:00,
 * which is exactly right. Tuesday 4:00 to 9:00 never crosses a DST change —
 * those land on Sunday at 2:00 — so the arithmetic is safe.
 *
 * This lives outside `adminActions.ts` because that file is `"use server"`,
 * where every export must be an async function; a synchronous helper there
 * fails the build.
 */
const REFINALIZE_WINDOW_MS = 5 * 3600_000;

export function refinalizeCutoff(now: Date): Date {
  return new Date(lastEtWeekdayTime(now, 2, 4, 0).getTime() + REFINALIZE_WINDOW_MS);
}
