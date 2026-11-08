// Safety checks shared by the test-database scripts and the integration/e2e
// test setup. Integration tests TRUNCATE tables, so they must only ever touch
// a database that is (1) local, (2) named *_test, (3) named differently from
// the development DATABASE_URL's database, and (4) carries the marker comment
// that only scripts/test-db.mjs writes, and only on a database it created.

export const TEST_DB_MARKER = "covalink-isolated-test-database";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const TEST_DB_NAME = /^[a-z][a-z0-9_]*_test$/;

/**
 * True for any spelling of the local machine: localhost, 127.0.0.0/8, ::1
 * (bracketed or expanded) and IPv4-mapped loopback.
 */
export function isLoopbackHost(hostname) {
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (/^127(\.\d{1,3}){3}$/.test(h)) return true;
  if (/^::ffff:127(\.\d{1,3}){3}$/.test(h)) return true;
  return /^(0{0,4}:){2,7}0{0,3}1$/.test(h) || h === "::1";
}

/** Database name a postgres URL connects to (postgres.js defaults it to the user name). */
export function effectiveDatabaseName(url) {
  const u = new URL(url);
  return decodeURIComponent(u.pathname.slice(1)) || decodeURIComponent(u.username) || "postgres";
}

/**
 * The test target must never share a database name with DATABASE_URL.
 * Host aliases (localhost / 127.0.0.1 / ::1) and ports are deliberately not
 * used to tell databases apart: they commonly reach the same server. Names
 * are compared case-insensitively, which is stricter than PostgreSQL.
 */
function assertDistinctFromDev(testName, devDatabaseUrl) {
  let devName;
  try {
    devName = effectiveDatabaseName(devDatabaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL, so test-database isolation can't be verified.");
  }
  if (devName.toLowerCase() === testName.toLowerCase()) {
    throw new Error(`Test database "${testName}" has the same name as the DATABASE_URL database.`);
  }
}

/**
 * Throws unless `url` is acceptable as an isolated test database.
 * @param {string | undefined} url
 * @param {{ devDatabaseUrl?: string }} [opts]
 * @returns {{ url: string, name: string }}
 */
export function assertTestDatabaseUrl(url, opts = {}) {
  if (!url) {
    throw new Error("TEST_DATABASE_URL is not set. Point it at a local database whose name ends in _test (see web/.env.example).");
  }
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to use a test database with NODE_ENV=production.");
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error("TEST_DATABASE_URL is not a valid URL.");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new Error("TEST_DATABASE_URL must be a postgres:// URL.");
  if (!LOCAL_HOSTS.has(u.hostname)) throw new Error(`Refusing non-local test database host "${u.hostname}".`);
  const name = decodeURIComponent(u.pathname.slice(1));
  if (!TEST_DB_NAME.test(name)) throw new Error(`Refusing test database "${name}": the name must end in _test.`);
  if (opts.devDatabaseUrl) assertDistinctFromDev(name, opts.devDatabaseUrl);
  return { url, name };
}

/**
 * Verifies the marker comment on the connected database.
 * @param {import("postgres").Sql} sql
 * @param {string} expectedName
 */
export async function assertTestDatabaseMarker(sql, expectedName) {
  const [row] = await sql`
    select current_database() as name,
           shobj_description(d.oid, 'pg_database') as comment
    from pg_database d where d.datname = current_database()`;
  if (row?.name !== expectedName) throw new Error(`Connected to "${row?.name}", expected "${expectedName}".`);
  if (row.comment !== TEST_DB_MARKER) {
    throw new Error(`Database "${expectedName}" is not marked as a COVALink test database. Create it with "npm run db:test:prepare".`);
  }
}
