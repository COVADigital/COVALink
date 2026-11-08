// Backup variants for the restore regression checks in smoke.mjs. Each variant is SELF-CONSISTENT: SHA256SUMS (and, where the archive
// changes, the manifest's own hash and size) are recomputed, as an attacker or
// a careless edit would, so only restore.sh's manifest validation or its
// reconciliation can refuse it.
import { createHash } from "node:crypto";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Manifest entries as [key, raw JSON value text], in file order. */
export function parseManifest(text) {
  const lines = text.split("\n");
  return lines
    .slice(1, lines.lastIndexOf("}"))
    .map((line) => /^ {2}"([^"]+)": (.*?),?$/.exec(line))
    .map((m) => [m[1], m[2]]);
}

/** The exact layout ops/backup.sh writes. */
export const writeManifestText = (entries) => `{\n${entries.map(([k, v]) => `  "${k}": ${v}`).join(",\n")}\n}\n`;

/** Rewrites SHA256SUMS from the files as they now are (the order backup.sh uses). */
export function recomputeSums(dir) {
  const line = (f) => `${sha256(readFileSync(path.join(dir, f)))}  ${f}`;
  writeFileSync(path.join(dir, "SHA256SUMS"), ["database.dump", "media.tar", "manifest.json"].map(line).join("\n") + "\n");
}

/** Copies a valid backup and applies `edit(entries) => entries | string` to its manifest, then recomputes SHA256SUMS. */
export function manifestVariant(validDir, targetDir, edit, { sums } = {}) {
  cpSync(validDir, targetDir, { recursive: true });
  const file = path.join(targetDir, "manifest.json");
  const out = edit(parseManifest(readFileSync(file, "utf8")));
  writeFileSync(file, typeof out === "string" ? out : writeManifestText(out));
  recomputeSums(targetDir);
  if (sums) writeFileSync(path.join(targetDir, "SHA256SUMS"), sums(readFileSync(path.join(targetDir, "SHA256SUMS"), "utf8")));
}

const set = (key, raw) => (entries) => entries.map(([k, v]) => [k, k === key ? raw : v]);
const without = (key) => (entries) => entries.filter(([k]) => k !== key);

/**
 * Malformed manifests. `marker` is a host path (forward slashes) that a
 * command substitution in the payloads would create if any value were ever
 * evaluated by the shell or by Bash arithmetic.
 * @returns {{ name: string, edit: Function, sums?: Function, stderr: RegExp }[]}
 */
export function malformedManifests(marker) {
  // Naming a set array matters: the pre-fix restore.sh executed exactly this
  // under `set -u` through `(( got < want ))` (with an unset name it aborted first).
  const inject = `BASH_VERSINFO[$(echo injected>${marker})]`;
  return [
    { name: "arithmetic command substitution as a JSON string (migrationCount)", edit: set("migrationCount", `"${inject}"`), stderr: /migrationCount must be a non-negative integer/ },
    { name: "arithmetic command substitution as a bare value (mediaRows)", edit: set("mediaRows", inject), stderr: /mediaRows must be a non-negative integer/ },
    { name: "command substitution in a string field (gitRevision)", edit: set("gitRevision", `"$(echo injected>${marker})"`), stderr: /gitRevision has an unexpected value/ },
    { name: "missing field (managedFiles)", edit: without("managedFiles"), stderr: /missing field managedFiles/ },
    { name: "duplicate field (migrationCount)", edit: (e) => [...e.slice(0, 1), ["migrationCount", "0"], ...e.slice(1)], stderr: /duplicate field migrationCount/ },
    { name: "number as a string (migrationCount \"4\")", edit: set("migrationCount", '"4"'), stderr: /migrationCount must be a non-negative integer/ },
    { name: "negative number (mediaRows -1)", edit: set("mediaRows", "-1"), stderr: /mediaRows must be a non-negative integer/ },
    { name: "fractional number (managedFiles 1.5)", edit: set("managedFiles", "1.5"), stderr: /managedFiles must be a non-negative integer/ },
    { name: "exponent (migrationCount 4e0)", edit: set("migrationCount", "4e0"), stderr: /migrationCount must be a non-negative integer/ },
    { name: "leading zero (migrationCount 04)", edit: set("migrationCount", "04"), stderr: /migrationCount must be a non-negative integer/ },
    { name: "oversized number (migrationCount 99999)", edit: set("migrationCount", "99999"), stderr: /migrationCount must be a non-negative integer of at most 4 digits/ },
    { name: "oversized number (databaseBytes, 14 digits)", edit: set("databaseBytes", "12345678901234"), stderr: /databaseBytes must be a non-negative integer of at most 13 digits/ },
    { name: "unknown field", edit: (e) => [...e, ["restoreHook", '"x"']], stderr: /unknown field restoreHook/ },
    { name: "unknown format", edit: set("format", '"covalink-backup/2"'), stderr: /format has an unexpected value/ },
    { name: "malformed SHA-256 (databaseSha256, uppercase)", edit: (e) => e.map(([k, v]) => [k, k === "databaseSha256" ? v.toUpperCase() : v]), stderr: /databaseSha256 has an unexpected value/ },
    { name: "unexpected file name (databaseFile ../database.dump)", edit: set("databaseFile", '"../database.dump"'), stderr: /databaseFile has an unexpected value/ },
    { name: "escaped quote in a string", edit: set("gitRevision", '"a\\"b"'), stderr: /gitRevision must be a string/ },
    { name: "not the canonical layout (minified JSON)", edit: (e) => JSON.stringify(Object.fromEntries(e.map(([k, v]) => [k, JSON.parse(v)]))), stderr: /not a JSON object in the canonical layout/ },
    { name: "CRLF line endings", edit: (e) => writeManifestText(e).replaceAll("\n", "\r\n"), stderr: /not a small plain-text file/ },
    { name: "SHA256SUMS listing another path", edit: (e) => e, sums: (s) => s + `${"0".repeat(64)}  ../../etc/passwd\n`, stderr: /SHA256SUMS must list exactly/ },
    { name: "SHA256SUMS listing media.tar twice instead of manifest.json", edit: (e) => e, sums: (s) => s.replace(/^.*  manifest\.json$/m, s.split("\n")[1]), stderr: /SHA256SUMS lists media\.tar twice/ },
  ];
}
