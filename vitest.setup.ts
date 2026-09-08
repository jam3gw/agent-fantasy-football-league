/**
 * Runs in every test worker before any test file.
 *
 * The Vercel build runs the suite with the production environment loaded, and
 * on 2026-09-08 the alarm tests sent real "[League]" emails through Resend.
 * Tests must behave the same everywhere, so two guards:
 *
 * 1. Every credential or outbound address is removed from the environment.
 *    A test that needs one sets a fake value itself.
 * 2. The global `fetch` throws. A test that needs the network stubs `fetch`
 *    with `vi.stubGlobal` or by assignment, as the existing ones do; library
 *    code that reaches the network anyway sees a failed request, never a
 *    real one.
 */
const OUTBOUND = [
  "DATABASE_URL",
  "AI_GATEWAY_API_KEY",
  "WEB_SEARCH_API_KEY",
  "WEB_SEARCH_PROVIDER",
  "RESEND_API_KEY",
  "ALERT_EMAIL_TO",
  "ALERT_WEBHOOK_URL",
  "COMMISSIONER_PASSWORD",
  "SESSION_SECRET",
  "CRON_SECRET",
  "SITE_DOMAIN",
  "SIMULATION_MODE",
];
for (const name of OUTBOUND) delete process.env[name];

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`tests do not reach the network (fetch ${url}); stub fetch in the test`);
}) as typeof fetch;
