// Generates THIRD_PARTY_NOTICES.txt: the license declarations and notice texts
// collected for the third-party software in the COVALink container image, and
// for the source code copied into this repository. License and copyright files
// from the upstream source of the base image's Alpine packages, sharp's libvips
// components and their Rust crates come from third-party/component-notices.json,
// which release/source-bundle/extract-notices.mjs generates from the
// corresponding-source bundle. It over-includes rather than miss bundled code:
// every production npm package for Linux on amd64 and arm64, the packages
// Next.js vendors, the base image's Alpine packages, Node.js, and copied code.
//
// Run it inside the image's patched base (web/Dockerfile stage "patched-base":
// NODE_IMAGE plus the temporary Alpine security update, built by
// release/patched-base.sh), so the Alpine package database and Node.js version
// are the image's own, after an
// `npm ci` for each architecture. docs/DEVELOPMENT.md ("Third-party notices")
// has the exact commands. Dependency-free; it never contacts the network.
//
//   node scripts/third-party-notices.mjs --modules <dir> [--modules <dir> ...]
//     [--apk-db /lib/apk/db/installed] [--out THIRD_PARTY_NOTICES.txt] [--check]
//
// --check compares with the existing file and exits 1 if it differs. Any
// production package without a license source is an error, never a gap.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright)([.\-_].*)?$/i;
const ARCHES = ["x64", "arm64"];

function args(argv) {
  const out = { modules: [], apkDb: "/lib/apk/db/installed", out: join(WEB, "THIRD_PARTY_NOTICES.txt"), check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--modules") out.modules.push(argv[++i]);
    else if (a === "--apk-db") out.apkDb = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--check") out.check = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.modules.length === 0) throw new Error("at least one --modules directory is required");
  return out;
}

/** Line endings normalized, trailing whitespace removed, one final newline. */
function clean(text) {
  return text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\n+$/, "") + "\n";
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function loadSources() {
  const sources = JSON.parse(readFileSync(join(WEB, "third-party", "sources.json"), "utf8"));
  const verify = (label, entry) => {
    if (sha256(entry.text) !== entry.sha256) throw new Error(`${label}: text doesn't match its recorded sha256`);
  };
  for (const [id, entry] of Object.entries(sources.spdx)) verify(`spdx ${id}`, entry);
  verify("node", sources.node);
  for (const entry of sources.copied) verify(`copied ${entry.name}`, entry);
  return sources;
}

/**
 * Component notices extracted from the corresponding-source bundle by
 * release/source-bundle/extract-notices.mjs. Each text's id is its sha256,
 * which is checked here; the file is generated and never edited by hand.
 */
function loadComponentNotices() {
  const file = join(WEB, "third-party", "component-notices.json");
  const notices = JSON.parse(readFileSync(file, "utf8"));
  if (notices.format !== "covalink-component-notices/1") throw new Error("component-notices.json: unknown format");
  if (!/^[0-9a-f]{64}$/.test(notices.bundle_manifest_sha256 ?? "")) throw new Error("component-notices.json: bundle manifest sha256 missing");
  for (const [id, text] of Object.entries(notices.texts)) {
    if (createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex") !== id && createHash("sha256").update(Buffer.from(text, "latin1")).digest("hex") !== id) throw new Error(`component-notices.json: text ${id} doesn't match its id`);
  }
  for (const c of notices.components) for (const s of c.sources) for (const l of s.licenses) if (!(l.text in notices.texts)) throw new Error(`component-notices.json: ${c.name} refers to a missing text`);
  return notices;
}

function licenseFiles(dir) {
  return readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name) && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: clean(readFileSync(join(dir, name), "utf8")) }));
}

function spdxIds(expression) {
  // "/" is the legacy Cargo spelling of OR (for example "MIT/Apache-2.0").
  return [...new Set((expression ?? "").replace(/[()/]/g, " ").split(/\s+/).filter((t) => t && !/^(AND|OR|WITH)$/.test(t)))];
}

function fitsImage(entry) {
  if (entry.os && !entry.os.includes("linux")) return false;
  if (entry.cpu && !entry.cpu.some((c) => ARCHES.includes(c))) return false;
  if (entry.libc && !entry.libc.includes("musl")) return false;
  return true;
}

