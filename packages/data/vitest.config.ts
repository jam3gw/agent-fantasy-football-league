import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { name: "data", include: ["test/**/*.test.ts"], setupFiles: ["../../vitest.setup.ts"], testTimeout: 30000 },
});
