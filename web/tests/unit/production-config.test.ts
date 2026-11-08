import { afterEach, describe, expect, it, vi } from "vitest";
import { formatConfigIssues, LOOPBACK_APP_URL_FLAG, productionConfigIssues } from "@/lib/config/production";

const SAFE = {
  NODE_ENV: "production",
  APP_URL: "https://links.example.com",
  DATABASE_URL: "postgresql://covalink:s3cret-pass@db:5432/covalink",
  BETTER_AUTH_SECRET: "a".repeat(43),
  STORAGE_DRIVER: "local",
  STORAGE_LOCAL_PATH: "/data/uploads",
  TRUST_PROXY: "true",
} as const;

/** The distinct settings reported (one setting may break several rules). */
const settings = (env: Record<string, string | undefined>) => [...new Set(productionConfigIssues(env).map((i) => i.setting))];

describe("production start-up configuration", () => {
  it("accepts a safe production configuration", () => {
    expect(productionConfigIssues(SAFE)).toEqual([]);
    expect(productionConfigIssues({ ...SAFE, STORAGE_DRIVER: undefined, TRUST_PROXY: undefined })).toEqual([]);
    expect(productionConfigIssues({ ...SAFE, SETUP_TOKEN: "t".repeat(32), MEDIA_QUOTA_MB: "10240", MAX_PROFILES_PER_USER: "1" })).toEqual([]);
    expect(productionConfigIssues({ ...SAFE, DATABASE_URL: "postgres://u@10.0.0.5/app" })).toEqual([]);
  });

  it("reports every missing required setting", () => {
    expect(settings({})).toEqual(
      expect.arrayContaining(["NODE_ENV", "APP_URL", "DATABASE_URL", "BETTER_AUTH_SECRET", "STORAGE_LOCAL_PATH"]),
    );
    for (const key of ["APP_URL", "DATABASE_URL", "BETTER_AUTH_SECRET", "STORAGE_LOCAL_PATH"] as const) {
      expect(settings({ ...SAFE, [key]: undefined })).toEqual([key]);
      expect(settings({ ...SAFE, [key]: "" })).toEqual([key]);
    }
  });

  it("requires NODE_ENV=production", () => {
    expect(settings({ ...SAFE, NODE_ENV: "development" })).toEqual(["NODE_ENV"]);
    expect(settings({ ...SAFE, NODE_ENV: undefined })).toEqual(["NODE_ENV"]);
  });

  it("refuses a running server in the build phase (build placeholders never apply at runtime)", () => {
    expect(settings({ ...SAFE, NEXT_PHASE: "phase-production-build" })).toEqual(["NEXT_PHASE"]);
    expect(settings({ ...SAFE, NEXT_PHASE: "phase-production-server" })).toEqual([]);
  });

  it("requires an https origin for APP_URL", () => {
    for (const bad of ["http://links.example.com", "ftp://links.example.com", "links.example.com", "https://user:pw@links.example.com", "https://links.example.com/app", "https://links.example.com/?a=1", "https://links.example.com/#x", "javascript:alert(1)"]) {
      expect(settings({ ...SAFE, APP_URL: bad }), bad).toEqual(["APP_URL"]);
    }
  });

  it("accepts an http loopback APP_URL only with the explicit smoke flag", () => {
    for (const url of ["http://127.0.0.1:3000", "http://localhost:8080", "http://[::1]:3000"]) {
      expect(settings({ ...SAFE, APP_URL: url }), url).toEqual(["APP_URL"]);
      expect(settings({ ...SAFE, APP_URL: url, [LOOPBACK_APP_URL_FLAG]: "1" }), url).toEqual(["APP_URL"]);
      expect(settings({ ...SAFE, APP_URL: url, [LOOPBACK_APP_URL_FLAG]: "true" }), url).toEqual([]);
    }
    // The flag never admits a non-loopback http origin.
    expect(settings({ ...SAFE, APP_URL: "http://10.0.0.5:3000", [LOOPBACK_APP_URL_FLAG]: "true" })).toEqual(["APP_URL"]);
    expect(settings({ ...SAFE, APP_URL: "http://127.0.0.1.example.com", [LOOPBACK_APP_URL_FLAG]: "true" })).toEqual(["APP_URL"]);
  });

  it("requires a structurally valid PostgreSQL DATABASE_URL", () => {
    for (const bad of ["not a url", "mysql://u:p@db:3306/app", "postgresql://u:p@db:5432", "postgresql://u:p@db:5432/", "http://db/app"]) {
      expect(settings({ ...SAFE, DATABASE_URL: bad }), bad).toEqual(["DATABASE_URL"]);
    }
  });

  it("enforces the secret minimum and refuses the example placeholder", () => {
    expect(settings({ ...SAFE, BETTER_AUTH_SECRET: "x".repeat(31) })).toEqual(["BETTER_AUTH_SECRET"]);
    expect(settings({ ...SAFE, BETTER_AUTH_SECRET: "replace-with-at-least-32-random-characters" })).toEqual(["BETTER_AUTH_SECRET"]);
    expect(settings({ ...SAFE, SETUP_TOKEN: "short" })).toEqual(["SETUP_TOKEN"]);
  });

  it("requires local storage on an absolute path", () => {
    expect(settings({ ...SAFE, STORAGE_DRIVER: "s3" })).toEqual(["STORAGE_DRIVER"]);
    for (const bad of ["./data/uploads", "data/uploads", "../uploads"]) {
      expect(settings({ ...SAFE, STORAGE_LOCAL_PATH: bad }), bad).toEqual(["STORAGE_LOCAL_PATH"]);
    }
  });

  it("keeps bounded numbers, booleans and enums within their ranges", () => {
    const cases: [string, string][] = [
      ["MAX_PROFILES_PER_USER", "0"],
      ["MAX_PROFILES_PER_USER", "101"],
      ["MAX_PROFILES_PER_USER", "2.5"],
      ["MEDIA_QUOTA_MB", "0"],
      ["MEDIA_QUOTA_MB", "10241"],
      ["MEDIA_UPLOADS_PER_HOUR", "1001"],
      ["MEDIA_UPLOADS_PER_HOUR", "lots"],
      ["ANALYTICS_RETENTION_DAYS", "0"],
      ["SMTP_PORT", "25.5"],
      ["REGISTRATION_ENABLED", "yes"],
      ["TRUST_PROXY", "on"],
      ["LOG_LEVEL", "verbose"],
    ];
    for (const [key, value] of cases) {
      expect(settings({ ...SAFE, [key]: value }), `${key}=${value}`).toEqual([key]);
    }
  });

  it("never includes a setting's value in the reported problems", () => {
    const sentinel = "SENTINEL-9f2c";
    const hostile = {
      NODE_ENV: `${sentinel}-env`,
      APP_URL: `http://${sentinel}.example.com/${sentinel}`,
      DATABASE_URL: `mysql://user:${sentinel}@${sentinel}/db`,
      BETTER_AUTH_SECRET: sentinel,
      SETUP_TOKEN: sentinel,
      STORAGE_DRIVER: sentinel,
      STORAGE_LOCAL_PATH: `./${sentinel}`,
      MEDIA_QUOTA_MB: sentinel,
      TRUST_PROXY: sentinel,
      LOG_LEVEL: sentinel,
    };
    const issues = productionConfigIssues(hostile);
    expect(issues.length).toBeGreaterThanOrEqual(10);
    expect(JSON.stringify(issues)).not.toContain(sentinel);
    expect(formatConfigIssues(issues)).not.toContain(sentinel);
    // A valid but secret connection string and secret never appear either.
    expect(formatConfigIssues(productionConfigIssues({ ...SAFE, APP_URL: "http://x.example" }))).not.toMatch(/s3cret|aaaa/);
  });
});

