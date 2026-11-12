// Candidate gates for a COVALink release image. Each gate tests the exact
// candidate, by digest, and writes a JSON result; any failure, error or
// unreadable input fails the gate. Run from the repository root on Linux with
// Docker, logged in to read the staging package:
//
//   node release/gates/candidate-gates.mjs <gate> --image <ref@sha256:...> --work <dir> --out <json> [gate options]
//
// Gates: rebuild, identity, contents, secrets, sbom, vulnerabilities, alpine-security-update, non-root,
// notices, source-bundle, libvips-replacement, deployment-smoke. rebuild also
// needs --secret-file (the candidate's Server Actions key) and runs in the job
// that built the candidate. Decision rules live in checks.mjs.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  builderVersionFrom, contentVerdict, emailFindings, KNOWN_DIFFERENCES, keyExposures, libvipsVerdict, NEXT_VERSION, NON_ROOT_FIND, normalizeFileList,
  rebuildVerdict, securityUpdateVerdict, toolchainVerdict, uncoveredPackages, validActionsKey,
} from "./checks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const config = Object.fromEntries(
  readFileSync(join(ROOT, "release", "config.env"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const [gate, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const need = (name, pattern) => {
  const v = opt(name);
  if (!v || (pattern && !pattern.test(v))) throw new Error(`--${name} is missing or malformed`);
  return v;
};
const DIGEST_REF = /^[a-z0-9./-]+@sha256:[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function run(cmd, args, { input, allowFail = false, maxBuffer = 1 << 30, env } = {}) {
  const r = spawnSync(cmd, args, { input, maxBuffer, encoding: "buffer", env: env ? { ...process.env, ...env } : process.env });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args[0]} exited ${r.status}: ${r.stderr.toString().trim().split("\n").slice(-3).join(" | ")}`);
  return { status: r.status, stdout: r.stdout.toString(), stderr: r.stderr.toString(), raw: r.stdout };
}
const docker = (args, o) => run("docker", args, o);
// Images built FROM a locally pulled or retagged image must use the Docker engine's
// own builder, which sees local images and loads its results. The release workflow
// makes a docker-container builder the default, so these builds name this one: the
// engine's builder carries the current context's name ("default" on a hosted runner).
const LOCAL_BUILDER = { BUILDX_BUILDER: spawnSync("docker", ["context", "show"], { encoding: "utf8" }).stdout?.trim() || "default" };
const inImage = (image, script) => docker(["run", "--rm", "--network", "none", "--entrypoint", "sh", image, "-c", script]).stdout;
// As root with a read-only root filesystem, for reading every file (such as /etc/shadow) without changing any.
const inImageAsRoot = (image, script) => docker(["run", "--rm", "--network", "none", "--read-only", "--user", "0:0", "--entrypoint", "sh", image, "-c", script]).stdout;

// Saves the candidate once as a docker-archive for the scanners, which then need no registry access.
function imageArchive(image, work) {
  const tar = join(work, "candidate-image.tar");
  if (!existsSync(tar)) docker(["save", "-o", tar, image]);
  return tar;
}
function imagetools(image, format) {
  return JSON.parse(docker(["buildx", "imagetools", "inspect", image, "--format", format]).stdout);
}
// SPDX packages as "type:name@version" keys, with their declared licenses.
function spdxPackages(doc) {
  const out = new Map();
  for (const p of doc.packages ?? []) {
    const purl = (p.externalRefs ?? []).map((r) => r.referenceLocator).find((l) => typeof l === "string" && l.startsWith("pkg:"));
    if (!purl) continue;
    const m = /^pkg:([a-z]+)\/(?:([^/@]+)\/)?([^@?]+)@([^?#]+)/.exec(purl);
    if (!m) continue;
    const type = m[1];
    const name = decodeURIComponent(type === "npm" && m[2] ? `${m[2]}/${m[3]}` : m[3]);
    const version = decodeURIComponent(m[4]);
    const license = [p.licenseDeclared, p.licenseConcluded].find((l) => l && l !== "NOASSERTION" && l !== "NONE") ?? "";
    out.set(`${type}:${name}@${version}`, { type, name, version, license });
  }
  return out;
}

const gates = {
  // A clean build of the same commit, with the same per-candidate Server Actions
  // key (a BuildKit secret), produces the same files and labels, and next build ran
  // with no network. Both builds use the commit as their build ID and embed the
  // supplied key in their build output, as Next.js does by design: the key is
  // recoverable from the distributed image and is not a repository, workflow,
  // deployment or runtime secret. It must not leak anywhere else: not into either
  // image's history or configuration, the candidate's provenance, or the rebuild
  // log. Every file must be byte-identical except the six known differences, each
  // narrowly normalized, under the pinned Next.js version; and the pinned
  // Dockerfile frontend and BuildKit must have been in effect. Runs in the job
  // that built the candidate, which holds the key file; the key is never written
  // to the result.
  rebuild({ image, work }) {
    const commit = need("commit", SHA40);
    const keyFile = need("secret-file");
    const key = readFileSync(keyFile, "utf8");
    if (!validActionsKey(key)) throw new Error("the Server Actions key file isn't the base64 encoding of 32 bytes (no trailing newline)");
    const rebuilt = "covalink-rebuild:gate";
    const log = docker(["buildx", "build", "--no-cache", "--progress=plain", "--load", "-t", rebuilt,
      "--build-arg", `GIT_SHA=${commit}`, "--build-arg", `SOURCE_BUNDLE=${need("bundle", DIGEST_REF)}`,
      "--secret", `id=server_actions_key,src=${keyFile}`, join(ROOT, "web")]);
    const buildLog = log.stdout + log.stderr;
    const offline = /\[build \d+\/\d+\] RUN --network=none [^\n]*npm run build/.test(buildLog) && /RUN --network=none [^\n]*npm run build[\s\S]*?DONE/.test(buildLog);

    const buildIdOf = (ref) => inImage(ref, "cat /app/.next/BUILD_ID").trim();
    const files = (ref) => inImage(ref, "find / -xdev \\( -path /proc -o -path /sys -o -path /dev \\) -prune -o -type f -print | LC_ALL=C sort").split("\n").filter(Boolean);
    const hashes = (ref) => new Map(inImageAsRoot(ref, "find / -xdev \\( -path /proc -o -path /sys -o -path /dev \\) -prune -o -type f -print0 | xargs -0 sha256sum")
      .split("\n").filter(Boolean).map((l) => [l.slice(66), l.slice(0, 64)]));
    const embeddedKey = (ref) => { try { return JSON.parse(inImage(ref, "cat /app/.next/server/server-reference-manifest.json")).encryptionKey ?? ""; } catch { return ""; } };
    const labels = (ref) => JSON.parse(docker(["image", "inspect", "-f", "{{json .Config.Labels}}", ref]).stdout);

    const idA = buildIdOf(image);
    const idB = buildIdOf(rebuilt);
    const verdict = rebuildVerdict({ offline, listA: normalizeFileList(files(image), idA), listB: normalizeFileList(files(rebuilt), idB), labelsA: labels(image), labelsB: labels(rebuilt) });
    const ha = hashes(image);
    const hb = hashes(rebuilt);
    // Byte-level comparison (checks.mjs, contentVerdict): only the known
    // differences in the six known files, each narrowly normalized, may remain.
    const nextVersion = (ref) => inImage(ref, "node -p \"require('/app/node_modules/next/package.json').version\"").trim();
    const readRaw = (ref, path) => docker(["run", "--rm", "--network", "none", "--read-only", "--user", "0:0", "--entrypoint", "cat", ref, path]).raw;
    const differingKnown = [...ha.keys()].filter((p) => p in KNOWN_DIFFERENCES && hb.has(p) && ha.get(p) !== hb.get(p));
    const contents = Object.fromEntries(differingKnown.map((p) => [p, { a: readRaw(image, p), b: readRaw(rebuilt, p) }]));
    const content = contentVerdict({ hashesA: ha, hashesB: hb, contents, nextVersions: { candidate: nextVersion(image), rebuild: nextVersion(rebuilt) } });
    // The pinned toolchain was the one in effect (checks.mjs, toolchainVerdict).
    const toolchain = toolchainVerdict({
      pins: config,
      dockerfileFirstLine: readFileSync(join(ROOT, "web", "Dockerfile"), "utf8").split(/\r?\n/)[0],
      builderVersion: builderVersionFrom(docker(["buildx", "inspect"]).stdout),
      provenance: imagetools(image, "{{json .Provenance}}"),
      rebuildLog: buildLog,
    });
    // Expected: both builds embed the supplied key in their server files.
    const keyEmbeddedInBothBuilds = embeddedKey(image) === key && embeddedKey(rebuilt) === key;
    // Not allowed: the key anywhere outside the build output.
    const leaks = keyExposures(key, {
      "candidate history": docker(["history", "--no-trunc", "--format", "{{.CreatedBy}}", image]).stdout,
      "candidate configuration": docker(["image", "inspect", "-f", "{{json .Config}}", image]).stdout,
      "candidate provenance": JSON.stringify(imagetools(image, "{{json .Provenance}}")),
      "rebuild history": docker(["history", "--no-trunc", "--format", "{{.CreatedBy}}", rebuilt]).stdout,
      "rebuild configuration": docker(["image", "inspect", "-f", "{{json .Config}}", rebuilt]).stdout,
      "rebuild log": buildLog,
    });
    // The log is kept only once it's known not to hold the key.
    if (leaks.length === 0) writeFileSync(join(work, "rebuild.log"), buildLog);
    return {
      ok: verdict.ok && content.ok && toolchain.ok && idA === commit && idB === commit && keyEmbeddedInBothBuilds && leaks.length === 0,
      details: {
        offlineBuildStepRan: offline, buildIds: { candidate: idA, rebuild: idB },
        keyEmbeddedInBothBuilds, keyLeakedOutsideBuildOutput: leaks,
        files: ha.size, onlyInCandidate: verdict.onlyInCandidate.slice(0, 20), onlyInRebuild: verdict.onlyInRebuild.slice(0, 20),
        labelDifferences: verdict.labelDifferences,
        content: { ok: content.ok, nextVersion: NEXT_VERSION, differing: content.differing, problems: content.problems.slice(0, 50) },
        toolchain: { ok: toolchain.ok, frontend: config.DOCKERFILE_FRONTEND, buildkit: config.BUILDKIT_IMAGE, problems: toolchain.problems },
      },
    };
  },

  // The digest, the revision label and the image's version all name this commit.
  identity({ image }) {
    const commit = need("commit", SHA40);
    const digest = image.slice(image.indexOf("@") + 1);
    const raw = docker(["buildx", "imagetools", "inspect", image, "--raw"]).raw;
    const rawDigest = `sha256:${sha256(raw)}`;
    const labels = JSON.parse(docker(["image", "inspect", "-f", "{{json .Config.Labels}}", image]).stdout);
    const env = JSON.parse(docker(["image", "inspect", "-f", "{{json .Config.Env}}", image]).stdout);
    const gitSha = (env.find((e) => e.startsWith("COVALINK_GIT_SHA=")) ?? "").slice("COVALINK_GIT_SHA=".length);
    return {
      ok: rawDigest === digest && labels["org.opencontainers.image.revision"] === commit && gitSha === commit,
      details: { digest, registryDigest: rawDigest, revisionLabel: labels["org.opencontainers.image.revision"], versionEnv: gitSha },
    };
  },

  // No environment files, tests, reference material, keys or dev dependencies; license files present.
  contents({ image }) {
    const devDeps = Object.keys(JSON.parse(readFileSync(join(ROOT, "web", "package.json"), "utf8")).devDependencies);
    const out = inImage(image, [
      `for d in ${devDeps.join(" ")}; do [ -e "/app/node_modules/$d" ] && echo "DEV $d"; done; true`,
      "find / -xdev \\( -path /proc -o -path /sys \\) -prune -o \\( -name '.env' -o -name '.env.*' -o -name '.git' -o -name 'reference' -o -name 'tests' -o -name '__tests__' -o -name '*.test.*' -o -name '*.spec.*' -o -name 'test-results' -o -name 'compose*.yaml' -o -name 'Dockerfile' \\) -print | sed 's/^/FORBIDDEN /'",
      "find /app /data \\( -name '*.pem' -o -name '*.key' -o -name '*.p12' \\) -print | sed 's/^/FORBIDDEN /'",
      "find /app -name '*.map' | sed 's/^/MAP /'",
      "for f in LICENSE NOTICE THIRD_PARTY_NOTICES.txt CORRESPONDING_SOURCE.md SOURCE_BUNDLE public/licenses/fonts/README.txt public/licenses/fonts/geist-OFL.txt; do [ -s /app/$f ] || echo \"MISSING $f\"; done",
    ].join("; "));
    const pick = (p) => out.split("\n").filter((l) => l.startsWith(p)).map((l) => l.slice(p.length));
    const problems = [...pick("FORBIDDEN ").map((f) => `forbidden ${f}`), ...pick("DEV ").map((d) => `dev dependency ${d}`), ...pick("MISSING ").map((f) => `missing ${f}`)];
    return { ok: problems.length === 0, details: { problems, sourceMapsForReview: pick("MAP ") } };
  },

  // No secrets or personal data in history, labels, environment, provenance or SBOM; provenance is minimal.
  secrets({ image }) {
    const history = docker(["history", "--no-trunc", "--format", "{{.CreatedBy}}", image]).stdout;
    const inspect = docker(["image", "inspect", "-f", "{{json .Config.Env}} {{json .Config.Labels}}", image]).stdout;
    const provenance = imagetools(image, "{{json .Provenance}}");
    const sbom = imagetools(image, "{{json .SBOM}}");
    const text = `${history}\n${inspect}\n${JSON.stringify(provenance)}\n${JSON.stringify(sbom)}`;
    const patterns = {
      privateKey: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      githubToken: /\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/,
      awsKey: /\bAKIA[0-9A-Z]{16}\b/,
      secretAssignment: /(PASSWORD|SECRET|TOKEN|API_KEY)=[^\s"',}]{8,}/i,
      databaseUrlWithPassword: /postgres(ql)?:\/\/[^:\s/]+:[^@\s]{3,}@/i,
    };
    const found = Object.entries(patterns).filter(([, re]) => re.test(text)).map(([k]) => k);
    // Email addresses (a real address ends in an alphabetic top-level domain, so
    // an image reference with a numeric version tag doesn't match). None may appear in the
    // history, environment, labels or provenance. In the SBOM, the only ones
    // allowed are third-party package metadata (a package's supplier, originator
    // or declared download location, from its own manifest) and the file names of
    // Alpine's public signing keys; an address anywhere else fails.
    // Email addresses: rules and their reasons are in checks.mjs (emailFindings).
    const emailsIn = emailFindings({ metadataText: `${history}\n${inspect}\n${JSON.stringify(provenance)}`, sbom });
    if (emailsIn.length) found.push("emailAddress");
    const prov = JSON.stringify(provenance);
    const minimal = /"buildType"/.test(prov) && !/"layers"\s*:/.test(prov) && !/"source"\s*:\s*\{"locations"/.test(prov);
    return { ok: found.length === 0 && minimal, details: { patternsFound: found, emailAddressesIn: emailsIn, provenanceMinimal: minimal } };
  },

  // The attached SBOM and an independent scan agree; every component is covered by the notices.
  sbom({ image, work }) {
    const attached = imagetools(image, "{{json .SBOM}}");
    const attachedDoc = attached.SPDX ?? attached["linux/amd64"]?.SPDX;
    if (!attachedDoc) throw new Error("no readable SPDX SBOM attached to the image");
    const tar = imageArchive(image, work);
    const scan = docker(["run", "--rm", "--network", "none", "-v", `${work}:/work:ro`, config.SYFT_IMAGE, "scan", "docker-archive:/work/candidate-image.tar", "-o", "spdx-json", "-q"]);
    writeFileSync(join(work, "sbom-independent.spdx.json"), scan.stdout);
    void tar;
    const a = spdxPackages(attachedDoc);
    const b = spdxPackages(JSON.parse(scan.stdout));
    const relevant = (m) => new Map([...m].filter(([, p]) => ["npm", "apk"].includes(p.type)));
    const ra = relevant(a);
    const rb = relevant(b);
    const onlyAttached = [...ra.keys()].filter((k) => !rb.has(k));
    const onlyIndependent = [...rb.keys()].filter((k) => !ra.has(k));
    const norm = (l) => l.replace(/[()]/g, "").split(/\s+(?:AND|OR)\s+/).map((x) => x.trim()).sort().join(" ");
    const licenseDisagreements = [...ra.keys()].filter((k) => rb.has(k) && ra.get(k).license && rb.get(k).license && norm(ra.get(k).license) !== norm(rb.get(k).license));
    // Coverage: every npm and apk package is named in the notices.
    const notices = readFileSync(join(ROOT, "web", "THIRD_PARTY_NOTICES.txt"), "utf8");
    // COVALink's own package (web/package.json) is covered by LICENSE and NOTICE, not the third-party notices.
    const own = JSON.parse(readFileSync(join(ROOT, "web", "package.json"), "utf8"));
    const uncovered = uncoveredPackages([...ra.values(), ...rb.values()].map((p) => `${p.name}@${p.version}`), notices, `${own.name}@${own.version}`);
    const otherTypes = [...new Set([...a.values(), ...b.values()].filter((p) => !["npm", "apk"].includes(p.type)).map((p) => `${p.type}:${p.name}@${p.version}`))].sort();
    writeFileSync(join(work, "sbom-attached.spdx.json"), JSON.stringify(attachedDoc));
    return {
      ok: onlyAttached.length === 0 && onlyIndependent.length === 0 && licenseDisagreements.length === 0 && uncovered.length === 0,
      details: {
        attachedPackages: a.size, independentPackages: b.size, comparedPackages: ra.size,
        onlyAttached, onlyIndependent, licenseDisagreements, notCoveredByNotices: uncovered,
        otherComponentsForReview: otherTypes,
      },
    };
  },

  // The vulnerability policy: critical findings, and high findings, block unless a valid exception covers them.
  vulnerabilities({ image, work }) {
    const digest = image.slice(image.indexOf("@") + 1);
    imageArchive(image, work);
    const scan = docker(["run", "--rm", "-v", `${work}:/work:ro`, config.GRYPE_IMAGE, "docker-archive:/work/candidate-image.tar", "-o", "json", "-q"], { allowFail: true });
    if (scan.status !== 0) throw new Error("vulnerability scanner failed");
    writeFileSync(join(work, "vulnerabilities.json"), scan.stdout);
    const result = JSON.parse(scan.stdout);
    const file = JSON.parse(readFileSync(join(ROOT, "web", "third-party", "vulnerability-exceptions.json"), "utf8"));
    const now = Date.now();
    const valid = (e) => e && e.digest === digest && e.approver === "COVADigital" && typeof e.reason === "string" && e.reason.length > 10
      && Date.parse(e.expires) > now && Date.parse(e.expires) - Date.parse(e.approved) <= 30 * 86400000 && Date.parse(e.approved) <= now;
    const exceptions = (file.exceptions ?? []).filter(valid);
    const covered = (m) => exceptions.some((e) => e.id === m.vulnerability.id && e.package === m.artifact.name && e.version === m.artifact.version);
    const blocking = [];
    const review = [];
    for (const m of result.matches ?? []) {
      const sev = (m.vulnerability.severity ?? "Unknown").toLowerCase();
      const fixed = m.vulnerability.fix?.state === "fixed";
      const entry = { id: m.vulnerability.id, severity: m.vulnerability.severity, package: m.artifact.name, version: m.artifact.version, type: m.artifact.type, fix: m.vulnerability.fix?.versions ?? [] };
      if ((sev === "critical" || sev === "high") && !covered(m)) blocking.push({ ...entry, rule: sev === "critical" ? "critical" : fixed ? "high with a fix" : "high without a fix: needs an owner-approved exception" });
      else if (sev === "critical" || sev === "high") review.push({ ...entry, exception: true });
      else review.push(entry);
    }
    const db = result.descriptor?.db ?? {};
    return {
      ok: blocking.length === 0,
      details: {
        scanner: config.GRYPE_IMAGE, database: { built: db.status?.built ?? db.built ?? null, schema: db.status?.schemaVersion ?? db.schemaVersion ?? null },
        blocking, mediumLowAndExcepted: review, validExceptions: exceptions.length, ignoredInvalidExceptions: (file.exceptions ?? []).length - exceptions.length,
      },
    };
  },

  // The temporary Alpine zlib update is in effect (rules in checks.mjs,
  // securityUpdateVerdict). Reads the scan the vulnerabilities gate saved in the
  // same work folder, so it runs after that gate; without that scan it fails.
  "alpine-security-update"({ image, work }) {
    const scanFile = join(work, "vulnerabilities.json");
    if (!existsSync(scanFile)) throw new Error("no vulnerability scan in the work folder; run the vulnerabilities gate first");
    const scan = JSON.parse(readFileSync(scanFile, "utf8"));
    const attached = imagetools(image, "{{json .SBOM}}");
    const sbomDoc = attached.SPDX ?? attached["linux/amd64"]?.SPDX;
    if (!sbomDoc) throw new Error("no readable SPDX SBOM attached to the image");
    const sbomZlibVersions = [...spdxPackages(sbomDoc).values()].filter((p) => p.type === "apk" && p.name === "zlib").map((p) => p.version);
    const installedVersion = inImage(image, "awk '/^P:zlib$/{f=1} f&&/^V:/{print substr($0,3); exit}' /lib/apk/db/installed").trim();
    const exceptionsFile = JSON.parse(readFileSync(join(ROOT, "web", "third-party", "vulnerability-exceptions.json"), "utf8"));
    const verdict = securityUpdateVerdict({
      pins: config,
      dockerfileText: readFileSync(join(ROOT, "web", "Dockerfile"), "utf8"),
      installedVersion,
      sbomZlibVersions,
      scanMatches: scan.matches,
      exceptions: exceptionsFile.exceptions,
    });
    return {
      ok: verdict.ok,
      details: { expected: config.ALPINE_ZLIB_VERSION, fixes: config.ALPINE_ZLIB_FIXES, installedVersion, sbomZlibVersions, problems: verdict.problems },
    };
  },

  // Runs as uid/gid 1000; application files root-owned and not writable by it; Compose hardening intact.
  "non-root"({ image }) {
    const user = docker(["image", "inspect", "-f", "{{.Config.User}}", image]).stdout.trim();
    // Root-owned, and not group- or world-writable (rules in checks.mjs, NON_ROOT_FIND).
    const writable = inImage(image, `${NON_ROOT_FIND} | head -20`).split("\n").filter(Boolean);
    const compose = readFileSync(join(ROOT, "compose.prod.yaml"), "utf8");
    const hardening = { readOnly: /read_only:\s*true/.test(compose), capDropAll: /cap_drop:\s*\[\s*ALL\s*\]/.test(compose), noNewPrivileges: /no-new-privileges/.test(compose), ipcNone: /ipc:\s*none/.test(compose) };
    return { ok: user === "1000:1000" && writable.length === 0 && Object.values(hardening).every(Boolean), details: { user, notRootOwnedOrWritable: writable, hardening } };
  },

  // The regenerated notices equal the repository copy and the image's copy, byte for byte.
  notices({ image }) {
    const generated = readFileSync(need("generated"));
    const repo = readFileSync(join(ROOT, "web", "THIRD_PARTY_NOTICES.txt"));
    const inImg = docker(["run", "--rm", "--network", "none", "--entrypoint", "cat", image, "/app/THIRD_PARTY_NOTICES.txt"]).raw;
    const text = repo.toString("utf8");
    const geist = /^geist \S+$/m.test(text) && /SIL OPEN FONT LICENSE/i.test(text) && existsSync(join(ROOT, "web", "public", "licenses", "fonts", "geist-OFL.txt"));
    const busboy = /^busboy\b/m.test(text) && /Copyright Brian White/.test(text);
    return {
      ok: sha256(generated) === sha256(repo) && sha256(repo) === sha256(inImg) && geist && busboy,
      details: { generated: sha256(generated), repository: sha256(repo), image: sha256(inImg), geistLicensePresent: geist, busboyLicensePresent: busboy },
    };
  },

  // The image names its source bundle by digest; the bundle covers its operating-system packages and the upstream libvips package.
  "source-bundle"({ image, work }) {
    const bundleRef = need("bundle", DIGEST_REF);
    const dir = need("bundle-dir");
    const fileValue = docker(["run", "--rm", "--network", "none", "--entrypoint", "cat", image, "/app/SOURCE_BUNDLE"]).stdout.trim();
    const labels = JSON.parse(docker(["image", "inspect", "-f", "{{json .Config.Labels}}", image]).stdout);
    const manifestBuf = readFileSync(join(dir, "MANIFEST.json"));
    const manifest = JSON.parse(manifestBuf);
    const bundled = new Set(manifest.components.filter((c) => c.type === "alpine").flatMap((c) => c.packages.map((p) => `${p.name}@${p.version}`)));
    const apk = inImage(image, "cat /lib/apk/db/installed").split("\n\n").map((b) => [(/^P:(.*)$/m.exec(b) ?? [])[1], (/^V:(.*)$/m.exec(b) ?? [])[1]]).filter(([p]) => p).map(([p, v]) => `${p}@${v}`);
    const missing = apk.filter((k) => !bundled.has(k));
    const sl = manifest.components.find((c) => c.type === "sharp-libvips");
    const record = JSON.parse(readFileSync(join(ROOT, "web", "third-party", "upstream-libvips.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(ROOT, "web", "package-lock.json"), "utf8")).packages;
    const lockMismatch = Object.entries(record.packages).filter(([name, p]) => lock[`node_modules/${name}`]?.version !== p.version || lock[`node_modules/${name}`]?.integrity !== p.integrity).map(([n]) => n);
    const libHash = inImage(image, `sha256sum ${record.library.path} | cut -c1-64`).trim();
    const notices = JSON.parse(readFileSync(join(ROOT, "web", "third-party", "component-notices.json"), "utf8"));
    void work;
    const checks = {
      fileMatchesBundle: fileValue === bundleRef,
      labelMatchesBundle: labels["io.covalink.source-bundle"] === bundleRef,
      everyImagePackageBundled: missing.length === 0,
      upstreamLibvipsVersion: sl?.version === config.SHARP_LIBVIPS_VERSION && sl?.commit === config.SHARP_LIBVIPS_COMMIT,
      lockfileMatchesRecord: lockMismatch.length === 0,
      libraryMatchesRecord: libHash === record.library.sha256,
      noticesFromThisBundle: notices.bundle_manifest_sha256 === sha256(manifestBuf),
      toolchainRecorded: manifest.build_toolchain?.dockerfile_frontend === config.DOCKERFILE_FRONTEND && manifest.build_toolchain?.buildkit === config.BUILDKIT_IMAGE,
      upstreamLimitationDisclosed: /not a verified record of the crates inside the shipped library/.test(sl?.note ?? ""),
    };
    return { ok: Object.values(checks).every(Boolean), details: { bundle: bundleRef, checks, imagePackagesNotBundled: missing, lockfileMismatches: lockMismatch, libraryInImage: libHash } };
  },

  // The full deployment smoke against the published candidate: pulled by digest, retagged, not rebuilt.
  "deployment-smoke"({ image, work }) {
    const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "test:deploy"], {
      cwd: join(ROOT, "web"), env: { ...process.env, ...LOCAL_BUILDER, SMOKE_IMAGE: image }, encoding: "utf8", maxBuffer: 1 << 30, shell: process.platform === "win32",
    });
    const log = `${r.stdout}\n${r.stderr}`;
    writeFileSync(join(work, "deployment-smoke.log"), log);
    const summary = /\[deploy\] (\d+)\/(\d+) checks passed/.exec(log);
    const failedChecks = log.split("\n").filter((l) => /^\s+FAIL /.test(l)).map((l) => l.trim().slice(5, 200));
    const usedImage = new RegExp(`published image pulled by digest`).test(log);
    return {
      ok: r.status === 0 && !!summary && summary[1] === summary[2] && usedImage,
      details: { exitCode: r.status, passed: summary ? Number(summary[1]) : 0, total: summary ? Number(summary[2]) : 0, publishedImageMode: usedImage, failedChecks },
    };
  },

  // The documented libvips replacement works: a separately obtained copy of the same version loads and real operations succeed.
  "libvips-replacement"({ image, work }) {
    const record = JSON.parse(readFileSync(join(ROOT, "web", "third-party", "upstream-libvips.json"), "utf8"));
    const name = config.SHARP_LIBVIPS_PACKAGE;
    const want = record.packages[name];
    const dir = join(work, "libvips-replacement");
    mkdirSync(dir, { recursive: true });
    // npm from the pinned base image, so the download works the same on any host.
    const packed = docker(["run", "--rm", "-v", `${dir}:/out`, "-w", "/out", "--entrypoint", "npm", config.NODE_IMAGE,
      "pack", `${name}@${config.SHARP_LIBVIPS_VERSION}`, "--silent"]).stdout.trim().split("\n").pop();
    const tgz = join(dir, packed);
    const integrity = `sha512-${createHash("sha512").update(readFileSync(tgz)).digest("base64")}`;
    if (integrity !== want.integrity) throw new Error("the downloaded package doesn't match the lockfile integrity");
    const lib = record.library.path.split("/").pop();
    docker(["run", "--rm", "--network", "none", "-v", `${dir}:/out`, "-w", "/out", "--entrypoint", "tar", config.NODE_IMAGE, "-xzf", packed, `package/lib/${lib}`]);
    copyFileSync(join(dir, "package", "lib", lib), join(dir, lib));
    copyFileSync(join(ROOT, "release", "gates", "sharp-ops.cjs"), join(dir, "sharp-ops.cjs"));
    writeFileSync(join(dir, "Dockerfile"), `FROM ${image}\nCOPY --chown=root:root --chmod=0644 ${lib} ${record.library.path}\nCOPY --chown=root:root --chmod=0644 sharp-ops.cjs /tmp/sharp-ops.cjs\n`);
    docker(["build", "-q", "-t", "covalink-libvips-replacement:gate", dir], { env: LOCAL_BUILDER });
    const ops = (ref) => JSON.parse(docker(["run", "--rm", "--network", "none", "--entrypoint", "node", ref, "/tmp/sharp-ops.cjs"], { allowFail: true }).stdout.trim() || "{}");
    writeFileSync(join(dir, "Dockerfile.control"), `FROM ${image}\nCOPY --chown=root:root --chmod=0644 sharp-ops.cjs /tmp/sharp-ops.cjs\n`);
    docker(["build", "-q", "-f", join(dir, "Dockerfile.control"), "-t", "covalink-libvips-control:gate", dir], { env: LOCAL_BUILDER });
    const control = ops("covalink-libvips-control:gate");
    const swapped = ops("covalink-libvips-replacement:gate");
    const libSha = sha256(readFileSync(join(dir, lib)));
    const problems = libvipsVerdict({ control, swapped, replacementSha256: libSha, recordSha256: record.library.sha256 });
    return { ok: problems.length === 0, details: { problems, control, swapped, replacementSha256: libSha } };
  },
};

async function main() {
  if (!gates[gate]) throw new Error(`unknown gate "${gate}"; one of: ${Object.keys(gates).join(", ")}`);
  const image = need("image", DIGEST_REF);
  const work = resolve(need("work"));
  const out = need("out");
  mkdirSync(work, { recursive: true });
  let result;
  try {
    result = await gates[gate]({ image, work });
  } catch (err) {
    result = { ok: false, details: { error: err.message } };
  }
  const record = { gate, image, ok: result.ok === true, ...result, at: new Date().toISOString() };
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`${record.ok ? "PASS" : "FAIL"} ${gate}`);
  process.exitCode = record.ok ? 0 : 1;
}
main();
