import postgres from "postgres";
import { assertTestDatabaseMarker, assertTestDatabaseUrl } from "../../scripts/test-db-guard.mjs";

let client: postgres.Sql | undefined;
let verifiedName: string | undefined;

/** Direct SQL access to the guarded test database (for assertions and fixtures). */
export function testSql(): postgres.Sql {
  if (!client) {
    const { url, name } = assertTestDatabaseUrl(process.env.DATABASE_URL);
    client = postgres(url, { max: 4, onnotice: () => {} });
    verifiedName = name;
  }
  return client;
}

/**
 * Empties every application table in the test database. Re-verifies the
 * test-database marker immediately before truncating.
 */
export async function resetDatabase(): Promise<void> {
  const sql = testSql();
  await assertTestDatabaseMarker(sql, verifiedName!);
  const tables = await sql<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public'`;
  if (tables.length === 0) throw new Error("Test database has no tables; run npm run db:test:prepare");
  await sql.unsafe(`truncate ${tables.map((t) => `"public"."${t.tablename}"`).join(", ")} restart identity cascade`);
}

export async function closeTestSql(): Promise<void> {
  await client?.end();
  client = undefined;
}
