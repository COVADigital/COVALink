// Regression tests for the temporary Alpine zlib update (release/gates/checks.mjs,
// securityUpdateVerdict), run against the repository's own web/Dockerfile and pins.
//
//   node --test "release/gates/test/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { securityUpdateVerdict, stageGraphProblems } from "../checks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const pins = Object.fromEntries(readFileSync(join(ROOT, "release", "config.env"), "utf8").split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const dockerfile = readFileSync(join(ROOT, "web", "Dockerfile"), "utf8");
const V = pins.ALPINE_ZLIB_VERSION;
const CVE = pins.ALPINE_ZLIB_FIXES;

const good = () => ({
  pins, dockerfileText: dockerfile, installedVersion: V, sbomZlibVersions: [V],
  scanMatches: [{ vulnerability: { id: "CVE-2025-60876", severity: "Medium" }, artifact: { name: "busybox", version: "1.37.0-r31" } }],
  exceptions: [],
});
const fails = (change, pattern) => {
  const v = securityUpdateVerdict({ ...good(), ...change });
  assert.equal(v.ok, false, JSON.stringify(Object.keys(change)));
  assert.ok(v.problems.some((p) => pattern.test(p)), `no problem matching ${pattern}: ${JSON.stringify(v.problems)}`);
};

test("security update: the repository's Dockerfile and pins pass with the fixed package in place", () => {
  assert.equal(V, "1.4-r0");
  assert.equal(CVE, "CVE-2026-4738");
  assert.deepEqual(securityUpdateVerdict(good()).problems, []);
});

test("security update: the installed version must be exactly the pinned one", () => {
  fails({ installedVersion: "1.3.2-r1" }, /installed zlib is 1\.3\.2-r1/);
  fails({ installedVersion: "1.4-r1" }, /installed zlib is 1\.4-r1/);
  fails({ installedVersion: "" }, /\(missing\)/);
});

test("security update: the SBOM must report exactly the pinned version", () => {
  fails({ sbomZlibVersions: [] }, /SBOM lists zlib \(none\)/);
  fails({ sbomZlibVersions: ["1.3.2-r1"] }, /SBOM lists zlib 1\.3\.2-r1/);
  fails({ sbomZlibVersions: [V, "1.3.2-r1"] }, /not exactly/);
});

test("security update: the scan must no longer report zlib or the fixed CVE", () => {
  const zlibMatch = { vulnerability: { id: CVE, severity: "Critical" }, artifact: { name: "zlib", version: "1.3.2-r1" } };
  fails({ scanMatches: [...good().scanMatches, zlibMatch] }, /still reports zlib 1\.3\.2-r1/);
  fails({ scanMatches: [{ vulnerability: { id: "CVE-2099-0001", severity: "Low" }, artifact: { name: "zlib", version: V } }] }, /still reports zlib 1\.4-r0/);
  fails({ scanMatches: [{ vulnerability: { id: CVE, severity: "Critical" }, artifact: { name: "zlib-dev", version: V } }] }, new RegExp(`still reports ${CVE}`));
  fails({ scanMatches: undefined }, /no vulnerability scan results/);
});

test("security update: no exception may cover zlib or the fixed CVE", () => {
  fails({ exceptions: [{ id: CVE, package: "zlib", version: "1.3.2-r1" }] }, /an exception covers/);
  fails({ exceptions: [{ id: "CVE-2099-0001", package: "zlib", version: V }] }, /an exception covers zlib/);
  fails({ exceptions: [{ id: CVE, package: "other", version: "1" }] }, /an exception covers other/);
  fails({ exceptions: undefined }, /unreadable/);
});

