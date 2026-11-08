import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "dotenv";
import { assertTestDatabaseUrl } from "../../scripts/test-db-guard.mjs";

/** Prefix of every throwaway media storage root created by the test suites. */
export const TEST_STORAGE_PREFIX = "covalink-media-test-";

export const TEST_SETUP_TOKEN = "test-setup-token-0123456789abcdef0123456789";
export const TEST_APP_URL = "http://localhost:3000";

/**
 * Points the process at an isolated, guarded test database before any app
 * module is imported. Reads `.env` only to learn the dev DATABASE_URL so the
 * guard can refuse a test URL that targets the same database.
 */
export function configureTestEnvironment(urlVar: "TEST_DATABASE_URL" | "E2E_DATABASE_URL") {
  config({ path: ".env", quiet: true });
  const devDatabaseUrl = process.env.DATABASE_URL;
  const { url, name } = assertTestDatabaseUrl(process.env[urlVar], { devDatabaseUrl });
  // Media goes to a fresh temp directory (or, for E2E, the one the test server uses); never ./data.
  const storageRoot = process.env.E2E_STORAGE_ROOT ?? mkdtempSync(path.join(tmpdir(), TEST_STORAGE_PREFIX));
  Object.assign(process.env, {
    STORAGE_LOCAL_PATH: storageRoot,
    DATABASE_URL: url,
    APP_URL: process.env.E2E_BASE_URL ?? TEST_APP_URL,
    BETTER_AUTH_SECRET: process.env.TEST_AUTH_SECRET ?? "test-only-secret-not-for-production-0123456789",
    SETUP_TOKEN: process.env.E2E_SETUP_TOKEN ?? TEST_SETUP_TOKEN,
    REGISTRATION_ENABLED: "true",
    REQUIRE_EMAIL_VERIFICATION: "false",
    SMTP_HOST: "",
    TRUST_PROXY: "false",
    LOG_LEVEL: "silent",
  });
  return { url, name, storageRoot };
}
