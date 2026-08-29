/**
 * Reporter tools (SPEC §8.4 table 3, §11). The reporter is the 13th agent: no
 * team, no team write tools. Everything it reads is already public on the site.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { formatEt } from "@league/shared";
import {
  decisionLogs,
  reporterPosts,
  scratchpads,
  sessionEvents,
  sessions,
  teams,
} from "@league/engine";
import type { LeagueTool, ToolContext, ToolResult } from "./types.ts";
import { defineTool, pageRows, toolFailure } from "./types.ts";

/** Tool results trim tool payloads to this many characters (§8.4). */
const TRANSCRIPT_TOOL_RESULT_CHARS = 2000;

function requireReporter(ctx: ToolContext): ToolResult | null {
  if (ctx.teamId !== null) {
    return toolFailure("wrong_session_kind", "This tool is only available to the league reporter.");
  }
  return null;
}

export const getDecisionLogs = defineTool({
  name: "get_decision_logs",
  description:
    "Decision-log entries with the team, its model, the session kind, and the time. Filter by team or week.",
  schema: z.object({
    team_id: z.number().int().optional(),
    week: z.number().int().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  async execute(args, ctx) {
    const denied = requireReporter(ctx);
    if (denied) return denied;
    const filters = [
      args.team_id !== undefined ? eq(decisionLogs.teamId, args.team_id) : undefined,
      args.week !== undefined ? eq(decisionLogs.week, args.week) : undefined,
    ].filter(Boolean);
    const rows = await ctx.db
      .select({
        id: decisionLogs.id,
        teamId: decisionLogs.teamId,
        sessionId: decisionLogs.sessionId,
        week: decisionLogs.week,
        kind: decisionLogs.kind,
        summary: decisionLogs.summary,
        createdAt: decisionLogs.createdAt,
      })
      .from(decisionLogs)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(decisionLogs.createdAt));
    const allTeams = await ctx.db.select().from(teams);
    const items = rows.map((r) => {
      const t = allTeams.find((x) => x.id === r.teamId);
      return {
        team_id: r.teamId,
        team: t?.name ?? null,
        model: t?.modelLabel ?? null,
        session_id: r.sessionId,
        week: r.week,
        kind: r.kind,
        summary: r.summary,
        at: formatEt(r.createdAt),
      };
    });
    return pageRows(items, args.offset ?? 0, args.limit ?? 50);
  },
});

export const getTeamScratchpad = defineTool({
  name: "get_team_scratchpad",
  description: "That team's current scratchpad. Public on the site; attribute anything you quote.",
  schema: z.object({ team_id: z.number().int() }),
  async execute(args, ctx) {
    const denied = requireReporter(ctx);
    if (denied) return denied;
    const team = (await ctx.db.select().from(teams).where(eq(teams.id, args.team_id)))[0];
    if (!team) return toolFailure("not_found", `There is no team ${args.team_id}.`);
    const pad = (
      await ctx.db.select().from(scratchpads).where(eq(scratchpads.teamId, args.team_id))
    )[0];
    return {
      team_id: team.id,
      team: team.name,
      model: team.modelLabel,
      content: pad?.content ?? "",
      updated_at: pad ? formatEt(pad.updatedAt) : null,
    };
  },
});

export const listSessions = defineTool({
  name: "list_sessions",
  description: "Sessions with status, kind, tool counts, and cost. Filter by team, week, or kind.",
  schema: z.object({
    team_id: z.number().int().optional(),
    week: z.number().int().optional(),
    kind: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  async execute(args, ctx) {
    const denied = requireReporter(ctx);
    if (denied) return denied;
    const rows = await ctx.db.select().from(sessions).orderBy(desc(sessions.createdAt));
    const allTeams = await ctx.db.select().from(teams);
    const filtered = rows.filter((s) => {
      if (args.team_id !== undefined && s.teamId !== args.team_id) return false;
      if (args.kind !== undefined && s.kind !== args.kind) return false;
      if (args.week !== undefined) {
        // A session with no week belongs to no week (the draft and onboarding,
        // §8.7), so it matches no week filter — treating "missing" as "matches
        // everything" put all 168 draft picks into every week's list.
        const w = (s.context as { week?: number }).week;
        if (w !== args.week) return false;
      }
      return true;
    });
    const items = filtered.map((s) => {
      const t = s.teamId === null ? null : allTeams.find((x) => x.id === s.teamId);
      return {
        session_id: s.id,
        team_id: s.teamId,
        team: s.teamId === null ? "reporter" : (t?.name ?? null),
        model: s.modelId,
        kind: s.kind,
        status: s.status,
        ended_by: s.endedBy,
        tool_calls: s.toolCalls,
        invalid_tool_calls: s.invalidToolCalls,
        cost_usd: s.costUsd,
        started_at: s.startedAt ? formatEt(s.startedAt) : null,
      };
    });
    return pageRows(items, args.offset ?? 0, args.limit ?? 50);
  },
});

export const getSessionTranscript = defineTool({
  name: "get_session_transcript",
  description:
    "One session's transcript: the model's messages and its tool calls. Tool results are trimmed.",
  schema: z.object({
    session_id: z.number().int(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  async execute(args, ctx) {
    const denied = requireReporter(ctx);
    if (denied) return denied;
    const session = (await ctx.db.select().from(sessions).where(eq(sessions.id, args.session_id)))[0];
    if (!session) return toolFailure("not_found", `There is no session ${args.session_id}.`);
    const events = await ctx.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, args.session_id))
      .orderBy(sessionEvents.seq);
    const items = events
      .filter((e) => e.type !== "system")
      .map((e) => {
        const content = JSON.stringify(e.content);
        return {
          seq: e.seq,
          type: e.type,
          content:
            content.length > TRANSCRIPT_TOOL_RESULT_CHARS
              ? `${content.slice(0, TRANSCRIPT_TOOL_RESULT_CHARS)}… (trimmed)`
              : content,
        };
      });
    return pageRows(items, args.offset ?? 0, args.limit ?? 100, {
      session_id: session.id,
      team_id: session.teamId,
      kind: session.kind,
      model: session.modelId,
      status: session.status,
    });
  },
});

export const publishReport = defineTool({
  name: "publish_report",
  description: "Publish your finished post. This ends the session.",
  ending: true,
  schema: z.object({
    kind: z.enum(["draft_grades", "recap", "preview", "trade_note"]),
    week: z.number().int().optional(),
    title: z.string().min(1).max(120),
    body_md: z.string().min(1).max(12_000),
  }),
  async execute(args, ctx) {
    const denied = requireReporter(ctx);
    if (denied) return denied;
    const rows = await ctx.db
      .insert(reporterPosts)
      .values({
        kind: args.kind,
        week: args.week ?? null,
        title: args.title,
        bodyMd: args.body_md,
        sessionId: ctx.sessionId,
        createdAt: ctx.clock.now(),
      })
      .returning({ id: reporterPosts.id });
    return { published: true, post_id: rows[0]!.id, kind: args.kind, title: args.title };
  },
});

export const REPORTER_TOOLS: LeagueTool[] = [
  getDecisionLogs,
  getTeamScratchpad,
  listSessions,
  getSessionTranscript,
  publishReport,
];
