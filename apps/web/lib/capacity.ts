import "server-only";
/**
 * Capacity watchdogs (2026-08-29 audit): the two resources whose exhaustion
 * nothing watched. §17 warns that a full database fails writes "while the
 * admin pages render calm and empty", and a drained AI Gateway balance fails
 * every session for every team at once — both were invisible until the moment
 * they happened. Checked hourly from the tick (`tick.capacity` stage); each
 * writes its own health row and emails at most once per ET day while the
 * condition stands. Alarms notify (§8.7); nothing is ever stopped.
 */
import { sql } from "drizzle-orm";
import type { Clock } from "@league/shared";
import type { EngineDb } from "@league/engine";
import { health } from "@league/engine";
import { env } from "./env";
import { notifyOnce } from "./alarms";

/** Hourly: both readings move slowly, and each check costs a query or an HTTP call. */
export const CAPACITY_CHECK_INTERVAL_MS = 60 * 60_000;

/**
 * The Neon Launch plan includes 10 GiB of storage; past that the league is
 * billed for overage rather than stopped (the hard ceiling is terabytes away),
 * so this is a growth alarm, not a countdown to a wall: at 80% the season's
 * transcript growth deserves a look before it becomes a bill.
 */
export const DB_SIZE_BUDGET_BYTES = 10 * 1024 ** 3;
export const DB_SIZE_WARN_AT = 0.8;

/**
 * Appendix F puts a regular-season week at roughly $150 across twelve agents,
 * so $100 was the original line: about the last point where a dead
 * auto-top-up (an expired card, a billing hiccup) could be fixed before the
 * balance reached zero mid-week.
 *
 * Lowered to $15 at the commissioner's request 2026-09-09: the balance sat
 * under $100 for over a week without auto top-up actually failing, and the
 * daily email got noisy. $15 gives much less runway before the true
 * zero-balance outage (every session for every team fails at once) — at the
 * $150/week pace that is under a day, against roughly half a week before.
 * Still an alarm, not a cap: nothing stops until $0 either way (§8.7).
 */
export const GATEWAY_CREDITS_ALARM_USD = 15;

const GATEWAY_CREDITS_URL = "https://ai-gateway.vercel.sh/v1/credits";

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

/**
 * Unlike the tick stages, recovery here *clears* the old error text. A feed
 * row's stale error is harmless context; a stale dollar figure ("balance is
 * $42.10") beside an "ok" badge reads as a live emergency to anyone glancing
 * at /admin/health after the top-up already happened.
 */
async function record(database: EngineDb, key: string, at: Date, error?: string): Promise<void> {
  const set = error
    ? { lastError: error.slice(0, 500), lastErrorAt: at }
    : { lastSuccessAt: at, lastError: null, lastErrorAt: null };
  await database
    .insert(health)
    .values({ key, ...set })
    .onConflictDoUpdate({ target: health.key, set });
}

/**
 * Compare the database's size with the storage budget. Green under the warn
 * line; over it, a `db.size` error row (which /admin/health badges) and one
 * email per ET day. `session_events` stores every model message and tool
 * result, so it is nearly always the answer to "what grew".
 *
 * The reading is a floor, not the bill: `pg_database_size` measures this one
 * database's logical size, while Neon's storage metering also counts the
 * 7-day history window and every other branch. The alarm can therefore lag
 * the invoice — acceptable for a growth alarm, wrong for accounting.
 */
