/**
 * The test database snapshot (helpers/db.ts) must be the schema the
 * migrations produce, or every other test is checking the wrong database.
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { existsSync, statSync } from "node:fs";
import { bootFresh, bootFromSnapshot, createTestDb, snapshotPath, type TestDb } from "./helpers/db.ts";

async function describeSchema(db: TestDb) {
  const columns = await db.execute(sql`
    select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns where table_schema = 'public'
    order by table_name, ordinal_position`);
  const constraints = await db.execute(sql`
    select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def
    from pg_constraint where connamespace = 'public'::regnamespace
    order by 1, 2`);
  const indexes = await db.execute(sql`
    select tablename, indexname, indexdef from pg_indexes where schemaname = 'public'
    order by 1, 2`);
  const migrations = await db.execute(sql`select hash from drizzle.__drizzle_migrations order by id`);
  return { columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows, migrations: migrations.rows };
}

describe("PGlite snapshot", () => {
  it("has the same tables, columns, constraints, indexes and migration log as a fresh migrate", async () => {
    // The shared instance came from the snapshot when one existed, and
    // wrote it otherwise; either way the file is there now.
    await createTestDb();
    const file = snapshotPath();
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBeGreaterThan(1_000_000);

    // Load it directly, so this cannot pass by comparing fresh with fresh.
    const snap = await bootFromSnapshot(file);
    expect(snap).toBeDefined();
    const fresh = await bootFresh();
    try {
      const a = await describeSchema(snap!.db);
      const b = await describeSchema(fresh.db);
      expect(a.columns.length).toBeGreaterThan(50);
      expect(a).toEqual(b);
    } finally {
      await snap!.client.close();
      await fresh.client.close();
    }
  });
});
