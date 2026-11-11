// Derives the component license and copyright notices from a source bundle:
// the license files shipped in each component's own upstream source. Run it
// inside the pinned base image, which provides tar:
//
//   node extract-notices.mjs <bundle dir> <output json> [--check]
//
// For every Alpine source package and every sharp-libvips source archive, it
// reads files named LICENSE, LICENCE, COPYING, NOTICE or COPYRIGHT (with any
// suffix) at the archive's top level, files in a top-level LICENSES folder, and
// the few deeper paths a top-level license points to (REFERENCED below). It
// also keeps the notices file sharp-libvips publishes for its build.
// For every vendored Rust crate, it reads the same names at the crate's root.
// A component without such a file is recorded as having none; nothing is added
// by hand. Identical texts are stored once. --check regenerates in memory and
// exits 1 if the result differs from <output json>.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const [bundle, output, flag] = process.argv.slice(2);
if (!bundle || !output) throw new Error("usage: extract-notices.mjs <bundle dir> <output json> [--check]");
const at = (p) => join(bundle, ...p.split("/"));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const LICENSE_NAME = /^(licen[cs]e|copying|notice|copyright)([.\-_].*)?$/i;
const ARCHIVE = /\.(tar\.(gz|xz|bz2)|tgz|tbz2|txz)$/;
const texts = new Map();

function addText(buf) {
  const id = sha256(buf);
  if (!texts.has(id)) {
    const utf8 = buf.toString("utf8");
    texts.set(id, utf8.includes("�") ? buf.toString("latin1") : utf8);
  }
  return id;
}

// License texts that a component's top-level license file points to elsewhere
// in its archive, by project name. Each listed path must exist, or extraction fails.
const REFERENCED = {
  freetype: ["docs/FTL.TXT", "docs/GPLv2.TXT"],
  mozjpeg: ["README.ijg"],
};

