/**
 * Mock-draft controls (docs/SETUP.md §8 step 7). THIS BRANCH ONLY — never
 * merged to main. A preview deployment has no cron and no commissioner
 * cookie, so the mock draft is driven through here instead: the same lib
 * functions the admin actions call, minus the auth that only production has.
 *
 * Two locks keep it away from the real league: production answers 404
 * unconditionally, and previews sit behind Vercel's deployment protection.
 */
import { desc, isNotNull, sql } from "drizzle-orm";
import { sessionKey } from "@league/shared";
import { createSession, draftPicks, getSettings, rankings, sessions, spendLedger, teams } from "@league/engine";
import { db, leagueClock } from "../../../lib/db";
import { drawDraftOrder, getDraft } from "../../../lib/draft";
import { bookJobNow } from "../../../lib/jobs";
import { runTick } from "../../../lib/tick";

export const dynamic = "force-dynamic";
// The tick executes due jobs inline (ingests can take a while).
export const maxDuration = 800;

export async function GET(request: Request): Promise<Response> {
  if (process.env.VERCEL_ENV === "production") {
    return new Response("not found", { status: 404 });
  }
  const op = new URL(request.url).searchParams.get("op") ?? "status";
  const database = db();
  const clock = await leagueClock();

  try {
    switch (op) {
      case "status": {
        const settings = await getSettings(database);
        const state = await getDraft(database);
        const sessionCounts = await database
          .select({ kind: sessions.kind, status: sessions.status, n: sql<number>`count(*)::int` })
          .from(sessions)
          .groupBy(sessions.kind, sessions.status);
        const failed = await database
          .select({ id: sessions.id, teamId: sessions.teamId, kind: sessions.kind, error: sessions.error })
          .from(sessions)
          .where(isNotNull(sessions.error))
          .orderBy(desc(sessions.id))
          .limit(10);
        const [picks] = await database.select({ n: sql<number>`count(*)::int` }).from(draftPicks);
        const [ranked] = await database
          .select({ n: sql<number>`count(*)::int` })
          .from(rankings)
          .where(sql`${rankings.set} = 'draft' and ${rankings.rank} is not null`);
        const [spend] = await database
          .select({ usd: sql<number>`coalesce(sum(${spendLedger.costUsd}), 0)::float` })
          .from(spendLedger);
        return Response.json({
          ok: true,
          phase: settings.phase,
          week: settings.currentWeek,
          draft: state
            ? { status: state.status, currentPick: state.currentPick, orderDrawn: (state.order ?? []).length }
            : null,
          rankedPlayers: ranked?.n ?? 0,
          picksRecorded: picks?.n ?? 0,
          sessions: sessionCounts,
          failedSessions: failed,
          spendUsd: spend?.usd ?? 0,
        });
      }

      case "draw": {
        const state = await getDraft(database);
        if (state && (state.status === "running" || state.status === "complete")) {
          return Response.json({ ok: false, error: "draft already started" }, { status: 409 });
        }
        const order = await drawDraftOrder(database, clock);
        return Response.json({ ok: true, order });
      }

      case "onboard": {
        // Mirrors runOnboardingAction (§10.1): order first, then one queued
        // onboarding session per team, staggered a minute apart.
        const state = await getDraft(database);
        if (!state?.order || state.order.length === 0) {
          return Response.json({ ok: false, error: "draw the order first" }, { status: 409 });
        }
        const settings = await getSettings(database);
        const allTeams = await database.select().from(teams);
        let queued = 0;
        let i = 0;
        for (const team of allTeams) {
          const id = await createSession(database, settings, {
            teamId: team.id,
            kind: "onboarding",
            trigger: "commissioner",
            idempotencyKey: sessionKey(team.id, "onboarding", settings.season, 0, "setup"),
            modelId: team.modelId,
            dueAt: new Date(clock.now().getTime() + i * 60_000),
            now: clock.now(),
            context: { week: settings.currentWeek },
          });
          if (id !== null) queued++;
          i++;
        }
        return Response.json({ ok: true, queued, teams: allTeams.length });
      }

      case "start": {
        // Mirrors startDraftAction: the §5.7 gate, a fresh rankings pull, then
        // the durable draft workflow booked for the next tick.
        const state = await getDraft(database);
        if (!state?.order || state.order.length === 0) {
          return Response.json({ ok: false, error: "draw the order first" }, { status: 409 });
        }
        if (state.status === "complete") {
          return Response.json({ ok: false, error: "draft already complete" }, { status: 409 });
        }
        const [ranked] = await database
          .select({ n: sql<number>`count(*)::int` })
          .from(rankings)
          .where(sql`${rankings.set} = 'draft' and ${rankings.rank} is not null`);
        if ((ranked?.n ?? 0) < 200) {
          return Response.json({ ok: false, error: `gate not met: ${ranked?.n ?? 0} ranked, 200 needed` }, { status: 409 });
        }
        if (state.currentPick === null || state.currentPick <= 1) {
          await bookJobNow(database, clock, "ingest.rankings");
        }
        await bookJobNow(database, clock, "draft.run");
        return Response.json({ ok: true, booked: ["ingest.rankings", "draft.run"] });
      }

      case "validate": {
        // Rebuild a session's messages from its transcript and validate them
        // on THIS runtime — separates a bundle that validates differently
        // from live objects holding what JSON cannot record.
        const sessionId = Number(new URL(request.url).searchParams.get("session"));
        const { debugValidateSession } = await import("@league/agent");
        return Response.json(await debugValidateSession(database, sessionId));
      }

      case "probe": {
        // Execute the read tools live and validate each output as the SDK
        // will — the transcript cannot show NaN/Infinity/Date/undefined.
        const { debugProbeTools, toolsForKind } = await import("@league/agent");
        const kit = toolsForKind("onboarding") as unknown as Array<{
          name: string;
          execute: (args: unknown, ctx: unknown) => Promise<unknown>;
        }>;
        return Response.json(
          await debugProbeTools(database, clock, kit, [
            { tool: "get_league_state", args: {} },
            { tool: "get_draft_state", args: {} },
            { tool: "read_scratchpad", args: {} },
            { tool: "get_available_players", args: { sort: "rank", limit: 60 } },
            { tool: "player_research", args: { kind: "draft_rankings", limit: 100 } },
            { tool: "player_research", args: { kind: "injuries", limit: 50 } },
            { tool: "player_research", args: { kind: "projections", week: 0, limit: 100 } },
            { tool: "player_research", args: { kind: "ros_rankings", limit: 40 } },
            { tool: "player_research", args: { kind: "weekly_rankings", week: 1, limit: 40 } },
            { tool: "player_research", args: { kind: "trending", limit: 25 } },
          ]),
        );
      }

      case "catalog": {
        // Search the gateway's live model catalog, for picking a swap target.
        const q = (new URL(request.url).searchParams.get("q") ?? "").toLowerCase();
        const { fetchGatewayModelIds } = await import("@league/agent");
        // Previews have no AI_GATEWAY_API_KEY (Production scope); the gateway
        // accepts the deployment's OIDC token in the same Bearer header.
        const catalog = await fetchGatewayModelIds({
          apiKey: process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN,
        });
        return Response.json({
          ok: catalog.ok,
          error: catalog.error ?? null,
          matches: catalog.ids.filter((id) => id.toLowerCase().includes(q)).slice(0, 40),
        });
      }

      case "swap": {
        // Mirrors swapModelAction: catalog-verified, recorded as a public
        // commissioner transaction. Mock-branch rehearsal of the same swap
        // the commissioner asked for on production.
        const url = new URL(request.url);
        const teamId = Number(url.searchParams.get("team"));
        const modelId = url.searchParams.get("model") ?? "";
        const label = url.searchParams.get("label") ?? modelId;
        if (!Number.isFinite(teamId) || !modelId) {
          return Response.json({ ok: false, error: "team and model are required" }, { status: 400 });
        }
        const { checkGatewayModelId } = await import("@league/agent");
        const { recordTransaction, teams: teamsTable } = await import("@league/engine");
        const { eq: eqOp } = await import("drizzle-orm");
        const onGateway = await checkGatewayModelId(modelId, {
          apiKey: process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN,
        });
        if (onGateway === "not_found") {
          return Response.json({ ok: false, error: `the gateway has no model called ${modelId}` }, { status: 400 });
        }
        const team = (await database.select().from(teamsTable).where(eqOp(teamsTable.id, teamId)))[0];
        if (!team) return Response.json({ ok: false, error: `team ${teamId} not found` }, { status: 404 });
        const provider = modelId.split("/")[0] ?? "unknown";
        await database
          .update(teamsTable)
          .set({ modelId, modelLabel: label, provider })
          .where(eqOp(teamsTable.id, teamId));
        await recordTransaction(database, {
          type: "commissioner",
          week: null,
          teamIds: [teamId],
          payload: { action: "model_swapped", teamId, from: team.modelId, to: modelId, reason: "price point (mock rehearsal)" },
        });
        return Response.json({ ok: true, from: team.modelId, to: modelId, verified: onGateway });
      }

      case "tick": {
        const summary = await runTick();
        return Response.json({ ok: true, ...summary });
      }

      default:
        return Response.json({ ok: false, error: `unknown op ${op}` }, { status: 400 });
    }
  } catch (error) {
    return Response.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
