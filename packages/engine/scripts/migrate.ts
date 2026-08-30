/**
 * Apply Drizzle migrations to the database in DATABASE_URL.
 *
 * Uses Neon's HTTP driver, which needs only outbound HTTPS — the same path
 * Vercel functions use and the only one open from the build sandbox (raw
 * Postgres on 5432 is not reachable there). DDL is one statement per request,
 * which the migrator handles.
 *
 * Local runs point at the Neon `dev` branch; deploys point at `main`.
 */
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const db = drizzle(neon(url));
await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
console.log("migrations applied");
