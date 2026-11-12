// Retrieves a source bundle by digest with no registry credentials, verifies
// every digest on the way, and extracts it. Run on Linux (it uses tar):
//
//   node retrieve.mjs <registry>/<name>@sha256:<64 hex> <out dir> [--insecure-http]
//
// For ghcr.io it asks for an anonymous pull token, which succeeds only if the
// package is public. --insecure-http is for local test registries only.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const [ref, out, flag] = process.argv.slice(2);
const m = /^([a-z0-9.:-]+)\/([a-z0-9./-]+)@(sha256:[0-9a-f]{64})$/.exec(ref ?? "");
if (!m || !out) throw new Error("usage: retrieve.mjs <registry>/<name>@sha256:<digest> <out dir>");
const [, registry, name, digest] = m;
const base = `${flag === "--insecure-http" ? "http" : "https"}://${registry}/v2/${name}`;
const ACCEPT = "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json";
const sha256 = (buf) => `sha256:${createHash("sha256").update(buf).digest("hex")}`;

let token = null;
if (registry === "ghcr.io") {
  const r = await fetch(`https://ghcr.io/token?scope=repository:${name}:pull`);
  if (!r.ok) throw new Error(`anonymous token refused (${r.status}): the package isn't public`);
  token = (await r.json()).token;
}
async function get(path, accept) {
  const r = await fetch(`${base}${path}`, { headers: { ...(accept ? { accept } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, redirect: "follow" });
  if (!r.ok) throw new Error(`GET ${path} returned ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

const index = await get(`/manifests/${digest}`, ACCEPT);
if (sha256(index) !== digest) throw new Error("index digest mismatch");
console.log(`ok index ${digest}`);
let manifest = JSON.parse(index);
if (manifest.manifests) {
  const entry = manifest.manifests.find((x) => x.platform?.architecture !== "unknown") ?? manifest.manifests[0];
  const buf = await get(`/manifests/${entry.digest}`, ACCEPT);
  if (sha256(buf) !== entry.digest) throw new Error("manifest digest mismatch");
  console.log(`ok manifest ${entry.digest}`);
  manifest = JSON.parse(buf);
}
mkdirSync(out, { recursive: true });
for (const layer of manifest.layers) {
  const blob = await get(`/blobs/${layer.digest}`);
  if (sha256(blob) !== layer.digest) throw new Error(`layer digest mismatch ${layer.digest}`);
  const file = join(out, ".layer.tar.gz");
  writeFileSync(file, blob);
  execFileSync("tar", ["-xzf", ".layer.tar.gz"], { cwd: out });
  rmSync(file);
  console.log(`ok layer ${layer.digest} (${blob.length} bytes)`);
}
console.log(`retrieved ${ref} into ${out}/covalink-sources`);
