import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { name: "agent", include: ["test/**/*.test.ts"], setupFiles: ["../../vitest.setup.ts"] },
});
