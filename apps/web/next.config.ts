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
