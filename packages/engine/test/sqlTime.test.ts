/**
 * The bug this guards against passed the whole test suite and then failed on
 * every request in production.
 *
 * A raw `sql` template carries no column type, so its parameters reach the
 * driver untyped — and the two drivers disagree about a JS `Date`. PGlite (what
 * the tests run on) accepts it; postgres-js (production) throws
 * ERR_INVALID_ARG_TYPE. So no PGlite-backed test can ever catch it, and a
 * behavioural test here would be worthless.
 *
 * What is checkable, and what actually matters, is the *shape of the query* the
 * builder emits: every parameter must be a string, never a Date.
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { tstz } from "../src/db/sqlTime.ts";
import { scheduledJobs } from "../src/db/schema.ts";

const dialect = new PgDialect();
const at = new Date("2026-09-15T13:00:00.000Z");

describe("tstz — timestamps in raw sql templates", () => {
  it("sends the timestamp as a cast ISO string, not a Date", () => {
    const query = dialect.sqlToQuery(sql`select ${tstz(at)}`);
    expect(query.params).toEqual(["2026-09-15T13:00:00.000Z"]);
    expect(query.sql).toContain("::timestamptz");
  });

  it("passes no parameter of type Date, which is what postgres-js rejects", () => {
    const query = dialect.sqlToQuery(
      sql`select * from ${scheduledJobs} where ${scheduledJobs.dueAt} <= ${tstz(at)}`,
    );
    for (const p of query.params) expect(p).not.toBeInstanceOf(Date);
  });

  it("a bare Date is what the bug looked like — kept as the contrast", () => {
    const query = dialect.sqlToQuery(sql`select ${at}`);
    // This is the shape that reached production and threw. If drizzle ever
    // starts serializing bare Dates itself, this test tells us the helper is
    // no longer load-bearing.
    expect(query.params[0]).toBeInstanceOf(Date);
  });
});

/**
 * A source scan, because no runtime test on PGlite can catch this. Any raw
 * `sql` template interpolating something that looks like a Date variable must
 * go through `tstz`.
 */
describe("no raw sql template interpolates a bare Date", () => {
  it("scans the source of every package", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

    async function* walk(dir: string): AsyncGenerator<string> {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".next" || e.name === ".git" || e.name === "drizzle") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) yield* walk(full);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) yield full;
      }
    }

    // Names that hold a Date in this codebase.
    const dateish = /\$\{(now|at|dayStart|since|cutoff|dueAt|deadlineAt|startedAt|endedAt|firedAt|[a-zA-Z]*(At|Start|Time))\}/;
    const offenders: string[] = [];

    for (const dir of ["apps/web", "packages/engine/src", "packages/agent/src", "packages/data/src", "packages/shared/src"]) {
      for await (const file of walk(path.join(root, dir))) {
        const text = await readFile(file, "utf8");
        // Each raw sql`...` template, backticks balanced well enough for this.
        for (const m of text.matchAll(/\bsql(?:<[^>]*>)?`([^`]*)`/g)) {
          if (dateish.test(m[1]!)) offenders.push(`${path.relative(root, file)}: ${m[0].slice(0, 90)}`);
        }
      }
    }

    expect(offenders, "wrap the timestamp in tstz() — see db/sqlTime.ts").toEqual([]);
  });
});
