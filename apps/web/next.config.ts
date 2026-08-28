import type { NextConfig } from "next";
import { withWorkflow } from "@workflow/next";

const nextConfig: NextConfig = {
  // The engine and its Postgres driver are server-only Node code.
  serverExternalPackages: ["postgres", "drizzle-orm"],
};

// Vercel Workflows (§4.1): durable steps for the jobs that outlive a single
// 800-second function invocation — the draft above all.
export default withWorkflow(nextConfig);
