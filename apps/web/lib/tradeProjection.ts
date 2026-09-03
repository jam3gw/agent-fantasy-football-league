/**
 * The rest-of-season projection a trade offer shows next to each player, and
 * the one number that summarises the deal (SPEC §3.5, §5.4).
 *
 * Week 0 of `player_week_proj` holds the season-long projection, so "rest of
 * season" here is that row. A player without one is shown as unknown rather
 * than as 0.0 — the same rule the tier derivation follows in §5.7: omit rather
 * than fabricate.
 */

/** Sum of the known projections; `null` when no player on the side has one. */
export function sumProjections(values: ReadonlyArray<number | null | undefined>): number | null {
  let total: number | null = null;
  for (const v of values) {
    if (v == null) continue;
    total = (total ?? 0) + v;
  }
  return total;
}

/** "12.3" or "—" for a player row. */
export function formatProjection(value: number | null | undefined): string {
  return value == null ? "—" : value.toFixed(1);
}

/**
 * The net swing to the proposer: what it receives minus what it gives up,
 * signed, one decimal. "+4.2 proj pts" / "−1.0 proj pts" / "±0.0 proj pts".
 * Null when either side has no projection at all, since a swing against an
 * unknown side would be a made-up number.
 */
export function swingLabel(giveSum: number | null, getSum: number | null): string | null {
  if (giveSum === null || getSum === null) return null;
  const swing = getSum - giveSum;
  const rounded = Math.abs(swing) < 0.05 ? 0 : swing;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "±";
  return `${sign}${Math.abs(rounded).toFixed(1)} proj pts`;
}
