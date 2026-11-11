// Regression tests for the candidate gates' decisions (release/gates/checks.mjs)
// and the deployment smoke test's published-image rules. Each refinement is shown
// to keep rejecting genuine violations, not only to accept the false positives it
// was made for. Run from the repository root:
//
//   node --test "release/gates/test/*.test.mjs"
//
// The non-root test needs Docker; it fails, rather than skips, without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EMAIL, emailFindings, keyExposures, libvipsVerdict, NON_ROOT_FIND, normalizeFileList, rebuildVerdict, uncoveredPackages, validActionsKey,
} from "../checks.mjs";
import { PUBLISHED_IMAGE, revisionFromEnv } from "../../../web/tests/deploy/published-image.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const config = Object.fromEntries(readFileSync(join(ROOT, "release", "config.env"), "utf8").split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

// ------------------------------------------------------------------ secrets ----
const ADDRESS = "someone@example.org";
const sbomWith = (extra = {}) => ({
  SPDX: {
    creationInfo: { creators: ["Tool: buildkit-syft-scanner@1.12.1"] },
    packages: [{ name: "pino", supplier: "Person: A Maintainer (maintainer@example.net)", originator: "Person: B (b@example.net)", downloadLocation: "git+ssh://git@example.org/x/y.git" }],
    files: [{ fileName: "etc/apk/keys/alpine-devel@lists.alpinelinux.org-6165ee59.rsa.pub" }, { fileName: "usr/share/apk/keys/alpine-devel@lists.alpinelinux.org-5243ef4b.rsa.pub" }],
    ...extra,
  },
});

test("secrets: image references with numeric tags aren't addresses, real addresses are", () => {
  for (const ref of ["buildkit-syft-scanner@1.12.1", "node@24.22.2-alpine3.24", "registry@3.1.2", "x@sha256"]) assert.equal(EMAIL.test(ref), false, ref);
  for (const addr of [ADDRESS, "a.b+c@mail.example.net", "first.last@team.test"]) assert.equal(EMAIL.test(addr), true, addr);
});

test("secrets: third-party package metadata and Alpine key file names pass", () => {
  assert.deepEqual(emailFindings({ metadataText: "RUN npm ci\n{\"org.opencontainers.image.revision\":\"abc\"}", sbom: sbomWith() }), []);
});

test("secrets: an address in history, environment, labels or provenance fails", () => {
  for (const metadataText of [`RUN git config user.email ${ADDRESS}`, `["MAINTAINER=${ADDRESS}"]`, `{"org.opencontainers.image.authors":"${ADDRESS}"}`, `{"invocation":{"parameters":{"x":"${ADDRESS}"}}}`]) {
    assert.deepEqual(emailFindings({ metadataText, sbom: sbomWith() }), ["history, environment, labels or provenance"], metadataText);
  }
});

test("secrets: an address anywhere else in the SBOM fails", () => {
  const cases = [
    [{ creationInfo: { creators: [`Person: ${ADDRESS}`] } }, "SBOM SPDX.creationInfo.creators[]"],
    [{ name: `scan by ${ADDRESS}` }, "SBOM SPDX.name"],
    [{ packages: [{ name: ADDRESS }] }, "SBOM SPDX.packages[].name"],
    [{ packages: [{ name: "x", comment: ADDRESS }] }, "SBOM SPDX.packages[].comment"],
    [{ files: [{ fileName: `app/.env.${ADDRESS}` }] }, "SBOM SPDX.files[].fileName"],
    // An Alpine key name outside the apk key folders, or with another domain, isn't exempt.
    [{ files: [{ fileName: "app/keys/alpine-devel@lists.alpinelinux.org-6165ee59.rsa.pub" }] }, "SBOM SPDX.files[].fileName"],
    [{ files: [{ fileName: "etc/apk/keys/someone@example.org-6165ee59.rsa.pub" }] }, "SBOM SPDX.files[].fileName"],
  ];
  for (const [extra, where] of cases) assert.deepEqual(emailFindings({ metadataText: "", sbom: sbomWith(extra) }), [where], JSON.stringify(extra));
});

