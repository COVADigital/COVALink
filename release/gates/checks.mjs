// The decisions the candidate gates make, as pure functions, so the regression
// tests in release/gates/test/ can show that each one still rejects genuine
// violations. candidate-gates.mjs collects the inputs and calls these.

// An email address: a real one ends in an alphabetic top-level domain, so an
// image reference with a numeric version tag doesn't match.
export const EMAIL = /[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/;

// File names of Alpine Linux's public signing keys, as an SBOM lists them.
const ALPINE_KEY = /^(etc|usr\/share)\/apk\/keys\/alpine-devel@lists\.alpinelinux\.org-[0-9a-f]{8}\.rsa\.pub$/;
// SBOM fields that carry a third-party package's own metadata.
const PACKAGE_METADATA = ["SPDX.packages[].supplier", "SPDX.packages[].originator", "SPDX.packages[].downloadLocation"];

/**
 * Where email addresses appear. None may appear in the image history,
 * environment, labels or provenance (metadataText). In the SBOM, only third-party
 * package metadata and Alpine's key file names may hold one. Returns the places
 * that fail; empty means none.
 */
export function emailFindings({ metadataText, sbom }) {
  const found = [];
  if (EMAIL.test(metadataText)) found.push("history, environment, labels or provenance");
  const walk = (v, path) => {
    if (typeof v === "string") {
      if (!EMAIL.test(v)) return;
      const field = path.replace(/\[\d+\]/g, "[]");
      const allowed = PACKAGE_METADATA.includes(field) || (field === "SPDX.files[].fileName" && ALPINE_KEY.test(v));
      if (!allowed && !found.includes(`SBOM ${field}`)) found.push(`SBOM ${field}`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const k of Object.keys(v)) walk(v[k], path ? `${path}.${k}` : k);
  };
  walk(sbom, "");
  return found;
}

/** Packages (as name and version joined by "@") that the notices don't name. Only COVALink's own package is exempt. */
export function uncoveredPackages(packages, noticesText, self) {
  const named = new Set();
  for (const line of noticesText.split("\n")) {
    const m = /^(\S+) (\S+?)(?:  \(|$)/.exec(line);
    if (m) named.add(`${m[1]}@${m[2]}`);
  }
  return [...new Set(packages)].filter((k) => k !== self && !named.has(k)).sort();
}

/**
 * The find expression the non-root gate runs in the image: anything under /app
 * (except .next/cache) that isn't owned by root, and any file or directory that
 * is group- or world-writable. A symbolic link's own mode is always 777 and
 * grants nothing, so links are checked for ownership only.
 */
export const NON_ROOT_FIND = "find /app -xdev -path /app/.next/cache -prune -o \\( ! -user 0 -o \\( ! -type l \\( -perm -0002 -o -perm -0020 \\) \\) \\) -print";

/** The libvips replacement passes only if both images pass every operation and the swapped one loaded the recorded library. */
export function libvipsVerdict({ control, swapped, replacementSha256, recordSha256 }) {
  const problems = [];
  if (control?.allPassed !== true) problems.push("the unmodified image failed an operation");
  if (swapped?.allPassed !== true) problems.push("the image with the replacement failed an operation");
  if (swapped?.loadedSha256 !== replacementSha256) problems.push("the image didn't load the replacement library");
  if (replacementSha256 !== recordSha256) problems.push("the replacement isn't the recorded library");
  return problems;
}

/** A Server Actions key: base64 of exactly 32 bytes, as Next.js requires for AES-256. */
export function validActionsKey(text) {
  if (typeof text !== "string" || text === "") return false;
  const bytes = Buffer.from(text, "base64");
  return bytes.length === 32 && bytes.toString("base64") === text;
}

/** Names of the given texts that contain the key (or its hex form). Empty means the key appears in none. */
export function keyExposures(key, texts) {
  const forms = [key, Buffer.from(key, "base64").toString("hex")];
  return Object.entries(texts).filter(([, t]) => forms.some((f) => t.includes(f))).map(([name]) => name);
}

/**
 * The approved rebuild comparison: the offline build step ran, the normalized
 * file lists are equal, and the labels are equal. Content differences are
 * reported for investigation.
 */
export function rebuildVerdict({ offline, listA, listB, labelsA, labelsB }) {
  const b = new Set(listB);
  const a = new Set(listA);
  const onlyInCandidate = listA.filter((f) => !b.has(f));
  const onlyInRebuild = listB.filter((f) => !a.has(f));
  const labelDifferences = Object.keys({ ...labelsA, ...labelsB }).filter((k) => labelsA[k] !== labelsB[k]);
  return { ok: offline === true && onlyInCandidate.length === 0 && onlyInRebuild.length === 0 && labelDifferences.length === 0, onlyInCandidate, onlyInRebuild, labelDifferences };
}

/** Normalizes an image's file list for comparison: the build ID and long hashes become placeholders. */
export function normalizeFileList(files, buildId) {
  return files.map((f) => (buildId ? f.split(buildId).join("<build-id>") : f).replace(/[0-9a-f]{16,}|[A-Za-z0-9_-]{20,}(?=\.)/g, "<hash>"));
}

// ------------------------------------------------- byte-level rebuild comparison ----
// Two builds of one commit with the same key must be byte-identical, except for
// values Next.js generates at random on every build with no setting to fix them.
// These rules were established for exactly Next.js NEXT_VERSION by tracing each
// difference to its source; another version fails until they're reviewed again.
export const NEXT_VERSION = "16.4.3";

// Docker writes these into every container when it starts; they aren't image content.
export const RUNTIME_FILES = new Set(["/etc/hostname", "/etc/hosts", "/etc/resolv.conf"]);

const DRAFT_MODE_FIELDS = { previewModeId: /^[0-9a-f]{32}$/, previewModeSigningKey: /^[0-9a-f]{64}$/, previewModeEncryptionKey: /^[0-9a-f]{64}$/ };

/**
 * The only files allowed to differ, each with the one normalization it gets:
 * - draft-mode keys (crypto.randomBytes in next/dist/build/preview-key-utils.js),
 *   in preview-props.json and in prerender-manifest.json's "preview" object;
 * - one fallback route-parameter placeholder %%drp:<param>:<id>%% (Math.random in
 *   next/dist/server/request/fallback-params.js) in each of four prerendered
 *   segments, where <param> is that route's own dynamic segment;
 * - in the [handle] segment only, the static-stage byte length the Flight stream
 *   records in its final row (staticStageByteLength, "l", in
 *   next/dist/server/app-render/app-render.js). It counts the bytes before the
 *   trailing completion rows, so it shifts with the placeholder's length; it's
 *   recomputed independently from the file's own bytes, never trusted.
 */
export const KNOWN_DIFFERENCES = {
  "/app/.next/server/preview-props.json": { kind: "draft-mode-json", at: [] },
  "/app/.next/prerender-manifest.json": { kind: "draft-mode-json", at: ["preview"] },
  "/app/.next/server/app/[handle].segments/_full.segment.rsc": { kind: "fallback-param", param: "handle", count: 1, stageOffset: true },
  "/app/.next/server/app/admin/users/[id].segments/_full.segment.rsc": { kind: "fallback-param", param: "id", count: 1, stageOffset: false },
  "/app/.next/server/app/dashboard/profiles/[id].segments/_full.segment.rsc": { kind: "fallback-param", param: "id", count: 1, stageOffset: false },
  "/app/.next/server/app/dashboard/profiles/[id]/analytics.segments/_full.segment.rsc": { kind: "fallback-param", param: "id", count: 1, stageOffset: false },
};

/**
 * The static-stage byte-length row of a Flight segment, checked against the
 * file's own bytes. The file must end with a newline, and its last row must be
 * "<row>:<n>": <row> a lowercase hex row ID used by no other row, <n> a decimal
 * with no leading zero. Immediately before it must come the trailing completion
 * block, exactly one "<id>:true" row followed by one or more "<id>:C" rows, and
 * <n> must equal the byte offset at which that block starts, computed here from
 * the bytes. Returns { row, offset, start }, where start is the final row's own
 * byte offset; throws for a missing, duplicate, moved, malformed or wrong offset.
 */
export function stageOffsetRow(text) {
  if (!text.endsWith("\n")) throw new Error("the segment doesn't end with a newline");
  const lines = text.slice(0, -1).split("\n");
  const offsets = [];
  let at = 0;
  for (const l of lines) { offsets.push(at); at += l.length + 1; }
  const last = lines.length - 1;
  const m = /^([0-9a-f]+):(0|[1-9][0-9]*)$/.exec(lines[last]);
  if (!m) throw new Error("the final row isn't a static-stage offset row");
  const [, row, value] = m;
  const rowIds = lines.map((l) => /^([0-9a-f]+):/.exec(l)?.[1]).filter(Boolean);
  if (rowIds.filter((id) => id === row).length !== 1) throw new Error(`row ${row} appears more than once`);
  let i = last - 1;
  while (i >= 0 && /^[0-9a-f]+:C$/.test(lines[i])) i--;
  if (i === last - 1) throw new Error("no completion rows before the static-stage offset");
  if (i < 0 || !/^[0-9a-f]+:true$/.test(lines[i])) throw new Error("the completion block doesn't start with one true row");
  if (i > 0 && /^[0-9a-f]+:true$/.test(lines[i - 1])) throw new Error("the completion block starts with more than one true row");
  const computed = offsets[i];
  if (Number(value) !== computed) throw new Error(`the recorded static-stage offset ${value} isn't the computed ${computed}`);
  return { row, offset: computed, start: offsets[last] };
}

/** True if the final row of a segment is "<row>:<n>" with n the byte offset of a row start: an offset row where none is expected. */
function hasStageOffsetRow(text) {
  try { stageOffsetRow(text); return true; } catch { /* not a valid offset row */ }
  const lines = text.replace(/\n$/, "").split("\n");
  const m = /^[0-9a-f]+:(0|[1-9][0-9]*)$/.exec(lines.at(-1) ?? "");
  if (!m) return false;
  let at = 0;
  return lines.slice(0, -1).some((l) => { const hit = at === Number(m[1]); at += l.length + 1; return hit; });
}

/**
 * Draft-mode JSON: parsed and validated; the object at `at` must hold exactly the
 * three draft-mode fields, each in its expected format. Only those three values
 * are replaced, in the raw bytes, and each must occur exactly once there.
 */
export function normalizeDraftModeJson(buf, at) {
  const text = buf.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buf)) throw new Error("not valid UTF-8");
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error("not valid JSON"); }
  let obj = doc;
  for (const k of at) obj = obj && typeof obj === "object" && !Array.isArray(obj) ? obj[k] : undefined;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`no draft-mode object at ${at.join(".") || "the top level"}`);
  const keys = Object.keys(obj).sort();
  const want = Object.keys(DRAFT_MODE_FIELDS).sort();
  if (keys.join(",") !== want.join(",")) throw new Error(`draft-mode object has fields ${keys.join(", ")}, not exactly ${want.join(", ")}`);
  let out = text;
  for (const [field, format] of Object.entries(DRAFT_MODE_FIELDS)) {
    const value = obj[field];
    if (typeof value !== "string" || !format.test(value)) throw new Error(`${field} isn't in its expected format`);
    const quoted = JSON.stringify(value);
    if (out.split(quoted).length !== 2) throw new Error(`${field}'s value doesn't occur exactly once`);
    out = out.replace(quoted, `"<${field}>"`);
  }
  return out;
}

