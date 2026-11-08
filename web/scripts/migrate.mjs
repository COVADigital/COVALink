// Applies pending SQL migrations. Plain ESM so it runs in the production image
// without TypeScript tooling. Usage: node scripts/migrate.mjs [migrationsDir]
//
// A Postgres advisory lock serializes concurrent runs (e.g. several replicas
// starting at once); the lock and the migrations share one connection.
// Pending migrations are applied in one transaction, so a failure leaves the
// database at its previous level and a rerun is safe. Migrations are
// forward-only: nothing here ever rolls one back.
//
// Errors are logged as one bounded line (code and scrubbed message) so the
// connection string, password or SQL parameters never reach the logs.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { databaseUrlSecrets, describeError } from "./error-summary.mjs";

const MIGRATION_LOCK_ID = 727_001;
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[migrate] DATABASE_URL is not set");
  process.exit(1);
}
const migrationsFolder = process.argv[2] ?? "./src/db/migrations";
const secrets = databaseUrlSecrets(url);

const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 15 });
try {
  console.log("[migrate] waiting for migration lock…");
  await sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`;
  console.log(`[migrate] applying migrations from ${migrationsFolder}`);
  await migrate(drizzle(sql), { migrationsFolder });
  const [{ applied }] = await sql`select count(*)::int as applied from drizzle.__drizzle_migrations`;
  console.log(`[migrate] database is up to date (${applied} migrations applied)`);
} catch (err) {
  console.error(`[migrate] failed: ${describeError(err, secrets)}`);
  process.exitCode = 1;
} finally {
  await sql`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`.catch(() => {});
  await sql.end({ timeout: 5 }).catch(() => {});
}
