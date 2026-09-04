import type { NextConfig } from "next";
import { withWorkflow } from "@workflow/next";

const nextConfig: NextConfig = {
  // The engine and its Postgres driver are server-only Node code.
  serverExternalPackages: ["postgres", "drizzle-orm"],
  /**
   * §12.1's freshness windows are set by each page's own `export const
   * revalidate`, which is what makes the CDN hold a copy for that long — a
   * header declared here cannot do it, because a page's own `Cache-Control`
   * (Next writes `no-store` for anything rendered per request) wins over
   * anything config or `proxy.ts` adds to the response.
   *
   * What is left here is the one direction that needs forcing: nothing behind
   * the commissioner login may ever be stored, by any cache.
   */
  /**
   * The team page's week used to be a query string. Reading one makes Next
   * render the page per request, so the week is a path segment now; the old
   * links still land in the right place.
   */
  async redirects() {
    return [
      {
        source: "/teams/:slug",
        // Only a week the new route accepts (1–18); anything else falls through
        // to the team page, which shows the current week, as the old page did.
        has: [{ type: "query", key: "week", value: "(?<week>[1-9]|1[0-8])" }],
        destination: "/teams/:slug/week/:week",
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      { source: "/admin/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      { source: "/api/admin/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
    ];
  },
};

// Vercel Workflows (§4.1): durable steps for the jobs that outlive a single
// 800-second function invocation — the draft above all.
export default withWorkflow(nextConfig);