test("security update: the Dockerfile must install the exact package once, verified, under every later stage", () => {
  fails({ dockerfileText: dockerfile.replace(`zlib=${V}`, "zlib") }, /exactly zlib=1\.4-r0 once/);
  fails({ dockerfileText: dockerfile.replace(`zlib=${V}`, "zlib=1.4-r1") }, /exactly zlib=1\.4-r0 once/);
  const I = `apk add --no-cache --no-logfile zlib=${V}`;
  assert.ok(dockerfile.includes(I), "the Dockerfile's install line changed");
  fails({ dockerfileText: dockerfile.replace(I, `${I} && ${I}`) }, /once/);
  fails({ dockerfileText: dockerfile.replace(I, `${I} && apk add --no-cache zlib`) }, /once/);
  fails({ dockerfileText: dockerfile.replace(I, `apk add --no-cache zlib=${V}`) }, /once, as/);
  fails({ dockerfileText: dockerfile.replace(I, `apk add --no-cache --no-logfile --allow-untrusted zlib=${V}`) }, /bypasses apk's signature checks/);
  fails({ dockerfileText: dockerfile.replace(I, `apk add --no-cache --no-logfile --force-overwrite zlib=${V}`) }, /bypasses|once/);
  fails({ dockerfileText: dockerfile.replace("FROM patched-base AS runtime", "FROM ${NODE_IMAGE} AS runtime") }, /stage runtime builds on the unpatched base image/);
  fails({ dockerfileText: dockerfile.replace("FROM patched-base AS deps", "FROM ${NODE_IMAGE} AS deps") }, /stage deps builds on the unpatched base image/);
  fails({ dockerfileText: dockerfile.replace("FROM ${NODE_IMAGE} AS patched-base", "FROM alpine:3.24 AS patched-base") }, /first stage must be FROM \$\{NODE_IMAGE\} AS patched-base/);
});

test("security update: malformed pins fail closed", () => {
  fails({ pins: { ...pins, ALPINE_ZLIB_VERSION: "1.4" } }, /exact Alpine package version/);
  fails({ pins: { ...pins, ALPINE_ZLIB_VERSION: "" } }, /exact Alpine package version/);
  fails({ pins: { ...pins, ALPINE_ZLIB_FIXES: "" } }, /doesn't name the CVEs/);
});

// ------------------------------------------------------------- stage graph ----
const graphFails = (text, pattern, label) => {
  const problems = stageGraphProblems(text);
  assert.ok(problems.length > 0, `${label}: expected the stage graph to fail`);
  assert.ok(problems.some((p) => pattern.test(p)), `${label}: no problem matching ${pattern}: ${JSON.stringify(problems)}`);
  // The whole gate fails too, not only the helper.
  assert.equal(securityUpdateVerdict({ ...good(), dockerfileText: text }).ok, false, `${label}: the gate passed`);
};

test("stage graph: the repository's Dockerfile is sound", () => {
  assert.deepEqual(stageGraphProblems(dockerfile), []);
});

test("stage graph: direct bypasses of patched-base fail", () => {
  const cases = [
    ["deps from alpine:3.24", "FROM patched-base AS deps", "FROM alpine:3.24 AS deps", /stage deps builds on an image/],
    ["deps from scratch", "FROM patched-base AS deps", "FROM scratch AS deps", /stage deps builds on scratch/],
    ["deps from the unpatched base", "FROM patched-base AS deps", "FROM ${NODE_IMAGE} AS deps", /unpatched base image/],
    ["build from an external image", "FROM deps AS build", "FROM node:24-alpine AS build", /stage build builds on an image/],
    ["build from a digest-pinned image", "FROM deps AS build", `FROM node@sha256:${"a".repeat(64)} AS build`, /stage build builds on an image/],
    ["runtime from an external image", "FROM patched-base AS runtime", "FROM gcr.io/distroless/nodejs24 AS runtime", /stage runtime builds on an image/],
    ["deps from a stage index", "FROM patched-base AS deps", "FROM 0 AS deps", /a stage index/],
    ["--platform doesn't hide the base", "FROM patched-base AS deps", "FROM --platform=linux/amd64 alpine:3.24 AS deps", /stage deps builds on an image/],
    ["lowercase instruction", "FROM patched-base AS deps", "from alpine:3.24 as deps", /stage deps builds on an image/],
    ["FROM split across a continuation line", "FROM patched-base AS deps", "FROM \\\n  alpine:3.24 AS deps", /stage deps builds on an image/],
  ];
  for (const [label, from, to, pattern] of cases) {
    assert.ok(dockerfile.includes(from), `${label}: fixture line missing`);
    graphFails(dockerfile.replace(from, to), pattern, label);
  }
});

test("stage graph: indirect bypasses through an intermediate stage fail", () => {
  // An intermediate named stage that doesn't descend from patched-base, used by deps.
  const via = dockerfile.replace("FROM patched-base AS deps", "FROM alpine:3.24 AS tools\nRUN true\nFROM tools AS deps");
  graphFails(via, /stage tools builds on an image/, "intermediate from alpine");
  assert.ok(stageGraphProblems(via).some((p) => /stage deps builds on a stage that doesn't descend from patched-base \(tools\)/.test(p)), "deps through tools must fail too");
  // And deeper: build depends on deps, which depends on the bad intermediate.
  assert.ok(stageGraphProblems(via).some((p) => /stage build builds on a stage that doesn't descend/.test(p)), "build through deps must fail too");
  // Files copied in from an image or a non-descending stage.
  graphFails(dockerfile.replace("COPY --from=build /app/public ./public", "COPY --from=alpine:3.24 /lib/libz.so.1 /lib/libz.so.1"), /files come from alpine:3\.24/, "COPY from an image");
  graphFails(dockerfile.replace("COPY --from=build /app/public ./public", "COPY --from=0 /lib/libz.so.1 /lib/libz.so.1"), /files come from 0/, "COPY from a stage index");
  graphFails(dockerfile.replace("FROM patched-base AS runtime", "FROM alpine:3.24 AS tools\nFROM patched-base AS runtime\nCOPY --from=tools /lib/libz.so.1 /lib/libz.so.1"), /files come from tools/, "COPY from a non-descending stage");
  graphFails(dockerfile.replace("RUN --network=none --mount=type=secret", "RUN --network=none --mount=type=bind,from=alpine:3.24,target=/x --mount=type=secret"), /files come from alpine:3\.24/, "mount from an image");
});

test("stage graph: duplicate, unknown, forward and cyclic stage references fail", () => {
  graphFails(dockerfile.replace("FROM deps AS build", "FROM deps AS deps"), /duplicate stage name: deps/, "duplicate name");
  graphFails(dockerfile.replace("FROM deps AS build", "FROM deps AS Deps"), /duplicate stage name: deps/, "duplicate name differing in case");
  graphFails(dockerfile.replace("FROM deps AS build", "FROM nonexistent AS build"), /stage build builds on an image or a stage not declared before it \(nonexistent\)/, "unknown stage");
  graphFails(dockerfile.replace("FROM patched-base AS deps", "FROM build AS deps"), /stage deps builds on an image or a stage not declared before it \(build\)/, "forward reference");
  const cycle = "FROM ${NODE_IMAGE} AS patched-base\nRUN apk add --no-cache --no-logfile zlib=1.4-r0\nFROM b AS a\nFROM a AS b\nFROM b AS runtime\n";
  graphFails(cycle, /stage a builds on an image or a stage not declared before it \(b\)/, "cycle");
});

test("stage graph: patched-base must come first, from the pinned image; FROM must be well formed; runtime ships", () => {
  graphFails(dockerfile.replace("FROM ${NODE_IMAGE} AS patched-base", "FROM alpine:3.24 AS patched-base"), /first stage must be/, "patched-base from alpine");
  graphFails(dockerfile.replace("FROM ${NODE_IMAGE} AS patched-base", "FROM ${NODE_IMAGE} AS base"), /first stage must be/, "renamed patched-base");
  graphFails(`FROM alpine:3.24 AS early\n${dockerfile.replace(/^# syntax=.*\n/, "")}`, /first stage must be/, "a stage before patched-base");
  graphFails(dockerfile.replace("FROM patched-base AS deps", "FROM patched-base"), /malformed or unnamed FROM/, "unnamed stage");
  graphFails(dockerfile.replace("FROM patched-base AS deps", "FROM patched-base AS deps extra"), /malformed or unnamed FROM/, "trailing words");
  graphFails(`${dockerfile}\nFROM runtime AS debug\n`, /isn't runtime/, "a stage after runtime");
  graphFails("", /no FROM instructions/, "empty Dockerfile");
});
