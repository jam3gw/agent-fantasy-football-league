/**
 * PGlite harness for agent tests. The engine package already builds one from
 * the real migrations; re-export it so tool tests run against the same schema
 * (and so PGlite stays a single devDependency of the engine).
 */
export { createTestDb } from "../../../engine/test/helpers/db.ts";
export type { TestDb } from "../../../engine/test/helpers/db.ts";
