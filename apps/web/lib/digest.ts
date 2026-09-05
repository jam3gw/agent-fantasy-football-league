import "server-only";
/**
 * The commissioner digest (SPEC §12.3): one email every Tuesday morning, after
 * finalization, the weekly reviews, and the reporter recap. The same digest
 * also goes out once after the draft, with grades, auto-picks and the cost of
 * the draft in place of results and standings.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Clock } from "@league/shared";
import { formatEt } from "@league/shared";
import type { EngineDb } from "@league/engine";
import {
  MOOT_OFFER_REASON,
  MOOT_OFFER_REASON_EXPIRED,
  MOOT_VOTE_REASON,
  computeStandings,
  costAlarms,
  draftPicks,
  getPlayoffSeeds,
  getSettings,
  health,
  matchups,
  players,
  reporterPosts,
  sessions,
  spendLedger,
  spendRollups,
  teams,
  trades,
  tradeVotes,
  transactions,
} from "@league/engine";
import { env } from "./env";
import { sendEmail } from "./alarms";
import { weekScoringSource } from "./finalize";

export interface DigestOptions {
  /** The week to report on. Defaults to the week just finalized. */
  week?: number;
  /** `draft` swaps results and standings for grades, auto-picks and draft cost. */
  reason?: "week" | "draft";
}

