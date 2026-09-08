import { defineConfig } from "vitest/config";

// One root config; `projects` replaces the deprecated workspace file.
export default defineConfig({
  test: {
    // The Vercel build sets NODE_ENV=production, and React's production
    // build does not export `act`. Tests always run against the
    // development build, wherever they run.
    env: { NODE_ENV: "test" },
    projects: [
      "packages/shared/vitest.config.ts",
      "packages/engine/vitest.config.ts",
      "packages/data/vitest.config.ts",
      "packages/agent/vitest.config.ts",
      "apps/web/vitest.config.ts",
    ],
  },
});
