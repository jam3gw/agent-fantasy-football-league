import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { name: "shared", include: ["test/**/*.test.ts"], setupFiles: ["../../vitest.setup.ts"] },
});
