import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll } from "vitest";
import { configureTestEnvironment, TEST_STORAGE_PREFIX } from "./test-env";
import { recordInvalidation } from "./cache-spy";
import { closeTestSql, testSql } from "./db";
import { assertTestDatabaseMarker } from "../../scripts/test-db-guard.mjs";

// Runs before each integration test file imports application modules.
const { name, storageRoot } = configureTestEnvironment("TEST_DATABASE_URL");
await assertTestDatabaseMarker(testSql(), name);

// Imported dynamically: app modules read the (now configured) environment on load.
const { setPublicCacheInvalidator } = await import("@/features/profiles/cache");
setPublicCacheInvalidator(recordInvalidation);

afterAll(async () => {
  await closeTestSql();
  // Close the application's own pool so the worker can exit promptly.
  const { pgClient } = await import("@/db");
  await pgClient.end({ timeout: 1 });
  // Remove this file's throwaway media root (only ever a directory this setup created).
  if (path.basename(storageRoot).startsWith(TEST_STORAGE_PREFIX)) await rm(storageRoot, { recursive: true, force: true });
});
