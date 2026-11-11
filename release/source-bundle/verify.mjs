// Checks that a source bundle tree is complete and intact, with no network.
// Run it inside the pinned base image (it uses the image's busybox sh to expand
// the sharp-libvips download list):
//
//   node verify.mjs <bundle dir>
//
// Exit 0 only when every check passes. Output names checks and files only.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, lstatSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const bundle = process.argv[2];
if (!bundle) throw new Error("usage: verify.mjs <bundle dir>");
let failures = 0;
const fail = (msg) => { failures++; console.log(`FAIL ${msg}`); };
const ok = (msg) => console.log(`ok ${msg}`);
const hash = (alg, path) => createHash(alg).update(readFileSync(path)).digest("hex");
const at = (p) => join(bundle, ...p.split("/"));

// 1. SHA256SUMS covers every file exactly once, and every hash matches.
const sums = new Map();
for (const line of readFileSync(at("SHA256SUMS"), "utf8").split("\n").filter(Boolean)) {
  const m = /^([0-9a-f]{64}) [ *]\.\/(.+)$/.exec(line);
  if (!m) { fail("SHA256SUMS has a malformed line"); continue; }
  if (sums.has(m[2])) fail(`SHA256SUMS lists ${m[2]} twice`);
  sums.set(m[2], m[1]);
}
const all = [];
const visit = (d) => {
  for (const n of readdirSync(d)) {
    const f = join(d, n);
    const st = lstatSync(f);
    const r = relative(bundle, f).split(sep).join("/");
    if (st.isDirectory()) visit(f);
    else if (st.isFile()) all.push(r);
    else fail(`not a regular file: ${r}`);
  }
};
visit(bundle);
for (const f of all) {
  if (f === "SHA256SUMS") continue;
  if (!sums.has(f)) fail(`not in SHA256SUMS: ${f}`);
  else if (hash("sha256", at(f)) !== sums.get(f)) fail(`checksum: ${f}`);
}
for (const f of sums.keys()) if (!existsSync(at(f))) fail(`listed but missing: ${f}`);
ok(`SHA256SUMS: ${sums.size} files checked`);

// 2. Every file MANIFEST.json names exists with the recorded SHA-256.
const manifest = JSON.parse(readFileSync(at("MANIFEST.json"), "utf8"));
if (manifest.format !== "covalink-source-bundle/1") fail("MANIFEST.json format");
// The build toolchain pins, each an image reference pinned by digest.
const PINNED = /^[a-z0-9./-]+:[0-9A-Za-z.+-]+@sha256:[0-9a-f]{64}$/;
if (!PINNED.test(manifest.build_toolchain?.dockerfile_frontend ?? "") || !/^moby\/buildkit:v[0-9.]+@sha256:[0-9a-f]{64}$/.test(manifest.build_toolchain?.buildkit ?? "")) {
  fail("MANIFEST.json doesn't record the pinned build toolchain");
} else {
  ok(`build toolchain: ${manifest.build_toolchain.dockerfile_frontend.split("@")[0]}, ${manifest.build_toolchain.buildkit.split("@")[0]}`);
}
let named = 0;
const check = (e) => { named++; if (!existsSync(at(e.path))) fail(`manifest file missing: ${e.path}`); else if (hash("sha256", at(e.path)) !== e.sha256) fail(`manifest checksum: ${e.path}`); };
for (const c of manifest.components) {
  for (const e of c.files ?? []) check(e);
  for (const e of c.sources ?? []) check(e);
  if (c.build_scripts) check(c.build_scripts);
  if (c.lockfile) check(c.lockfile);
}
ok(`MANIFEST.json: ${named} files checked`);

// 3. Alpine: each recipe's version, and every sha512sums entry present and matching.
for (const c of manifest.components.filter((x) => x.type === "alpine")) {
  const dir = `alpine/${c.origin}`;
  const apkbuild = readFileSync(at(`${dir}/aports/APKBUILD`), "utf8");
  const block = /^sha512sums="([\s\S]*?)"/m.exec(apkbuild);
  if (!block) {
    // A recipe with no source line at all (a metapackage) has nothing to fetch.
    // Any recipe that lists sources must also list their checksums.
    if (/^source=/m.test(apkbuild)) fail(`${c.origin}: recipe lists sources but no sha512sums`);
    else ok(`alpine ${c.origin} ${c.version}: recipe has no upstream sources`);
    continue;
  }
  let n = 0;
  for (const line of block[1].split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [want, name] = line.split(/\s+/);
    const p = [`${dir}/distfiles/${name}`, `${dir}/aports/${name}`].find((x) => existsSync(at(x)));
    if (!p) { fail(`${c.origin}: missing ${name}`); continue; }
    if (hash("sha512", at(p)) !== want) fail(`${c.origin}: sha512 ${name}`);
    n++;
  }
  ok(`alpine ${c.origin} ${c.version}: ${n} recipe sources match its sha512sums`);
}

// 4. sharp-libvips: the URLs its bundled build script fetches equal the bundle's index.
const sl = manifest.components.find((x) => x.type === "sharp-libvips");
const src = mkdtempSync(join(tmpdir(), "sl-"));
execFileSync("tar", ["xzf", at(sl.build_scripts.path), "-C", src, "--strip-components=1"]);
const want = execFileSync("sh", ["-c", `cd "${src}" && . ./versions.properties && without_patch() { echo "\${1%.[[:digit:]]*}"; } && without_prerelease() { echo "\${1%-[[:alnum:]]*}"; } && grep -E '^\\s*\\$CURL ' build/posix.sh | sed -E 's/^\\s*\\$CURL (-O )?//; s/ \\|.*$//' | while read -r u; do eval "echo \\"$u\\""; done`], { encoding: "utf8" })
  .split("\n").filter(Boolean).sort();
const have = sl.sources.map((s) => s.url).sort();
if (JSON.stringify(want) !== JSON.stringify(have)) fail(`sharp-libvips: the bundle's index doesn't match the ${want.length} URLs build/posix.sh fetches`);
else ok(`sharp-libvips ${sl.version}: all ${want.length} URLs build/posix.sh fetches are in the bundle`);

// 5. Rust: every crates.io package in the resolved lockfile is vendored with its checksum.
const rust = manifest.components.find((x) => x.type === "rust-crates");
let m = 0;
for (const c of rust.crates) {
  const j = at(`${rust.vendor_dir}/${c.name}-${c.version}/.cargo-checksum.json`);
  if (!existsSync(j)) { fail(`crate not vendored: ${c.name}-${c.version}`); continue; }
  if (JSON.parse(readFileSync(j, "utf8")).package !== c.checksum) fail(`crate checksum: ${c.name}-${c.version}`);
  m++;
}
ok(`rust: ${m} of ${rust.crates.length} crates vendored with matching checksums`);

const bytes = all.reduce((s, f) => s + statSync(at(f)).size, 0);
console.log(`bundle: ${all.length} files, ${bytes} bytes`);
console.log(failures ? `SOURCE BUNDLE: FAIL (${failures})` : "SOURCE BUNDLE: PASS");
process.exitCode = failures ? 1 : 0;
