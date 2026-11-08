// Creates (if needed) and migrates an isolated test database.
// Usage: node --env-file-if-exists=.env scripts/test-db.mjs [ENV_VAR_NAME]
// ENV_VAR_NAME defaults to TEST_DATABASE_URL (E2E uses E2E_DATABASE_URL).
//
// Never drops anything. It only creates a database that does not exist yet,
// marks it as a test database, and applies migrations to that database.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { assertTestDatabaseMarker, assertTestDatabaseUrl, TEST_DB_MARKER } from "./test-db-guard.mjs";

const varName = process.argv[2] ?? "TEST_DATABASE_URL";
const { url, name } = assertTestDatabaseUrl(process.env[varName], { devDatabaseUrl: process.env.DATABASE_URL });

const admin = new URL(url);
admin.pathname = "/postgres";
const adminSql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
try {
  const [exists] = await adminSql`select 1 from pg_database where datname = ${name}`;
  if (!exists) {
    // Identifiers can't be bound as parameters; `name` is validated by the guard regex.
    await adminSql.unsafe(`create database "${name}"`);
    await adminSql.unsafe(`comment on database "${name}" is '${TEST_DB_MARKER}'`);
    console.log(`[test-db] created ${name}`);
  } else {
    console.log(`[test-db] ${name} exists`);
  }
} finally {
  await adminSql.end();
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await assertTestDatabaseMarker(sql, name);
  await migrate(drizzle(sql), { migrationsFolder: "./src/db/migrations" });
  console.log(`[test-db] ${name} migrated`);
} finally {
  await sql.end();
}