/**
 * Fallback-parameter placeholders: the file must hold exactly "count" %%drp:...%%
 * tokens, each %%drp:<param>:<id>%% with <id> lowercase hex of 1 to 16 characters
 * and one <id> per file. With stageOffset, the final row must be a static-stage
 * offset row that matches the file's own bytes (stageOffsetRow); without it, the
 * file must have no such row. Only the tokens and that one offset value are
 * replaced; every other byte, including the offset row's ID, is kept.
 */
export function normalizeFallbackParams(buf, param, count, stageOffset = false) {
  const text = buf.toString("latin1");
  const tokens = [...text.matchAll(/%%drp:[^%]*%%/g)].map((m) => m[0]);
  if (!Number.isInteger(count) || count < 1) throw new Error("no expected token count");
  if (tokens.length !== count) throw new Error(`${tokens.length} fallback-parameter tokens, not ${count}`);
  const exact = new RegExp(`^%%drp:${param}:([0-9a-f]{1,16})%%$`);
  const ids = new Set();
  for (const t of tokens) {
    const m = exact.exec(t);
    if (!m) throw new Error(`unexpected token ${JSON.stringify(t.slice(0, 40))}`);
    ids.add(m[1]);
  }
  if (ids.size !== 1) throw new Error("tokens in one file use more than one id");
  if (/%%drp:/.test(text.replace(/%%drp:[^%]*%%/g, ""))) throw new Error("a malformed fallback-parameter token");
  let body = text;
  if (stageOffset) {
    const r = stageOffsetRow(text);
    body = `${text.slice(0, r.start)}${r.row}:<static-stage-offset>\n`;
  } else if (hasStageOffsetRow(text)) {
    throw new Error("an unexpected static-stage offset row");
  }
  return body.split(tokens[0]).join(`%%drp:${param}:<id>%%`);
}

