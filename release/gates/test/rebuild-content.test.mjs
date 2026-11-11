// Regression tests for the rebuild gate's byte-level comparison and its toolchain
// check (release/gates/checks.mjs). The comparison may forgive only the known
// random values in the six known files; everything else must fail.
//
//   node --test "release/gates/test/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  builderVersionFrom, contentVerdict, KNOWN_DIFFERENCES, NEXT_VERSION, normalizeDraftModeJson, normalizeFallbackParams, stageOffsetRow, toolchainVerdict,
} from "../checks.mjs";

const hex = (n) => randomBytes(n).toString("hex");
const draft = () => ({ previewModeId: hex(16), previewModeSigningKey: hex(32), previewModeEncryptionKey: hex(32) });
const previewProps = (d = draft()) => Buffer.from(JSON.stringify(d));
const prerender = (d = draft(), extra = {}) => Buffer.from(JSON.stringify({ version: 4, routes: { "/": { initialRevalidateSeconds: false } }, dynamicRoutes: {}, notFoundRoutes: [], preview: d, ...extra }));
const segHead = (param, id, body = "row") => `1:"$Sreact.fragment"\n6:[["children",{"s":{"n":"${param}","t":"d","k":"%%drp:${param}:${id}%%"},"h":8706}],"${body}"]\n`;
// As in the real files: the [handle] segment ends with the completion block and the
// static-stage offset row (the byte offset of that block); [id] segments end with a null row.
const withTail = (head, offset) => Buffer.from(offset ? `${head}19:true\n17:C\n14:C\n18:${head.length}\n` : `${head}19:C\n5:C\n1a:null\n`, "latin1");
const segment = (param, id, body = "row", offset = param === "handle") => withTail(segHead(param, id, body), offset);
const sha = (b) => createHash("sha256").update(b).digest("hex");

const [P_PROPS, P_PRERENDER, P_HANDLE, P_USER, P_PROFILE, P_ANALYTICS] = Object.keys(KNOWN_DIFFERENCES);

/** Two builds: identical shared files plus the six known files, each pair differing only in its random values. */
function builds(overrides = {}) {
  const shared = { "/app/server.js": Buffer.from("server"), "/etc/hostname": Buffer.from("a") };
  const a = {
    ...shared, [P_PROPS]: previewProps(), [P_PRERENDER]: prerender(),
    [P_HANDLE]: segment("handle", "5bb4b810e1dea8"), [P_USER]: segment("id", "381ebc29c837a8"),
    [P_PROFILE]: segment("id", "7499957d8a27e"), [P_ANALYTICS]: segment("id", "ce996e5317b65"),
  };
  const b = {
    ...shared, "/etc/hostname": Buffer.from("b"), [P_PROPS]: previewProps(), [P_PRERENDER]: prerender(),
    [P_HANDLE]: segment("handle", "981076f5a660e8"), [P_USER]: segment("id", "1f0e9d8c7b6a5"),
    [P_PROFILE]: segment("id", "a0b1c2d3e4f5"), [P_ANALYTICS]: segment("id", "123456789abcd"),
  };
  for (const [k, v] of Object.entries(overrides.a ?? {})) { if (v === null) delete a[k]; else a[k] = v; }
  for (const [k, v] of Object.entries(overrides.b ?? {})) { if (v === null) delete b[k]; else b[k] = v; }
  const hashes = (x) => new Map(Object.entries(x).map(([p, buf]) => [p, sha(buf)]));
  const contents = Object.fromEntries(Object.keys(KNOWN_DIFFERENCES).filter((p) => a[p] && b[p]).map((p) => [p, { a: a[p], b: b[p] }]));
  return { hashesA: hashes(a), hashesB: hashes(b), contents, nextVersions: { candidate: NEXT_VERSION, rebuild: NEXT_VERSION, ...overrides.nextVersions } };
}
const fails = (input, pattern) => {
  const v = contentVerdict(input);
  assert.equal(v.ok, false, "expected the comparison to fail");
  if (pattern) assert.ok(v.problems.some((p) => pattern.test(p)), `no problem matching ${pattern}: ${JSON.stringify(v.problems)}`);
};

test("content: the six known files differing only in their random values pass; Docker's runtime files are ignored", () => {
  const v = contentVerdict(builds());
  assert.deepEqual(v.problems, []);
  assert.equal(v.ok, true);
  assert.equal(v.differing.length, 6);
});

