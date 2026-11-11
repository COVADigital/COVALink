// Writes MANIFEST.json, README.md and rebuild-kit/REBUILD.md into a source
// bundle tree. MANIFEST.json lists every component and the SHA-256 of every
// source file. It deliberately records no commit, date or build identifier, so
// two bundles built from the same pinned inputs have byte-identical manifests;
// the candidate workflow compares manifests to decide whether a release can
// reuse the bundle already published.
//
//   node manifest.mjs <bundle dir> <origins.tsv> <config.env>
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const [bundle, originsFile, configFile] = process.argv.slice(2);
if (!bundle || !originsFile || !configFile) throw new Error("usage: manifest.mjs <bundle> <origins.tsv> <config.env>");

const config = Object.fromEntries(
  readFileSync(configFile, "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const rel = (path) => relative(bundle, path).split(sep).join("/");
const files = (dir) => {
  const out = [];
  const visit = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const st = lstatSync(full);
      if (st.isDirectory()) visit(full);
      else if (st.isFile()) out.push(full);
      else throw new Error(`the bundle must hold regular files only: ${rel(full)}`);
    }
  };
  visit(dir);
  return out;
};
const entry = (path) => ({ path: rel(path), sha256: sha256(path) });

// Alpine origins: one component per source package of the base image.
const origins = readFileSync(originsFile, "utf8").trim().split(/\r?\n/).map((l) => l.split("\t"));
const alpine = origins.map(([origin, commit, version, packages]) => {
  const dir = join(bundle, "alpine", origin);
  return {
    type: "alpine",
    origin,
    version,
    aports_commit: commit,
    packages: packages.split(",").map((p) => {
      const [name, pversion, license] = p.split("|");
      return { name, version: pversion, license };
    }),
    recipe: `alpine/${origin}/aports/APKBUILD`,
    files: files(dir).map(entry),
    verification: "every upstream source matches the recipe's sha512sums (abuild verify)",
  };
});

// sharp-libvips: the build scripts at the pinned commit and everything they download.
const slDir = join(bundle, "sharp-libvips");
const urls = readFileSync(join(slDir, "sources", "urls.tsv"), "utf8").trim().split(/\r?\n/).map((l) => l.split("\t"));
const archive = `sharp-libvips/sharp-libvips-${config.SHARP_LIBVIPS_COMMIT}.tar.gz`;
const sharpLibvips = {
  type: "sharp-libvips",
  package: config.SHARP_LIBVIPS_PACKAGE,
  version: config.SHARP_LIBVIPS_VERSION,
  commit: config.SHARP_LIBVIPS_COMMIT,
  build_scripts: entry(join(bundle, archive)),
  sources: urls.map(([url, file, hash]) => ({ url, path: `sharp-libvips/sources/${file}`, sha256: hash })),
  note:
    "The image ships this package's prebuilt library unchanged. These are the upstream source materials for this exact version: its build scripts and every source archive and patch they download. The prebuilt library came from a build whose Rust crates were resolved at build time, so the crates below are the result of repeating that resolution, not a verified record of the crates inside the shipped library.",
};

// Rust crates that librsvg's build resolves.
const lock = readFileSync(join(slDir, "cargo", "Cargo.lock.resolved"), "utf8");
const crates = [];
for (const block of lock.split("[[package]]").slice(1)) {
  const field = (k) => (new RegExp(`^${k} = "([^"]*)"`, "m").exec(block) ?? [])[1];
  if ((field("source") ?? "").includes("crates.io")) crates.push({ name: field("name"), version: field("version"), checksum: field("checksum") });
}
crates.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const rust = {
  type: "rust-crates",
  for: "librsvg, built into the sharp-libvips library",
  lockfile: entry(join(slDir, "cargo", "Cargo.lock.resolved")),
  crates,
  vendor_dir: "sharp-libvips/cargo/vendor",
};

const kitDir = join(bundle, "rebuild-kit");
const kit = { type: "rebuild-kit", files: files(kitDir).filter((f) => !f.endsWith("REBUILD.md")).map(entry) };

