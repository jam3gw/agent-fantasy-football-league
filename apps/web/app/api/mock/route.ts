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