/**
 * The byte-level comparison. hashesA/hashesB map path -> sha256 for every file in
 * each image; contents maps each differing known path to { a, b } buffers;
 * nextVersions are the Next.js versions installed in each image. Fails closed:
 * on another Next.js version, on any path present in only one image, on any
 * differing path outside KNOWN_DIFFERENCES, on any known path that doesn't
 * differ, and on any byte that still differs after normalization.
 */
export function contentVerdict({ hashesA, hashesB, contents, nextVersions }) {
  const problems = [];
  for (const [which, v] of Object.entries(nextVersions)) {
    if (v !== NEXT_VERSION) problems.push(`the ${which} has Next.js ${v || "(unknown)"}; the known differences were reviewed for ${NEXT_VERSION} only`);
  }
  const paths = (m) => [...m.keys()].filter((p) => !RUNTIME_FILES.has(p));
  const onlyA = paths(hashesA).filter((p) => !hashesB.has(p));
  const onlyB = paths(hashesB).filter((p) => !hashesA.has(p));
  for (const p of onlyA) problems.push(`only in the candidate: ${p}`);
  for (const p of onlyB) problems.push(`only in the rebuild: ${p}`);
  const differing = paths(hashesA).filter((p) => hashesB.has(p) && hashesA.get(p) !== hashesB.get(p)).sort();
  const known = Object.keys(KNOWN_DIFFERENCES).sort();
  for (const p of differing) if (!(p in KNOWN_DIFFERENCES)) problems.push(`unexpected difference: ${p}`);
  for (const p of known) if (!differing.includes(p)) problems.push(`expected difference missing: ${p}`);
  for (const p of differing.filter((x) => x in KNOWN_DIFFERENCES)) {
    const rule = KNOWN_DIFFERENCES[p];
    const c = contents?.[p];
    if (!c || !Buffer.isBuffer(c.a) || !Buffer.isBuffer(c.b)) { problems.push(`contents not read: ${p}`); continue; }
    try {
      const norm = (buf) => (rule.kind === "draft-mode-json" ? normalizeDraftModeJson(buf, rule.at) : normalizeFallbackParams(buf, rule.param, rule.count, rule.stageOffset === true));
      if (norm(c.a) !== norm(c.b)) problems.push(`differs beyond its known values: ${p}`);
    } catch (err) {
      problems.push(`${p}: ${err.message}`);
    }
  }
  return { ok: problems.length === 0, problems, differing };
}

