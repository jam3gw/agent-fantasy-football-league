/**
 * Tool infrastructure (SPEC §8.4).
 *
 * Every tool returns JSON. Errors never throw to the model — they come back as
 * `{ ok: false, error, message, hint? }`. Long lists are paged, never silently
 * cut: a page is at most 20,000 characters and says `has_more` plus how to get
 * the next page. That is a payload-size rule, not a limit on the model.
 */
import type { z } from "zod";
import type { Clock } from "@league/shared";
import type { EngineDb, SessionKind } from "@league/engine";

/** Max characters of JSON in one tool result page (§8.2). */
export const MAX_PAGE_CHARS = 20_000;

export interface ToolContext {
  db: EngineDb;
  clock: Clock;
  /** null for the reporter (§6: sessions.team_id is null for the reporter). */
  teamId: number | null;
  sessionId: number;
  kind: SessionKind;
  season: number;
  /** Secrets live here and never reach a model or a transcript. */
  config: {
    fantasyprosApiKey?: string;
    fantasyprosBaseUrl?: string;
    fantasyprosDailyCap?: number;
    webSearchProvider?: string;
    webSearchApiKey?: string;
    /** Blocked in agent web tools (§12.1). */
    siteDomain?: string;
  };
  /** Extra per-kind context, e.g. draft pick_no or the trade under review. */
  sessionContext: Record<string, unknown>;
}

export interface ToolFailure {
  ok: false;
  error: string;
  message: string;
  hint?: string;
  [k: string]: unknown;
}

export type ToolResult = ToolFailure | ({ ok?: true } & Record<string, unknown>);

export interface LeagueTool<TSchema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: TSchema;
  /** Ending tools finish a session when they succeed (§8.2 step 4). */
  ending?: boolean;
  execute: (args: z.infer<TSchema>, ctx: ToolContext) => Promise<ToolResult>;
}

export function toolFailure(error: string, message: string, hint?: string): ToolFailure {
  return hint ? { ok: false, error, message, hint } : { ok: false, error, message };
}

/**
 * Page a list into a result that fits MAX_PAGE_CHARS. Returns the rows that
 * fit plus paging fields; never truncates a row mid-way.
 */
export function pageRows<T>(
  rows: T[],
  offset: number,
  limit: number,
  extra: Record<string, unknown> = {},
): { items: T[]; total: number; offset: number; has_more: boolean; next_offset?: number } & Record<string, unknown> {
  const start = Math.max(0, offset);
  const slice = rows.slice(start, start + limit);
  const fitted: T[] = [];
  let chars = JSON.stringify(extra).length + 120;
  for (const row of slice) {
    const size = JSON.stringify(row).length + 2;
    if (fitted.length > 0 && chars + size > MAX_PAGE_CHARS) break;
    fitted.push(row);
    chars += size;
  }
  const nextOffset = start + fitted.length;
  const hasMore = nextOffset < rows.length;
  return {
    ...extra,
    items: fitted,
    total: rows.length,
    offset: start,
    has_more: hasMore,
    ...(hasMore ? { next_offset: nextOffset } : {}),
  };
}

/** Map an engine failure onto the tool wire shape (codes pass through unchanged). */
export function fromEngineFailure(f: {
  error: string;
  message: string;
  hint?: string;
  details?: unknown;
}): ToolFailure {
  const out: ToolFailure = { ok: false, error: f.error, message: f.message };
  if (f.hint) out.hint = f.hint;
  if (f.details !== undefined) out.details = f.details;
  return out;
}