// --------------------------------------------------------------------- sbom ----
test("sbom: only COVALink's own package at its own version is exempt from notices coverage", () => {
  const notices = "COVALink third-party notices\npino 9.0.0\nzlib 1.3.2-r1  (Zlib; source package zlib)\n";
  assert.deepEqual(uncoveredPackages(["pino@9.0.0", "zlib@1.3.2-r1", "web@0.1.0"], notices, "web@0.1.0"), []);
  assert.deepEqual(uncoveredPackages(["web@0.2.0"], notices, "web@0.1.0"), ["web@0.2.0"]);
  assert.deepEqual(uncoveredPackages(["left-pad@1.3.0", "pino@9.0.1"], notices, "web@0.1.0"), ["left-pad@1.3.0", "pino@9.0.1"]);
  assert.deepEqual(uncoveredPackages(["covalink@0.1.0"], notices, "web@0.1.0"), ["covalink@0.1.0"]);
});

// ----------------------------------------------------------------- non-root ----
test("non-root: group- or world-writable files and directories and non-root owners fail; root-owned links pass", () => {
  const setup = [
    "set -e",
    "mkdir -p /app/.next/static/media /app/.next/cache /app/lib /app/opendir",
    "touch /app/ok.js && chmod 0644 /app/ok.js",
    // The font-permission case the image build fixes: a group-writable font file.
    "touch /app/.next/static/media/font.woff2 && chmod 0664 /app/.next/static/media/font.woff2",
    "touch /app/world.js && chmod 0666 /app/world.js",
    "chmod 0775 /app/opendir",
    "touch /app/owned-by-node.js && chown 1000:1000 /app/owned-by-node.js",
    "ln -s ok.js /app/lib/root-link",
    "ln -s ok.js /app/lib/node-link && chown -h 1000:1000 /app/lib/node-link",
    "touch /app/.next/cache/runtime-cache && chown -R 1000:1000 /app/.next/cache && chmod 0666 /app/.next/cache/runtime-cache",
    NON_ROOT_FIND,
  ].join("; ");
  const r = spawnSync("docker", ["run", "--rm", "--network", "none", "--user", "0:0", "--entrypoint", "sh", config.NODE_IMAGE, "-c", setup], { encoding: "utf8" });
  assert.equal(r.status, 0, `docker run failed (Docker is required for this test): ${r.stderr}`);
  const flagged = r.stdout.split("\n").filter(Boolean).sort();
  assert.deepEqual(flagged, ["/app/.next/static/media/font.woff2", "/app/lib/node-link", "/app/opendir", "/app/owned-by-node.js", "/app/world.js"]);
});

test("non-root: the image build removes group and world write from everything under /app", () => {
  const dockerfile = readFileSync(join(ROOT, "web", "Dockerfile"), "utf8");
  const runtime = dockerfile.slice(dockerfile.indexOf("AS runtime"));
  const chmodAt = runtime.indexOf("chmod -R go-w /app");
  assert.ok(chmodAt > 0, "the runtime stage no longer runs chmod -R go-w /app");
  assert.ok(chmodAt > runtime.lastIndexOf("COPY "), "chmod -R go-w /app must come after the last COPY into the runtime stage");
  assert.ok(chmodAt < runtime.indexOf("USER 1000:1000"), "chmod -R go-w /app must run before switching to the runtime user");
});

// ------------------------------------------------------------ deployment smoke ----
test("smoke: a published image's expected version must be one full commit SHA", () => {
  const sha = "0baa73ebd0515e8f23c424caa33e1b367daa8aa0";
  assert.equal(revisionFromEnv(["NODE_ENV=production", `COVALINK_GIT_SHA=${sha}`]), sha);
  for (const env of [[], ["COVALINK_GIT_SHA="], ["COVALINK_GIT_SHA=unknown"], ["COVALINK_GIT_SHA=local"], [`COVALINK_GIT_SHA=${sha.slice(0, 12)}`],
    [`COVALINK_GIT_SHA=smoke-${sha.slice(0, 12)}-dirty-1`], [`COVALINK_GIT_SHA=${sha.toUpperCase()}`], [`COVALINK_GIT_SHA=${sha}`, `COVALINK_GIT_SHA=${sha}`], null]) {
    assert.throws(() => revisionFromEnv(env), undefined, JSON.stringify(env));
  }
});