// ---------------------------------------------------------------- toolchain ----
/**
 * The pinned build toolchain was the one in effect. pins: DOCKERFILE_FRONTEND and
 * BUILDKIT_IMAGE from release/config.env. Checks web/Dockerfile's first line, the
 * builder's reported BuildKit version, the frontend recorded in the candidate's
 * provenance (request source and resolved dependency), and the frontend the
 * comparison rebuild resolved. Any mismatch or missing value fails.
 */
export function toolchainVerdict({ pins, dockerfileFirstLine, builderVersion, provenance, rebuildLog }) {
  const problems = [];
  const frontend = pins?.DOCKERFILE_FRONTEND ?? "";
  const fm = /^([a-z0-9./-]+):([0-9][0-9A-Za-z.-]*)@sha256:([0-9a-f]{64})$/.exec(frontend);
  const bm = /^moby\/buildkit:(v[0-9]+\.[0-9]+\.[0-9]+)@sha256:[0-9a-f]{64}$/.exec(pins?.BUILDKIT_IMAGE ?? "");
  if (!fm) problems.push("DOCKERFILE_FRONTEND isn't a pinned image reference");
  if (!bm) problems.push("BUILDKIT_IMAGE isn't a pinned moby/buildkit release");
  if (!fm || !bm) return { ok: false, problems };
  const [, frontendName, frontendVersion, frontendDigest] = fm;
  if (dockerfileFirstLine !== `# syntax=${frontend}`) problems.push("web/Dockerfile's first line isn't the pinned syntax directive");
  if (builderVersion !== bm[1]) problems.push(`the builder runs BuildKit ${builderVersion || "(unknown)"}, not ${bm[1]}`);
  const slsa = provenance?.SLSA ?? provenance?.["linux/amd64"]?.SLSA;
  const source = slsa?.buildDefinition?.externalParameters?.request?.args?.source;
  if (source !== frontend) problems.push("the candidate's provenance doesn't name the pinned frontend as its source");
  const deps = slsa?.buildDefinition?.resolvedDependencies ?? [];
  const resolved = deps.filter((d) => typeof d?.uri === "string" && d.uri.startsWith(`pkg:docker/${frontendName}@`));
  if (resolved.length === 0) problems.push("the candidate's provenance resolved no Dockerfile frontend");
  for (const d of resolved) {
    if (d.digest?.sha256 !== frontendDigest || !d.uri.startsWith(`pkg:docker/${frontendName}@${frontendVersion}?digest=sha256:${frontendDigest}`)) problems.push(`the candidate resolved another frontend: ${d.uri}`);
  }
  const loaded = [...String(rebuildLog ?? "").matchAll(/resolve image config for docker-image:\/\/(?:docker\.io\/)?(\S+)/g)].map((m) => m[1]).filter((r) => r.startsWith(`${frontendName}:`) || r.startsWith(`${frontendName}@`));
  if (loaded.length === 0) problems.push("the comparison rebuild didn't resolve the pinned frontend");
  for (const r of loaded) if (r !== frontend) problems.push(`the comparison rebuild resolved another frontend: ${r}`);
  return { ok: problems.length === 0, problems };
}

