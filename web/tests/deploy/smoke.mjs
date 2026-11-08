// Production smoke and security verification. Usage (from web/):
//   npm run test:deploy            (add -- --keep to leave the stacks up for debugging)
//
// Builds the production image through compose.prod.yaml, then uses unique
// throwaway Compose projects (covalink-smoke-<id>, -r for the restore target, -f
// for migration failure), each with its own volumes, networks and random
// secrets in a temporary env file, and removes them all at the end. It never
// touches the development database or any existing volume. The app is
// published on 127.0.0.1 only, through compose.smoke.yaml.
//
// Needs: Docker with Compose v2, Git Bash or bash (ops/*.sh), and Microsoft
// Edge for the browser step (PW_CHANNEL selects another installed browser).
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { malformedManifests, manifestVariant, parseManifest, recomputeSums, writeManifestText } from "./backup-variants.mjs";

const KEEP = process.argv.includes("--keep");
const WEB = process.cwd();
const ROOT = path.resolve(WEB, "..");
const PROD = path.join(ROOT, "compose.prod.yaml");
const SMOKE = path.join(ROOT, "compose.smoke.yaml");
const OPS = path.join(ROOT, "ops");
const HELPER_IMAGE = "postgres:17.11-alpine3.24@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b";
const MIGRATIONS = readdirSync(path.join(WEB, "src/db/migrations")).filter((f) => f.endsWith(".sql")).length;
const BASH = process.env.SMOKE_BASH ?? (process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash");

const id = randomBytes(3).toString("hex");
const gitSha = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).stdout.trim() || "unknown";
const dirty = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" }).stdout.trim() ? "-dirty" : "";
const IMAGE = "covalink";
const TAG = `smoke-${gitSha}${dirty}-${id}`;
const work = mkdtempSync(path.join(tmpdir(), "covalink-smoke-"));

