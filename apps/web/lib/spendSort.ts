/**
 * Column sort for the per-agent table on `/spend`. Every column is a number
 * or a nullable number; unknown values stay at the bottom either way.
 */
import { compareNullable } from "./listControls";

export interface SpendRow {
  key: string;
  href: string;
  name: string;
  model: string;
  alarms: number;
  today: number;
  week: number;
  season: number;
  paid: number;
  sessions: number;
  perSession: number | null;
  perPoint: number | null;
  perWin: number | null;
  input: number;
  output: number;
  reasoning: number;
  cached: number;
}

export const SPEND_COLUMNS = [
  ["name", "Agent"],
  ["today", "Today"],
  ["week", "Week"],
  ["season", "Season (list)"],
  ["paid", "Season (paid)"],
  ["sessions", "Sessions"],
  ["perSession", "Avg / session"],
  ["perPoint", "$ / point"],
  ["perWin", "$ / win"],
  ["input", "In"],
  ["output", "Out"],
  ["reasoning", "Reasoning"],
  ["cached", "Cached"],
] as const;
export type SpendColumn = (typeof SPEND_COLUMNS)[number][0];
export const SPEND_COLUMN_KEYS: readonly string[] = SPEND_COLUMNS.map(([k]) => k);

export function sortSpendRows(rows: readonly SpendRow[], column: string, dir: "asc" | "desc"): SpendRow[] {
  const key = (SPEND_COLUMN_KEYS.includes(column) ? column : "season") as SpendColumn;
  const copy = [...rows];
  copy.sort((a, b) => {
    // A fixed locale: the order is computed on the server and again in the
    // browser, and the two must agree.
    if (key === "name") return dir === "asc" ? a.name.localeCompare(b.name, "en") : b.name.localeCompare(a.name, "en");
    return compareNullable(a[key], b[key], dir) || a.name.localeCompare(b.name, "en");
  });
  return copy;
}