function npmPackages(roots) {
  const lock = JSON.parse(readFileSync(join(WEB, "package-lock.json"), "utf8"));
  const found = new Map();
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key.startsWith("node_modules/") || entry.dev || !fitsImage(entry)) continue;
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    const id = `${name}@${entry.version}`;
    if (found.has(id)) continue;
    const dir = roots.map((root) => join(root, key.slice("node_modules/".length))).find((d) => existsSync(join(d, "package.json")));
    // An optional package that no Linux install contains belongs to another
    // platform (for example sharp's wasm32 build) and isn't in the image.
    if (!dir && entry.optional) continue;
    if (!dir) throw new Error(`${id} isn't installed in any --modules directory`);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (pkg.version !== entry.version) throw new Error(`${id}: installed version is ${pkg.version}`);
    const extra = name.startsWith("@img/sharp-libvips-") ? libvipsNotice(dir) : [];
    found.set(id, { name, version: entry.version, license: entry.license ?? pkg.license ?? "", files: [...licenseFiles(dir), ...extra] });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** sharp-libvips packages carry their component licenses in the README's "Licensing" section. */
function libvipsNotice(dir) {
  const readme = clean(readFileSync(join(dir, "README.md"), "utf8"));
  const start = readme.indexOf("## Licensing");
  if (start < 0) throw new Error(`${dir}: README.md has no Licensing section`);
  return [{ name: "README.md (Licensing section)", text: readme.slice(start) }];
}

function vendoredPackages(roots) {
  const compiled = roots.map((r) => join(r, "next", "dist", "compiled")).find(existsSync);
  if (!compiled) throw new Error("next/dist/compiled not found");
  const found = new Map();
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { visit(full); continue; }
      if (name !== "package.json") continue;
      const pkg = JSON.parse(readFileSync(full, "utf8"));
      if (!pkg.name) continue;
      const id = `${pkg.name}@${pkg.version ?? ""}`;
      const files = licenseFiles(dir);
      const seen = found.get(id);
      if (!seen || (seen.files.length === 0 && files.length > 0)) found.set(id, { name: pkg.name, version: pkg.version ?? "", license: typeof pkg.license === "string" ? pkg.license : "", files });
    }
  };
  visit(compiled);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function apkPackages(path) {
  return readFileSync(path, "utf8").split(/\n\n+/).map((block) => {
    const field = (k) => (block.match(new RegExp(`^${k}:(.*)$`, "m")) ?? [])[1] ?? "";
    return { name: field("P"), version: field("V"), license: field("L"), origin: field("o"), commit: field("c") };
  }).filter((p) => p.name).sort((a, b) => a.name.localeCompare(b.name));
}