/** BuildKit's version as `docker buildx inspect` reports it. */
export function builderVersionFrom(inspectOutput) {
  return /^BuildKit version:\s*(\S+)\s*$/m.exec(String(inspectOutput ?? ""))?.[1] ?? "";
}

// ------------------------------------------------- Alpine security update ----
/**
 * The Dockerfile's stage graph, checked fail closed. Comment lines are dropped
 * and continuation lines joined, as Docker does. Then:
 * - every FROM must be "FROM [--platform=<p>] <base> AS <name>", with a name;
 * - the first stage must be exactly "FROM ${NODE_IMAGE} AS patched-base";
 * - every later stage must name, as its base, a stage declared before it, so it
 *   descends from patched-base; an external image, ${NODE_IMAGE}, scratch, a
 *   stage index, an unknown or later stage (which a cycle would need) all fail;
 * - stage names must be unique (Docker compares them without case);
 * - COPY --from= and RUN --mount=...,from= may name only those stages;
 * - the last stage, the one that ships, must be "runtime".
 * Returns the problems found; an empty list means the graph is sound.
 */
export function stageGraphProblems(dockerfileText) {
  const problems = [];
  const lines = String(dockerfileText ?? "").split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  const instructions = lines.join("\n").replace(/\\\r?\n/g, " ").split("\n").map((l) => l.trim()).filter(Boolean);
  const stages = [];
  const declared = new Set(); // every stage name seen so far, for duplicate detection
  const descends = new Set(); // only stages proven to descend from patched-base
  for (const ins of instructions) {
    if (/^FROM\b/i.test(ins)) {
      const m = /^FROM\s+(?:--platform=\S+\s+)?(\S+)\s+AS\s+([A-Za-z][A-Za-z0-9_.-]*)$/i.exec(ins);
      if (!m) { problems.push(`malformed or unnamed FROM: ${ins.slice(0, 80)}`); stages.push({ name: null }); continue; }
      const base = m[1];
      const name = m[2].toLowerCase();
      let ok = true;
      if (declared.has(name)) { problems.push(`duplicate stage name: ${name}`); ok = false; }
      if (stages.length === 0) {
        if (base !== "${NODE_IMAGE}" || name !== "patched-base") { problems.push("the first stage must be FROM ${NODE_IMAGE} AS patched-base"); ok = false; }
      } else if (!descends.has(base.toLowerCase())) {
        const b = base.toLowerCase();
        const why = base === "${NODE_IMAGE}" ? "the unpatched base image"
          : b === "scratch" ? "scratch"
          : /^\d+$/.test(base) ? "a stage index"
          : declared.has(b) ? "a stage that doesn't descend from patched-base"
          : "an image or a stage not declared before it";
        problems.push(`stage ${name} builds on ${why} (${base}), not on a stage that descends from patched-base`);
        ok = false;
      }
      stages.push({ base, name });
      declared.add(name);
      if (ok) descends.add(name);
      continue;
    }
    // Files may only come from stages that descend from patched-base, never straight from an image.
    for (const ref of [...ins.matchAll(/--from=([^\s,]+)/g), ...ins.matchAll(/--mount=\S*?\bfrom=([^\s,]+)/g)].map((x) => x[1])) {
      if (!descends.has(ref.toLowerCase())) problems.push(`files come from ${ref}, which isn't a stage descending from patched-base declared before that instruction`);
    }
  }
  if (stages.length === 0) problems.push("no FROM instructions");
  if (!descends.has("patched-base")) problems.push("no valid patched-base stage");
  if (stages.length > 0 && stages.at(-1).name !== "runtime") problems.push("the last stage, the one that ships, isn't runtime");
  return problems;
}

