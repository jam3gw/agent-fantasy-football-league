import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../../src/db/schema.ts";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));
const SNAPSHOT_DIR = fileURLToPath(new URL("../../../../node_modules/.cache/pglite", import.meta.url));

/** The installed version of a package, read from the package.json above its entry file. */
function packageVersion(name: string): string {
  let dir = path.dirname(createRequire(import.meta.url).resolve(name));
  for (;;) {
    const file = path.join(dir, "package.json");
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
      if (pkg.name === name && pkg.version) return pkg.version;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no package.json for ${name}`);
    dir = parent;
  }
}

/**
 * The snapshot is a PGlite data directory with every migration applied, as
 * one uncompressed tar. Its name is a hash of everything that shapes it: the
 * migration files (SQL, journal and meta snapshots), the PGlite version (a
 * data directory belongs to one Postgres build) and the drizzle-orm version
 * (its migrator writes the bookkeeping table). A change to any of them is a
 * new snapshot; a stale one is never read again.
 */
function snapshotPath(): string {
  const hash = createHash("sha256");
  hash.update(`pglite=${packageVersion("@electric-sql/pglite")}\0drizzle-orm=${packageVersion("drizzle-orm")}\0`);
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

/** A fresh PGlite with the migrations run on it, whatever the cache holds. */
export async function bootFresh(): Promise<{ client: PGlite; db: TestDb }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { client, db };
}

/** Load a snapshot, or return undefined when there is none or it is unusable. */
async function bootFromSnapshot(file: string): Promise<{ client: PGlite; db: TestDb } | undefined> {
  let tar: Buffer;
  try {
    tar = readFileSync(file);
  } catch {
    return undefined; // no snapshot yet
  }
  // An empty file loads as an empty database, silently; a torn one throws.
  if (tar.length === 0) return undefined;
  try {
    // A copy into a plain Uint8Array: the web package type-checks this file
    // against the DOM lib, where a Node Buffer is not a Blob part.
    const client = new PGlite({ loadDataDir: new Blob([new Uint8Array(tar)]) });
    await client.waitReady;
    const { rows } = await client.query<{ n: number }>(
      "select count(*)::int as n from pg_tables where schemaname = 'public'",
    );
    if (rows[0]!.n > 0) return { client, db: drizzle(client, { schema }) };
    await client.close();
  } catch {
    // fall through to a fresh boot
  }
  return undefined;
}

/** Write the snapshot: a temp file then a rename, so a reader never sees a partial one. */
async function writeSnapshot(client: PGlite, file: string): Promise<void> {
  try {
    const dump = await client.dumpDataDir("none");
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    // Old snapshots are never read again; do not let them pile up in the cache.
    for (const old of readdirSync(SNAPSHOT_DIR)) {
      if (old.endsWith(".tar") && path.join(SNAPSHOT_DIR, old) !== file) rmSync(path.join(SNAPSHOT_DIR, old), { force: true });
    }
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, Buffer.from(await dump.arrayBuffer()));
    renameSync(tmp, file);
  } catch {
    // The snapshot is only a speed-up; a test never fails for want of it.
  }
}

/**
 * Starting a PGlite instance and running the migrations costs about 1.8 s;
 * loading a data directory that already has them costs about 0.5 s. The
 * first boot in a run writes the snapshot and every later boot, in this run
 * or the next, loads it. The cache lives under `node_modules/.cache`, which
 * is not committed and which the Vercel build cache keeps between deploys.
 * Any doubt about the snapshot — missing, empty, unloadable, no tables —
 * means a fresh boot, which then rewrites it.
 */
async function boot(): Promise<{ client: PGlite; db: TestDb }> {
  const file = snapshotPath();
  const loaded = await bootFromSnapshot(file);
  if (loaded) return loaded;
  const fresh = await bootFresh();
  await writeSnapshot(fresh.client, file);
  return fresh;
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