function render(sources, npm, vendored, apk, components) {
  const needed = new Set();
  const out = [];
  const rule = (title) => out.push("", "=".repeat(78), title, "=".repeat(78), "");
  if (npm.some((p) => p.name.startsWith("@img/sharp-libvips-"))) for (const id of sources.libvipsComponents.licenses) needed.add(id);
  const entry = (title, license, files) => {
    out.push("-".repeat(78), title, `Declared license: ${license || "(none declared)"}`, "-".repeat(78));
    if (files.length === 0) {
      for (const id of spdxIds(license)) needed.add(id);
      out.push("No license file is included; the standard text of the declared license is in", "section 8.", "");
    }
    for (const file of files) out.push(`[${file.name}]`, "", file.text);
  };

  out.push("COVALink third-party notices", "============================", "",
    "Generated by web/scripts/third-party-notices.mjs. Do not edit by hand.", "",
    "COVALink itself is licensed under the Apache License, Version 2.0 (LICENSE and",
    "NOTICE). This file contains the license declarations and notice texts",
    "collected for the COVALink container image and this source snapshot: the",
    "license files of every production npm package for Linux on amd64 and arm64",
    "and of the packages Next.js vendors, the declared licenses of the base",
    "image's Alpine Linux packages, the license and copyright files from the",
    "upstream source of the components listed in section 5, Node.js's license,",
    "the source code copied into this repository, and the standard texts of the",
    "declared licenses.", "",
    "Section 5 covers these components, and only these: the Alpine Linux source",
    "packages of the base image, the source archives sharp's prebuilt libvips",
    "library is built from, and the Rust crates resolved for that build. Their",
    "texts are extracted from the corresponding-source bundle by",
    "release/source-bundle/extract-notices.mjs (bundle MANIFEST.json sha256",
    `${components.bundle_manifest_sha256}).`,
    "The prebuilt libvips library resolved its Rust crates when it was built, so",
    "the crate list repeats that resolution and isn't a verified record of the",
    "crates inside the shipped library. web/CORRESPONDING_SOURCE.md says how to",
    "retrieve the bundle.", "",
    "Contents",
    "  1. Source code copied into this repository",
    `  2. npm packages (${npm.length})`,
    `  3. Packages vendored by Next.js (${vendored.length})`,
    `  4. Alpine Linux packages of the base image (${apk.length})`,
    `  5. Component notices from the corresponding source (${components.components.length})`,
    `  6. Component license and copyright texts (${Object.keys(components.texts).length})`,
    `  7. Node.js ${sources.node.version}`,
    "  8. Standard license texts");

  rule("1. Source code copied into this repository");
  for (const c of sources.copied) entry(`${c.name} (${c.paths.join(", ")})`, c.license, [{ name: c.file, text: clean(c.text) }]);
  rule("2. npm packages");
  for (const p of npm) entry(`${p.name} ${p.version}`, p.license, p.files);
  rule("3. Packages vendored by Next.js (next/dist/compiled)");
  for (const p of vendored) entry(p.version ? `${p.name} ${p.version}` : p.name, p.license, p.files);
  rule("4. Alpine Linux packages of the base image");
  out.push("The base image is node:" + sources.node.version.slice(1) + " on Alpine Linux. Each package is listed with",
    "its declared license; the standard license texts are in section 8, the",
    "license files from its source package are in sections 5 and 6, and its",
    "source is in the corresponding-source bundle (web/CORRESPONDING_SOURCE.md).", "");
  for (const p of apk) {
    for (const id of spdxIds(p.license)) needed.add(id);
    out.push(`${p.name} ${p.version}  (${p.license}; source package ${p.origin}, aports commit ${p.commit})`);
  }

  // Texts are numbered in order of first reference, and printed once in section 6.
  const label = new Map();
  for (const c of components.components) for (const s of c.sources) for (const l of s.licenses) if (!label.has(l.text)) label.set(l.text, `T${label.size + 1}`);
  const KIND = { "alpine-package": "Alpine source package", "libvips-build-notices": "sharp-libvips build notices", "libvips-component": "libvips component", "rust-crate": "Rust crate" };
  rule("5. Component notices from the corresponding source");
  out.push("Each component lists the license and copyright files found in its upstream",
    "source, by path in the source bundle, and the section 6 text that holds each.", "");
  for (const c of components.components) {
    out.push(`${KIND[c.kind] ?? c.kind}: ${c.name}${c.version ? ` ${c.version}` : ""}`);
    if (c.url) out.push(`  source: ${c.url}`);
    if (c.declared_license !== undefined) {
      out.push(`  declared license: ${c.declared_license || "(none declared)"}`);
      if (c.sources.length === 0) for (const id of spdxIds(c.declared_license)) needed.add(id);
    }
    for (const s of c.sources) for (const l of s.licenses) out.push(`  ${s.source} : ${l.file} -> ${label.get(l.text)}`);
    if (c.note) out.push(`  ${c.note}${c.declared_license ? " Its standard text is in section 8." : ""}`);
    out.push("");
  }
  rule("6. Component license and copyright texts");
  for (const [id, name] of label) out.push("-".repeat(78), `${name} (sha256 ${id})`, "-".repeat(78), "", clean(components.texts[id]));

  rule(`7. Node.js ${sources.node.version}`);
  out.push(clean(sources.node.text));
  rule("8. Standard license texts");
  for (const id of [...needed].sort()) {
    const text = sources.spdx[id];
    if (!text) throw new Error(`no standard text recorded for ${id} (add it to third-party/sources.json)`);
    out.push("-".repeat(78), `${id}: ${text.name}`, "-".repeat(78), "", clean(text.text));
  }
  return clean(out.join("\n"));
}

function main() {
  const opts = args(process.argv.slice(2));
  const sources = loadSources();
  if (process.version !== sources.node.version) throw new Error(`run with Node.js ${sources.node.version} (the base image), not ${process.version}`);
  const text = render(sources, npmPackages(opts.modules), vendoredPackages(opts.modules), apkPackages(opts.apkDb), loadComponentNotices());
  if (opts.check) {
    const current = existsSync(opts.out) ? readFileSync(opts.out, "utf8") : "";
    if (current !== text) { console.error(`${opts.out} is out of date; regenerate it`); process.exit(1); }
    console.log(`${opts.out} is current (sha256 ${sha256(text)})`);
    return;
  }
  writeFileSync(opts.out, text);
  console.log(`wrote ${opts.out} (sha256 ${sha256(text)})`);
}

main();