/** §12.3 point 1: seeds are shown once week 12 has started. */
const SEEDS_FROM_WEEK = 12;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export async function buildWeeklyDigest(
  db: EngineDb,
  clock: Clock,
  options: DigestOptions = {},
): Promise<{ subject: string; html: string }> {
  const settings = await getSettings(db);
  const now = clock.now();
  const isDraft = options.reason === "draft";
  // The Tuesday digest runs after finalization has already advanced the week.
  const week = options.week ?? Math.max(1, settings.currentWeek - 1);
  const since = new Date(now.getTime() - 7 * 24 * 3600_000);
  const allTeams = await db.select().from(teams);
  const nameOf = (id: number | null) => (id === null ? "Reporter" : (allTeams.find((t) => t.id === id)?.name ?? `Team ${id}`));

  const site = env.siteDomain ? `https://${env.siteDomain}` : "";
  const rows = (items: string[]) => (items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>` : "<p>None.</p>");

  // 1. Results and standings, or the draft.
  const head: string[] = [];
  if (isDraft) {
    const picks = await db.select().from(draftPicks).orderBy(draftPicks.pickNo);
    const autoPicks = picks.filter((p) => p.madeBy === "autopick");
    const pickedIds = [...new Set(picks.map((p) => p.playerId))];
    const named = pickedIds.length ? await db.select().from(players).where(inArray(players.playerId, pickedIds)) : [];
    const playerName = (id: string) => named.find((p) => p.playerId === id)?.fullName ?? id;
    const byTeam = new Map<number, number>();
    for (const p of picks) byTeam.set(p.teamId, (byTeam.get(p.teamId) ?? 0) + 1);

    const grades = await db
      .select()
      .from(reporterPosts)
      .where(eq(reporterPosts.kind, "draft_grades"))
      .orderBy(desc(reporterPosts.createdAt))
      .limit(1);

    head.push(
      `<h2>The draft is done</h2>`,
      `<p>${picks.length} picks; <strong>${autoPicks.length}</strong> were auto-picks.</p>`,
      `<h3>Auto-picks</h3>`,
      rows(autoPicks.map((p) => `Pick ${p.pickNo} — ${esc(nameOf(p.teamId))} — ${esc(playerName(p.playerId))} (${esc(p.reason)})`)),
      `<h3>Round 1</h3>`,
      rows(
        picks
          .filter((p) => p.round === 1)
          .map((p) => `${p.pickNo}. ${esc(nameOf(p.teamId))} — ${esc(playerName(p.playerId))}`),
      ),
      grades[0]
        ? `<p><a href="${site}/report">Reporter draft grades: ${esc(grades[0].title)}</a></p>`
        : `<p>No draft grades posted yet.</p>`,
    );
  } else {
    const weekMatchups = await db.select().from(matchups).where(eq(matchups.week, week));
    const standings = await computeStandings(db);
    const seeds = settings.currentWeek >= SEEDS_FROM_WEEK ? await getPlayoffSeeds(db) : {};
    const seedOf = (teamId: number) => {
      const s = seeds[String(teamId)];
      return s ? ` <strong>[seed ${s}]</strong>` : "";
    };
    head.push(
      `<h2>Week ${week}</h2>`,
      rows(
        weekMatchups.map(
          (m) =>
            `${esc(nameOf(m.homeTeamId))} ${m.homePoints ?? 0} — ${m.awayPoints ?? 0} ${esc(nameOf(m.awayTeamId))}` +
            (m.isPlayoff ? " (playoff)" : ""),
        ),
      ),
      `<h3>Standings</h3>`,
      rows(
        standings.map(
          (s) =>
            `${s.rank}. ${esc(nameOf(s.teamId))} ${s.wins}-${s.losses}${s.ties ? `-${s.ties}` : ""} ` +
            `(${s.pointsFor.toFixed(1)} PF)${seedOf(s.teamId)}`,
        ),
      ),
    );
  }

  // 2. Transactions since the last digest, with trade outcomes and tallies.
  const txs = await db.select().from(transactions).where(gte(transactions.createdAt, since)).orderBy(desc(transactions.createdAt));
  const movedPlayerIds = [
    ...new Set(
      txs.flatMap((t) => {
        const p = t.payload as Record<string, unknown>;
        return [p.playerId, ...((p.givePlayerIds as string[]) ?? []), ...((p.getPlayerIds as string[]) ?? [])].filter(
          (v): v is string => typeof v === "string",
        );
      }),
    ),
  ];
  const movedPlayers = movedPlayerIds.length
    ? await db.select().from(players).where(inArray(players.playerId, movedPlayerIds))
    : [];
  const movedName = (id: unknown) =>
    typeof id === "string" ? (movedPlayers.find((p) => p.playerId === id)?.fullName ?? id) : "";

  const describeTx = (t: (typeof txs)[number]) => {
    const p = t.payload as Record<string, unknown>;
    const who = t.teamIds.map(nameOf).join(" / ");
    switch (t.type) {
      case "waiver_add":
        return `Waiver won — ${esc(who)} added ${esc(movedName(p.playerId))}${p.dropPlayerId ? `, dropped ${esc(movedName(p.dropPlayerId))}` : ""}`;
      case "add":
        return `Free agent — ${esc(who)} added ${esc(movedName(p.playerId))}`;
      case "drop":
        return `Drop — ${esc(who)} dropped ${esc(movedName(p.playerId))}`;
      case "trade": {
        const give = ((p.givePlayerIds as string[]) ?? []).map(movedName).join(", ");
        const get = ((p.getPlayerIds as string[]) ?? []).map(movedName).join(", ");
        return `Trade executed — ${esc(who)}: ${esc(give)} for ${esc(get)}`;
      }
      default:
        return `${esc(t.type)} — ${esc(who)}`;
    }
  };

  // Vetoed and failed trades never write a transaction (nothing moved), so
  // they are read from `trades` with their vote tallies (§12.3 point 2).
  const endedTrades = await db
    .select()
    .from(trades)
    .where(and(gte(trades.updatedAt, since), inArray(trades.status, ["vetoed", "failed"])));
  const tallies = endedTrades.length
    ? await db
        .select({
          tradeId: tradeVotes.tradeId,
          vetoes: sql<number>`count(*) filter (where ${tradeVotes.vote} = 'veto')`,
          allows: sql<number>`count(*) filter (where ${tradeVotes.vote} = 'allow')`,
        })
        .from(tradeVotes)
        .where(
          inArray(
            tradeVotes.tradeId,
            endedTrades.map((t) => t.id),
          ),
        )
        .groupBy(tradeVotes.tradeId)
    : [];
  const tradeLines = endedTrades.map((t) => {
    const v = tallies.find((x) => x.tradeId === t.id);
    const tally = v ? ` — ${Number(v.vetoes)} veto / ${Number(v.allows)} allow` : "";
    const label = t.status === "vetoed" ? "Trade vetoed" : `Trade failed (${esc(t.resolutionReason ?? "unknown")})`;
    return `${label} — ${esc(nameOf(t.proposerTeamId))} / ${esc(nameOf(t.counterpartyTeamId))}${tally}`;
  });

  // 3. Sessions.
  const recentSessions = await db.select().from(sessions).where(gte(sessions.createdAt, since));
  const byKind = new Map<string, number>();
  for (const s of recentSessions) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
  // A vote session retired because its trade resolved first is a healthy
  // no-op, not a failure; nine of them per early-resolved trade would bury
  // the real failures in this table.
  const failed = recentSessions.filter(
    (s) =>
      (s.status === "failed" || s.status === "skipped" || s.status === "timed_out") &&
      s.error !== MOOT_VOTE_REASON &&
      s.error !== MOOT_OFFER_REASON &&
      s.error !== MOOT_OFFER_REASON_EXPIRED,
  );
  const guarded = recentSessions.filter((s) => s.endedBy === "ceiling" || s.endedBy === "deadline");

  // 4. Spend.
  const rollups = await db.select().from(spendRollups);
  const seasonKey = String(settings.season);
  const leagueSeason = rollups.find((r) => r.scope === "league" && r.period === "season" && r.periodStart === seasonKey);
  const perAgent = rollups
    .filter((r) => r.scope === "agent" && r.period === "season" && r.periodStart === seasonKey)
    .sort((a, b) => b.costUsd - a.costUsd);
  // Week rollups are keyed `W<week>` (packages/agent/src/spend.ts periodStartKey).
  const weekKey = `W${week}`;
  const perAgentWeek = new Map(
    rollups.filter((r) => r.scope === "agent" && r.period === "week" && r.periodStart === weekKey).map((r) => [r.scopeKey, r]),
  );
  const weeksElapsed = Math.max(1, settings.currentWeek - settings.startWeek + 1);
  const pace = ((leagueSeason?.costUsd ?? 0) / weeksElapsed) * 18;
  const openAlarms = await db.select().from(costAlarms).where(gte(costAlarms.firedAt, since));

  const draftCost = isDraft
    ? (
        await db
          .select({ total: sql<number>`coalesce(sum(${spendLedger.costUsd}), 0)::float8` })
          .from(spendLedger)
          .where(inArray(spendLedger.kind, ["draft_pick", "onboarding"]))
      )[0]?.total ?? 0
    : 0;

  // 5. Health.
  const feeds = await db.select().from(health);
  const source = isDraft ? null : await weekScoringSource(db, week);
  const degraded = feeds.filter((f) => f.lastError);

  // 6. Reporter recap link.
  const recap = (
    await db.select().from(reporterPosts).where(eq(reporterPosts.kind, "recap")).orderBy(desc(reporterPosts.createdAt)).limit(1)
  )[0];

  const html = [
    ...head,
    `<h3>Transactions</h3>`,
    rows([...txs.slice(0, 40).map(describeTx), ...tradeLines]),
    `<h3>Sessions</h3>`,
    rows([
      ...[...byKind.entries()].map(([kind, n]) => `${esc(kind)}: ${n}`),
      `hit a loop guard: ${guarded.length}`,
    ]),
    `<h4>Failed or skipped (${failed.length})</h4>`,
    rows(failed.slice(0, 30).map((s) => `${esc(nameOf(s.teamId))} — ${esc(s.kind)} — ${esc(s.status)} — ${esc(s.error ?? "no error recorded")}`)),
    `<h3>Spend</h3>`,
    isDraft ? `<p>The draft and onboarding cost <strong>$${draftCost.toFixed(2)}</strong>.</p>` : "",
    `<p>League season to date: <strong>$${(leagueSeason?.costUsd ?? 0).toFixed(2)}</strong>; at this pace, about $${pace.toFixed(0)} for the season.</p>`,
    rows(
      perAgent.map((r) => {
        const label = r.scopeKey === "reporter" ? "Reporter" : nameOf(Number(r.scopeKey));
        const thisWeek = perAgentWeek.get(r.scopeKey)?.costUsd ?? 0;
        return `${esc(label)}: $${thisWeek.toFixed(2)} this week, $${r.costUsd.toFixed(2)} season`;
      }),
    ),
    `<p>Every step bills the AI Gateway, so list cost and paid cost are the same figure.</p>`,
    openAlarms.length ? `<p>${openAlarms.length} cost alarm(s) fired this week.</p>` : "",
    `<h3>Health</h3>`,
    isDraft ? "" : `<p>Week ${week} was scored by: <strong>${esc(source ?? "unknown")}</strong>.</p>`,
    degraded.length ? `<p><strong>${degraded.length} feed(s) degraded.</strong></p>` : "",
    rows(
      feeds.map(
        (f) =>
          `${esc(f.key)}: ${f.lastSuccessAt ? `ok ${esc(formatEt(f.lastSuccessAt))}` : "no success recorded"}${f.lastError ? ` (last error: ${esc(f.lastError)})` : ""}`,
      ),
    ),
    recap && !isDraft ? `<p><a href="${site}/report">Reporter recap: ${esc(recap.title)}</a></p>` : "",
    `<p><a href="${site}/spend">Spend page</a></p>`,
  ]
    .filter(Boolean)
    .join("\n");

  return { subject: isDraft ? `[League] Draft digest` : `[League] Week ${week} digest`, html };
}

export async function sendWeeklyDigest(db: EngineDb, clock: Clock, options: DigestOptions = {}): Promise<boolean> {
  const { subject, html } = await buildWeeklyDigest(db, clock, options);
  return sendEmail(subject, html);
}
