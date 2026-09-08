import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../../src/db/schema.ts";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));
const SNAPSHOT_DIR = fileURLToPath(new URL("../../../../node_modules/.cache/pglite", import.meta.url));

/**
 * The snapshot is a PGlite data directory with every migration applied, as
 * one uncompressed tar. Its name is a hash of the migration files, so a new
 * migration is a new snapshot and a stale one is simply never read again.
 */
function snapshotPath(): string {
  const hash = createHash("sha256");
  for (const file of readdirSync(MIGRATIONS, { recursive: true }).sort()) {
    const full = path.join(MIGRATIONS, String(file));
    let body: Buffer;
    try {
      body = readFileSync(full);
    } catch {
      continue; // a directory
    }
    hash.update(String(file)).update("\0").update(body).update("\0");
  }
  return path.join(SNAPSHOT_DIR, `${hash.digest("hex").slice(0, 16)}.tar`);
}

/**
 * Starting a PGlite instance and running the migrations costs about 1.8 s;
 * loading a data directory that already has them costs about 0.5 s. The
 * first boot writes the snapshot (atomically: a temp file then a rename, so
 * parallel workers never read a half-written one) and every later boot, in
 * this run or the next, loads it instead. The cache lives under
 * `node_modules/.cache`, which is not committed and which the Vercel build
 * cache keeps between deploys.
 */
async function boot(): Promise<{ client: PGlite; db: TestDb }> {
  const file = snapshotPath();
  let tar: Buffer | undefined;
  try {
    tar = readFileSync(file);
  } catch {
    // no snapshot yet
  }
  if (tar) {
    // A copy into a plain Uint8Array: the web package type-checks this file
    // against the DOM lib, where a Node Buffer is not a Blob part.
    const client = new PGlite({ loadDataDir: new Blob([new Uint8Array(tar)]) });
    await client.waitReady;
    return { client, db: drizzle(client, { schema }) };
  }
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  try {
    const dump = await client.dumpDataDir("none");
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, Buffer.from(await dump.arrayBuffer()));
    renameSync(tmp, file);
  } catch {
    // The snapshot is only a speed-up; a test never fails for want of it.
  }
  return { client, db };
}

/**
 * Each test file boots one instance the first time it asks and every later
 * call empties it instead (truncating every table costs about sixty
 * milliseconds). Vitest isolates test files, so the cache below is per file
 * and the instance goes away with the file's worker.
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