/**
 * The temporary zlib update on top of the pinned base image (web/Dockerfile,
 * stage "patched-base"). pins: ALPINE_ZLIB_VERSION and ALPINE_ZLIB_FIXES from
 * release/config.env. Fails closed unless:
 * - the Dockerfile builds every later stage on patched-base, installs exactly
 *   zlib=<version> once, and never bypasses apk's signature checks;
 * - the image's installed zlib is exactly <version>;
 * - the attached SBOM lists zlib at exactly <version> and no other version;
 * - the vulnerability scan reports no finding for zlib at all;
 * - the exceptions file holds no exception for zlib or for the fixed CVE.
 */
export function securityUpdateVerdict({ pins, dockerfileText, installedVersion, sbomZlibVersions, scanMatches, exceptions }) {
  const problems = [];
  const version = pins?.ALPINE_ZLIB_VERSION ?? "";
  const fixes = (pins?.ALPINE_ZLIB_FIXES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!/^[0-9][0-9a-z.]*-r[0-9]+$/.test(version)) problems.push("ALPINE_ZLIB_VERSION isn't an exact Alpine package version");
  if (fixes.length === 0 || fixes.some((id) => !/^CVE-\d{4}-\d{4,}$/.test(id))) problems.push("ALPINE_ZLIB_FIXES doesn't name the CVEs the update fixes");
  if (problems.length) return { ok: false, problems };

  // Instructions only: comment lines (which may name the flags that aren't used) are dropped.
  const text = String(dockerfileText ?? "").split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
  // Exactly one zlib install, in exactly this form: no package cache, and no
  // write to /var/log/apk.log (a timestamped line there would make builds differ).
  const installs = text.match(/apk add(?: --?[a-z-]+(?:=\S+)?)* zlib(?:=\S+)?/g) ?? [];
  const wanted = `apk add --no-cache --no-logfile zlib=${version}`;
  if (installs.length !== 1 || installs[0] !== wanted) problems.push(`web/Dockerfile doesn't install exactly zlib=${version} once, as "${wanted}"`);
  if (/--allow-untrusted|--force\b|--force-|--no-verify/.test(text)) problems.push("web/Dockerfile bypasses apk's signature checks");
  problems.push(...stageGraphProblems(dockerfileText));

  if (installedVersion !== version) problems.push(`the image's installed zlib is ${installedVersion || "(missing)"}, not ${version}`);
  const sbom = [...new Set(sbomZlibVersions ?? [])];
  if (sbom.length !== 1 || sbom[0] !== version) problems.push(`the SBOM lists zlib ${sbom.join(", ") || "(none)"}, not exactly ${version}`);
  if (!Array.isArray(scanMatches)) problems.push("no vulnerability scan results");
  else {
    const zlib = scanMatches.filter((m) => m?.artifact?.name === "zlib");
    for (const m of zlib) problems.push(`the scan still reports zlib ${m.artifact.version}: ${m.vulnerability?.id}`);
    for (const id of fixes) if (scanMatches.some((m) => m?.vulnerability?.id === id)) problems.push(`the scan still reports ${id}`);
  }
  if (!Array.isArray(exceptions)) problems.push("the exceptions list is unreadable");
  else for (const e of exceptions) if (e?.package === "zlib" || fixes.includes(e?.id)) problems.push(`an exception covers ${e?.package ?? "?"} ${e?.id ?? "?"}`);
  return { ok: problems.length === 0, problems };
}