test("content: the known set is exactly six paths, pinned to one Next.js version", () => {
  assert.equal(Object.keys(KNOWN_DIFFERENCES).length, 6);
  assert.equal(NEXT_VERSION, "16.4.3");
  fails(builds({ nextVersions: { rebuild: "16.4.4" } }), /reviewed for 16\.4\.3 only/);
  fails(builds({ nextVersions: { candidate: "" } }), /Next\.js \(unknown\)/);
});

test("content: an ordinary byte change in any other file fails", () => {
  fails(builds({ b: { "/app/server.js": Buffer.from("server!") } }), /unexpected difference: \/app\/server\.js/);
});

test("content: missing, additional and renamed paths fail closed", () => {
  // A known file identical in both builds is a missing expected difference.
  const same = segment("id", "381ebc29c837a8");
  fails(builds({ a: { [P_USER]: same }, b: { [P_USER]: same } }), /expected difference missing/);
  // A file in only one image.
  fails(builds({ b: { "/app/extra.js": Buffer.from("x") } }), /only in the rebuild/);
  fails(builds({ a: { [P_HANDLE]: null } }), /only in the rebuild/);
  // A renamed route: the old path is gone and the new one differs unexpectedly.
  const renamed = "/app/.next/server/app/[slug].segments/_full.segment.rsc";
  fails(builds({ a: { [P_HANDLE]: null, [renamed]: segment("slug", "aa") }, b: { [P_HANDLE]: null, [renamed]: segment("slug", "bb") } }), /unexpected difference/);
  // Contents that weren't read.
  const input = builds();
  delete input.contents[P_PROPS];
  fails(input, /contents not read/);
});

test("content: draft-mode JSON fails on any other change, field or format", () => {
  const d = draft();
  // Another byte in the manifest.
  fails(builds({ b: { [P_PRERENDER]: prerender(draft(), { notFoundRoutes: ["/x"] }) } }), /differs beyond its known values/);
  // An unexpected or missing field in the draft-mode object.
  assert.throws(() => normalizeDraftModeJson(previewProps({ ...d, extra: "x" }), []), /not exactly/);
  const withoutId = { previewModeSigningKey: d.previewModeSigningKey, previewModeEncryptionKey: d.previewModeEncryptionKey };
  assert.throws(() => normalizeDraftModeJson(previewProps(withoutId), []), /not exactly/);
  // Wrong formats.
  assert.throws(() => normalizeDraftModeJson(previewProps({ ...d, previewModeId: hex(15) }), []), /previewModeId/);
  assert.throws(() => normalizeDraftModeJson(previewProps({ ...d, previewModeSigningKey: hex(32).toUpperCase() }), []), /previewModeSigningKey/);
  assert.throws(() => normalizeDraftModeJson(previewProps({ ...d, previewModeEncryptionKey: 42 }), []), /previewModeEncryptionKey/);
  // Not JSON, not where expected, or a value repeated elsewhere in the file.
  assert.throws(() => normalizeDraftModeJson(Buffer.from("{not json"), []), /not valid JSON/);
  assert.throws(() => normalizeDraftModeJson(prerender(d), []), /not exactly/);
  assert.throws(() => normalizeDraftModeJson(previewProps(d), ["preview"]), /no draft-mode object/);
  assert.throws(() => normalizeDraftModeJson(prerender(d, { copy: d.previewModeId }), ["preview"]), /exactly once/);
  // Only the three values are forgiven: formatting or any other byte still compares.
  fails(builds({ b: { [P_PROPS]: Buffer.from(JSON.stringify(draft(), null, 1)) } }), /differs beyond its known values/);
});

