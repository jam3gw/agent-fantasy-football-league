/**
 * Time-zone helpers (SPEC §4.3): schedules are defined in America/New_York,
 * storage is UTC. DST-safe via Intl; no date library dependency.
 */
export const LEAGUE_TZ = "America/New_York";

/** Offset of `tz` from UTC at the instant `utc`, in milliseconds (EST: -5h, EDT: -4h). */
export function tzOffsetMs(tz: string, utc: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(utc)) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    parts.hour === "24" ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(utc.getTime() / 1000) * 1000;
}

/** Wall-clock time in `tz` → UTC instant. Handles DST transitions (two-pass). */
export function zonedTimeToUtc(
  y: number,
  m: number,
  d: number,
  hh = 0,
  mm = 0,
  tz: string = LEAGUE_TZ,
): Date {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const offset1 = tzOffsetMs(tz, new Date(wall));
  let ts = wall - offset1;
  const offset2 = tzOffsetMs(tz, new Date(ts));
  if (offset2 !== offset1) ts = wall - offset2;
  return new Date(ts);
}

/** Calendar date and time parts of a UTC instant, as seen in `tz`. */
export function wallClockParts(
  utc: Date,
  tz: string = LEAGUE_TZ,
): { y: number; m: number; d: number; hh: number; mm: number; ss: number; dow: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(utc)) parts[p.type] = p.value;
  const dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hh: parts.hour === "24" ? 0 : Number(parts.hour),
    mm: Number(parts.minute),
    ss: Number(parts.second),
    dow: dows.indexOf(parts.weekday ?? "Sun"),
  };
}

/**
 * The next instant with ET wall-clock `hh:mm` on weekday `dow` (0=Sun..6=Sat)
 * at or after `from` (strictly after when `strict`).
 * Example: nextEtWeekdayTime(now, 3, 4, 30) → next Wednesday 4:30 AM ET.
 */
export function nextEtWeekdayTime(
  from: Date,
  dow: number,
  hh: number,
  mm: number,
  opts: { strict?: boolean } = {},
): Date {
  const start = wallClockParts(from);
  // Walk ET calendar days from today; calendar arithmetic done at UTC noon to dodge DST edges.
  for (let i = 0; i <= 7; i++) {
    const dayAnchor = new Date(Date.UTC(start.y, start.m - 1, start.d + i, 12));
    const day = wallClockParts(dayAnchor, "UTC");
    if (((start.dow + i) % 7) !== dow) continue;
    const candidate = zonedTimeToUtc(day.y, day.m, day.d, hh, mm);
    if (opts.strict ? candidate > from : candidate >= from) return candidate;
  }
  // Only reachable when today matches dow but the time already passed: take next week's.
  const dayAnchor = new Date(Date.UTC(start.y, start.m - 1, start.d + 7, 12));
  const day = wallClockParts(dayAnchor, "UTC");
  return zonedTimeToUtc(day.y, day.m, day.d, hh, mm);
}

/** The next instant with ET wall-clock `hh:mm` (any day) at or after `from` (strictly after when `strict`). */
export function nextEtTime(from: Date, hh: number, mm: number, opts: { strict?: boolean } = {}): Date {
  const start = wallClockParts(from);
  for (let i = 0; i <= 2; i++) {
    const dayAnchor = new Date(Date.UTC(start.y, start.m - 1, start.d + i, 12));
    const day = wallClockParts(dayAnchor, "UTC");
    const candidate = zonedTimeToUtc(day.y, day.m, day.d, hh, mm);
    if (opts.strict ? candidate > from : candidate >= from) return candidate;
  }
  /* c8 ignore next */
  throw new Error("unreachable");
}

/** ET calendar day (YYYY-MM-DD) of a UTC instant — the ET day used for daily allowances. */
export function etDay(utc: Date): string {
  const p = wallClockParts(utc);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Format a UTC instant as a readable ET string, e.g. "Tue Sep 8, 2026, 4:00 AM ET". */
export function formatEt(utc: Date): string {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: LEAGUE_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(utc);
  return `${s} ET`;
}
