import "server-only";
/**
 * The commissioner digest (SPEC §12.3): one email every Tuesday morning, after
 * finalization, the weekly reviews, and the reporter recap.
 */
import { and, desc, eq, gte } from "drizzle-orm";
import type { Clock } from "@league/shared";
import { formatEt } from "@league/shared";
import type { EngineDb } from "@league/engine";
import {
  computeStandings,
  costAlarms,
  getSettings,
  health,
  matchups,
  reporterPosts,
  sessions,
  spendRollups,
  teams,
  transactions,
} from "@league/engine";
import { env } from "./env";
import { sendEmail } from "./alarms";
import { weekScoringSource } from "./finalize";

export async function buildWeeklyDigest(db: EngineDb, clock: Clock): Promise<{ subject: string; html: string }> {
  const settings = await getSettings(db);
  const now = clock.now();
  const week = Math.max(1, settings.currentWeek - 1); // the week just finalized
  const since = new Date(now.getTime() - 7 * 24 * 3600_000);
  const allTeams = await db.select().from(teams);
  const nameOf = (id: number | null) => (id === null ? "Reporter" : (allTeams.find((t) => t.id === id)?.name ?? `Team ${id}`));

  // 1. Results and standings.
  const weekMatchups = await db.select().from(matchups).where(eq(matchups.week, week));
  const standings = await computeStandings(db);

  // 2. Transactions since the last digest.
  const txs = await db.select().from(transactions).where(gte(transactions.createdAt, since)).orderBy(desc(transactions.createdAt));

  // 3. Sessions.
  const recentSessions = await db.select().from(sessions).where(gte(sessions.createdAt, since));
  const byKind = new Map<string, number>();
  for (const s of recentSessions) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
  const failed = recentSessions.filter((s) => s.status === "failed" || s.status === "skipped" || s.status === "timed_out");
  const guarded = recentSessions.filter((s) => s.endedBy === "ceiling" || s.endedBy === "deadline");

  // 4. Spend.
  const rollups = await db.select().from(spendRollups);
  const seasonKey = String(settings.season);
  const leagueSeason = rollups.find((r) => r.scope === "league" && r.period === "season" && r.periodStart === seasonKey);
  const perAgent = rollups
    .filter((r) => r.scope === "agent" && r.period === "season" && r.periodStart === seasonKey)
    .sort((a, b) => b.costUsd - a.costUsd);
  const weeksElapsed = Math.max(1, settings.currentWeek - settings.startWeek + 1);
  const pace = ((leagueSeason?.costUsd ?? 0) / weeksElapsed) * 18;
  const openAlarms = await db.select().from(costAlarms).where(and(gte(costAlarms.firedAt, since)));

  // 5. Health.
  const feeds = await db.select().from(health);
  const source = await weekScoringSource(db, week);

  // 6. Reporter recap link.
  const recap = (
    await db.select().from(reporterPosts).where(eq(reporterPosts.kind, "recap")).orderBy(desc(reporterPosts.createdAt)).limit(1)
  )[0];

  const site = env.siteDomain ? `https://${env.siteDomain}` : "";
  const rows = (items: string[]) => (items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>` : "<p>None.</p>");

  const html = [
    `<h2>Week ${week}</h2>`,
    rows(
      weekMatchups.map(
        (m) => `${nameOf(m.homeTeamId)} ${m.homePoints ?? 0} — ${m.awayPoints ?? 0} ${nameOf(m.awayTeamId)}`,
      ),
    ),
    `<h3>Standings</h3>`,
    rows(
      standings.map(
        (s) => `${s.rank}. ${nameOf(s.teamId)} ${s.wins}-${s.losses}${s.ties ? `-${s.ties}` : ""} (${s.pointsFor.toFixed(1)} PF)`,
      ),
    ),
    `<h3>Transactions</h3>`,
    rows(txs.slice(0, 40).map((t) => `${t.type} — ${t.teamIds.map(nameOf).join(", ")}`)),
    `<h3>Sessions</h3>`,
    rows([
      ...[...byKind.entries()].map(([kind, n]) => `${kind}: ${n}`),
      `failed or skipped: ${failed.length}`,
      `hit a loop guard: ${guarded.length}`,
    ]),
    `<h3>Spend</h3>`,
    `<p>League season to date: <strong>$${(leagueSeason?.costUsd ?? 0).toFixed(2)}</strong>; at this pace, about $${pace.toFixed(0)} for the season.</p>`,
    rows(perAgent.map((r) => `${nameOf(r.scopeKey === "reporter" ? null : Number(r.scopeKey))}: $${r.costUsd.toFixed(2)}`)),
    openAlarms.length ? `<p>${openAlarms.length} cost alarm(s) fired this week.</p>` : "",
    `<h3>Health</h3>`,
    `<p>Week ${week} was scored by: <strong>${source ?? "unknown"}</strong>.</p>`,
    rows(feeds.map((f) => `${f.key}: ${f.lastSuccessAt ? `ok ${formatEt(f.lastSuccessAt)}` : "no success recorded"}${f.lastError ? ` (last error: ${f.lastError})` : ""}`)),
    recap ? `<p><a href="${site}/report">Reporter recap: ${recap.title}</a></p>` : "",
    `<p><a href="${site}/spend">Spend page</a></p>`,
  ].join("\n");

  return { subject: `[League] Week ${week} digest`, html };
}

export async function sendWeeklyDigest(db: EngineDb, clock: Clock): Promise<boolean> {
  const { subject, html } = await buildWeeklyDigest(db, clock);
  return sendEmail(subject, html);
}