export async function checkDbSize(
  database: EngineDb,
  clock: Clock,
  budgetBytes: number = DB_SIZE_BUDGET_BYTES,
): Promise<{ bytes: number; alarmed: boolean }> {
  const result = await database.execute(sql`select pg_database_size(current_database()) as bytes`);
  const rows =
    (result as unknown as { rows?: Array<{ bytes?: unknown }> }).rows ??
    (result as unknown as Array<{ bytes?: unknown }>);
  const bytes = Number(rows[0]?.bytes ?? 0);
  const now = clock.now();

  if (!Number.isFinite(bytes) || bytes <= 0) {
    await record(database, "db.size", now, "pg_database_size returned nothing usable");
    return { bytes: 0, alarmed: false };
  }
  if (bytes < budgetBytes * DB_SIZE_WARN_AT) {
    await record(database, "db.size", now);
    return { bytes, alarmed: false };
  }

  const pct = Math.round((bytes / budgetBytes) * 100);
  const message =
    `the database is ${gib(bytes)} — ${pct}% of the ${gib(budgetBytes)} storage budget. ` +
    `session_events is the usual growth; check the Neon console before the overage becomes a bill.`;
  await record(database, "db.size", now, message);
  await notifyOnce(
    database,
    clock,
    "db_size",
    `[League] Database at ${pct}% of its storage budget`,
    `<p>${message}</p><p>Nothing stops at 100% — Neon bills overage instead — but transcript growth at this pace is worth a look now rather than at the invoice.</p>`,
    message,
  );
  return { bytes, alarmed: true };
}

/**
 * Read the AI Gateway credit balance. The gateway is the league's only billing
 * path (§8.9), so a balance at $0 is a total outage: every session for every
 * team fails at once, and the per-model outage detector then reports twelve
 * separate "providers" down. Auto top-up makes that unlikely, not impossible —
 * this is the watchdog for the day the top-up itself fails.
 */
export async function checkGatewayCredits(
  database: EngineDb,
  clock: Clock,
  thresholdUsd: number = GATEWAY_CREDITS_ALARM_USD,
  fetchImpl: typeof fetch = fetch,
): Promise<{ balanceUsd: number | null; alarmed: boolean }> {
  const key = env.aiGatewayApiKey;
  const now = clock.now();
  if (!key) {
    await record(
      database,
      "gateway.credits",
      now,
      "AI_GATEWAY_API_KEY is not set, so the balance cannot be read — and no session can run at all",
    );
    return { balanceUsd: null, alarmed: false };
  }

  let body: { balance?: unknown };
  try {
    const res = await fetchImpl(GATEWAY_CREDITS_URL, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      await record(database, "gateway.credits", now, `the gateway answered ${res.status} reading /v1/credits`);
      return { balanceUsd: null, alarmed: false };
    }
    body = (await res.json()) as { balance?: unknown };
  } catch (err) {
    await record(database, "gateway.credits", now, `reading /v1/credits failed: ${String(err).slice(0, 200)}`);
    return { balanceUsd: null, alarmed: false };
  }

  // The documented shape is `{ "balance": "95.50", "total_used": "4.50" }` —
  // strings, in USD. Anything else must read as unusable, not as $0:
  // `Number(null)` and `Number("")` are both 0, which would false-alarm a
  // drained balance out of a merely broken response.
  const raw = body.balance;
  const balance =
    typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(balance)) {
    await record(database, "gateway.credits", now, "the /v1/credits answer had no usable balance field");
    return { balanceUsd: null, alarmed: false };
  }

  if (balance >= thresholdUsd) {
    await record(database, "gateway.credits", now);
    return { balanceUsd: balance, alarmed: false };
  }

  const message =
    `the AI Gateway balance is $${balance.toFixed(2)}, under the $${thresholdUsd.toFixed(0)} alarm line. ` +
    `At $0 every session for every team fails at once.`;
  await record(database, "gateway.credits", now, message);
  await notifyOnce(
    database,
    clock,
    "gateway_credits",
    `[League] AI Gateway balance is down to $${balance.toFixed(2)}`,
    `<p>${message}</p><p>Top up under the Vercel team&rsquo;s AI Gateway tab and check that auto top-up is still on. Nothing is paused; sessions keep spending until the balance is gone.</p>`,
    message,
  );
  return { balanceUsd: balance, alarmed: true };
}
