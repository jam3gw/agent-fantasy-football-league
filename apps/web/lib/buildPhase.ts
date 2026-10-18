/**
 * True while `next build` prerenders pages for a production deploy.
 *
 * A page that never revalidates (`revalidate = false`) is rendered once, at
 * build time, and served until the next deploy. If its data read fails then,
 * the empty fallback such a page normally shows would stay live for the whole
 * deploy, so the page throws instead and the build fails: production stays on
 * the last good deployment. Preview builds have no database (RUNBOOK) and keep
 * the fallback.
 */
export function failBuildOnReadError(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build" && process.env.VERCEL_ENV === "production";
}
