/**
 * Runtime database client. Vercel functions run on the Node runtime (§4.1), so
 * `postgres-js` over TCP is used — it supports the interactive transactions
 * every engine write needs. Neon's HTTP driver cannot do those, and is used
 * only by the migration script.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { EngineDb } from "./index.ts";
import * as schema from "./schema.ts";

let cached: { db: EngineDb; sql: postgres.Sql } | null = null;

export interface DbClientOptions {
  url?: string;
  /** Serverless functions should keep the pool tiny; each instance is short-lived. */
  max?: number;
  connectTimeoutSeconds?: number;
}

/**
 * The process-wide database handle. Reused across warm invocations so a
 * serverless instance does not open a new pool per request.
 */
export function getDb(options: DbClientOptions = {}): EngineDb {
  const url = options.url ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (cached) return cached.db;
  const sql = postgres(url, {
    max: options.max ?? 3,
    idle_timeout: 20,
    // Fail fast rather than hang. Pages are ISR-prerendered at build time, so
    // an unreachable database must surface as an error the page can degrade
    // on, well inside Next's 60-second per-page budget — not as a long retry
    // that fails the whole deploy.
    connect_timeout: options.connectTimeoutSeconds ?? 8,
    max_lifetime: 60 * 30,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema }) as unknown as EngineDb;
  cached = { db, sql };
  return db;
}

/** Close the pool (tests and scripts; serverless functions never call this). */
export async function closeDb(): Promise<void> {
  if (!cached) return;
  await cached.sql.end();
  cached = null;
}
