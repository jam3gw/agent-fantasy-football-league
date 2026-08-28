import "server-only";
/**
 * Cost alarm notification (SPEC §8.7). Alarms notify; they never stop a
 * session. Every enabled channel fires for every alarm.
 */
import { eq, inArray } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "@league/engine";
import { costAlarms, teams } from "@league/engine";
import type { FiredAlarm } from "@league/agent";
import { env } from "./env";

function subjectFor(alarm: FiredAlarm, label: string): string {
  return `[League] ${alarm.scope} alarm: ${label} $${alarm.amountUsd.toFixed(2)} > $${alarm.thresholdUsd.toFixed(2)}`;
}

export async function notifyAlarms(db: EngineDb, clock: Clock, alarms: FiredAlarm[]): Promise<void> {
  if (alarms.length === 0) return;
  const allTeams = await db.select().from(teams);

  for (const alarm of alarms) {
    const team = allTeams.find((t) => String(t.id) === alarm.scopeKey);
    const label = team?.name ?? (alarm.scopeKey === "league" ? "the league" : alarm.scopeKey);
    const sent: string[] = [];

    if (alarm.channels.includes("email")) {
      if (await sendEmail(subjectFor(alarm, label), alarmBody(alarm, label))) sent.push("email");
    }
    if (alarm.channels.includes("webhook") && env.alertWebhookUrl) {
      if (await postWebhook(env.alertWebhookUrl, alarm)) sent.push("webhook");
    }
    // The site banner needs no send: an unacknowledged row IS the banner.
    if (alarm.channels.includes("site")) sent.push("site");

    const rows = await db
      .select()
      .from(costAlarms)
      .where(inArray(costAlarms.ruleId, [alarm.ruleId]));
    const row = rows.find(
      (r) =>
        r.scopeKey === alarm.scopeKey &&
        r.periodStart === alarm.periodStart &&
        Number(r.thresholdUsd) === alarm.thresholdUsd,
    );
    if (row) {
      await db.update(costAlarms).set({ notifiedVia: sent }).where(eq(costAlarms.id, row.id));
    }
  }
  void clock;
}

function alarmBody(alarm: FiredAlarm, label: string): string {
  const link = env.siteDomain
    ? `https://${env.siteDomain}/spend${alarm.scopeKey !== "league" ? `/${alarm.scopeKey}` : ""}`
    : "/spend";
  return [
    `<p>${label} has crossed $${alarm.thresholdUsd.toFixed(2)} for ${alarm.scope} (${alarm.periodStart}).</p>`,
    `<p>Current: <strong>$${alarm.amountUsd.toFixed(2)}</strong></p>`,
    `<p><a href="${link}">Open the spend page</a></p>`,
    `<p>This is an alarm, not a cap. Nothing was stopped.</p>`,
  ].join("\n");
}

/** Send through Resend. Returns false (without throwing) when unconfigured. */
export async function sendEmail(subject: string, html: string): Promise<boolean> {
  const key = env.resendApiKey;
  const to = env.alertEmailTo;
  if (!key || !to) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: `League <league@${env.siteDomain || "resend.dev"}>`,
        to: [to],
        subject,
        html,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function postWebhook(url: string, alarm: FiredAlarm): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alarm),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
