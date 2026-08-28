import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The engine and its Postgres driver are server-only Node code.
  serverExternalPackages: ["postgres", "drizzle-orm"],
  eslint: {
    // CI runs ESLint directly (next lint was removed in 16, and next build no
    // longer lints); this keeps the build from re-running it.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