const manifest = {
  format: "covalink-source-bundle/1",
  scope:
    "Source for the operating-system packages of the COVALink container image's base image, and the upstream source materials of the prebuilt libvips library that sharp loads, with the Rust crates its build resolves.",
  base_image: config.NODE_IMAGE,
  // The temporary Alpine security update applied on top of base_image (the
  // Dockerfile's patched-base stage); the alpine components below include it.
  base_image_security_updates: [{ package: "zlib", version: config.ALPINE_ZLIB_VERSION, fixes: config.ALPINE_ZLIB_FIXES.split(",") }],
  // The pinned toolchain that builds the image this bundle belongs to; the
  // candidate build fails if the builder's effective versions differ.
  build_toolchain: { dockerfile_frontend: config.DOCKERFILE_FRONTEND, buildkit: config.BUILDKIT_IMAGE },
  components: [...alpine, sharpLibvips, rust, kit],
};
writeFileSync(join(bundle, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);

writeFileSync(
  join(bundle, "README.md"),
  `# COVALink source bundle

Source code for the third-party components of the COVALink container image that
are distributed in binary form:

- every operating-system package of the base image (\`${config.NODE_IMAGE}\`):
  its Alpine \`aports\` recipe at the recorded commit, and every upstream source
  file the recipe lists, checked against the recipe's own checksums;
- ${config.SHARP_LIBVIPS_PACKAGE} ${config.SHARP_LIBVIPS_VERSION}, the prebuilt
  libvips library sharp loads: its build scripts at commit
  ${config.SHARP_LIBVIPS_COMMIT}, every source archive and patch they download
  (indexed by URL in \`sharp-libvips/sources/urls.tsv\`), and the Rust crates
  librsvg's build resolves, vendored.

The image ships that library unchanged. Its build resolved Rust crates at build
time, so the vendored crates are the result of repeating that resolution, not a
verified record of the crates inside the shipped library.

\`MANIFEST.json\` lists every component and file with its SHA-256, and
\`SHA256SUMS\` covers every file. \`rebuild-kit/REBUILD.md\` rebuilds the libvips
library from this bundle with no network access.
`,
);

writeFileSync(
  join(kitDir, "REBUILD.md"),
  `# Rebuilding the libvips library from this bundle

Run these steps on Linux with Docker, from the bundle's root folder.

1. Build the pinned build environment (its toolchain packages come from the network):
   \`docker build -t libvips-buildenv rebuild-kit\`
2. Extract the build scripts into an empty \`packaging/\` folder:
   \`mkdir packaging && tar xzf ${archive} -C packaging --strip-components=1\`
3. Build with no network. \`curl-from-bundle.sh\` serves only files indexed in
   \`sharp-libvips/sources/urls.tsv\`, and \`cargo-config.toml\` points Cargo at
   the vendored crates:

       docker run --rm --network none -v "$PWD:/bundle:ro" -v "$PWD/packaging:/packaging" \\
         -v "$PWD/rebuild-kit/curl-from-bundle.sh:/usr/local/bin/curl:ro" \\
         -v "$PWD/rebuild-kit/cargo-config.toml:/usr/local/cargo/config.toml:ro" \\
         libvips-buildenv sh -c /packaging/build/posix.sh

4. The result is \`packaging/sharp-libvips-linuxmusl-x64.tar.gz\`. Its
   \`lib/libvips-cpp.so.*\` replaces the library in the image as described in
   the COVALink repository's \`web/CORRESPONDING_SOURCE.md\`.

The upstream build script is used unmodified. The build environment is the
upstream \`platforms/linuxmusl-x64/Dockerfile\` with its base image, Rust
toolchain, cargo-c and meson versions pinned.
`,
);
console.log(`MANIFEST.json: ${alpine.length} Alpine origins, ${urls.length} sharp-libvips sources, ${crates.length} crates`);
if (!existsSync(join(bundle, archive))) throw new Error(`missing ${archive}`);