test("content: fallback-parameter tokens fail on any other format, count, location or byte", () => {
  assert.equal(normalizeFallbackParams(segment("handle", "5bb4b810e1dea8"), "handle", 1, true), normalizeFallbackParams(segment("handle", "0"), "handle", 1, true));
  // Another parameter name than the route's own.
  fails(builds({ b: { [P_HANDLE]: segment("id", "981076f5a660e8") } }), /unexpected token/);
  fails(builds({ b: { [P_USER]: segment("handle", "1f0e9d8c7b6a5") } }), /unexpected token/);
  // Malformed ids: uppercase, not hex, empty, too long.
  for (const id of ["ABCDEF12", "xyz123", "", "0123456789abcdef0"]) assert.throws(() => normalizeFallbackParams(segment("handle", id), "handle", 1), /unexpected token/, id);
  // Wrong token count, and a broken token left over.
  assert.throws(() => normalizeFallbackParams(Buffer.from("no tokens here"), "handle", 1), /0 fallback-parameter tokens/);
  assert.throws(() => normalizeFallbackParams(Buffer.from("%%drp:handle:aa%% %%drp:handle:aa%%"), "handle", 1), /2 fallback-parameter tokens/);
  assert.throws(() => normalizeFallbackParams(Buffer.from("%%drp:handle:aa%% %%drp:handle:bb"), "handle", 1), /malformed/);
  // Another byte changed beside the token, or the token moved.
  fails(builds({ b: { [P_HANDLE]: withTail(segHead("handle", "981076f5a660e8").replace('"h":8706}', '"h":8706,"x":1}'), true) } }), /differs beyond/);
  fails(builds({ b: { [P_HANDLE]: segment("handle", "981076f5a660e8", "rows") } }), /differs beyond/);
  const moved = withTail('1:"$Sreact.fragment"\n6:[["children",{"s":{"n":"handle","t":"d"},"k":"%%drp:handle:981076f5a660e8%%","h":8706}],"row"]\n', true);
  fails(builds({ b: { [P_HANDLE]: moved } }), /differs beyond/);
});

test("content: the [handle] static-stage offset is recomputed from the bytes; tokens of different lengths pass", () => {
  // Real case: placeholders of 14 and 13 characters shift the recorded offset by one.
  const a = segment("handle", "5bb4b810e1dea8");
  const b = segment("handle", "1c91380468e98");
  assert.notEqual(a.toString("latin1").split("\n").at(-2), b.toString("latin1").split("\n").at(-2));
  assert.deepEqual(contentVerdict(builds({ a: { [P_HANDLE]: a }, b: { [P_HANDLE]: b } })).problems, []);
  const r = stageOffsetRow(a.toString("latin1"));
  assert.equal(r.row, "18");
  assert.equal(r.offset, a.toString("latin1").indexOf("19:true"));
});

