import { afterAll } from "vitest";
import { assertTestDatabaseMarker } from "../../scripts/test-db-guard.mjs";
import { recordInvalidation } from "./cache-spy";
import { closeTestSql, testSql } from "./db";
import { configureTestEnvironment } from "./test-env";

if (!process.env.E2E_BASE_URL) {
  throw new Error("E2E tests run against a live server. Use `npm run test:e2e` (which starts one) instead of invoking this project directly.");
}
const { name } = configureTestEnvironment("E2E_DATABASE_URL");
await assertTestDatabaseMarker(testSql(), name);

// Fixture writes from this process can't evict the server's in-memory cache
// (like a second replica). Record them instead; the server must stay correct
// via its per-request live check.
const { setPublicCacheInvalidator } = await import("@/features/profiles/cache");
setPublicCacheInvalidator(recordInvalidation);

afterAll(async () => {
  await closeTestSql();
  const { pgClient } = await import("@/db");
  await pgClient.end({ timeout: 1 });
});