// ---------------------------------------------------------------- helpers ----
const results = [];
let fatal = false;
async function check(name, fn) {
  if (fatal) return results.push({ name, ok: false, detail: "skipped after an earlier fatal failure" });
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? "" });
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`  FAIL ${name} — ${err.message}`);
    if (err.fatal) fatal = true;
  }
}
const assert = (cond, message, fatalError = false) => {
  if (!cond) throw Object.assign(new Error(message), { fatal: fatalError });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function run(cmd, args, { input, timeout = 600_000, env } = {}) {
  const r = spawnSync(cmd, args, { input, timeout, env: env ?? process.env, maxBuffer: 512 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ? r.stdout.toString() : "", stderr: r.stderr ? r.stderr.toString() : "", raw: r.stdout, error: r.error };
}
const docker = (...args) => run("docker", args);
const must = (r, what) => {
  assert(r.status === 0, `${what} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")}`);
  return r.stdout.trim();
};
const inspect = (target, format) => must(docker("inspect", "-f", format, target), `docker inspect ${target}`);

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

const secrets = [];
const secret = (bytes = 32) => {
  const value = randomBytes(bytes).toString("hex");
  secrets.push(value);
  return value;
};
const authSecret = secret();

async function makeStack(suffix) {
  const name = `covalink-smoke-${id}${suffix}`;
  const port = await freePort();
  const setupToken = secret();
  const envFile = path.join(work, `${name}.env`);
  const vars = {
    COVALINK_IMAGE: IMAGE,
    COVALINK_IMAGE_TAG: TAG,
    SERVICE_PASSWORD_64_POSTGRES: secret(),
    SERVICE_BASE64_64_AUTHSECRET: authSecret,
    SERVICE_BASE64_64_SETUPTOKEN: setupToken,
    APP_URL: `http://127.0.0.1:${port}`,
    REGISTRATION_ENABLED: "true",
    // TRUST_PROXY is deliberately NOT set: the stacks run on compose.prod.yaml's
    // own default, which the configuration check asserts is false.
    SMOKE_PORT: String(port),
  };
  writeFileSync(envFile, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  const dc = (...args) => run("docker", ["compose", "-p", name, "-f", PROD, "-f", SMOKE, "--env-file", envFile, ...args], { timeout: 900_000 });
  const dcAsync = (...args) =>
    new Promise((resolve) => {
      const p = spawn("docker", ["compose", "-p", name, "-f", PROD, "-f", SMOKE, "--env-file", envFile, ...args]);
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("close", (status) => resolve({ status, out }));
    });
  const container = (service) => dc("ps", "-a", "-q", service).stdout.trim().split("\n")[0] || "";
  const psql = (statement) => must(dc("exec", "-T", "db", "psql", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-U", "covalink", "-d", "covalink", "-c", statement), `psql (${statement.slice(0, 40)})`);
  return { name, port, base: `http://127.0.0.1:${port}`, setupToken, envFile, dc, dcAsync, container, psql, volume: (v) => `${name}_${v}` };
}

async function waitHealth(containerId, want = "healthy", seconds = 180) {
  const deadline = Date.now() + seconds * 1000;
  let last = "";
  while (Date.now() < deadline) {
    last = docker("inspect", "-f", "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.State.Status}}", containerId).stdout.trim();
    if (last.startsWith(want)) return last;
    await sleep(1000);
  }
  throw new Error(`container did not become ${want} within ${seconds} s (last: ${last})`);
}

/** Raw HTTP request (raw header list kept, so duplicate headers can be counted). */
/** A new connection per request (like distinct clients) unless a keep-alive `agent` is given. */
function request(url, { method = "GET", headers = {}, body, timeout = 60_000, agent = false, localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, timeout, agent, localAddress }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("aborted", () => reject(Object.assign(new Error("response aborted"), { code: "TRUNCATED" })));
      res.on("error", (e) => reject(Object.assign(e, { code: "TRUNCATED" })));
      res.on("end", () => {
        const raw = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) raw.push([res.rawHeaders[i].toLowerCase(), res.rawHeaders[i + 1]]);
        resolve({ status: res.statusCode, raw, header: (n) => raw.filter(([k]) => k === n).map(([, v]) => v), body: Buffer.concat(chunks) });
      });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    if (body && typeof body[Symbol.asyncIterator] === "function") {
      (async () => {
        try {
          for await (const chunk of body) if (!req.destroyed) req.write(chunk);
          req.end();
        } catch (e) {
          req.destroy(e);
        }
      })();
    } else req.end(body);
  });
}
const json = (res) => JSON.parse(res.body.toString("utf8"));

/** Sentinels that must never be stored or logged: a client address and a user-agent marker. */
const SENTINEL_IP = "203.0.113.199";
const SENTINEL_UA_MARK = "CovalinkSentinelAgent";
const SMOKE_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 ${SENTINEL_UA_MARK}/9.9`;

/** One session for the main stack's API calls: sign-in is rate limited per endpoint (TRUST_PROXY=false). */
let mainSession = "";
/** The super administrator's session on the main stack (admin checks). */
let ownerCookie = "";
const session = async () => (mainSession ||= await signIn(main, state.email, state.password));

async function signIn(stack, email, password) {
  const res = await request(`${stack.base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: stack.base, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert(res.status === 200, `sign-in returned ${res.status}`);
  return res.header("set-cookie").map((c) => c.split(";")[0]).join("; ");
}

function upload(stack, cookie, kind, body, length, type = "image/jpeg") {
  return request(`${stack.base}/api/media?kind=${kind}`, {
    method: "POST",
    headers: { origin: stack.base, cookie, "content-type": type, ...(length ? { "content-length": String(length) } : {}), "x-upload-filename": "smoke.jpg" },
    body,
  });
}

/** A failed sign-in (unknown account); /sign-in/email allows 5 per minute per rate-limit identity, then 429. */
const badSignIn = (base, { headers = {}, localAddress, via = base } = {}) =>
  request(`${via}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json", ...headers },
    body: JSON.stringify({ email: "nobody@example.com", password: "not-the-password-1" }),
    localAddress,
  }).then((r) => r.status);

/** Distinct spoofed client addresses (TEST-NET-3), sent as both forwarding headers. */
const spoofed = (prefix, i) => ({ "x-forwarded-for": `203.0.113.${prefix + i}`, "x-real-ip": `203.0.113.${prefix + i}` });

/**
 * A controlled reverse proxy on 127.0.0.1 that, like Coolify's Traefik with
 * untrusted clients, discards every client-supplied forwarding header and sets
 * X-Forwarded-For and X-Real-IP to the connecting peer's own address.
 */
async function headerOverwritingProxy(target) {
  const upstream = new URL(target);
  const server = http.createServer((req, res) => {
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/^(x-forwarded-|x-real-ip$|forwarded$)/.test(k)));
    const peer = req.socket.remoteAddress.replace(/^::ffff:/, "");
    Object.assign(headers, { "x-forwarded-for": peer, "x-real-ip": peer });
    const up = http.request({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers, agent: false }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.writeHead(502).end());
    req.pipe(up);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function* trickle(buf, chunks, delayMs) {
  const size = Math.ceil(buf.length / chunks);
  for (let i = 0; i < buf.length; i += size) {
    yield buf.subarray(i, i + size);
    await sleep(delayMs);
  }
}

/** Lists the media volume's tmp/ entries and root probe files through the pinned helper image. */
function volumeLeftovers(volume) {
  const out = must(
    docker("run", "--rm", "--network", "none", "-v", `${volume}:/data:ro`, "--entrypoint", "sh", HELPER_IMAGE, "-c", "ls -A /data/tmp 2>/dev/null; ls -A /data | grep '^\\.readiness-' || true"),
    "volume listing",
  );
  return out ? out.split("\n").filter(Boolean) : [];
}

const bashScript = (script, args) => run(BASH, [path.join(OPS, script).replaceAll("\\", "/"), ...args], { timeout: 900_000 });
/** Like bashScript, without blocking the event loop (so requests can run concurrently). */
const bashScriptAsync = (script, args) =>
  new Promise((resolve) => {
    const p = spawn(BASH, [path.join(OPS, script).replaceAll("\\", "/"), ...args]);
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });

/** Hashes of a stack's whole database (pg_dump) and media volume (names, sizes, owners, modes, mtimes, contents). */
function targetFingerprint(stack) {
  // pg_dump 17.6+ writes a random \restrict key per run; everything else is deterministic.
  const dump = must(stack.dc("exec", "-T", "db", "pg_dump", "-U", "covalink", "-d", "covalink"), "pg_dump")
    .split("\n").filter((l) => !/^\\(un)?restrict /.test(l)).join("\n");
  const media = must(
    docker("run", "--rm", "--network", "none", "-v", `${stack.volume("media")}:/data:ro`, "--entrypoint", "sh", HELPER_IMAGE, "-c",
      "cd /data && find . -exec stat -c '%n %s %u:%g %a %Y' {} + | sort && find . -type f -exec sha256sum {} + | sort"),
    "media listing",
  );
  return { db: sha256(dump), media: sha256(media), files: media.split("\n").filter((l) => / {2}\.\//.test(l)).length };
}

/** Builds `${IMAGE}:${tag}`: this image plus one more migration with the given SQL. */
function imageWithExtraMigration(tag, name, sql) {
  const ctx = path.join(work, `image-${name}`);
  cpSync(path.join(WEB, "src/db/migrations"), path.join(ctx, "migrations"), { recursive: true });
  const journalPath = path.join(ctx, "migrations", "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const migrationTag = `${String(journal.entries.length).padStart(4, "0")}_${name}`;
  writeFileSync(path.join(ctx, "migrations", `${migrationTag}.sql`), sql);
  journal.entries.push({ idx: journal.entries.length, version: "7", when: Date.now(), tag: migrationTag, breakpoints: true });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  writeFileSync(path.join(ctx, "Dockerfile"), `FROM ${IMAGE}:${TAG}\nCOPY migrations/ /app/src/db/migrations/\n`);
  must(docker("build", "-q", "-t", `${IMAGE}:${tag}`, ctx), `build the ${name} image`);
}

async function stopTimed(containerId) {
  const t0 = Date.now();
  const r = await new Promise((resolve) => {
    const p = spawn("docker", ["stop", "-t", "60", containerId]);
    p.on("close", (status) => resolve(status));
  });
  return { status: r, seconds: (Date.now() - t0) / 1000, exitCode: Number(inspect(containerId, "{{.State.ExitCode}}")), oom: inspect(containerId, "{{.State.OOMKilled}}") };
}

// ---------------------------------------------------------------- run --------
const main = await makeStack("");
const restore = await makeStack("-r");
const failing = await makeStack("-f");
const stateFile = path.join(work, "state.json");
let state = {};
let imageId = "";
let appId = "";
// Worst case for decoder memory: 16-bit RGBA PNG at the 40 MP ceiling (no
// shrink-on-load, unlike JPEG) with EXIF orientation 6, so auto-orientation
// needs the whole decoded image.
const maxPng = await sharp({ create: { width: 8000, height: 5000, channels: 4, background: { r: 40, g: 90, b: 160, alpha: 0.6 } } })
  .toColourspace("rgb16")
  .png({ compressionLevel: 9 })
  .withMetadata({ orientation: 6 })
  .toBuffer();
const smallPng = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#aa3366" } }).png({ compressionLevel: 0 }).toBuffer();

console.log(`[deploy] project ${main.name} (app on 127.0.0.1:${main.port}), image ${IMAGE}:${TAG}`);
try {
  console.log("\n# Image");
  await check("image builds through compose.prod.yaml with no network during next build", () => {
    const r = main.dc("build", "app");
    assert(r.status === 0, `compose build failed: ${(r.stderr || r.stdout).split("\n").slice(-5).join(" | ")}`, true);
    assert(/RUN --network=none npm run build/.test(readFileSync(path.join(WEB, "Dockerfile"), "utf8")), "Dockerfile no longer builds with --network=none", true);
    imageId = must(docker("image", "inspect", "-f", "{{.Id}}", `${IMAGE}:${TAG}`), "image inspect");
    return `${imageId.slice(0, 19)}…, ${Math.round(Number(inspect(imageId, "{{.Size}}")) / 1e6)} MB`;
  });

  await check("image runs as uid/gid 1000 by default", () => {
    const user = inspect(imageId, "{{.Config.User}}");
    assert(user === "1000:1000", `Config.User is ${user}`);
    return user;
  });

  await check("image contains no tests, reference source, env files, keys, dev dependencies or build cache", () => {
    const devDeps = Object.keys(JSON.parse(readFileSync(path.join(WEB, "package.json"), "utf8")).devDependencies);
    const script = [
      `for d in ${devDeps.join(" ")}; do [ -e "/app/node_modules/$d" ] && echo "DEV $d"; done; true`,
      // Anywhere in the image: environment files, repository or reference material, build and test output.
      "find / -xdev \\( -path /proc -o -path /sys \\) -prune -o \\( -name '.env' -o -name '.env.*' -o -name '*.tsbuildinfo' -o -name '.git' -o -name 'reference' -o -name 'linkstack' -o -name 'test-results' -o -name 'playwright-report' -o -name 'coverage' -o -name 'Dockerfile' -o -name 'compose*.yaml' \\) -print | sed 's/^/FORBIDDEN /'",
      // In the application and data paths (the base OS has its own CA bundle and busybox's `test`): keys and tests.
      "find /app /data \\( -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.test.*' -o -name '*.spec.*' -o \\( -type d \\( -name test -o -name tests -o -name __tests__ \\) \\) \\) -print | sed 's/^/FORBIDDEN /'",
      "ls /app/node_modules /app/node_modules/@img | sed 's/^/MOD /'",
      "find /app/src -type f | sed 's/^/SRC /'",
      "find /app/.next/cache -mindepth 1 | sed 's/^/CACHE /'",
      "for b in npm npx yarn corepack; do command -v $b >/dev/null && echo TOOL $b; done; true",
      "find /app/.next/server -type f \\( -name '*.html' -o -name '*.rsc' -o -name '*.meta' -o -name '*.body' \\) -exec grep -l 'build-placeholder.invalid' {} + 2>/dev/null | sed 's/^/PLACEHOLDER /'; true",
    ].join("; ");
    const out = must(docker("run", "--rm", "--network", "none", "--entrypoint", "sh", imageId, "-c", script), "filesystem audit");
    const lines = out.split("\n");
    const pick = (p) => lines.filter((l) => l.startsWith(p)).map((l) => l.slice(p.length));
    const forbidden = pick("FORBIDDEN ");
    const modules = pick("MOD ");
    const src = pick("SRC ").filter((f) => !/^\/app\/src\/db\/migrations\//.test(f) && f !== "/app/src/features/media/layout.mjs");
    const problems = [
      ...forbidden.map((f) => `forbidden path ${f}`),
      ...pick("DEV ").map((d) => `dev dependency ${d}`),
      ...src.map((f) => `development source ${f}`),
      ...pick("CACHE ").map((f) => `build cache entry ${f}`),
      ...pick("TOOL ").map((t) => `package manager ${t}`),
      ...pick("PLACEHOLDER ").map((f) => `build placeholder in prerendered output ${f}`),
    ];
    assert(problems.length === 0, problems.slice(0, 6).join("; "));
    return `${modules.length} top-level runtime packages, none of the ${devDeps.length} dev dependencies; src limited to migrations + media layout`;
  });

  await check("only the Linux musl sharp binary is installed, and sharp loads", () => {
    const out = must(
      docker("run", "--rm", "--network", "none", "--entrypoint", "node", imageId, "-e",
        "const s=require('sharp');const r=process.report.getReport().header;console.log(JSON.stringify({sharp:s.versions.sharp,vips:s.versions.vips,platform:process.platform,arch:process.arch,glibc:r.glibcVersionRuntime??null,img:require('fs').readdirSync('node_modules/@img')}))"),
      "sharp load",
    );
    const info = JSON.parse(out);
    const arch = info.arch;
    const expected = ["colour", `sharp-libvips-linuxmusl-${arch}`, `sharp-linuxmusl-${arch}`].sort();
    assert(info.platform === "linux" && info.glibc === null, `not linux/musl: ${out}`);
    assert(JSON.stringify(info.img.sort()) === JSON.stringify(expected), `@img packages: ${info.img.join(", ")}`);
    assert(info.sharp === "0.35.5", `sharp ${info.sharp}`);
    return `sharp ${info.sharp}, libvips ${info.vips}, linux/${arch} musl; @img: ${info.img.join(", ")}`;
  });

  await check("image history, labels and environment contain no secrets", () => {
    const history = must(docker("history", "--no-trunc", "--format", "{{.CreatedBy}}", imageId), "docker history");
    const config = must(docker("image", "inspect", "-f", "{{json .Config.Env}} {{json .Config.Labels}}", imageId), "image config");
    const all = `${history}\n${config}`;
    const leaked = secrets.filter((s) => all.includes(s));
    assert(leaked.length === 0, `${leaked.length} smoke secret value(s) found in image metadata`);
    const named = all.match(/(BETTER_AUTH_SECRET|POSTGRES_PASSWORD|SETUP_TOKEN|SMTP_PASSWORD|DATABASE_URL)=\S+/g) ?? [];
    assert(named.length === 0, `secret-named assignments in history: ${named.join(", ")}`);
    const args = history.match(/\|\d+ [A-Z_]+=/g) ?? [];
    return `build args recorded: ${args.length ? args.join(" ") : "none"}`;
  });

  await check("invalid production configuration: exit 78 before serving, naming settings but no values", async () => {
    const port = await freePort();
    const sentinel = secret();
    const name = `covalink-smoke-${id}-badcfg`;
    const r0 = docker("run", "-d", "--name", name, "-p", `127.0.0.1:${port}:3000`,
      "-e", `APP_URL=http://links.example.com`, "-e", `DATABASE_URL=postgresql://u:${sentinel}@db/app`,
      "-e", `BETTER_AUTH_SECRET=${sentinel.slice(0, 16)}`, "-e", "STORAGE_LOCAL_PATH=relative/path", imageId);
    must(r0, "start container with an invalid configuration");
    let answered = 0;
    try {
      const deadline = Date.now() + 30_000;
      while (inspect(name, "{{.State.Running}}") === "true" && Date.now() < deadline) {
        if (await request(`http://127.0.0.1:${port}/api/health`, { timeout: 1000 }).then(() => true, () => false)) answered++;
      }
      const exit = inspect(name, "{{.State.ExitCode}}");
      const logs = docker("logs", name);
      const text = logs.stdout + logs.stderr;
      assert(exit === "78", `exit code ${exit}`);
      assert(answered === 0, `${answered} request(s) answered by a misconfigured server`);
      for (const setting of ["APP_URL", "BETTER_AUTH_SECRET", "STORAGE_LOCAL_PATH"]) assert(text.includes(setting), `log doesn't name ${setting}`);
      assert(!text.includes(sentinel) && !text.includes(sentinel.slice(0, 16)) && !/postgres(ql)?:\/\//.test(text), "log contains a secret or connection string");
      return `exit 78, 0 requests answered; ${text.match(/"settings":\[[^\]]*\]/)?.[0] ?? ""}`;
    } finally {
      docker("rm", "-f", "-v", name);
    }
  });

  await check("image HEALTHCHECK is liveness only: healthy with the database unreachable, readiness 503", async () => {
    const port = await freePort();
    const name = `covalink-smoke-${id}-nodb`;
    must(docker("run", "-d", "--name", name, "--read-only", "--ipc", "none", "--init", "--cap-drop", "ALL",
      "--tmpfs", "/tmp:uid=1000,gid=1000,mode=0700", "--tmpfs", "/app/.next/cache:uid=1000,gid=1000,mode=0700",
      "-p", `127.0.0.1:${port}:3000`, "-e", `APP_URL=http://127.0.0.1:${port}`, "-e", "COVALINK_ALLOW_LOOPBACK_APP_URL=true",
      "-e", "DATABASE_URL=postgresql://probe:not-a-secret@127.0.0.1:1/unreachable", "-e", `BETTER_AUTH_SECRET=${authSecret}`, imageId), "start container without a database");
    try {
      const status = await waitHealth(name, "healthy", 90);
      const ready = await request(`http://127.0.0.1:${port}/api/ready`);
      assert(ready.status === 503 && json(ready).checks.database === "unavailable" && json(ready).checks.storage === "ok", `ready ${ready.status} ${ready.body}`);
      return `${status.split(" ")[0]} (image HEALTHCHECK); /api/ready 503 ${JSON.stringify(json(ready).checks)}`;
    } finally {
      docker("rm", "-f", "-v", name);
    }
  });

  console.log("\n# Production Compose configuration");
  await check("compose.prod.yaml publishes no host ports and isolates PostgreSQL", () => {
    const r = run("docker", ["compose", "-p", main.name, "-f", PROD, "--env-file", main.envFile, "config", "--format", "json"]);
    const cfg = JSON.parse(must(r, "compose config"));
    const published = Object.entries(cfg.services).filter(([, s]) => s.ports?.length).map(([n]) => n);
    assert(published.length === 0, `services publishing ports: ${published.join(", ")}`);
    assert(Object.keys(cfg.services.db.networks ?? {}).join() === "backend", "db is not on the backend network only");
    assert(cfg.networks.backend.internal === true, "backend network is not internal");
    const app = cfg.services.app;
    assert(app.read_only && app.init && app.ipc === "none" && app.cap_drop?.includes("ALL") && app.security_opt?.includes("no-new-privileges:true"), "app hardening incomplete");
    assert(app.stop_grace_period === "1m0s", `stop_grace_period ${app.stop_grace_period}`);
    assert(cfg.services.migrate.restart === "no" && JSON.stringify(cfg.services.migrate.command) === JSON.stringify(["node", "scripts/migrate.mjs"]), "migrate service changed");
    // The env file sets no TRUST_PROXY, so this is the file's own default.
    assert(!/^TRUST_PROXY=/m.test(readFileSync(main.envFile, "utf8")), "the smoke env file sets TRUST_PROXY, hiding the default");
    assert(app.environment.TRUST_PROXY === "false", `default TRUST_PROXY is ${JSON.stringify(app.environment.TRUST_PROXY)}`);
    return `app mem_limit ${app.mem_limit} bytes, pids ${app.pids_limit}, cpus ${app.cpus}; TRUST_PROXY defaults to false`;
  });

  await check("compose.prod.yaml refuses a missing or empty required variable, with no default text", () => {
    const base = readFileSync(main.envFile, "utf8");
    const required = ["SERVICE_PASSWORD_64_POSTGRES", "APP_URL", "SERVICE_BASE64_64_AUTHSECRET", "SERVICE_BASE64_64_SETUPTOKEN"];
    const env = { ...process.env };
    for (const name of required) delete env[name];
    const probe = path.join(work, `${main.name}-required.env`);
    let refused = 0;
    for (const name of required) {
      const without = base.replace(new RegExp(`^${name}=.*\\n`, "m"), "");
      for (const content of [without, `${without}${name}=\n`]) {
        writeFileSync(probe, content, { mode: 0o600 });
        const r = run("docker", ["compose", "-p", main.name, "-f", PROD, "--env-file", probe, "config", "--format", "json"], { env });
        assert(r.status !== 0, `compose config accepted a missing or empty ${name}`);
        assert(r.stderr.includes(name), `the refusal doesn't name ${name}`);
        refused += 1;
      }
    }
    rmSync(probe, { force: true });
    // Blank SMTP settings reach the app as empty strings; the stack starting below proves they validate.
    const cfg = JSON.parse(must(run("docker", ["compose", "-p", main.name, "-f", PROD, "--env-file", main.envFile, "config", "--format", "json"]), "compose config"));
    assert(cfg.services.app.environment.SETUP_TOKEN === main.setupToken, "generated setup token is not mapped into SETUP_TOKEN");
    assert(cfg.services.app.environment.SMTP_PORT === "", `default SMTP_PORT is ${JSON.stringify(cfg.services.app.environment.SMTP_PORT)}`);
    return `${refused} refusals across ${required.length} variables; generated setup token mapped; SMTP_PORT defaults to blank`;
  });

  console.log("\n# Stack start (clean database)");
  await check("stack starts: db healthy, migrate completes, app healthy (readiness)", async () => {
    const r = main.dc("up", "-d");
    assert(r.status === 0, `compose up failed: ${(r.stderr || r.stdout).split("\n").slice(-4).join(" | ")}`, true);
    appId = main.container("app");
    return await waitHealth(appId);
  });

  await check("migrate ran the same image on a clean database and applied every migration", () => {
    const migrateId = main.container("migrate");
    const [mImage, aImage] = [inspect(migrateId, "{{.Image}}"), inspect(appId, "{{.Image}}")];
    assert(mImage === aImage && aImage === imageId, `image IDs differ: migrate ${mImage}, app ${aImage}, built ${imageId}`);
    assert(inspect(migrateId, "{{.State.ExitCode}}") === "0", "migrate exit code");
    const logs = main.dc("logs", "migrate").stdout;
    assert(logs.includes(`(${MIGRATIONS} migrations applied)`), `migrate log: ${logs.trim().split("\n").pop()}`);
    assert(main.psql("select count(*) from drizzle.__drizzle_migrations") === String(MIGRATIONS), "migration rows");
    return `${MIGRATIONS} migrations; image ${aImage.slice(0, 19)}…`;
  });

  await check("app runs as uid/gid 1000 under init with a read-only root filesystem", () => {
    assert(inspect(appId, "{{.HostConfig.ReadonlyRootfs}}") === "true", "ReadonlyRootfs is false");
    const ids = must(docker("exec", appId, "sh", "-c", "id -u; id -g; tr '\\0' ' ' < /proc/1/cmdline"), "id");
    const [uid, gid, pid1] = ids.split("\n");
    assert(uid === "1000" && gid === "1000", `uid/gid ${uid}/${gid}`);
    assert(/docker-init/.test(pid1), `PID 1 is ${pid1}`);
    const write = docker("exec", appId, "sh", "-c", "echo x > /app/probe");
    assert(write.status !== 0 && /read-only file system/i.test(write.stderr), `writing /app: ${write.stderr.trim()}`);
    return `uid 1000, gid 1000, PID 1 ${pid1.split(" ")[0]}`;
  });

  await check("only /tmp, /app/.next/cache and /data/uploads are writable", () => {
    const script =
      'for d in $(awk "{print \\$2}" /proc/mounts | sort -u) / /app /app/.next /app/.next/server /app/node_modules /app/public /etc /home/node /usr /var /var/tmp /root /run /opt /srv; do [ -d "$d" ] || continue; if mkdir "$d/.w$$" 2>/dev/null; then rmdir "$d/.w$$"; echo "$d"; fi; done; stat -c "%n %u:%g %a" /tmp /app/.next/cache /data/uploads; [ -e /dev/shm ] && echo SHM; true';
    const lines = must(docker("exec", appId, "sh", "-c", script), "writability scan").split("\n");
    const writable = lines.filter((l) => l.startsWith("/") && !l.includes(" ")).sort();
    assert(JSON.stringify(writable) === JSON.stringify(["/app/.next/cache", "/data/uploads", "/tmp"]), `writable: ${writable.join(", ")}`);
    const owners = lines.filter((l) => l.includes(" 1000:1000 "));
    assert(owners.length === 3 && owners.every((l) => l.endsWith(" 700")), `ownership: ${lines.filter((l) => l.includes(":")).join("; ")}`);
    assert(!lines.includes("SHM"), "/dev/shm exists");
    return "all three owned 1000:1000 mode 0700; no /dev/shm";
  });

  await check("PostgreSQL has no host port; the app only the smoke loopback port", () => {
    const dbId = main.container("db");
    assert(inspect(dbId, "{{json .HostConfig.PortBindings}}") === "{}", "db has port bindings");
    assert(docker("port", dbId).stdout.trim() === "", "db publishes ports");
    const appPorts = docker("port", appId).stdout.trim().split("\n");
    assert(appPorts.length === 1 && appPorts[0] === `3000/tcp -> 127.0.0.1:${main.port}`, `app ports: ${appPorts.join(", ")}`);
    return appPorts[0];
  });

  console.log("\n# Health");
  await check("/api/health and /api/ready return 200 with only the fixed vocabulary", async () => {
    const health = await request(`${main.base}/api/health`);
    const ready = await request(`${main.base}/api/ready`);
    assert(health.status === 200 && JSON.stringify(json(health)) === '{"status":"ok"}', `health ${health.status} ${health.body}`);
    assert(ready.status === 200 && JSON.stringify(json(ready)) === '{"status":"ready","checks":{"database":"ok","storage":"ok"}}', `ready ${ready.status} ${ready.body}`);
    for (const r of [health, ready]) assert(/no-store/.test(r.header("cache-control").join()), "cache-control");
    const text = health.body.toString() + ready.body.toString();
    assert(!secrets.some((s) => text.includes(s)) && !/postgres|db:5432|password/i.test(text), "health bodies leak details");
    return "health ok; ready {database: ok, storage: ok}";
  });

  console.log("\n# Product workflow (browser)");
  await check("setup, registration, sign-out/in, profile edit, avatar upload, publish, cache invalidation", () => {
    const r = run(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "-c", "tests/deploy/playwright.config.ts"], {
      env: { ...process.env, SMOKE_BASE_URL: main.base, SMOKE_SETUP_TOKEN: main.setupToken, SMOKE_STATE_FILE: stateFile },
    });
    process.stdout.write(r.stdout.split("\n").map((l) => `      ${l}`).join("\n") + "\n");
    assert(r.status === 0, `playwright exit ${r.status}: ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`, true);
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    return `public /${state.handle}, avatar ${state.avatarUrl}`;
  });

  await check("account deletion only through the confirmed Server Action (Better Auth delete-user is 404)", async () => {
    const email = "smoke-delete@example.com";
    const password = "smoke-delete-password-1";
    const up = await request(`${main.base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: main.base, "content-type": "application/json" },
      body: JSON.stringify({ name: "Delete Me", email, password }),
    });
    assert(up.status === 200, `sign-up ${up.status}`);
    const cookie = up.header("set-cookie").map((c) => c.split(";")[0]).join("; ");
    const direct = await request(`${main.base}/api/auth/delete-user`, {
      method: "POST",
      headers: { origin: main.base, cookie, "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    assert(direct.status === 404, `direct delete-user ${direct.status}`);
    assert(main.psql(`select count(*) from users where email = '${email}'`) === "1", "deleted by the blocked endpoint");
    const page = await request(`${main.base}/dashboard/account`, { headers: { cookie } });
    let actionId = "";
    for (const src of new Set([...page.body.toString().matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]))) {
      const m = /createServerReference\)?\(\s*"([0-9a-f]{40,})"[^()]*?"deleteAccountAction"/.exec((await request(`${main.base}${src}`)).body.toString());
      if (m) actionId = m[1];
    }
    assert(actionId, "deleteAccountAction id not found in the account page's client chunks");
    const act = (confirmation) =>
      request(`${main.base}/dashboard/account`, {
        method: "POST",
        headers: { "next-action": actionId, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component", origin: main.base, cookie },
        body: JSON.stringify([{ password, confirmation }]),
      }).then((r) => r.body.toString());
    const unconfirmed = await act("delete");
    assert(unconfirmed.includes('"ok":false') && main.psql(`select count(*) from users where email = '${email}'`) === "1", "deleted without the typed phrase");
    const done = await act("delete my account");
    assert(done.includes('"ok":true'), `deletion failed: ${done.slice(-200)}`);
    assert(main.psql(`select count(*) from users where email = '${email}'`) === "0", "user row still present");
    assert(main.psql("select count(*) from audit_logs where action = 'account.deleted' and actor_id is null") === "1", "no account.deleted audit row");
    const again = await request(`${main.base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: main.base, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    assert(again.status === 401, `sign-in after deletion ${again.status}`);
    return "direct endpoint 404; no phrase refused; confirmed action deleted; audit account.deleted; sign-in now 401";
  });

  await check("account self-service pages: token pages send no-referrer, no-store and noindex once; reset requests are generic", async () => {
    for (const path of ["/reset-password", "/verify-email"]) {
      const res = await request(`${main.base}${path}`);
      assert(res.status === 200, `${path} ${res.status}`);
      assert(JSON.stringify(res.header("referrer-policy")) === '["no-referrer"]', `${path} referrer-policy ${res.header("referrer-policy")}`);
      assert(JSON.stringify(res.header("x-robots-tag")) === '["noindex"]', `${path} x-robots-tag ${res.header("x-robots-tag")}`);
      const cache = res.header("cache-control");
      assert(cache.length === 1 && /no-store/.test(cache[0]), `${path} cache-control ${cache}`);
      assert(res.header("content-security-policy").length === 1, `${path} CSP fields ${res.header("content-security-policy").length}`);
    }
    const forgot = (await request(`${main.base}/forgot-password`)).body.toString();
    const ask = (email) =>
      request(`${main.base}/api/auth/request-password-reset`, {
        method: "POST",
        headers: { origin: main.base, "content-type": "application/json" },
        body: JSON.stringify({ email }),
      }).then((r) => `${r.status} ${r.body.toString()}`);
    const known = await ask(state.ownerEmail);
    const unknown = await ask("nobody-smoke@example.com");
    assert(known === unknown && known.startsWith("200 "), `reset answers differ: ${known} | ${unknown}`);
    for (const path of ["/api/auth/verify-email?token=x", "/api/auth/reset-password/x?callbackURL=%2F"]) {
      const res = await request(`${main.base}${path}`);
      assert(res.status === 404, `${path} ${res.status}`);
    }
    // A reset token in the query string is refused before Better Auth; the body form is still routed.
    const reset = (path, body) =>
      request(`${main.base}${path}`, { method: "POST", headers: { origin: main.base, "content-type": "application/json" }, body: JSON.stringify(body) });
    const queryForm = await reset("/api/auth/reset-password?token=x", { newPassword: "smoke-new-password" });
    assert(queryForm.status === 404, `query-token reset ${queryForm.status}`);
    const bodyForm = await reset("/api/auth/reset-password", { token: "x", newPassword: "smoke-new-password" });
    assert(bodyForm.status === 400, `body-token reset ${bodyForm.status}`);
    return `token pages: one no-referrer/no-store/noindex/CSP each; forgot-password ${forgot.includes("reset-unavailable") ? "says to ask the administrator (no SMTP)" : "shows the form"}; reset answers identical; token-in-URL endpoints and the query-token reset 404; body-token reset routed (400 for a bad token)`;
  });

  console.log("\n# Response headers");
  let avatarSha = "";
  await check("media responses: image/webp, exactly one sandbox CSP, nosniff, CORP, no cookies", async () => {
    const res = await request(`${main.base}${state.avatarUrl}`);
    assert(res.status === 200, `status ${res.status}`);
    const csp = res.header("content-security-policy");
    assert(csp.length === 1, `${csp.length} CSP headers`);
    assert(/^sandbox; default-src 'none'/.test(csp[0]), `CSP ${csp[0]}`);
    assert(res.header("content-type").join() === "image/webp", "content-type");
    assert(res.header("x-content-type-options").join() === "nosniff", "nosniff");
    assert(res.header("cross-origin-resource-policy").join() === "same-origin", "CORP");
    assert(res.header("set-cookie").length === 0, "media response sets a cookie");
    avatarSha = sha256(res.body);
    return `CSP "${csp[0]}"`;
  });

  await check("public profile responses: one CSP and no cookies", async () => {
    const res = await request(`${main.base}/${state.handle}`);
    assert(res.status === 200, `status ${res.status}`);
    assert(res.header("content-security-policy").length === 1, `${res.header("content-security-policy").length} CSP headers`);
    assert(res.header("set-cookie").length === 0, "public page sets a cookie");
    assert(res.body.toString().includes(state.displayName), "published name missing");
    return "1 CSP, 0 Set-Cookie";
  });

  console.log("\n# Analytics");
  let analyticsProfile = "";
  await check("link blocks use /go; beacon and /go set no cookies; /go p95 < 500 ms after warm-up, every click stored", async () => {
    const blockId = randomUUID();
    const link = JSON.stringify([{ id: blockId, type: "link", version: 2, visible: true, config: { title: "Smoke link", url: "https://smoke-destination.example.com/landing" } }]);
    // A new published revision with one link block (as a publish would write it).
    main.psql(`update profiles set published = jsonb_set(published, '{blocks}', coalesce(published->'blocks', '[]'::jsonb) || '${link}'::jsonb),
      draft_revision = draft_revision + 1, published_revision = draft_revision + 1 where handle = '${state.handle}'`);
    analyticsProfile = main.psql(`select id from profiles where handle = '${state.handle}'`);
    const page = await request(`${main.base}/${state.handle}`);
    assert(page.status === 200 && page.body.toString().includes(`href="/go/${analyticsProfile}/${blockId}"`), "public link does not use /go");
    assert(page.header("set-cookie").length === 0, "public page sets a cookie");
    const visitor = { "user-agent": SMOKE_UA, "x-forwarded-for": SENTINEL_IP, "x-real-ip": SENTINEL_IP };
    const beacon = await request(`${main.base}/api/v`, {
      method: "POST",
      headers: { origin: main.base, "sec-fetch-site": "same-origin", "content-type": "application/json", ...visitor },
      body: JSON.stringify({ p: analyticsProfile, r: "https://referrer.example.org/some/path?q=1" }),
    });
    assert(beacon.status === 204 && beacon.header("set-cookie").length === 0, `beacon ${beacon.status}, ${beacon.header("set-cookie").length} cookies`);
    const clicks = () => Number(main.psql(`select count(*) from analytics_events where profile_id = '${analyticsProfile}' and type = 'click'`));
    const before = clicks();
    const go = async () => {
      const t0 = performance.now();
      const res = await request(`${main.base}/go/${analyticsProfile}/${blockId}`, { headers: visitor });
      const ms = performance.now() - t0;
      assert(res.status === 302 && res.header("location").join() === "https://smoke-destination.example.com/landing", `/go ${res.status}`);
      assert(res.header("cache-control").join() === "no-store" && res.header("set-cookie").length === 0, "/go headers");
      return ms;
    };
    for (let i = 0; i < 10; i++) await go();
    const timings = [];
    for (let i = 0; i < 100; i++) timings.push(await go());
    timings.sort((a, b) => a - b);
    const p50 = timings[49];
    const p95 = timings[94];
    const stored = clicks() - before;
    assert(stored === 110, `${stored} of 110 clicks stored`);
    const view = main.psql(`select concat_ws(',', referrer_host, device, coalesce(visitor_hash, 'null')) from analytics_events where profile_id = '${analyticsProfile}' and type = 'view'`);
    assert(view === "referrer.example.org,desktop,null", `view row ${view}`);
    assert(p95 < 500, `/go p95 ${p95.toFixed(0)} ms`);
    return `/go after 10 warm-up requests: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${timings[99].toFixed(1)} ms (100 sequential, each 302 + stored click: ${stored}/110); beacon 204; view stored as host+device, no visitor hash (TRUST_PROXY default false)`;
  });

  await check("contact and social blocks: social item /go counted per block, HEAD not; vCard with each header once; email direct", async () => {
    const socialId = randomUUID();
    const emailId = randomUUID();
    const contactId = randomUUID();
    const blocks = JSON.stringify([
      { id: socialId, type: "social", version: 2, visible: true, config: { items: [{ platform: "github", url: "https://github.com/smoke" }], style: "inherit" } },
      { id: emailId, type: "email", version: 2, visible: true, config: { label: "Email smoke", email: "smoke@example.com", subject: "Hi" } },
      { id: contactId, type: "contact", version: 2, visible: true, config: { label: "Save contact", firstName: "Zoe", organization: "Smoke; Co" } },
    ]);
    main.psql(`update profiles set published = jsonb_set(published, '{blocks}', coalesce(published->'blocks', '[]'::jsonb) || '${blocks}'::jsonb),
      draft_revision = draft_revision + 1, published_revision = draft_revision + 1 where handle = '${state.handle}'`);
    const html = (await request(`${main.base}/${state.handle}`)).body.toString();
    assert(html.includes(`href="/go/${analyticsProfile}/${socialId}/0"`), "social item does not use /go/{index}");
    assert(html.includes('href="mailto:smoke@example.com?subject=Hi"'), "email link");
    assert(html.includes(`href="/api/vcard/${analyticsProfile}/${contactId}"`), "contact card link");

    const events = () => Number(main.psql(`select count(*) from analytics_events where profile_id = '${analyticsProfile}'`));
    const socialClicks = () => Number(main.psql(`select count(*) from analytics_events where block_id = '${socialId}' and type = 'click'`));
    const visitor = { "user-agent": SMOKE_UA, "x-forwarded-for": SENTINEL_IP };
    const go = await request(`${main.base}/go/${analyticsProfile}/${socialId}/0`, { headers: visitor });
    assert(go.status === 302 && go.header("location").join() === "https://github.com/smoke" && go.header("set-cookie").length === 0, `social /go ${go.status}`);
    const head = await request(`${main.base}/go/${analyticsProfile}/${socialId}/0`, { method: "HEAD", headers: visitor });
    assert(head.status === 302 && head.header("location").join() === "https://github.com/smoke", `social /go HEAD ${head.status}`);
    const outOfRange = await request(`${main.base}/go/${analyticsProfile}/${socialId}/1`, { headers: visitor });
    assert(outOfRange.status === 404, `out-of-range index ${outOfRange.status}`);
    assert(socialClicks() === 1, `${socialClicks()} social clicks stored (expected 1)`);

    const before = events();
    const card = await request(`${main.base}/api/vcard/${analyticsProfile}/${contactId}`, { headers: visitor });
    const once = (name, expected) => {
      const values = card.header(name);
      assert(values.length === 1 && (expected === undefined || values[0] === expected), `vCard ${name}: ${JSON.stringify(values)}`);
    };
    assert(card.status === 200, `vCard ${card.status}`);
    once("content-type", "text/vcard; charset=utf-8");
    once("content-disposition", 'attachment; filename="Zoe.vcf"');
    once("x-content-type-options", "nosniff");
    once("cache-control", "no-store");
    once("x-robots-tag", "noindex, nofollow");
    once("content-security-policy", "sandbox; default-src 'none'");
    assert(card.header("set-cookie").length === 0, "vCard sets a cookie");
    const text = card.body.toString("utf8");
    assert(text.startsWith("BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Zoe\r\n") && text.includes("ORG:Smoke\\; Co\r\n") && text.endsWith("END:VCARD\r\n"), "vCard body");
    const cardHead = await request(`${main.base}/api/vcard/${analyticsProfile}/${contactId}`, { method: "HEAD" });
    assert(cardHead.status === 200 && cardHead.body.length === 0 && cardHead.header("content-disposition").join() === 'attachment; filename="Zoe.vcf"', "vCard HEAD");
    const missing = await request(`${main.base}/api/vcard/${analyticsProfile}/${emailId}`);
    assert(missing.status === 404 && missing.header("content-security-policy").length === 1 && missing.header("content-disposition").length === 0, `vCard of an email block ${missing.status}`);
    assert(events() === before, "a vCard download was recorded");
    return "social item /go 302 + 1 click (HEAD and out-of-range not counted); mailto link direct; vCard 200 with one content-type/disposition/nosniff/no-store/noindex/CSP each, no cookie; HEAD 200 empty; non-contact 404; downloads not counted";
  });

  await check("image blocks: uploaded image rendered with its stored size and no optimizer; linked image /go counted, HEAD not; no cookies", async () => {
    const cookie = await session();
    const up = await upload(main, cookie, "background", smallPng, smallPng.length, "image/png");
    assert(up.status === 201, `upload ${up.status}`);
    const asset = JSON.parse(up.body.toString()).asset;
    assert(asset.width === 1200 && asset.height === 900 && /^\/media\/[0-9a-f-]{36}\.webp$/.test(asset.url), `asset ${JSON.stringify(asset)}`);
    const imageId = randomUUID();
    const blocks = JSON.stringify([
      {
        id: imageId,
        type: "image",
        version: 2,
        visible: true,
        config: { src: asset.url, width: asset.width, height: asset.height, alt: "Smoke image", decorative: false, href: "https://smoke-image.example.com/", aspect: "auto" },
      },
    ]);
    main.psql(`update profiles set published = jsonb_set(published, '{blocks}', coalesce(published->'blocks', '[]'::jsonb) || '${blocks}'::jsonb),
      draft_revision = draft_revision + 1, published_revision = draft_revision + 1 where handle = '${state.handle}'`);
    const page = await request(`${main.base}/${state.handle}`);
    const html = page.body.toString();
    const expected = `<a class="pp-image-link" href="/go/${analyticsProfile}/${imageId}" rel="noopener nofollow ugc"><img class="pp-image" src="${asset.url}" alt="Smoke image" width="1200" height="900" loading="lazy" decoding="async"/></a>`;
    assert(page.status === 200 && html.includes(expected), "image block markup");
    assert(!html.includes("/_next/image"), "image optimizer used");
    assert(page.header("content-security-policy").length === 1 && page.header("set-cookie").length === 0, "public page headers");
    const file = await request(`${main.base}${asset.url}`);
    assert(file.status === 200 && file.header("content-type").join() === "image/webp" && file.header("set-cookie").length === 0, `image file ${file.status}`);

    const imageClicks = () => Number(main.psql(`select count(*) from analytics_events where block_id = '${imageId}' and type = 'click'`));
    const visitor = { "user-agent": SMOKE_UA, "x-forwarded-for": SENTINEL_IP };
    const head = await request(`${main.base}/go/${analyticsProfile}/${imageId}`, { method: "HEAD", headers: visitor });
    assert(head.status === 302 && head.header("location").join() === "https://smoke-image.example.com/", `image /go HEAD ${head.status}`);
    const go = await request(`${main.base}/go/${analyticsProfile}/${imageId}`, { headers: visitor });
    assert(go.status === 302 && go.header("location").join() === "https://smoke-image.example.com/", `image /go ${go.status}`);
    assert(go.header("cache-control").join() === "no-store" && go.header("set-cookie").length === 0, "image /go headers");
    assert(imageClicks() === 1, `${imageClicks()} image clicks stored (expected 1)`);
    return `img ${asset.width}×${asset.height} with width/height, lazy, no /_next/image; /go 302 + 1 click (HEAD not counted); 1 CSP, 0 cookies`;
  });

  await check("embed blocks: click-to-load box with no iframe or provider resource; embed frame-src only on public pages; /go 404; no cookies", async () => {
    const videoId = randomUUID();
    const musicId = randomUUID();
    const blocks = JSON.stringify([
      { id: videoId, type: "video", version: 2, visible: true, config: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Smoke video" } },
      { id: musicId, type: "music", version: 2, visible: true, config: { url: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC" } },
    ]);
    main.psql(`update profiles set published = jsonb_set(published, '{blocks}', coalesce(published->'blocks', '[]'::jsonb) || '${blocks}'::jsonb),
      draft_revision = draft_revision + 1, published_revision = draft_revision + 1 where handle = '${state.handle}'`);
    const page = await request(`${main.base}/${state.handle}`);
    const html = page.body.toString();
    assert(page.status === 200 && html.includes('aria-label="Smoke video"') && html.includes('aria-label="Spotify player"'), "embed boxes");
    assert(!/<iframe/i.test(html), "iframe before Load");
    const markup = html.replace(/<script[\s\S]*?<\/script>/g, "");
    assert(!/\b(?:src|srcset|poster)="[^"]*(?:youtube|vimeo|spotify|soundcloud)/i.test(markup), "provider resource in the markup");
    assert(markup.includes('href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" target="_blank" rel="noopener nofollow ugc"'), "Open link");
    const frameSrc = "frame-src https://www.youtube-nocookie.com/embed/ https://player.vimeo.com/video/ https://open.spotify.com/embed/ https://w.soundcloud.com/player/";
    const csp = page.header("content-security-policy");
    assert(csp.length === 1 && csp[0].includes(frameSrc) && page.header("set-cookie").length === 0, "public page headers");
    for (const path of ["/login", "/dashboard", "/admin", "/api/health"]) {
      const other = await request(`${main.base}${path}`);
      const otherCsp = other.header("content-security-policy");
      assert(otherCsp.length === 1 && otherCsp[0].includes("frame-src 'none'"), `${path} keeps frame-src 'none'`);
    }
    const visitor = { "user-agent": SMOKE_UA, "x-forwarded-for": SENTINEL_IP };
    for (const id of [videoId, musicId]) {
      const go = await request(`${main.base}/go/${analyticsProfile}/${id}`, { headers: visitor });
      assert(go.status === 404, `embed /go ${go.status}`);
    }
    return "2 click-to-load boxes, 0 iframes, 0 provider resources; 1 CSP with the embed frame-src on the public page, frame-src 'none' elsewhere; /go 404; 0 cookies";
  });

  await check("analytics:purge runs in the read-only app container and a one-off container: dry run, exact deletion, idempotent", async () => {
    const pid = analyticsProfile;
    // Default retention 395 days: boundary = start of UTC day (today - 394).
    main.psql(`insert into analytics_events (profile_id, type, device, occurred_at) values
      ('${pid}', 'view', 'desktop', (date_trunc('day', now() at time zone 'utc') - interval '394 days') at time zone 'utc' - interval '1 millisecond'),
      ('${pid}', 'view', 'desktop', now() - interval '800 days'),
      ('${pid}', 'view', 'desktop', (date_trunc('day', now() at time zone 'utc') - interval '394 days') at time zone 'utc')`);
    main.psql(`insert into analytics_salts (day, salt) select (now() at time zone 'utc')::date - d, rpad(d::text, 43, 'x') from generate_series(0, 4) d on conflict (day) do nothing`);
    const total = () => main.psql("select count(*) from analytics_events");
    const before = Number(total());
    const exec = (...args) => main.dc("exec", "-T", "app", "node", "scripts/analytics-purge.mjs", ...args);
    const dry = exec("--dry-run");
    assert(dry.status === 0 && /would delete 2 events and 3 salts/.test(dry.stdout), `dry run: ${dry.status} ${dry.stdout.trim()} ${dry.stderr.trim()}`);
    assert(Number(total()) === before, "dry run deleted rows");
    const real = exec();
    assert(real.status === 0 && /deleted 2 events and 3 salts/.test(real.stdout), `purge: ${real.status} ${real.stdout.trim()} ${real.stderr.trim()}`);
    assert(Number(total()) === before - 2, "wrong number of events deleted");
    const ages = main.psql("select string_agg(((now() at time zone 'utc')::date - day)::text, ',' order by day desc) from analytics_salts");
    assert(ages === "0,1", `salts left: ages ${ages}`);
    const oneOff = main.dc("run", "--rm", "--no-deps", "migrate", "node", "scripts/analytics-purge.mjs");
    assert(oneOff.status === 0 && /deleted 0 events and 0 salts/.test(oneOff.stdout), `one-off rerun: ${oneOff.status} ${oneOff.stdout.trim()} ${oneOff.stderr.trim()}`);
    const out = dry.stdout + real.stdout + oneOff.stdout + dry.stderr + real.stderr + oneOff.stderr;
    assert(!secrets.some((s) => out.includes(s)) && !/postgres(ql)?:\/\/|[0-9a-f]{64}|xxxx/.test(out), "purge output contains a secret, URL, hash or salt");
    return `${real.stdout.trim().split("\n").pop().replace("[analytics:purge] ", "")}; salts kept: today and yesterday; rerun (one-off migrate-service container): 0 and 0`;
  });

  console.log("\n# Administration console");
  await check("admin status page: only the safe vocabulary, the image's version, database and storage ready", async () => {
    ownerCookie = await signIn(main, state.ownerEmail, state.ownerPassword);
    const res = await request(`${main.base}/admin`, { headers: { cookie: ownerCookie } });
    const html = res.body.toString();
    assert(res.status === 200, `/admin ${res.status}`);
    const value = (id) => new RegExp(`data-testid="status-${id}"[^>]*>([^<]*)<`).exec(html)?.[1];
    assert(value("version") === TAG, `version ${value("version")}`);
    assert(value("database") === "Ready" && value("storage") === "Ready", `database ${value("database")}, storage ${value("storage")}`);
    assert(value("migrations") === String(MIGRATIONS), `migrations ${value("migrations")}`);
    assert(!secrets.some((s) => html.includes(s)), "status page contains a secret");
    for (const leak of [/postgres(ql)?:\/\//i, /\/data\/uploads/, /@db:5432/, /BETTER_AUTH_SECRET|POSTGRES_PASSWORD/]) assert(!leak.test(html), `status page matches ${leak}`);
    return `version ${value("version")}, database ${value("database")}, storage ${value("storage")}, email ${value("email")}, migrations ${value("migrations")}; no secret, URL or path`;
  });

  await check("admin mutation and audit round trip over Server Actions: disable, no-op repeat, re-enable; one audit row per change", async () => {
    const email = "smoke-admin-target@example.com";
    const up = await request(`${main.base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: main.base, "content-type": "application/json" },
      body: JSON.stringify({ name: "Smoke Target", email, password: "smoke-target-password-1" }),
    });
    assert(up.status === 200, `sign-up ${up.status}`);
    const targetId = main.psql(`select id from users where email = '${email}'`);
    const audits = () => Number(main.psql("select count(*) from audit_logs where action in ('user.ban', 'user.unban')"));
    const before = audits();
    const page = await request(`${main.base}/admin/users/${targetId}`, { headers: { cookie: ownerCookie } });
    const chunks = [...new Set([...page.body.toString().matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]))];
    let actionId = "";
    for (const src of chunks) {
      const m = /createServerReference\)?\(\s*"([0-9a-f]{40,})"[^()]*?"setUserDisabledAction"/.exec((await request(`${main.base}${src}`)).body.toString());
      if (m) actionId = m[1];
    }
    assert(actionId, "setUserDisabledAction id not found in the page's client chunks");
    const act = (disabled) =>
      request(`${main.base}/admin/users/${targetId}`, {
        method: "POST",
        headers: { "next-action": actionId, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component", origin: main.base, cookie: ownerCookie },
        body: JSON.stringify([{ userId: targetId, disabled }]),
      }).then((r) => r.body.toString());
    const disabled = await act(true);
    assert(disabled.includes('"changed":true'), `disable did not change: ${disabled.slice(-200)}`);
    assert(main.psql(`select banned from users where id = '${targetId}'`) === "t", "not disabled");
    assert(main.psql(`select count(*) from sessions where user_id = '${targetId}'`) === "0", "sessions remain");
    const repeat = await act(true);
    assert(repeat.includes('"changed":false'), `repeat was not a no-op: ${repeat.slice(-200)}`);
    assert(audits() === before + 1, `audit rows after disable + repeat: ${audits() - before}`);
    const enabled = await act(false);
    assert(enabled.includes('"changed":true'), `re-enable did not change: ${enabled.slice(-200)}`);
    assert(audits() === before + 2, `audit rows after re-enable: ${audits() - before}`);
    const audit = (await request(`${main.base}/admin/audit?target=${targetId}`, { headers: { cookie: ownerCookie } })).body.toString();
    assert(audit.includes("Account disabled") && audit.includes("Account re-enabled"), "audit page lacks the entries");
    return `disable → changed (sessions 0), repeat → no-op, re-enable → changed; audit rows +2 exactly; /admin/audit lists both`;
  });

  console.log("\n# Persistence");
  await check("uploaded media and data survive recreating the app container", async () => {
    const before = appId;
    must(main.dc("up", "-d", "--force-recreate", "--no-deps", "app"), "recreate app");
    appId = main.container("app");
    assert(appId && appId !== before, "app container was not recreated");
    await waitHealth(appId);
    const res = await request(`${main.base}${state.avatarUrl}`);
    assert(res.status === 200 && sha256(res.body) === avatarSha, `avatar after recreate: ${res.status}`);
    const page = await request(`${main.base}/${state.handle}`);
    assert(page.status === 200 && page.body.toString().includes(state.displayName), "profile after recreate");
    return `new container ${appId.slice(0, 12)}; avatar bytes identical`;
  });

  // App-only rollback compatibility (docs/BACKUP_RESTORE.md "Rollback"): the previous approved image on the current schema.
  // Opt-in, because it needs that image locally: SMOKE_PREVIOUS_TAG=<tag of the previous covalink image>.
  const previousTag = process.env.SMOKE_PREVIOUS_TAG;
  if (previousTag) {
    await check(`the previous image (${previousTag}) serves on this schema: ready, public page, sign-in; then back to this image`, async () => {
      assert(/^[A-Za-z0-9._-]{1,128}$/.test(previousTag) && docker("image", "inspect", `${IMAGE}:${previousTag}`).status === 0, "previous image not found locally");
      const prevEnv = path.join(work, `${main.name}-previous.env`);
      writeFileSync(prevEnv, readFileSync(main.envFile, "utf8").replace(`COVALINK_IMAGE_TAG=${TAG}`, `COVALINK_IMAGE_TAG=${previousTag}`), { mode: 0o600 });
      const swap = (envFile) => must(run("docker", ["compose", "-p", main.name, "-f", PROD, "-f", SMOKE, "--env-file", envFile, "up", "-d", "--no-deps", "--force-recreate", "app"]), "recreate app");
      swap(prevEnv);
      appId = main.container("app");
      await waitHealth(appId);
      const migrations = Number(main.psql("select count(*) from drizzle.__drizzle_migrations"));
      const ready = await request(`${main.base}/api/ready`);
      const page = await request(`${main.base}/${state.handle}`);
      await signIn(main, state.email, state.password);
      assert(ready.status === 200 && page.status === 200 && page.body.toString().includes(state.displayName), `previous image: ready ${ready.status}, page ${page.status}`);
      assert(!page.body.toString().includes("/go/"), "the previous image renders /go links");
      swap(main.envFile);
      appId = main.container("app");
      await waitHealth(appId);
      assert(inspect(appId, "{{.Config.Image}}") === `${IMAGE}:${TAG}`, "not back on this image");
      return `${migrations} migrations applied; previous image: ready 200, public page 200 (direct links, no beacon), sign-in 200; restored to this image`;
    });
  }

  console.log("\n# Memory at the configured limit");
  await check("concurrent maximum-bound (40 MP, 16-bit RGBA, rotated) image decodes fit within the app memory limit", async () => {
    const cookie = await session();
    const limit = Number(must(docker("exec", appId, "cat", "/sys/fs/cgroup/memory.max"), "memory.max"));
    const swap = must(docker("exec", appId, "cat", "/sys/fs/cgroup/memory.swap.max"), "memory.swap.max");
    assert(swap === "0", `swap allowed beyond the memory limit (memory.swap.max ${swap})`);
    const idle = Number(must(docker("exec", appId, "cat", "/sys/fs/cgroup/memory.current"), "memory.current"));
    const started = Date.now();
    const responses = await Promise.all([0, 1, 2, 3].map(() => upload(main, cookie, "background", maxPng, maxPng.length, "image/png")));
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const statuses = responses.map((r) => r.status);
    const peak = Number(must(docker("exec", appId, "cat", "/sys/fs/cgroup/memory.peak"), "memory.peak"));
    assert(inspect(appId, "{{.State.OOMKilled}}") === "false" && inspect(appId, "{{.State.Running}}") === "true", "app was OOM-killed or stopped");
    assert(statuses.every((s) => s === 201), `statuses ${statuses.join(", ")}`);
    const body = json(responses[0]).asset;
    assert(body.width === 2048 || body.height === 2048, `output ${body.width}x${body.height}`);
    assert(peak < limit * 0.9, `peak ${(peak / 2 ** 20).toFixed(0)} MiB is within 10% of the ${(limit / 2 ** 20).toFixed(0)} MiB limit`);
    return `4 concurrent 8000×5000 16-bit RGBA PNG (EXIF orientation 6, ${(maxPng.length / 1e6).toFixed(2)} MB) uploads (2 decode, 2 queued): 201 ×4 in ${seconds} s; idle ${(idle / 2 ** 20).toFixed(0)} MiB, cgroup peak ${(peak / 2 ** 20).toFixed(0)} MiB of ${(limit / 2 ** 20).toFixed(0)} MiB (${((100 * peak) / limit).toFixed(0)}%), no swap`;
  });

  console.log("\n# Readiness under dependency failures");
  await check("database outage: readiness 503 (database), liveness still 200; recovers", async () => {
    const dbId = main.container("db");
    must(docker("stop", "-t", "30", dbId), "stop db");
    try {
      const health = await request(`${main.base}/api/health`);
      const ready = await request(`${main.base}/api/ready`);
      assert(health.status === 200, `health ${health.status}`);
      const body = json(ready);
      assert(ready.status === 503 && ["unavailable", "timeout"].includes(body.checks.database) && body.checks.storage === "ok", `ready ${ready.status} ${ready.body}`);
      return `ready 503 ${JSON.stringify(body.checks)}; health 200`;
    } finally {
      must(docker("start", dbId), "start db");
      await waitHealth(dbId);
      const deadline = Date.now() + 60_000;
      while ((await request(`${main.base}/api/ready`).catch(() => ({ status: 0 }))).status !== 200) {
        assert(Date.now() < deadline, "readiness did not recover");
        await sleep(1000);
      }
    }
  });

  await check("unwritable media storage: readiness 503 (storage); recovers", async () => {
    const chmod = (mode) => must(docker("run", "--rm", "--network", "none", "-v", `${main.volume("media")}:/data`, "--entrypoint", "chmod", HELPER_IMAGE, mode, "/data"), "chmod volume");
    chmod("0500");
    try {
      const ready = await request(`${main.base}/api/ready`);
      const body = json(ready);
      assert(ready.status === 503 && body.checks.storage === "unavailable" && body.checks.database === "ok", `ready ${ready.status} ${ready.body}`);
      // The admin status page reports it too (sign-in and the database still work).
      const admin = (await request(`${main.base}/admin`, { headers: { cookie: ownerCookie } })).body.toString();
      assert(/data-testid="status-storage" data-tone="warn"[^>]*>Unavailable</.test(admin), "admin status does not show storage unavailable");
      assert(/data-testid="status-database"[^>]*>Ready</.test(admin) && !admin.includes("/data/uploads"), "admin status database or path");
      return `ready 503 ${JSON.stringify(body.checks)}; admin status: storage Unavailable, database Ready`;
    } finally {
      chmod("0700");
      const ready = await request(`${main.base}/api/ready`);
      assert(ready.status === 200, `ready after repair ${ready.status}`);
    }
  });

  console.log("\n# Graceful termination (docker stop, 60 s grace)");
  /** Runs a shutdown scenario and always brings the app back (healthy) afterwards. */
  const withRestart = async (fn) => {
    try {
      return await fn();
    } finally {
      if (inspect(appId, "{{.State.Running}}") !== "true") must(docker("start", appId), "start app");
      await waitHealth(appId);
    }
  };

  await check("normal requests: SIGTERM stops new connections without cutting off in-flight responses", () =>
    withRestart(async () => {
      const until = Date.now() + 4000;
      const outcomes = { ok: 0, refused: 0, truncated: 0, serverError: 0, keepAliveOk: 0, keepAliveReset: 0 };
      let lastOk = 0;
      const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 1 });
      const worker = async (agent) => {
        while (Date.now() < until) {
          try {
            const r = await request(`${main.base}/${state.handle}`, { timeout: 10_000, agent });
            if (r.status >= 500) outcomes.serverError++;
            else if (r.status === 200 && r.body.toString().includes("</html>")) {
              outcomes[agent ? "keepAliveOk" : "ok"]++;
              lastOk = Date.now();
            } else outcomes.truncated++;
          } catch (e) {
            if (e.code === "TRUNCATED") outcomes.truncated++;
            else outcomes[agent ? "keepAliveReset" : "refused"]++;
            await sleep(50);
          }
        }
      };
      // Three clients opening a new connection per request, one reusing a keep-alive connection.
      const workers = [worker(), worker(), worker(), worker(keepAlive)];
      await sleep(1000);
      const sigterm = Date.now();
      const stop = await stopTimed(appId);
      await Promise.all(workers);
      keepAlive.destroy();
      const servedAfter = ((lastOk - sigterm) / 1000).toFixed(2);
      assert(outcomes.ok > 0 && outcomes.refused > 0, `outcomes ${JSON.stringify(outcomes)}`);
      assert(outcomes.truncated === 0 && outcomes.serverError === 0, `outcomes ${JSON.stringify(outcomes)}`);
      assert(stop.exitCode === 143 && stop.oom === "false" && stop.seconds < 10, `exit ${stop.exitCode} after ${stop.seconds} s`);
      // A busy keep-alive connection is released at its next response (lib/server/shutdown.ts).
      assert(outcomes.keepAliveOk > 0 && lastOk - sigterm < 1500, `keep-alive connection still served ${servedAfter} s after SIGTERM`);
      return `${JSON.stringify(outcomes)}; last response ${servedAfter} s after SIGTERM; exited 143 after ${stop.seconds.toFixed(1)} s`;
    }));

  await check("slow streamed upload: drained to completion after SIGTERM; no new work accepted; no temp files", () => withRestart(async () => {
    const cookie = await session();
    const pending = upload(main, cookie, "avatar", trickle(smallPng, 40, 150), smallPng.length, "image/png");
    await sleep(1500);
    const stopping = stopTimed(appId);
    await sleep(700);
    const late = await request(`${main.base}/api/health`, { timeout: 5000 }).then((r) => `HTTP ${r.status}`, (e) => e.code ?? "error");
    const res = await pending;
    const stop = await stopping;
    assert(res.status === 201, `in-flight upload answered ${res.status} ${res.body}`);
    assert(!/^HTTP 200/.test(late), `a new request was served during shutdown (${late})`);
    assert(stop.exitCode === 143 && stop.seconds < 60, `exit ${stop.exitCode} after ${stop.seconds} s`);
    const left = volumeLeftovers(main.volume("media"));
    assert(left.length === 0, `left behind: ${left.join(", ")}`);
    return `upload 201 (${(smallPng.length / 1e6).toFixed(2)} MB over ~6 s); new request: ${late}; exited 143 after ${stop.seconds.toFixed(1)} s; tmp/ empty`;
  }));

  await check("image processing in progress: finished after SIGTERM; no temp files", () => withRestart(async () => {
    const cookie = await session();
    const pending = upload(main, cookie, "background", maxPng, maxPng.length, "image/png");
    await sleep(400);
    const stop = await stopTimed(appId);
    const res = await pending;
    assert(res.status === 201, `in-flight processing answered ${res.status}`);
    assert(stop.exitCode === 143 && stop.seconds < 60, `exit ${stop.exitCode} after ${stop.seconds} s`);
    const left = volumeLeftovers(main.volume("media"));
    assert(left.length === 0, `left behind: ${left.join(", ")}`);
    return `upload 201; exited 143 after ${stop.seconds.toFixed(1)} s; tmp/ empty`;
  }));

  await check("a forced kill (beyond the grace period) leaves a temp file that media:gc reports", () => withRestart(async () => {
    const cookie = await session();
    const pending = upload(main, cookie, "avatar", trickle(smallPng, 40, 150), smallPng.length, "image/png").catch((e) => e.code);
    await sleep(1500);
    must(docker("kill", "-s", "KILL", appId), "kill app");
    await pending;
    const left = volumeLeftovers(main.volume("media"));
    assert(left.length === 1 && /\.upload$/.test(left[0]), `expected one intake file, found: ${left.join(", ") || "none"}`);
    if (inspect(appId, "{{.State.Running}}") !== "true") must(docker("start", appId), "start app");
    await waitHealth(appId);
    const gc = must(docker("exec", appId, "node", "scripts/media-gc.mjs"), "media:gc dry run");
    assert(/leftover temp files: 1;/.test(gc), `media:gc: ${gc}`);
    must(docker("run", "--rm", "--network", "none", "-v", `${main.volume("media")}:/data`, "--entrypoint", "sh", HELPER_IMAGE, "-c", `rm /data/tmp/${left[0]}`), "remove the intake file");
    return `intake ${left[0].slice(0, 8)}…upload left; media:gc dry run lists 1 temp file (removed afterwards)`;
  }));

  console.log("\n# Migrations");
  await check("an already-current database: the migrator is a no-op", () => {
    const r = main.dc("run", "--rm", "migrate");
    assert(r.status === 0 && r.stdout.includes(`(${MIGRATIONS} migrations applied)`), `run migrate: ${r.status} ${r.stdout.trim().split("\n").pop()}`);
    assert(main.psql("select count(*) from drizzle.__drizzle_migrations") === String(MIGRATIONS), "migration rows changed");
    return `exit 0, still ${MIGRATIONS}`;
  });

  await check("a failing migration stops the app from starting, rolls back and logs no credentials", async () => {
    must(failing.dc("up", "-d", "--wait", "db"), "start failing-project db");
    failing.psql('create table "users" (id integer)'); // collides with migration 0000
    const r = failing.dc("up", "-d");
    assert(r.status !== 0, "compose up succeeded despite the failing migration");
    const migrateId = failing.container("migrate");
    assert(inspect(migrateId, "{{.State.ExitCode}}") === "1", "migrate exit code");
    const appContainer = failing.container("app");
    const started = appContainer ? inspect(appContainer, "{{.State.StartedAt}}") : "never created";
    assert(!appContainer || started.startsWith("0001-01-01"), `app started at ${started}`);
    const logs = failing.dc("logs", "migrate").stdout;
    const line = logs.split("\n").find((l) => l.includes("[migrate] failed")) ?? "";
    assert(line && line.length < 600, `failure line: ${line}`);
    assert(!secrets.some((s) => logs.includes(s)) && !/postgres(ql)?:\/\//.test(logs), "migrate logs contain credentials or a connection string");
    assert(failing.psql("select count(*) from drizzle.__drizzle_migrations") === "0", "a migration row was committed");
    const tables = failing.psql("select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname = 'public'");
    assert(tables === "users", `public tables after rollback: ${tables}`);
    return `app ${appContainer ? "created, never started" : "never created"}; log: ${line.replace(/^.*\[migrate\]/, "[migrate]").slice(0, 120)}`;
  });

  await check("rerunning after the failure is fixed is safe", async () => {
    failing.psql('drop table "users"');
    must(failing.dc("up", "-d"), "compose up after the fix");
    await waitHealth(failing.container("app"));
    assert(failing.psql("select count(*) from drizzle.__drizzle_migrations") === String(MIGRATIONS), "migration rows");
    return `${MIGRATIONS} migrations; app healthy`;
  });

  await check("concurrent migrators on a clean database serialize on the advisory lock", async () => {
    must(failing.dc("stop", "app"), "stop app");
    failing.psql("drop schema public cascade; drop schema drizzle cascade; create schema public");
    const runs = await Promise.all([0, 1, 2].map(() => failing.dcAsync("run", "--rm", "migrate")));
    assert(runs.every((r) => r.status === 0), `exit codes ${runs.map((r) => r.status).join(", ")}`);
    assert(failing.psql("select count(*) from drizzle.__drizzle_migrations") === String(MIGRATIONS), "migration rows");
    assert(failing.psql("select count(distinct hash) from drizzle.__drizzle_migrations") === String(MIGRATIONS), "duplicate migration rows");
    return `3 runners, all exit 0, exactly ${MIGRATIONS} rows`;
  });

  // An "upgrade" image: this image plus a migration that fails.
  const brokenTag = `${TAG}-brokenmigration`;
  const brokenEnv = path.join(work, `${failing.name}-broken.env`);
  const dcBroken = (...args) => run("docker", ["compose", "-p", failing.name, "-f", PROD, "-f", SMOKE, "--env-file", brokenEnv, ...args], { timeout: 900_000 });
  await check("upgrade pre-flight: the new image's failing migrator leaves the running app serving", async () => {
    must(failing.dc("up", "-d"), "start the failing-project app on the current image");
    const appBefore = failing.container("app");
    await waitHealth(appBefore);
    imageWithExtraMigration(brokenTag, "broken", 'SELECT * FROM "table_that_does_not_exist";\n');
    writeFileSync(brokenEnv, readFileSync(failing.envFile, "utf8").replace(`COVALINK_IMAGE_TAG=${TAG}`, `COVALINK_IMAGE_TAG=${brokenTag}`), { mode: 0o600 });

    const r = dcBroken("run", "--rm", "migrate");
    assert(r.status !== 0 && /\[migrate\] failed: .*cause 42P01/.test(r.stdout + r.stderr), `pre-flight migrate: exit ${r.status}`);
    assert(failing.container("app") === appBefore && inspect(appBefore, "{{.State.Running}}") === "true", "the running app was replaced or stopped");
    assert((await request(`${failing.base}/api/ready`)).status === 200, "the running app stopped serving");
    assert(failing.psql("select count(*) from drizzle.__drizzle_migrations") === String(MIGRATIONS), "the failed migration changed the database");
    return `pre-flight exit ${r.status} (42P01, rolled back); the old app kept serving (ready 200); still ${MIGRATIONS} migrations`;
  });

  await check("upgrade via `up -d` with a failing migration: app replaced but not started (outage); redeploying the previous image recovers", async () => {
    const appBefore = failing.container("app");
    const r = dcBroken("up", "-d");
    assert(r.status !== 0, "compose up succeeded despite the failing migration");
    const appAfter = failing.container("app");
    const replaced = appAfter !== appBefore && inspect(appAfter, "{{.Config.Image}}") === `${IMAGE}:${brokenTag}` && inspect(appAfter, "{{.State.Running}}") === "false";
    assert(replaced, "expected Compose to have replaced the app with a not-started container");
    const down = await request(`${failing.base}/api/ready`, { timeout: 3000 }).then((res) => `HTTP ${res.status}`, (e) => e.code ?? "error");
    assert(!/^HTTP 200/.test(down), `the site still answered (${down})`);
    assert(failing.psql("select count(*) from drizzle.__drizzle_migrations") === String(MIGRATIONS), "the failed migration changed the database");
    must(failing.dc("up", "-d"), "redeploy the previous image");
    await waitHealth(failing.container("app"));
    assert((await request(`${failing.base}/api/ready`)).status === 200, "not ready after redeploying the previous image");
    return `during the failed upgrade: ${down}; database unchanged; previous image redeployed: ready 200`;
  });

  console.log("\n# Proxy trust (TRUST_PROXY) on the -f stack");
  /** Rate-limit identities recorded for /sign-in/email (Better Auth key: `${ip}|${path}`). */
  const signInKeys = () =>
    failing.psql("select coalesce(string_agg(key || '=' || count, ',' order by key), '') from rate_limits where key like '%|/sign-in/email'").split(",").filter(Boolean);
  await check("default (TRUST_PROXY unset, so false): spoofed X-Forwarded-For/X-Real-IP do not select the rate-limit identity", async () => {
    const appContainer = failing.container("app");
    assert(must(docker("exec", appContainer, "printenv", "TRUST_PROXY"), "printenv") === "false", "the running app's TRUST_PROXY is not false");
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push(await badSignIn(failing.base, { headers: spoofed(10, i) }));
    assert(JSON.stringify(statuses) === JSON.stringify([401, 401, 401, 401, 401, 429]), `statuses ${statuses.join(", ")} (each request spoofed a different address)`);
    const keys = signInKeys();
    assert(keys.length === 1 && keys[0].startsWith("no-trusted-ip|"), `identities: ${keys.join(", ")}`);
    return `6 attempts with 6 different spoofed addresses: ${statuses.join(" ")}; one identity: ${keys[0]}`;
  });

  const trustedEnv = path.join(work, `${failing.name}-trusted.env`);
  const dcTrusted = (...args) => run("docker", ["compose", "-p", failing.name, "-f", PROD, "-f", SMOKE, "--env-file", trustedEnv, ...args], { timeout: 900_000 });
  await check("TRUST_PROXY=true without a header-overwriting proxy (control): spoofed headers DO select the identity", async () => {
    writeFileSync(trustedEnv, readFileSync(failing.envFile, "utf8") + "TRUST_PROXY=true\n", { mode: 0o600 });
    must(dcTrusted("up", "-d", "--no-deps", "--force-recreate", "app"), "recreate app with TRUST_PROXY=true");
    const appContainer = failing.container("app");
    await waitHealth(appContainer);
    assert(must(docker("exec", appContainer, "printenv", "TRUST_PROXY"), "printenv") === "true", "TRUST_PROXY is not true");
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push(await badSignIn(failing.base, { headers: spoofed(30, i) }));
    assert(statuses.every((s) => s === 401), `statuses ${statuses.join(", ")}`);
    const spoofedKeys = signInKeys().filter((k) => k.startsWith("203.0.113."));
    assert(spoofedKeys.length === 6, `identities: ${signInKeys().join(", ")}`);
    return `6 direct attempts, 6 spoofed identities, none limited (${statuses.join(" ")}): why the default is false`;
  });

  await check("TRUST_PROXY=true behind a header-overwriting proxy: the proxy-supplied client address is the identity", async () => {
    const proxy = await headerOverwritingProxy(failing.base);
    try {
      const before = new Set(signInKeys().map((k) => k.split("=")[0]));
      const a = [];
      for (let i = 0; i < 6; i++) a.push(await badSignIn(failing.base, { via: proxy.base, localAddress: "127.0.0.2", headers: spoofed(50, i) }));
      const b = await badSignIn(failing.base, { via: proxy.base, localAddress: "127.0.0.3", headers: spoofed(50, 0) });
      assert(JSON.stringify(a) === JSON.stringify([401, 401, 401, 401, 401, 429]), `client 127.0.0.2: ${a.join(", ")}`);
      assert(b === 401, `client 127.0.0.3: ${b} (should have its own bucket)`);
      const added = signInKeys().filter((k) => !before.has(k.split("=")[0]));
      assert(JSON.stringify(added.map((k) => k.split("=")[0]).sort()) === JSON.stringify(["127.0.0.2|/sign-in/email", "127.0.0.3|/sign-in/email"]), `new identities: ${added.join(", ")}`);
      return `client 127.0.0.2 (spoofing 6 addresses): ${a.join(" ")}; client 127.0.0.3: ${b}; identities ${added.join(", ")}`;
    } finally {
      await proxy.close();
      must(failing.dc("up", "-d", "--no-deps", "--force-recreate", "app"), "recreate app with the default TRUST_PROXY");
      await waitHealth(failing.container("app"));
    }
  });

  console.log("\n# Backup and restore");
  const backups = path.join(work, "backups");
  mkdirSync(backups);
  let backupDir = "";
  await check("authoritative backup: app stopped, dump + media + manifest, app ready again", async () => {
    const r = bashScript("backup.sh", ["--project", main.name, "--out", backups.replaceAll("\\", "/")]);
    process.stdout.write(r.stdout.split("\n").filter(Boolean).map((l) => `      ${l}\n`).join(""));
    assert(r.status === 0, `backup.sh exit ${r.status}: ${r.stderr.trim()}`, true);
    backupDir = path.join(backups, readdirSync(backups)[0]);
    const manifest = JSON.parse(readFileSync(path.join(backupDir, "manifest.json"), "utf8"));
    assert(manifest.consistency === "app-stopped" && manifest.migrationCount === MIGRATIONS && manifest.imageId === imageId, "manifest fields");
    assert(manifest.gitRevision === TAG, `revision ${manifest.gitRevision}`);
    const rows = Number(main.psql("select count(*) from media_assets"));
    assert(manifest.mediaRows === rows && manifest.managedFiles === rows, `rows ${manifest.mediaRows}/${rows}, files ${manifest.managedFiles}`);
    assert(readdirSync(backupDir).sort().join() === "SHA256SUMS,database.dump,manifest.json,media.tar", `files: ${readdirSync(backupDir).join(", ")}`);
    const contents = readFileSync(path.join(backupDir, "manifest.json"), "utf8") + readFileSync(path.join(backupDir, "SHA256SUMS"), "utf8");
    assert(!secrets.some((s) => contents.includes(s)), "manifest contains a secret");
    const tar = readFileSync(path.join(backupDir, "media.tar")).toString("latin1");
    assert(!/\.env|POSTGRES_PASSWORD|BETTER_AUTH_SECRET/.test(tar), "media archive contains environment data");
    assert((await request(`${main.base}/api/ready`)).status === 200, "app not ready after backup");
    return `migrations ${manifest.migrationCount}, media rows ${manifest.mediaRows}, files ${manifest.managedFiles}, dump ${manifest.databaseBytes} B, media ${manifest.mediaBytes} B`;
  });

  // Analytics tables as backed up (no traffic reaches the main stack between the backup and this read).
  const analyticsPrint = (stack) =>
    stack.psql(`select (select count(*) from analytics_events) || ':' || (select md5(coalesce(string_agg(e::text, '|' order by e.id), '')) from analytics_events e)
      || '/' || (select count(*) from analytics_salts) || ':' || (select md5(coalesce(string_agg(s::text, '|' order by s.day), '')) from analytics_salts s)`);
  const backedUpAnalytics = analyticsPrint(main);

  await check("restore refuses a modified backup before changing anything", () => {
    const copy = path.join(work, "tampered");
    cpSync(backupDir, copy, { recursive: true });
    const tarPath = path.join(copy, "media.tar");
    const bytes = readFileSync(tarPath);
    bytes[bytes.length - 2048] ^= 0xff;
    writeFileSync(tarPath, bytes);
    const r = bashScript("restore.sh", ["--project", main.name, "--from", copy.replaceAll("\\", "/"), "--apply", "--confirm", main.name, "--replace-nonempty"]);
    assert(r.status === 3 && /checksum verification failed/.test(r.stderr), `exit ${r.status}: ${r.stderr.trim()}`);
    assert((Number(main.psql("select count(*) from media_assets")) > 0), "main stack data changed");
    return "exit 3 (checksum verification failed)";
  });

  await check("fresh-stack restore: validation, confirmation, restore, migrator, readiness, gc dry run, counts", async () => {
    must(restore.dc("create"), "create restore stack");
    must(restore.dc("start", "db"), "start restore db");
    await waitHealth(restore.container("db"));
    const from = backupDir.replaceAll("\\", "/");
    const dry = bashScript("restore.sh", ["--project", restore.name, "--from", from]);
    assert(dry.status === 0 && /validation only/.test(dry.stdout), `validation run: ${dry.status} ${dry.stderr}`);
    const noConfirm = bashScript("restore.sh", ["--project", restore.name, "--from", from, "--apply"]);
    assert(noConfirm.status === 3, `--apply without --confirm: exit ${noConfirm.status}`);
    const wrongTarget = bashScript("restore.sh", ["--project", restore.name, "--from", from, "--apply", "--confirm", main.name]);
    assert(wrongTarget.status === 3, `--confirm naming another project: exit ${wrongTarget.status}`);
    const r = bashScript("restore.sh", ["--project", restore.name, "--from", from, "--apply", "--confirm", restore.name]);
    process.stdout.write(r.stdout.split("\n").filter(Boolean).map((l) => `      ${l}\n`).join(""));
    assert(r.status === 0, `restore.sh exit ${r.status}: ${r.stderr.trim()}`, true);
    assert(/orphan files \(no live row\): 0/.test(r.stdout) && /live rows without a file: 0/.test(r.stdout), "media:gc dry run reported a mismatch");
    assert(/counts match the manifest and every media row has exactly its file/.test(r.stdout), "counts or keys differ");
    // The app is started only after the migrator, the gc dry run and the reconciliation.
    const at = (re) => r.stdout.search(re);
    assert(at(/running the migrator/) < at(/media:gc dry run/) && at(/media:gc dry run/) < at(/counts match/) && at(/counts match/) < at(/starting the app/), "the app was started before reconciliation completed");
    assert(/restore complete; the app is ready/.test(r.stdout), "no readiness confirmation");
    return "validation-only exit 0; missing/wrong confirmation exit 3; restore exit 0; migrator → gc dry run (clean) → keys and counts match → app started → ready";
  });

  await check("the restored stack serves the same profile, media and accounts", async () => {
    const page = await request(`${restore.base}/${state.handle}`);
    assert(page.status === 200 && page.body.toString().includes(state.displayName), `profile ${page.status}`);
    const media = await request(`${restore.base}${state.avatarUrl}`);
    assert(media.status === 200 && sha256(media.body) === avatarSha, `avatar ${media.status}`);
    await signIn(restore, state.email, state.password);
    const rId = restore.container("app");
    assert(inspect(rId, "{{.Image}}") === imageId, "restore stack image differs");
    return "public page 200, avatar bytes identical, sign-in 200";
  });

  await check("analytics events and salts survive backup and restore unchanged", () => {
    const restored = analyticsPrint(restore);
    const [events, salts] = backedUpAnalytics.split("/").map((p) => Number(p.split(":")[0]));
    assert(events > 0 && salts > 0, `nothing to compare (${backedUpAnalytics})`);
    assert(restored === backedUpAnalytics, `restored ${restored} differs from backed up ${backedUpAnalytics}`);
    return `${events} events and ${salts} salts, content hashes identical`;
  });

  await check("restore refuses a running app and a non-empty target without --replace-nonempty", () => {
    const from = backupDir.replaceAll("\\", "/");
    const running = bashScript("restore.sh", ["--project", restore.name, "--from", from, "--apply", "--confirm", restore.name, "--replace-nonempty"]);
    assert(running.status === 3 && /must be stopped/.test(running.stderr), `running app: exit ${running.status} ${running.stderr.trim()}`);
    must(docker("stop", "-t", "60", restore.container("app")), "stop restore app");
    const nonEmpty = bashScript("restore.sh", ["--project", restore.name, "--from", from, "--apply", "--confirm", restore.name]);
    assert(nonEmpty.status === 3 && /refusing without --replace-nonempty/.test(nonEmpty.stderr), `non-empty: exit ${nonEmpty.status} ${nonEmpty.stderr.trim()}`);
    must(docker("start", restore.container("app")), "start restore app");
    return "running app: exit 3; non-empty target: exit 3";
  });

  await check("malicious and malformed manifests (self-consistent checksums) are refused with exit 3 before anything changes; no payload runs", async () => {
    const rApp = restore.container("app");
    must(docker("stop", "-t", "60", rApp), "stop restore app");
    const text = readFileSync(path.join(backupDir, "manifest.json"), "utf8");
    assert(writeManifestText(parseManifest(text)) === text, "the variant generator does not reproduce backup.sh's manifest layout");
    const startedAt = inspect(rApp, "{{.State.StartedAt}}");
    const before = targetFingerprint(restore);
    const marker = path.join(work, "injection-marker").replaceAll("\\", "/");
    const cases = malformedManifests(marker);
    const wrong = [];
    for (const [i, c] of cases.entries()) {
      const dir = path.join(work, `malformed-${i}`);
      manifestVariant(backupDir, dir, c.edit, { sums: c.sums });
      const r = bashScript("restore.sh", ["--project", restore.name, "--from", dir.replaceAll("\\", "/"), "--apply", "--confirm", restore.name, "--replace-nonempty"]);
      if (r.status !== 3 || !c.stderr.test(r.stderr) || /recreating the database/.test(r.stdout)) wrong.push(`${c.name}: exit ${r.status} ${r.stderr.trim()}`);
      rmSync(dir, { recursive: true, force: true });
    }
    assert(wrong.length === 0, wrong.slice(0, 3).join("; "));
    assert(!existsSync(marker), "an injected command ran (the marker file exists)");
    const after = targetFingerprint(restore);
    assert(after.db === before.db && after.media === before.media, "the target database or media changed");
    assert(inspect(rApp, "{{.State.Running}}") === "false" && inspect(rApp, "{{.State.StartedAt}}") === startedAt, "the app was started");
    return `${cases.length} variants (3 command-substitution payloads; missing, duplicate, string, negative, fractional, exponent, leading-zero, oversized, unknown, bad hash/name/format/layout, CRLF, bad SHA256SUMS): all exit 3; marker absent; pg_dump and media hashes unchanged (${before.files} files); app still stopped`;
  });

  await check("an internally inconsistent backup (media keys swapped, counts equal) exits 4 and the app never starts or serves", async () => {
    const rApp = restore.container("app");
    const startedAt = inspect(rApp, "{{.State.StartedAt}}");
    const dir = path.join(work, "inconsistent");
    cpSync(backupDir, dir, { recursive: true });
    // Move one stored image to a fresh key: same file count, but one row without its file and one file without a row.
    const key = `${randomUUID()}.webp`;
    const shard = `/x/${key.slice(0, 2)}/${key.slice(2, 4)}`;
    const swapped = run("docker", ["run", "--rm", "-i", "--network", "none", "--entrypoint", "sh", HELPER_IMAGE, "-c",
      `mkdir /x && tar -xf - -C /x && f=$(find /x -mindepth 3 -maxdepth 3 -type f -name '*.webp' | head -n 1) && [ -n "$f" ] && mkdir -p ${shard} && mv "$f" ${shard}/${key} && tar -cf - -C /x .`],
      { input: readFileSync(path.join(dir, "media.tar")) });
    assert(swapped.status === 0 && swapped.raw?.length > 0, `rewriting media.tar: ${swapped.stderr.trim()}`);
    writeFileSync(path.join(dir, "media.tar"), swapped.raw);
    const manifestPath = path.join(dir, "manifest.json");
    const entries = parseManifest(readFileSync(manifestPath, "utf8")).map(([k, v]) =>
      k === "mediaSha256" ? [k, `"${sha256(swapped.raw)}"`] : k === "mediaBytes" ? [k, String(swapped.raw.length)] : [k, v]);
    writeFileSync(manifestPath, writeManifestText(entries));
    recomputeSums(dir);

    let polls = 0;
    let answered = 0;
    let done = false;
    const poller = (async () => {
      while (!done) {
        polls++;
        for (const p of ["/api/health", `/${state.handle}`]) if (await request(`${restore.base}${p}`, { timeout: 1000 }).then(() => true, () => false)) answered++;
        await sleep(150);
      }
    })();
    const r = await bashScriptAsync("restore.sh", ["--project", restore.name, "--from", dir.replaceAll("\\", "/"), "--apply", "--confirm", restore.name, "--replace-nonempty"]);
    done = true;
    await poller;
    assert(r.status === 4, `exit ${r.status}: ${r.stderr.trim()}`);
    assert(/DISCREPANCY: media keys differ: 1 row\(s\) without a file, 1 file\(s\) without a row/.test(r.stdout), "key-level discrepancy not reported");
    assert(/orphan files \(no live row\): 1/.test(r.stdout) && /live rows without a file: 1/.test(r.stdout), "media:gc dry run did not show the mismatch");
    assert(!/starting the app/.test(r.stdout), "the app was started");
    assert(answered === 0, `${answered} public request(s) answered during the restore`);
    assert(inspect(rApp, "{{.State.Running}}") === "false" && inspect(rApp, "{{.State.StartedAt}}") === startedAt, "the app was started");
    return `exit 4 (1 row without a file, 1 file without a row; counts alone matched); ${polls} polls of the public port, 0 answered; app never started`;
  });

  await check("a restore whose app cannot become ready exits nonzero and leaves the app stopped", async () => {
    const badEnv = path.join(work, `${restore.name}-badcfg.env`);
    writeFileSync(badEnv, readFileSync(restore.envFile, "utf8").replace(/^SERVICE_BASE64_64_AUTHSECRET=.*$/m, "SERVICE_BASE64_64_AUTHSECRET=too-short"), { mode: 0o600 });
    must(run("docker", ["compose", "-p", restore.name, "-f", PROD, "-f", SMOKE, "--env-file", badEnv, "up", "--no-start", "--no-deps", "--force-recreate", "app"]), "recreate the app with an invalid configuration");
    const rApp = restore.container("app");
    const r = bashScript("restore.sh", ["--project", restore.name, "--from", backupDir.replaceAll("\\", "/"), "--apply", "--confirm", restore.name, "--replace-nonempty"]);
    assert(r.status === 1 && /did not become ready/.test(r.stderr), `exit ${r.status}: ${r.stderr.trim()}`);
    assert(/stopping the app: the restore did not complete/.test(r.stdout), "the app was not stopped after the failure");
    await sleep(5000); // the restart policy (unless-stopped) would have brought a merely-exited app back by now
    const st = inspect(rApp, "{{.State.Status}} {{.State.ExitCode}}");
    assert(st.startsWith("exited "), `app state ${st}`);
    return `exit 1 (validator exit ${st.split(" ")[1]}, restart detected); app stopped and stays stopped`;
  });

  const forwardTag = `${TAG}-forwardmigration`;
  await check("an older backup restored onto a newer image is migrated forward, reconciled, then served (sign-in, media bytes, readiness)", async () => {
    imageWithExtraMigration(forwardTag, "forward_probe", 'CREATE TABLE "smoke_forward_probe" ("id" integer);\n');
    const newerEnv = path.join(work, `${restore.name}-newer.env`);
    writeFileSync(newerEnv, readFileSync(restore.envFile, "utf8").replace(`COVALINK_IMAGE_TAG=${TAG}`, `COVALINK_IMAGE_TAG=${forwardTag}`), { mode: 0o600 });
    must(run("docker", ["compose", "-p", restore.name, "-f", PROD, "-f", SMOKE, "--env-file", newerEnv, "up", "--no-start", "--no-deps", "--force-recreate", "migrate", "app"]), "recreate migrate and app on the newer image");
    const r = bashScript("restore.sh", ["--project", restore.name, "--from", backupDir.replaceAll("\\", "/"), "--apply", "--confirm", restore.name, "--replace-nonempty"]);
    process.stdout.write(r.stdout.split("\n").filter((l) => /migrated forward|restored:|counts match|ready/.test(l)).map((l) => `      ${l}\n`).join(""));
    assert(r.status === 0, `exit ${r.status}: ${r.stderr.trim()}`);
    assert(r.stdout.includes(`migrated forward: ${MIGRATIONS} -> ${MIGRATIONS + 1} migrations`), "not migrated forward");
    assert(r.stdout.search(/counts match/) < r.stdout.search(/starting the app/), "the app was started before reconciliation");
    const rApp = restore.container("app");
    assert(inspect(rApp, "{{.Config.Image}}") === `${IMAGE}:${forwardTag}`, "app is not on the newer image");
    const media = await request(`${restore.base}${state.avatarUrl}`);
    assert(media.status === 200 && sha256(media.body) === avatarSha, `avatar ${media.status}`);
    await signIn(restore, state.email, state.password);
    assert((await request(`${restore.base}/api/ready`)).status === 200, "not ready");
    return `exit 0; ${MIGRATIONS} -> ${MIGRATIONS + 1} migrations; avatar bytes identical, sign-in 200, ready 200`;
  });

  console.log("\n# Hygiene");
  await check("no raw sentinel IP or user agent in either database, the app logs, the backup files or the image", () => {
    const places = [];
    for (const stack of [main, restore]) {
      // Plain-text dumps; the restored database is the content of the backup's (compressed) database.dump.
      places.push([`${stack.name} database`, must(stack.dc("exec", "-T", "db", "pg_dump", "-U", "covalink", "-d", "covalink", "--data-only"), "pg_dump")]);
      const logs = stack.dc("logs", "--no-color", "app");
      places.push([`${stack.name} app logs`, logs.stdout + logs.stderr]);
    }
    for (const f of ["manifest.json", "SHA256SUMS", "media.tar"]) places.push([`backup ${f}`, readFileSync(path.join(backupDir, f)).toString("latin1")]);
    places.push(["image metadata", must(docker("image", "inspect", `${IMAGE}:${TAG}`), "image inspect")]);
    const leaks = places.filter(([, text]) => text.includes(SENTINEL_IP) || text.includes(SENTINEL_UA_MARK) || text.includes("some/path?q=1")).map(([where]) => where);
    assert(leaks.length === 0, `found in: ${leaks.join(", ")}`);
    for (const stack of [main, restore]) assert(Number(stack.psql("select count(*) from analytics_events where type = 'view'")) > 0, `${stack.name}: no analytics view to look for`);
    return `${places.length} places searched (2 database dumps incl. the restored backup, 2 app logs, 3 uncompressed backup files, image metadata): none contains the sentinel IP, user agent or referrer path`;
  });

  await check("no temp media or readiness probe files remain in any stack", async () => {
    await waitHealth(restore.container("app"));
    const left = [main, restore, failing].flatMap((s) => volumeLeftovers(s.volume("media")).map((f) => `${s.name}: ${f}`));
    assert(left.length === 0, left.join(", "));
    return "tmp/ and probes empty in all three media volumes";
  });
} catch (err) {
  console.error("[deploy] unexpected error:", err);
  results.push({ name: "smoke run", ok: false, detail: err.message });
} finally {
  if (KEEP) {
    console.log(`\n[deploy] --keep: stacks left running (${main.name}, ${restore.name}, ${failing.name}); env files in ${work}`);
  } else {
    for (const s of [main, restore, failing]) s.dc("down", "-v", "--remove-orphans", "--timeout", "60");
    for (const suffix of ["brokenmigration", "forwardmigration"]) docker("image", "rm", `${IMAGE}:${TAG}-${suffix}`);
    const leftVolumes = docker("volume", "ls", "-q", "--filter", `name=covalink-smoke-${id}`).stdout.trim();
    console.log(`\n[deploy] removed stacks, networks and volumes${leftVolumes ? ` (STILL PRESENT: ${leftVolumes})` : ""}`);
    rmSync(work, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n[deploy] ${results.length - failed.length}/${results.length} checks passed; image ${IMAGE}:${TAG} (${imageId || "not built"})`);
for (const f of failed) console.log(`[deploy]   FAILED: ${f.name} — ${f.detail}`);
process.exit(failed.length ? 1 : 0);
