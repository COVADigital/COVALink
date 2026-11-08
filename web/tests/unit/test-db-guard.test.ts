import { afterEach, describe, expect, it, vi } from "vitest";
import { assertTestDatabaseUrl, effectiveDatabaseName, isLoopbackHost } from "../../scripts/test-db-guard.mjs";

const ALIASES = ["localhost", "127.0.0.1", "[::1]"] as const;
const url = (host: string, db: string, port = 5432) => `postgresql://covalink:pw@${host}:${port}/${db}`;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isLoopbackHost", () => {
  it.each(["localhost", "LOCALHOST", "db.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"])(
    "treats %s as loopback",
    (h) => expect(isLoopbackHost(h)).toBe(true),
  );
  it.each(["10.0.0.5", "db.example.com", "192.168.1.10", "::2", "localhost.example.com"])("treats %s as remote", (h) =>
    expect(isLoopbackHost(h)).toBe(false),
  );
});

describe("effectiveDatabaseName", () => {
  it("uses the path, else the user name (postgres.js default)", () => {
    expect(effectiveDatabaseName("postgresql://u:p@localhost:5432/covalink")).toBe("covalink");
    expect(effectiveDatabaseName("postgresql://covalink_test:p@localhost:5432")).toBe("covalink_test");
  });
});

describe("assertTestDatabaseUrl: loopback alias collisions", () => {
  const combos = ALIASES.flatMap((dev) => ALIASES.map((test) => [dev, test] as const));

  it.each(combos)("rejects the same database name via dev=%s / test=%s", (devHost, testHost) => {
    expect(() => assertTestDatabaseUrl(url(testHost, "covalink_test"), { devDatabaseUrl: url(devHost, "covalink_test") })).toThrow(
      /same name/,
    );
  });

  it.each(combos)("rejects even when ports differ (dev=%s / test=%s)", (devHost, testHost) => {
    expect(() =>
      assertTestDatabaseUrl(url(testHost, "covalink_test", 5433), { devDatabaseUrl: url(devHost, "covalink_test", 5432) }),
    ).toThrow(/same name/);
  });

  it.each(combos)("accepts a distinct *_test name (dev=%s / test=%s)", (devHost, testHost) => {
    expect(assertTestDatabaseUrl(url(testHost, "covalink_test"), { devDatabaseUrl: url(devHost, "covalink") })).toEqual({
      url: url(testHost, "covalink_test"),
      name: "covalink_test",
    });
  });

  it("compares names case-insensitively and resolves a path-less dev URL to its user", () => {
    expect(() => assertTestDatabaseUrl(url("localhost", "covalink_test"), { devDatabaseUrl: url("127.0.0.1", "COVALINK_TEST") })).toThrow(
      /same name/,
    );
    expect(() =>
      assertTestDatabaseUrl(url("localhost", "covalink_test"), { devDatabaseUrl: "postgresql://covalink_test:pw@127.0.0.1:5432" }),
    ).toThrow(/same name/);
  });

  it("rejects a remote dev URL with the same name too", () => {
    expect(() => assertTestDatabaseUrl(url("localhost", "app_test"), { devDatabaseUrl: url("db.example.com", "app_test") })).toThrow(
      /same name/,
    );
  });

  it("refuses when DATABASE_URL is present but unparseable", () => {
    expect(() => assertTestDatabaseUrl(url("localhost", "covalink_test"), { devDatabaseUrl: "not a url" })).toThrow(/isolation/);
  });

  it("accepts the repository's real configurations", () => {
    const dev = "postgresql://covalink:covalink_dev@127.0.0.1:5432/covalink";
    for (const db of ["covalink_test", "covalink_e2e_test"]) {
      expect(assertTestDatabaseUrl(`postgresql://covalink:covalink_dev@127.0.0.1:5432/${db}`, { devDatabaseUrl: dev }).name).toBe(db);
      expect(assertTestDatabaseUrl(`postgresql://covalink:covalink_dev@localhost:5432/${db}`, { devDatabaseUrl: dev }).name).toBe(db);
    }
  });
});

describe("assertTestDatabaseUrl: unchanged safety rules", () => {
  it("requires a URL", () => {
    expect(() => assertTestDatabaseUrl(undefined)).toThrow(/not set/);
  });

  it.each(["10.0.0.5", "db.example.com", "127.0.0.2"])("refuses non-local host %s", (host) => {
    expect(() => assertTestDatabaseUrl(url(host, "covalink_test"))).toThrow(/non-local/);
  });

  it.each(["covalink", "covalink_testing", "test", "Covalink_test", "covalink-test"])("refuses name %s", (db) => {
    expect(() => assertTestDatabaseUrl(url("localhost", db))).toThrow(/_test/);
  });

  it("refuses non-postgres URLs", () => {
    expect(() => assertTestDatabaseUrl("mysql://u:p@localhost/covalink_test")).toThrow(/postgres/);
  });

  it("refuses to run with NODE_ENV=production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => assertTestDatabaseUrl(url("localhost", "covalink_test"))).toThrow(/production/);
  });
});
