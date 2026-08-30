import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `*.generated.ts` is emitted by a build step and checked against its
  // source by a test; linting it only ever reports on the generator.
  { ignores: ["node_modules/", "drizzle/", "coverage/", "**/*.generated.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error"
    }
  }
);