// License files at an archive's top level (or in a top-level LICENSES folder),
// plus any REFERENCED paths for the project.
function archiveLicenses(path, project = "") {
  const members = execFileSync("tar", ["tf", path], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\n").filter(Boolean);
  const inner = (m) => m.split("/").filter((p) => p !== ".").slice(1).join("/");
  const extra = REFERENCED[project] ?? [];
  for (const want of extra) if (!members.some((m) => inner(m) === want)) throw new Error(`${path}: expected ${want}, which its license refers to`);
  const picked = members.filter((m) => {
    const parts = m.replace(/\/$/, "").split("/").filter((p) => p !== ".");
    if (m.endsWith("/")) return false;
    if (extra.includes(inner(m))) return true;
    if (parts.length === 2) return LICENSE_NAME.test(parts[1]);
    if (parts.length === 3) return /^LICENSES$/i.test(parts[1]);
    return false;
  }).sort();
  return picked.map((m) => {
    const buf = execFileSync("tar", ["xOf", path, m], { maxBuffer: 1 << 28 });
    return { file: m.split("/").slice(1).join("/"), sha256: sha256(buf), text: addText(buf) };
  });
}

// A readable name and version from a download URL: the repository and ref of a
// GitHub or GitLab archive link, otherwise "<name>-<version>" in the file name.
function projectOf(url) {
  const forge = /^https:\/\/(?:github\.com|gitlab\.[^/]+)\/[^/]+\/([^/]+)\/(?:-\/)?archive\/(?:[^/]+\/)?([^/]+?)(?:\.tar\.(?:gz|xz|bz2)|\.tgz)$/.exec(url);
  if (forge) return { name: forge[1], version: forge[2].startsWith(`${forge[1]}-`) ? forge[2].slice(forge[1].length + 1) : forge[2] };
  const file = url.split("/").pop().replace(ARCHIVE, "");
  const m = /^(.+?)-(v?\d.*)$/.exec(file);
  return m ? { name: m[1], version: m[2] } : { name: file, version: "" };
}

const manifest = JSON.parse(readFileSync(at("MANIFEST.json"), "utf8"));
const components = [];

for (const c of manifest.components.filter((x) => x.type === "alpine")) {
  const archives = c.files.filter((f) => f.path.includes("/distfiles/") && ARCHIVE.test(f.path));
  const sources = archives.map((f) => ({ source: f.path, licenses: archiveLicenses(at(f.path)) }));
  components.push({
    kind: "alpine-package",
    name: c.origin,
    version: c.version,
    packages: c.packages.map((p) => p.name),
    declared_license: [...new Set(c.packages.map((p) => p.license))].join(" / "),
    sources: sources.filter((s) => s.licenses.length),
    note: sources.some((s) => s.licenses.length) ? undefined : "No license file in the upstream source; see the declared license.",
  });
}

const sl = manifest.components.find((x) => x.type === "sharp-libvips");
// The notices file sharp-libvips publishes for its own build, kept whole.
for (const s of sl.sources.filter((x) => /THIRD-PARTY-NOTICES\.md$/.test(x.path))) {
  const buf = readFileSync(at(s.path));
  components.push({
    kind: "libvips-build-notices",
    name: "sharp-libvips",
    version: sl.version,
    url: s.url,
    sources: [{ source: s.path, licenses: [{ file: s.path.split("/").pop(), sha256: sha256(buf), text: addText(buf) }] }],
  });
}
for (const s of sl.sources.filter((x) => ARCHIVE.test(x.path))) {
  const project = projectOf(s.url);
  const licenses = archiveLicenses(at(s.path), project.name);
  components.push({
    kind: "libvips-component",
    ...project,
    url: s.url,
    sources: licenses.length ? [{ source: s.path, licenses }] : [],
    note: licenses.length ? undefined : "No license file at the top level of the upstream archive.",
  });
}

const rust = manifest.components.find((x) => x.type === "rust-crates");
for (const c of rust.crates) {
  const dir = at(`${rust.vendor_dir}/${c.name}-${c.version}`);
  const files = existsSync(dir) ? readdirSync(dir).filter((n) => LICENSE_NAME.test(n) && statSync(join(dir, n)).isFile()).sort() : [];
  const licenses = files.map((n) => { const buf = readFileSync(join(dir, n)); return { file: n, sha256: sha256(buf), text: addText(buf) }; });
  let declared = "";
  try { declared = (/^license\s*=\s*"([^"]*)"/m.exec(readFileSync(join(dir, "Cargo.toml"), "utf8")) ?? [])[1] ?? ""; } catch { /* no Cargo.toml */ }
  components.push({
    kind: "rust-crate",
    name: c.name,
    version: c.version,
    declared_license: declared,
    sources: licenses.length ? [{ source: `${rust.vendor_dir}/${c.name}-${c.version}`, licenses }] : [],
    note: licenses.length ? undefined : "No license file in the crate; see the declared license.",
  });
}

const result = {
  format: "covalink-component-notices/1",
  description: "License and copyright files from the upstream source of each component the COVALink container image ships in binary form, extracted from the source bundle by release/source-bundle/extract-notices.mjs. Generated; do not edit.",
  bundle_manifest_sha256: sha256(readFileSync(at("MANIFEST.json"))),
  components,
  texts: Object.fromEntries([...texts.entries()].sort(([a], [b]) => a.localeCompare(b))),
};
const json = `${JSON.stringify(result, null, 1)}\n`;
if (flag === "--check") {
  const current = existsSync(output) ? readFileSync(output, "utf8") : "";
  if (current !== json) { console.log(`FAIL ${output} doesn't match the notices extracted from this bundle`); process.exitCode = 1; }
  else console.log(`ok ${output} matches the notices extracted from this bundle`);
} else {
  writeFileSync(output, json);
  const without = components.filter((c) => c.sources.length === 0).length;
  console.log(`wrote ${output}: ${components.length} components (${without} without a license file), ${texts.size} distinct texts`);
}
