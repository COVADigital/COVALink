// Assembles candidate-report.json from the gate results and the build record.
// Exits 1 unless every required gate result is present and passed, every result
// is for the candidate image, and the build record names the pinned build
// toolchain (release/config.env).
//
//   node release/gates/report.mjs <results dir> <build record json> <out json>
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED = ["rebuild", "identity", "contents", "secrets", "sbom", "vulnerabilities", "alpine-security-update", "non-root", "notices", "source-bundle", "libvips-replacement", "deployment-smoke"];
const [dir, buildFile, out] = process.argv.slice(2);
if (!dir || !buildFile || !out) throw new Error("usage: report.mjs <results dir> <build record> <out>");
const build = JSON.parse(readFileSync(buildFile, "utf8"));
const results = Object.fromEntries(
  readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
    const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
    return [r.gate, r];
  }),
);
const missing = REQUIRED.filter((g) => !results[g]);
const failed = REQUIRED.filter((g) => results[g] && results[g].ok !== true);
const wrongImage = Object.values(results).filter((r) => r.image !== build.image).map((r) => r.gate);
const pins = Object.fromEntries(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "config.env"), "utf8").split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const toolchainMatches = typeof pins.DOCKERFILE_FRONTEND === "string" && typeof pins.BUILDKIT_IMAGE === "string"
  && build.toolchain?.dockerfile_frontend === pins.DOCKERFILE_FRONTEND && build.toolchain?.buildkit === pins.BUILDKIT_IMAGE;
const report = {
  format: "covalink-candidate-report/1",
  passed: missing.length === 0 && failed.length === 0 && wrongImage.length === 0 && toolchainMatches,
  image: build.image,
  digest: build.digest,
  tag_ref: build.tag_ref,
  commit: build.commit,
  version: build.version,
  run_id: build.run_id,
  source_bundle: { ref: build.source_bundle, status: build.source_bundle_status, manifest_sha256: build.bundle_manifest_sha256 },
  build_toolchain: { dockerfile_frontend: build.toolchain?.dockerfile_frontend ?? null, buildkit: build.toolchain?.buildkit ?? null, matches_pins: toolchainMatches },
  scanners: build.scanners,
  vulnerability_database: results.vulnerabilities?.details?.database ?? null,
  missing_gates: missing,
  failed_gates: failed,
  results_for_another_image: wrongImage,
  gates: Object.fromEntries(REQUIRED.filter((g) => results[g]).map((g) => [g, { ok: results[g].ok, details: results[g].details }])),
};
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(report.passed
  ? `CANDIDATE PASSED ${report.digest}`
  : `CANDIDATE FAILED: missing ${missing.join(", ") || "none"}; failed ${failed.join(", ") || "none"}${toolchainMatches ? "" : "; build toolchain doesn't match the pins"}`);
process.exitCode = report.passed ? 0 : 1;
if (!existsSync(out)) process.exitCode = 1;
