import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema.ts";

export * as schema from "./schema.ts";

/**
 * Driver-agnostic database handle: PGlite in unit tests, node-postgres
 * (Neon pooled) in deploys. A transaction handle satisfies it too, so engine
 * functions compose (nested calls become savepoints).
 */
export type EngineDb = PgDatabase<PgQueryResultHKT, typeof schema>;
