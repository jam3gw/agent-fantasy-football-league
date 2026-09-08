/**
 * "in 2d 4h", "in 3h 12m", "in 12m", or "now" once it has arrived. Its own
 * module so the ticking client component can import it without pulling the
 * rest of the front page's logic into the browser bundle.
 */
export function countdown(from: Date, to: Date): string {
  const ms = to.getTime() - from.getTime();
  if (ms <= 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${mins}m`;
  return `in ${Math.max(mins, 1)}m`;
}
