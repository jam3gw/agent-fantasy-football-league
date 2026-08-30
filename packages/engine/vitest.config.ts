import { defineConfig } from "vitest/config";
export default defineConfig({ test: { name: "engine", include: ["test/**/*.test.ts"], testTimeout: 30000, hookTimeout: 60000 } });
