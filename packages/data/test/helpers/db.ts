/**
 * PGlite harness for data tests. The engine package builds one from the real
 * migrations (one instance per test file, emptied between tests); re-export
 * it so every package shares the same harness and its speed.
 */
export { createTestDb } from "../../../engine/test/helpers/db.ts";
export type { TestDb } from "../../../engine/test/helpers/db.ts";
