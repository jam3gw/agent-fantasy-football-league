/**
 * Server-only environment access (SPEC §14). Nothing here is ever imported by
 * a client component, and no value is ever rendered or returned to a model.
 */
import "server-only";
import { hkdfSync } from "node:crypto";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** Domain separation for the derived cookie key: never the password itself. */
const COOKIE_KEY_SALT = "agent-fantasy-football-league/cookie";
const COOKIE_KEY_INFO = "commissioner-cookie-hmac-v1";
const MIN_DERIVED_PASSWORD = 16;

export const env = {
  get databaseUrl(): string {
    return required("DATABASE_URL");
  },
  get commissionerPassword(): string {
    return required("COMMISSIONER_PASSWORD");
  },
  /**
   * The key that signs the commissioner cookie. Explicit `SESSION_SECRET` wins;
   * otherwise it is derived from `COMMISSIONER_PASSWORD` via HKDF, so the league
   * has one secret to set instead of two. A missing second variable used to take
   * the admin login down with a bare 500, and the health page that would have
   * explained it sits behind the same login.
   *
   * The derived key inherits the password's entropy, so a short password would
   * let anyone holding a cookie brute-force it offline. `MIN_DERIVED_PASSWORD`
   * is the floor that makes that impractical; set `SESSION_SECRET` explicitly to
   * opt out of the check.
   */
  get sessionSecret(): string {
    const explicit = process.env.SESSION_SECRET;
    if (explicit) return explicit;
    const password = required("COMMISSIONER_PASSWORD");
    if (password.length < MIN_DERIVED_PASSWORD) {
      throw new Error(
        `COMMISSIONER_PASSWORD must be at least ${MIN_DERIVED_PASSWORD} characters when SESSION_SECRET is not set, ` +
          "because the cookie signing key is derived from it. Lengthen the password, or set SESSION_SECRET to any " +
          "long random string (openssl rand -base64 32).",
      );
    }
    return Buffer.from(hkdfSync("sha256", password, COOKIE_KEY_SALT, COOKIE_KEY_INFO, 32)).toString("base64url");
  },
  get cronSecret(): string {
    return required("CRON_SECRET");
  },
  get siteDomain(): string {
    return process.env.SITE_DOMAIN ?? "";
  },
  get leagueSeason(): number {
    return Number(process.env.LEAGUE_SEASON ?? 2026);
  },
  get simulationMode(): boolean {
    return process.env.SIMULATION_MODE === "true";
  },
  get alertEmailTo(): string | undefined {
    return process.env.ALERT_EMAIL_TO;
  },
  get resendApiKey(): string | undefined {
    return process.env.RESEND_API_KEY;
  },
  get alertWebhookUrl(): string | undefined {
    return process.env.ALERT_WEBHOOK_URL;
  },
  /**
   * Read by the capacity watchdog for the credits balance and by `odds.run`
   * for Jev (§11.1); the AI SDK reads it on its own for model calls.
   */
  get aiGatewayApiKey(): string | undefined {
    return process.env.AI_GATEWAY_API_KEY;
  },
  /** Tool config handed to the agent runner; keys never leave the server. */
  get toolConfig() {
    return {
      webSearchProvider: process.env.WEB_SEARCH_PROVIDER ?? "tavily",
      webSearchApiKey: process.env.WEB_SEARCH_API_KEY,
      siteDomain: process.env.SITE_DOMAIN,
    };
  },
};
