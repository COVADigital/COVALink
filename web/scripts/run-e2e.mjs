// End-to-end verification against the real production build.
// Usage (from web/):  npm run build; then (optionally followed by test files)
//   npm run test:e2e      -> HTTP-level suite (Vitest "e2e" project)
//   npm run test:browser  -> browser workflows (Playwright, local Edge)
//
// Starts four `next start` instances, all with throwaway secrets:
//   main  :3100  isolated E2E database (guarded, *_test, marker-checked)
//   down  :3101  DATABASE_URL points at a closed port      -> /api/ready must be 503
//   hung  :3102  DATABASE_URL points at a silent TCP server -> /api/ready must time out (503)
//   mail  :3103  same E2E database, REQUIRE_EMAIL_VERIFICATION=true and SMTP
//                pointed at a local test sink (scripts/smtp-sink.mjs)
// then runs the selected suite against them and stops everything. The suites
// get the sink's control URL (E2E_MAIL_URL) and a directory with each
// server's captured output (E2E_LOG_DIR/<name>.log), so they can check what
// production logs contain.
// Each suite resets the E2E database itself before running. Every server gets
// a fresh media storage root in the OS temp directory; after the run the
// main root's tmp/ area and readiness probes must be empty (no leftover
// temporary files), and all roots are removed.
//
// Container mode: with E2E_SERVER_IMAGE=<image> the three servers are
// that production image instead of `next start`, hardened as in
// compose.prod.yaml (read-only root, tmpfs /tmp and /app/.next/cache, no
// /dev/shm, all capabilities dropped, no-new-privileges, init, pid and memory
// limits), with
// the storage root bind-mounted at /data/uploads and the databases reached
// through host.docker.internal. The run fails if any container logs an EROFS
// (read-only filesystem) error.
//   $env:E2E_SERVER_IMAGE = "covalink:<tag>"; npm run test:e2e
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { startSmtpSink } from "./smtp-sink.mjs";
import { assertTestDatabaseUrl } from "./test-db-guard.mjs";

const SUITES = {
  api: ["node_modules/vitest/vitest.mjs", "run", "--project", "e2e"],
  browser: ["node_modules/@playwright/test/cli.js", "test", "-c", "playwright.config.ts"],
};
const suite = process.argv[2] ?? "api";
if (!Object.hasOwn(SUITES, suite)) {
  console.error(`[e2e] Unknown suite "${suite}". Use one of: ${Object.keys(SUITES).join(", ")}`);
  process.exit(1);
}

const { url: e2eDbUrl } = assertTestDatabaseUrl(process.env.E2E_DATABASE_URL, { devDatabaseUrl: process.env.DATABASE_URL });
const image = process.env.E2E_SERVER_IMAGE;
if (image && !/^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$/.test(image)) {
  console.error("[e2e] E2E_SERVER_IMAGE is not an image reference");
  process.exit(1);
}
if (!image && !existsSync(".next/BUILD_ID")) {
  console.error("[e2e] No production build found. Run `npm run build` first.");
  process.exit(1);
}

const prep = spawnSync(process.execPath, ["scripts/test-db.mjs", "E2E_DATABASE_URL"], { stdio: "inherit", env: process.env });
if (prep.status !== 0) process.exit(prep.status ?? 1);

const secret = randomBytes(32).toString("base64url");
const setupToken = randomBytes(32).toString("base64url");
const nextBin = "node_modules/next/dist/bin/next";

const silent = net.createServer(() => {}); // accepts TCP, never speaks the Postgres protocol
await new Promise((r) => silent.listen(0, "127.0.0.1", r));
const silentPort = silent.address().port;

// Test SMTP sink. Containers reach it through host.docker.internal, like the databases.
const sink = await startSmtpSink({ host: image ? "0.0.0.0" : "127.0.0.1" });
const logDir = mkdtempSync(path.join(tmpdir(), "covalink-e2e-logs-"));

const STORAGE_PREFIX = "covalink-media-test-";
const newStorageRoot = () => mkdtempSync(path.join(tmpdir(), STORAGE_PREFIX));

/** Environment passed by name into container-mode servers. */
const CONTAINER_ENV = [
  "APP_URL", "COVALINK_ALLOW_LOOPBACK_APP_URL", "DATABASE_URL", "BETTER_AUTH_SECRET", "SETUP_TOKEN",
  "REGISTRATION_ENABLED", "REQUIRE_EMAIL_VERIFICATION", "SMTP_HOST", "SMTP_PORT", "SMTP_FROM", "TRUST_PROXY", "LOG_LEVEL",
];