describe("build-phase environment placeholders", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const freshEnv = async () => {
    vi.resetModules();
    return (await import("@/lib/env")).env;
  };
  const clearRuntimeSettings = () => {
    for (const key of ["APP_URL", "DATABASE_URL", "BETTER_AUTH_SECRET"]) vi.stubEnv(key, undefined);
  };

  it("lets next build evaluate modules without runtime settings, using inert values", async () => {
    clearRuntimeSettings();
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    const e = (await freshEnv())();
    expect(new URL(e.APP_URL).hostname).toBe("build-placeholder.invalid");
    expect(new URL(e.DATABASE_URL).hostname).toBe("build-placeholder.invalid");
    expect(e.BETTER_AUTH_SECRET).toMatch(/^build-placeholder-not-a-secret/);
  });

  it("prefers real values in the build phase", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("APP_URL", "https://links.example.com");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db/app");
    vi.stubEnv("BETTER_AUTH_SECRET", "s".repeat(40));
    const e = (await freshEnv())();
    expect(e.APP_URL).toBe("https://links.example.com");
    expect(e.DATABASE_URL).toBe("postgresql://u:p@db/app");
    expect(e.BETTER_AUTH_SECRET).toBe("s".repeat(40));
  });

  it("never supplies placeholders outside the build phase", async () => {
    clearRuntimeSettings();
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    expect(await freshEnv()).toThrow(/APP_URL|DATABASE_URL|BETTER_AUTH_SECRET/);
    vi.stubEnv("NEXT_PHASE", undefined);
    expect(await freshEnv()).toThrow(/Invalid environment configuration/);
  });
});
