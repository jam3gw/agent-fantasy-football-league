import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "web", include: ["test/**/*.test.ts"], testTimeout: 30000 },
  resolve: {
    alias: {
      // `server-only` throws outside a React Server Component; the modules
      // under test are server code, so it is a no-op here.
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
      // Next's `@/` path alias, so tests can import shared component logic.
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
});