/** In container mode, loopback database hosts are the Docker host. */
const forContainer = (url) => {
  const u = new URL(url);
  if (["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && u.port !== "1") u.hostname = "host.docker.internal";
  return u.toString();
};

function serverEnv(port, databaseUrl, storageRoot, extra = {}) {
  return {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    APP_URL: `http://localhost:${port}`,
    // The production start-up validator requires https unless this loopback-only opt-in is set.
    COVALINK_ALLOW_LOOPBACK_APP_URL: "true",
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET: secret,
    SETUP_TOKEN: setupToken,
    REGISTRATION_ENABLED: "true",
    REQUIRE_EMAIL_VERIFICATION: "false",
    SMTP_HOST: "",
    TRUST_PROXY: "true", // lets tests vary X-Forwarded-For to exercise per-client rate limits
    LOG_LEVEL: "warn",
    STORAGE_LOCAL_PATH: storageRoot,
    ...extra,
  };
}

/** The mail server: verification required, SMTP to the sink (host-side address in container mode). */
const MAIL_ENV = {
  REQUIRE_EMAIL_VERIFICATION: "true",
  SMTP_HOST: image ? "host.docker.internal" : "127.0.0.1",
  SMTP_PORT: String(sink.smtpPort),
  SMTP_FROM: "COVALink E2E <no-reply@example.test>",
};

const servers = [
  { name: "main", port: 3100, db: e2eDbUrl },
  { name: "down", port: 3101, db: "postgresql://probe:not-a-secret@127.0.0.1:1/unreachable" },
  { name: "hung", port: 3102, db: `postgresql://probe:not-a-secret@127.0.0.1:${silentPort}/silent` },
  { name: "mail", port: 3103, db: e2eDbUrl, extra: MAIL_ENV },
].map((s) => {
  const storageRoot = newStorageRoot();
  return { ...s, storageRoot, ...(image ? startContainer(s, storageRoot) : startNext(s, storageRoot)) };
});
for (const s of servers) {
  s.proc.stderr.on("data", (d) => process.stderr.write(`[${s.name}] ${d}`));
  s.output = [];
  const logFile = path.join(logDir, `${s.name}.log`);
  for (const stream of [s.proc.stdout, s.proc.stderr]) {
    stream.on("data", (d) => {
      s.output.push(String(d));
      appendFileSync(logFile, d);
    });
  }
}

function startNext(s, storageRoot) {
  return {
    proc: spawn(process.execPath, [nextBin, "start", "-p", String(s.port)], {
      env: serverEnv(s.port, s.db, storageRoot, s.extra),
      stdio: ["ignore", "pipe", "pipe"],
    }),
  };
}

/** The production image, hardened as in compose.prod.yaml; secrets are passed by name (`-e KEY`), never in argv. */
function startContainer(s, storageRoot) {
  const container = `covalink-e2e-${s.name}-${randomBytes(4).toString("hex")}`;
  const env = { ...serverEnv(s.port, forContainer(s.db), "/data/uploads", s.extra), PORT: "3000" };
  const args = [
    "run", "--rm", "--name", container,
    "--init", "--read-only", "--ipc", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--pids-limit", "256", "--memory", "1g", "--memory-swap", "1g",
    "--tmpfs", "/tmp:size=256m,mode=0700,uid=1000,gid=1000",
    "--tmpfs", "/app/.next/cache:size=64m,mode=0700,uid=1000,gid=1000",
    "--add-host", "host.docker.internal:host-gateway",
    "-p", `127.0.0.1:${s.port}:3000`,
    "-v", `${storageRoot}:/data/uploads`,
    ...CONTAINER_ENV.flatMap((k) => ["-e", k]),
    image,
  ];
  return { container, proc: spawn("docker", args, { env, stdio: ["ignore", "pipe", "pipe"] }) };
}

async function waitForHealth(port) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server on :${port} did not become healthy`);
}

let exitCode = 1;
try {
  await Promise.all(servers.map((s) => waitForHealth(s.port)));
  console.log(`[e2e] servers healthy; running ${suite} suite`);
  // Extra arguments (e.g. a test file) are passed to the suite runner. Spawned
  // asynchronously: this process must keep serving the SMTP sink meanwhile.
  const run = spawn(process.execPath, [...SUITES[suite], ...process.argv.slice(3)], {
    stdio: "inherit",
    env: {
      ...process.env,
      E2E_BASE_URL: "http://localhost:3100",
      E2E_DOWN_URL: "http://localhost:3101",
      E2E_HUNG_URL: "http://localhost:3102",
      E2E_MAIL_BASE_URL: "http://localhost:3103",
      E2E_MAIL_URL: sink.controlUrl,
      E2E_LOG_DIR: logDir,
      E2E_SETUP_TOKEN: setupToken,
      TEST_AUTH_SECRET: secret,
      E2E_STORAGE_ROOT: servers[0].storageRoot,
    },
  });
  exitCode = await new Promise((resolve) => {
    run.on("exit", (code) => resolve(code ?? 1));
    run.on("error", () => resolve(1));
  });
} catch (err) {
  console.error("[e2e]", err.message);
} finally {
  for (const s of servers) {
    if (s.container) spawnSync("docker", ["stop", "-t", "10", s.container], { stdio: "ignore", timeout: 30_000 });
    else s.proc.kill();
  }
  silent.close();
  sink.close();
}

if (image) {
  const erofs = servers.filter((s) => /EROFS|read-only file system/i.test(s.output.join("")));
  console.log(`[e2e] container mode (${image}): ${erofs.length} server(s) logged read-only filesystem errors`);
  if (erofs.length) {
    console.error(`[e2e] EROFS in: ${erofs.map((s) => s.name).join(", ")}`);
    exitCode = exitCode || 1;
  }
}

// Leftover-temp check on the main server's storage root, then cleanup of every root.
const main = servers[0].storageRoot;
const list = (dir) => (existsSync(dir) ? readdirSync(dir) : []);
const leftoverTemps = list(path.join(main, "tmp"));
const leftoverProbes = list(main).filter((n) => n.startsWith(".readiness-"));
const stored = list(main).filter((n) => /^[0-9a-f]{2}$/.test(n)).reduce((n, a) => n + list(path.join(main, a)).reduce((m, b) => m + list(path.join(main, a, b)).length, 0), 0);
console.log(`[e2e] media storage: ${stored} stored file(s), ${leftoverTemps.length} temp file(s), ${leftoverProbes.length} readiness probe(s) left`);
if (leftoverTemps.length || leftoverProbes.length) {
  console.error("[e2e] temporary media files were left behind");
  exitCode = exitCode || 1;
}
for (const s of servers) {
  if (path.basename(s.storageRoot).startsWith(STORAGE_PREFIX)) rmSync(s.storageRoot, { recursive: true, force: true });
}
if (path.basename(logDir).startsWith("covalink-e2e-logs-")) rmSync(logDir, { recursive: true, force: true });
process.exit(exitCode);
