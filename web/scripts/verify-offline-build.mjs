// Proves `next build` needs no database. Usage (from web/):
//   npm run verify:offline-build
//
// Runs `npm run build` with DATABASE_URL (and every other database URL the
// project reads) pointed at a closed loopback port, and with a preload that
// records every outbound socket connection made by the build and all of its
// Node child processes. The build must succeed, and the record must show no
// connection to the closed port, to any PostgreSQL port, or to any other
// host except Next.js's npm security-advisory check. A self-test first
// proves the recorder sees connections.
//
// This writes .next/ like a normal build. The image build additionally runs
// `next build` with no network at all (RUN --network=none in web/Dockerfile).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const POSTGRES_PORTS = new Set([5432, 5433]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]);
// next build's default background security-advisory check (experimental.agentUpgrade
// "security") asks the npm registry over HTTPS. It is the only off-host connection
// allowed; inside the image build it has no network and fails silently.
const isAdvisoryCheck = (c) => c.host === "registry.npmjs.org" && c.port === 443;

const work = mkdtempSync(path.join(tmpdir(), "covalink-offline-build-"));
const preload = path.join(work, "connect-recorder.cjs");
const logFile = path.join(work, "connections.jsonl");

writeFileSync(
  preload,
  `"use strict";
const fs = require("node:fs");
const net = require("node:net");
const log = process.env.COVALINK_CONNECT_LOG;
const record = (entry) => { try { fs.appendFileSync(log, JSON.stringify({ pid: process.pid, ...entry }) + "\\n"); } catch {} };
record({ loaded: true, argv: process.argv.slice(1, 3).map((a) => require("node:path").basename(a)) });
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === "object") record({ host: first.host ?? null, port: first.port == null ? null : Number(first.port), path: first.path ?? null });
  else record({ host: typeof args[1] === "string" ? args[1] : null, port: Number(first) });
  return original.apply(this, args);
};
`,
);

/** Parsed connection records (loaded markers excluded) and the pids that loaded the recorder. */
function readLog() {
  if (!existsSync(logFile)) return { pids: new Set(), loaded: new Map(), connections: [] };
  const lines = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const loadedLines = lines.filter((l) => l.loaded);
  return { pids: new Set(loadedLines.map((l) => l.pid)), loaded: new Map(loadedLines.map((l) => [l.pid, l.argv])), connections: lines.filter((l) => !l.loaded) };
}

async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function fail(message) {
  console.error(`[offline-build] FAIL: ${message}`);
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

const port = await closedPort();
const deadUrl = `postgresql://covalink_offline_build:not-a-secret@127.0.0.1:${port}/covalink_offline_build`;
// npm's update check is the only network access npm itself would make here.
const env = { ...process.env, COVALINK_CONNECT_LOG: logFile, NEXT_TELEMETRY_DISABLED: "1", npm_config_update_notifier: "false" };
for (const key of Object.keys(env)) if (/^PG[A-Z]+$/.test(key)) delete env[key];
for (const key of ["DATABASE_URL", "TEST_DATABASE_URL", "E2E_DATABASE_URL"]) env[key] = deadUrl;
env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--require="${preload.replaceAll("\\", "/")}"`].filter(Boolean).join(" ");

// Self-test: the recorder must see a connection attempt to the closed port.
const probe = spawnSync(
  process.execPath,
  ["-e", `require("node:net").connect(${port}, "127.0.0.1").on("error", () => {})`],
  { env, stdio: "ignore" },
);
const selfTest = readLog();
if (probe.status !== 0 || !selfTest.connections.some((c) => c.port === port)) fail("the connection recorder did not see a test connection");
rmSync(logFile, { force: true });

console.log(`[offline-build] building with every database URL on closed port 127.0.0.1:${port}`);
// One fixed command string (no arguments to escape); a shell resolves npm/npm.cmd.
const build = spawnSync("npm run build", { env, stdio: "inherit", shell: true });
const { pids, loaded, connections } = readLog();
if (build.status !== 0) fail(`next build exited with ${build.status}`);
if (pids.size === 0) fail("the connection recorder was not loaded into the build");

const tcp = connections.filter((c) => c.path == null);
const toDeadPort = tcp.filter((c) => c.port === port);
const toPostgres = tcp.filter((c) => POSTGRES_PORTS.has(c.port));
const offHost = tcp.filter((c) => c.host != null && !LOOPBACK.has(c.host));
const advisory = offHost.filter(isAdvisoryCheck);
const unexpected = offHost.filter((c) => !isAdvisoryCheck(c));
if (toDeadPort.length) fail(`${toDeadPort.length} connection attempt(s) to the database URL during the build`);
if (toPostgres.length) fail(`${toPostgres.length} connection attempt(s) to a PostgreSQL port during the build`);
if (unexpected.length) {
  const who = (pid) => (loaded.get(pid) ?? []).join(" ");
  fail(`connection attempt(s) to other hosts: ${[...new Set(unexpected.map((c) => `${c.host}:${c.port} (from ${who(c.pid)})`))].join(", ")}`);
}

const loopbackPorts = [...new Set(tcp.filter((c) => !offHost.includes(c)).map((c) => c.port))].sort((a, b) => a - b);
console.log(
  `[offline-build] PASS: build succeeded; recorder loaded in ${pids.size} process(es); ` +
    `${tcp.length} TCP connection(s), none to the database port or a PostgreSQL port` +
    (loopbackPorts.length ? `; loopback build-internal ports: ${loopbackPorts.join(", ")}` : "") +
    (advisory.length ? `; ${advisory.length} HTTPS request(s) to registry.npmjs.org:443 (Next.js security-advisory check, not a database)` : ""),
);
rmSync(work, { recursive: true, force: true });
