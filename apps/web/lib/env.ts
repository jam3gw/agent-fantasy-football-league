/**
 * Server-only environment access (SPEC §14). Nothing here is ever imported by
 * a client component, and no value is ever rendered or returned to a model.
 */
import "server-only";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export const env = {
  get databaseUrl(): string {
    return required("DATABASE_URL");
  },
  get commissionerPassword(): string {
    return required("COMMISSIONER_PASSWORD");
  },
  get sessionSecret(): string {
    return required("SESSION_SECRET");
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
  /** Tool config handed to the agent runner; keys never leave the server. */
  get toolConfig() {
    return {
      fantasyprosApiKey: process.env.FANTASYPROS_API_KEY,
      fantasyprosBaseUrl: process.env.FANTASYPROS_BASE_URL,
      fantasyprosDailyCap: Number(process.env.FANTASYPROS_DAILY_CAP ?? 100),
      webSearchProvider: process.env.WEB_SEARCH_PROVIDER ?? "tavily",
      webSearchApiKey: process.env.WEB_SEARCH_API_KEY,
      siteDomain: process.env.SITE_DOMAIN,
    };
  },
};