test("content: missing, duplicate, moved, malformed, additional or wrong offsets fail", () => {
  const head = segHead("handle", "981076f5a660e8");
  const blk = "19:true\n17:C\n14:C\n";
  const off = head.length;
  const h = (s) => Buffer.from(s, "latin1");
  const cases = [
    ["incorrectly calculated", h(`${head}${blk}18:${off + 1}\n`), /isn't the computed/],
    ["off by the token-length delta in the wrong direction", h(`${head}${blk}18:${off - 1}\n`), /isn't the computed/],
    ["missing", h(`${head}${blk}`), /final row isn't a static-stage offset row/],
    ["replaced by null", h(`${head}${blk}18:null\n`), /final row isn't/],
    ["malformed: leading zero", h(`${head}${blk}18:0${off}\n`), /final row isn't/],
    ["malformed: not decimal", h(`${head}${blk}18:${off}x\n`), /final row isn't/],
    ["malformed: negative", h(`${head}${blk}18:-${off}\n`), /final row isn't/],
    ["malformed: uppercase row ID", h(`${head}${blk}1A:${off}\n`), /final row isn't/],
    ["no trailing newline", h(`${head}${blk}18:${off}`), /newline/],
    ["duplicate row", h(`${head}${blk}18:${off}\n18:${off}\n`), /more than once|no completion rows/],
    ["row ID used elsewhere", h(`${head.replace("1:", "18:")}${blk}18:${off}\n`), /more than once/],
    ["moved before the completion rows", h(`${head}18:${off}\n${blk}`), /final row isn't/],
    ["moved into the completion rows", h(`${head}19:true\n17:C\n18:${off}\n14:C\n`), /final row isn't/],
    ["no completion rows", h(`${head}18:${off}\n`), /no completion rows/],
    ["two true rows", h(`${head}1b:true\n${blk}18:${off + 8}\n`), /more than one true row/],
    ["block without a true row", h(`${head}17:C\n14:C\n18:${off}\n`), /doesn't start with one true row/],
    ["an additional offset row after it", h(`${head}${blk}18:${off}\n1c:${off}\n`), /no completion rows/],
  ];
  for (const [label, buf, pattern] of cases) {
    assert.throws(() => normalizeFallbackParams(buf, "handle", 1, true), pattern, label);
    fails(builds({ b: { [P_HANDLE]: buf } }), pattern);
  }
});

test("content: the offset row's ID must match, and [id] segments may have no offset row", () => {
  const head = segHead("handle", "981076f5a660e8");
  const otherId = Buffer.from(`${head}19:true\n17:C\n14:C\n1b:${head.length}\n`, "latin1");
  fails(builds({ b: { [P_HANDLE]: otherId } }), /differs beyond/);
  // A completion-block offset added to an [id] segment is an additional offset.
  const idHead = segHead("id", "1f0e9d8c7b6a5");
  const idWithOffset = Buffer.from(`${idHead}19:true\n16:C\n1a:${idHead.length}\n`, "latin1");
  assert.throws(() => normalizeFallbackParams(idWithOffset, "id", 1, false), /unexpected static-stage offset row/);
  fails(builds({ b: { [P_USER]: idWithOffset } }), /unexpected static-stage offset row/);
  // An offset-shaped final row that points at any row start counts too.
  const pointsAtRow = Buffer.from(`${idHead}19:C\n5:C\n1a:${idHead.length}\n`, "latin1");
  assert.throws(() => normalizeFallbackParams(pointsAtRow, "id", 1, false), /unexpected static-stage offset row/);
  // Any other byte in the tail still compares.
  fails(builds({ b: { [P_HANDLE]: Buffer.from(`${head}19:true\n17:D\n14:C\n18:${head.length}\n`, "latin1") } }), /doesn't start with one true row|no completion rows/);
  fails(builds({ b: { [P_USER]: Buffer.from(`${idHead}19:C\n5:C\n1a:nul\n`, "latin1") } }), /differs beyond/);
});

// ---------------------------------------------------------------- toolchain ----
const PINS = {
  DOCKERFILE_FRONTEND: `docker/dockerfile:1.28.0@sha256:${"b".repeat(64)}`,
  BUILDKIT_IMAGE: `moby/buildkit:v0.34.1@sha256:${"9".repeat(64)}`,
};
const frontendDep = (d) => ({ digest: { sha256: d }, uri: `pkg:docker/docker/dockerfile@1.28.0?digest=sha256:${d}&platform=linux%2Famd64` });
const provenance = (source = PINS.DOCKERFILE_FRONTEND, deps = [frontendDep("b".repeat(64))]) => ({
  SLSA: { buildDefinition: { externalParameters: { request: { args: { source } } }, resolvedDependencies: deps } },
});
const good = () => ({
  pins: PINS, dockerfileFirstLine: `# syntax=${PINS.DOCKERFILE_FRONTEND}`, builderVersion: "v0.34.1", provenance: provenance(),
  rebuildLog: `#2 resolve image config for docker-image://docker.io/${PINS.DOCKERFILE_FRONTEND}\n#3 DONE`,
});

test("toolchain: the pinned frontend and BuildKit in effect pass", () => {
  assert.deepEqual(toolchainVerdict(good()).problems, []);
  assert.equal(builderVersionFrom("Name: x\nBuildKit version:      v0.34.1\nPlatforms: linux/amd64"), "v0.34.1");
  assert.equal(builderVersionFrom("Name: x"), "");
});

test("toolchain: any other effective version, or a missing record, fails closed", () => {
  const cases = [
    [{ builderVersion: "v0.34.2" }, /BuildKit v0\.34\.2/],
    [{ builderVersion: "" }, /BuildKit \(unknown\)/],
    [{ dockerfileFirstLine: "# syntax=docker/dockerfile:1" }, /first line/],
    [{ dockerfileFirstLine: "FROM node" }, /first line/],
    [{ provenance: provenance("docker/dockerfile:1") }, /source/],
    [{ provenance: provenance(PINS.DOCKERFILE_FRONTEND, []) }, /resolved no Dockerfile frontend/],
    [{ provenance: provenance(PINS.DOCKERFILE_FRONTEND, [frontendDep("c".repeat(64))]) }, /another frontend/],
    [{ provenance: {} }, /source/],
    [{ rebuildLog: "#1 DONE" }, /didn't resolve the pinned frontend/],
    [{ rebuildLog: "#2 resolve image config for docker-image://docker.io/docker/dockerfile:1.27.0" }, /another frontend/],
    [{ pins: { ...PINS, BUILDKIT_IMAGE: "moby/buildkit:latest" } }, /BUILDKIT_IMAGE/],
    [{ pins: { ...PINS, DOCKERFILE_FRONTEND: "docker/dockerfile:1.28.0" } }, /DOCKERFILE_FRONTEND/],
  ];
  for (const [change, pattern] of cases) {
    const v = toolchainVerdict({ ...good(), ...change });
    assert.equal(v.ok, false, JSON.stringify(change));
    assert.ok(v.problems.some((p) => pattern.test(p)), `${JSON.stringify(change)}: ${JSON.stringify(v.problems)}`);
  }
});
