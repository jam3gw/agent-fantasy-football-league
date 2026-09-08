import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../../src/db/schema.ts";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

async function boot(): Promise<{ client: PGlite; db: TestDb }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { client, db };
}

/**
 * Starting a PGlite instance costs two to three seconds; the migrations on top
 * of it cost almost nothing, and emptying every table costs about sixty
 * milliseconds. So each test file boots one instance the first time it asks
 * and every later call empties it instead. Vitest isolates test files, so the
 * cache below is per file and the instance goes away with the file's worker.
 */
let shared: Promise<{ client: PGlite; db: TestDb; tables: string[] }> | undefined;

async function sharedDb() {
  shared ??= (async () => {
    const { client, db } = await boot();
    const { rows } = await client.query<{ name: string }>(
      "select tablename as name from pg_tables where schemaname = 'public' and tablename <> '__drizzle_migrations'",
    );
    return { client, db, tables: rows.map((r) => r.name) };
  })();
  return shared;
}

/**
 * An empty Postgres with the real migrations applied.
 *
 * By default this is the file's shared instance, emptied (every table
 * truncated, identities restarted); `close` is then a no-op. Pass
 * `{ isolated: true }` for a second, independent instance inside one test —
 * that one is really closed by `close`.
 */
export async function createTestDb(
  opts: { isolated?: boolean } = {},
): Promise<{ db: TestDb; close: () => Promise<void> }> {
  if (opts.isolated) {
    const { client, db } = await boot();
    return { db, close: () => client.close() };
  }
  const { client, db, tables } = await sharedDb();
  await client.exec(`truncate ${tables.map((t) => `"${t}"`).join(", ")} restart identity cascade`);
  return { db, close: async () => {} };
}
