import type { NextConfig } from "next";
import { withWorkflow } from "@workflow/next";

/**
 * §12.1's freshness windows. Pages render per request (they show live,
 * time-dependent state), so the CDN is told how long it may hold a copy and
 * to serve the stale one while it refreshes.
 *
 * These are declared here rather than in `proxy.ts` because a proxy's response
 * headers are overwritten by the page's own `Cache-Control`, which Next sets to
 * `no-store` for a `force-dynamic` page.
 */
const LIVE = "public, s-maxage=30, stale-while-revalidate=120";
const DEFAULT = "public, s-maxage=300, stale-while-revalidate=1200";

const nextConfig: NextConfig = {
  // The engine and its Postgres driver are server-only Node code.
  serverExternalPackages: ["postgres", "drizzle-orm"],
  async headers() {
    return [
      { source: "/", headers: [{ key: "Cache-Control", value: LIVE }] },
      { source: "/matchups/:week", headers: [{ key: "Cache-Control", value: LIVE }] },
      { source: "/draft", headers: [{ key: "Cache-Control", value: LIVE }] },
      { source: "/standings", headers: [{ key: "Cache-Control", value: DEFAULT }] },
      { source: "/board", headers: [{ key: "Cache-Control", value: DEFAULT }] },
      { source: "/transactions", headers: [{ key: "Cache-Control", value: DEFAULT }] },
      { source: "/waivers", headers: [{ key: "Cache-Control", value: DEFAULT }] },
      { source: "/trades", headers: [{ key: "Cache-Control", value: DEFAULT }] },
      { source: "/report", headers: [{ key: "Cache-Control", value: DEFAULT }] },
      { source: "/benchmark", headers: [{ key: "Cache-Control", value: DEFAULT }] },
      { source: "/about", headers: [{ key: "Cache-Control", value: DEFAULT }] },
      { source: "/teams/:slug", headers: [{ key: "Cache-Control", value: DEFAULT }] },
      { source: "/players/:id", headers: [{ key: "Cache-Control", value: DEFAULT }] },
      { source: "/sessions/:id", headers: [{ key: "Cache-Control", value: DEFAULT }] },
      { source: "/spend", headers: [{ key: "Cache-Control", value: DEFAULT }] },
      { source: "/spend/:slug", headers: [{ key: "Cache-Control", value: DEFAULT }] },
      // Nothing behind the commissioner login is ever cached.
      { source: "/admin/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      { source: "/api/admin/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
    ];
  },
};

// Vercel Workflows (§4.1): durable steps for the jobs that outlive a single
// 800-second function invocation — the draft above all.
export default withWorkflow(nextConfig);