test("smoke: SMOKE_IMAGE must be pinned by digest", () => {
  assert.equal(PUBLISHED_IMAGE.test(`ghcr.io/covadigital/covalink-staging@sha256:${"a".repeat(64)}`), true);
  for (const ref of ["ghcr.io/covadigital/covalink-staging:candidate", `ghcr.io/x@sha256:${"a".repeat(63)}`, `ghcr.io/x:tag@sha256:${"A".repeat(64)}`, ""]) assert.equal(PUBLISHED_IMAGE.test(ref), false, ref);
});

// ----------------------------------------------------------- libvips replacement ----
test("libvips replacement: passes only when both images work and the recorded replacement was loaded", () => {
  const rec = "979b625437190a1970b835164e0e30d47dc60159ce6a394ce78cc40cb9d59ab8";
  const good = { allPassed: true, loadedSha256: rec };
  assert.deepEqual(libvipsVerdict({ control: good, swapped: good, replacementSha256: rec, recordSha256: rec }), []);
  assert.equal(libvipsVerdict({ control: { allPassed: false }, swapped: good, replacementSha256: rec, recordSha256: rec }).length, 1);
  assert.equal(libvipsVerdict({ control: good, swapped: { ...good, allPassed: false }, replacementSha256: rec, recordSha256: rec }).length, 1);
  assert.equal(libvipsVerdict({ control: good, swapped: { allPassed: true, loadedSha256: "0".repeat(64) }, replacementSha256: rec, recordSha256: rec }).length, 1);
  assert.equal(libvipsVerdict({ control: good, swapped: { allPassed: true, loadedSha256: "1".repeat(64) }, replacementSha256: "1".repeat(64), recordSha256: rec }).length, 1);
  assert.ok(libvipsVerdict({ control: {}, swapped: {}, replacementSha256: rec, recordSha256: rec }).length >= 2, "an empty result (the operations didn't run) must fail");
});

// ------------------------------------------------------------- rebuild and key ----
test("rebuild: the Server Actions key must be base64 of exactly 32 bytes", () => {
  const ok = Buffer.alloc(32, 7).toString("base64");
  assert.equal(validActionsKey(ok), true);
  for (const bad of ["", Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64"), `${ok}\n`, ok.replace(/=$/, ""), Buffer.alloc(32).toString("hex"), undefined]) {
    assert.equal(validActionsKey(bad), false, String(bad));
  }
});

test("rebuild: the key is found in any text that holds it, in base64 or hex", () => {
  const key = Buffer.alloc(32, 9).toString("base64");
  const hex = Buffer.from(key, "base64").toString("hex");
  assert.deepEqual(keyExposures(key, { history: "RUN npm run build", log: "#9 DONE" }), []);
  assert.deepEqual(keyExposures(key, { history: `ARG KEY=${key}`, provenance: `{"x":"${hex}"}`, log: "fine" }), ["history", "provenance"]);
});

test("rebuild: offline step, file lists and labels must all match; differing chunk names still fail", () => {
  const base = { offline: true, listA: ["/app/a.js"], listB: ["/app/a.js"], labelsA: { x: "1" }, labelsB: { x: "1" } };
  assert.equal(rebuildVerdict(base).ok, true);
  assert.equal(rebuildVerdict({ ...base, offline: false }).ok, false);
  assert.equal(rebuildVerdict({ ...base, listB: ["/app/a.js", "/app/b.js"] }).ok, false);
  assert.equal(rebuildVerdict({ ...base, labelsB: { x: "2" } }).ok, false);
  assert.equal(rebuildVerdict({ ...base, labelsB: { x: "1", y: "1" } }).ok, false);
  // The chunk names that differed between two builds aren't normalized away.
  const a = normalizeFileList(["/app/.next/static/chunks/19b-cj78x6sjs.js"], "U3p9TwQP8WcH4VUtDpL7o");
  const b = normalizeFileList(["/app/.next/static/chunks/07y4-2-xk8umg.js"], "rD-3OnzHaOb43TNvpqxfQ");
  assert.equal(rebuildVerdict({ ...base, listA: a, listB: b }).ok, false);
  // The build ID itself is normalized only where it appears in a path.
  assert.deepEqual(normalizeFileList(["/app/.next/static/abc123/_buildManifest.js"], "abc123"), ["/app/.next/static/<build-id>/_buildManifest.js"]);
});
