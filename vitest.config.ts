import { defineConfig } from "vitest/config";

// One root config; `projects` replaces the deprecated workspace file.
export default defineConfig({
  test: {
    projects: [
      "packages/shared/vitest.config.ts",
      "packages/engine/vitest.config.ts",
      "packages/data/vitest.config.ts",
      "packages/agent/vitest.config.ts",
      "apps/web/vitest.config.ts",
    ],
  },
});
