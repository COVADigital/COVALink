import { config } from "dotenv";
import { assertTestDatabaseMarker, assertTestDatabaseUrl } from "../../scripts/test-db-guard.mjs";

/**
 * Resets the guarded E2E database before the browser suite. Same protections
 * as the Vitest suites: local host, *_test name distinct from DATABASE_URL,
 * marker comment re-checked immediately before truncating.
 */
export default async function globalSetup() {
  if (!process.env.E2E_BASE_URL || !process.env.E2E_SETUP_TOKEN) {
    throw new Error("Run the browser suite with `npm run test:browser` (it starts the server and provides credentials).");
  }
  config({ path: ".env", quiet: true });
  const { url } = assertTestDatabaseUrl(process.env.E2E_DATABASE_URL, { devDatabaseUrl: process.env.DATABASE_URL });
  process.env.DATABASE_URL = url;
  const { resetDatabase, closeTestSql, testSql } = await import("../support/db");
  try {
    await assertTestDatabaseMarker(testSql(), new URL(url).pathname.slice(1));
    await resetDatabase();
  } finally {
    await closeTestSql();
  }
}
