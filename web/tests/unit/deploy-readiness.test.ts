import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { productionConfigIssues } from "@/lib/config/production";
import { envSchema } from "@/lib/env";

const createTransport = vi.hoisted(() => vi.fn(() => ({ sendMail: vi.fn(async () => ({})) })));
vi.mock("nodemailer", () => ({ default: { createTransport } }));

/** Deployment readiness: what a real host or Coolify depends on. */
const ROOT = path.resolve(import.meta.dirname, "../../..");

describe("compose.prod.yaml installation variables", () => {
  const compose = readFileSync(path.join(ROOT, "compose.prod.yaml"), "utf8");
  // Every `${VAR?…}` or `${VAR:?…}` expression outside comments, with the text after the `?`.
  const required = compose
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .flatMap((line) => [...line.matchAll(/\$\{([A-Z0-9_]+):?\?([^}]*)\}/g)])
    .map(([, name, text]) => ({ name, text }));

  it("requires only APP_URL from a Coolify operator and generated secrets", () => {
    expect([...new Set(required.map((r) => r.name))].sort()).toEqual([
      "APP_URL",
      "SERVICE_BASE64_64_AUTHSECRET",
      "SERVICE_BASE64_64_SETUPTOKEN",
      "SERVICE_PASSWORD_64_POSTGRES",
    ]);
  });

  it("has no text after `:?`, which Coolify would store as the initial value", () => {
    expect(required.filter((r) => r.text !== "")).toEqual([]);
  });

  it("wires Coolify-generated secrets into the application names", () => {
    expect(compose).toContain('x-database-password: &database-password "${SERVICE_PASSWORD_64_POSTGRES:?}"');
    expect(compose).toContain("POSTGRES_PASSWORD: *database-password");
    expect(compose).toContain("APP_URL: ${APP_URL:?}");
    expect(compose).toContain('BETTER_AUTH_SECRET: "${SERVICE_BASE64_64_AUTHSECRET:?}"');
    expect(compose).toContain(":${SERVICE_PASSWORD_64_POSTGRES:?}@db:5432/");
  });

  it("requires Coolify's generated setup token", () => {
    expect(compose).toContain('SETUP_TOKEN: "${SERVICE_BASE64_64_SETUPTOKEN:?}"');
  });
});

describe("operator scripts", () => {
  it.each(["ops/backup.sh", "ops/restore.sh"])("%s is executable in Git", (script) => {
    const r = spawnSync("git", ["ls-files", "--stage", "--", script], { cwd: ROOT, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout.split(/\s+/)[0]).toBe("100755");
  });
});

describe("SMTP_PORT", () => {
  const SAFE = {
    NODE_ENV: "production",
    APP_URL: "https://links.example.com",
    DATABASE_URL: "postgresql://covalink:s3cret-pass@db:5432/covalink",
    BETTER_AUTH_SECRET: "a".repeat(43),
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_PATH: "/data/uploads",
  };

  it.each([
    ["unset", undefined],
    ["blank", ""],
    ["whitespace", "  "],
  ])("treats %s as unset", (_name, value) => {
    expect(envSchema.parse({ ...SAFE, SMTP_PORT: value }).SMTP_PORT).toBeUndefined();
    expect(productionConfigIssues({ ...SAFE, SMTP_PORT: value })).toEqual([]);
  });

  it("keeps an explicit port", () => {
    expect(envSchema.parse({ ...SAFE, SMTP_PORT: "2525" }).SMTP_PORT).toBe(2525);
    expect(productionConfigIssues({ ...SAFE, SMTP_PORT: "2525" })).toEqual([]);
  });

  it.each(["25.5", "lots"])("still refuses %s", (value) => {
    expect(productionConfigIssues({ ...SAFE, SMTP_PORT: value }).map((i) => i.setting)).toEqual(["SMTP_PORT"]);
  });
});

describe("the SMTP transport's port", () => {
  beforeEach(() => {
    vi.resetModules();
    createTransport.mockClear();
    vi.stubEnv("APP_URL", "https://links.example.com");
    vi.stubEnv("DATABASE_URL", "postgresql://covalink:s3cret-pass@db:5432/covalink");
    vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(43));
    vi.stubEnv("SMTP_HOST", "smtp.example.com");
    vi.stubEnv("SMTP_FROM", "COVALink <no-reply@example.com>");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["blank, not secure", "", "false", 587, false],
    ["blank, secure", "", "true", 465, true],
    ["explicit, not secure", "2525", "false", 2525, false],
    ["explicit, secure", "2465", "true", 2465, true],
  ])("%s", async (_name, port, secure, wantPort, wantSecure) => {
    vi.stubEnv("SMTP_PORT", port);
    vi.stubEnv("SMTP_SECURE", secure);
    const { sendMail } = await import("@/lib/mail");
    await sendMail({ to: "person@example.com", subject: "Subject", text: "Body" });
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: "smtp.example.com", port: wantPort, secure: wantSecure }));
  });
});
