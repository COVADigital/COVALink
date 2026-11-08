// Orphan inspection and cleanup for uploaded media. Plain ESM so it
// runs without TypeScript tooling; the CLI is scripts/media-gc.mjs.
//
// Only names in the managed namespace are ever considered:
//   {root}/{hh}/{hh}/{uuid}.webp   whose shard directories match the key
//   {root}/tmp/{uuid}.upload | {uuid}.webp.tmp
//   {root}/.readiness-{uuid}.probe
// Anything else (other names, directories, symlinks) is counted as
// "unexpected" and never touched. Deletion requires --apply AND an explicit
// --min-age-hours.
//
// Scan results carry only a kind and a name, never a path that is trusted
// later. Immediately before each unlink the path is rebuilt from the
// validated relative managed-namespace segments under the real root captured
// by the scan, the configured root must still resolve to that same real
// root, every intermediate directory must still be a real directory (not a
// symlink or junction) whose real path is exactly the expected one, the leaf
// must be a regular file, and a key must still have no live row. Anything
// changed, missing or redirected is skipped, never deleted.
import { lstat, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { MEDIA_KEY_PATTERN, PROBE_FILE_PATTERN, SHARD_PATTERN, TEMP_DIR, TEMP_FILE_PATTERN } from "../src/features/media/layout.mjs";

export const USAGE = "Usage: npm run media:gc -- [--apply --min-age-hours=N]  (dry run unless both --apply and --min-age-hours are given; N >= 1)";
export const MAX_LISTED = 20;

export class UsageError extends Error {}

/**
 * @param {string[]} argv
 * @returns {{ apply: boolean, minAgeHours: number | null }}
 */
export function parseArgs(argv) {
  let apply = false;
  let minAgeHours = null;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg.startsWith("--min-age-hours=")) {
      const v = arg.slice("--min-age-hours=".length);
      if (!/^\d{1,5}$/.test(v) || Number(v) < 1) throw new UsageError(`--min-age-hours must be a whole number of hours, at least 1. ${USAGE}`);
      minAgeHours = Number(v);
    } else throw new UsageError(`Unknown argument "${arg.slice(0, 40)}". ${USAGE}`);
  }
  if (apply && minAgeHours === null) throw new UsageError(`--apply requires an explicit --min-age-hours=N. ${USAGE}`);
  return { apply, minAgeHours };
}

/**
 * The storage root as configured, refusing a relative path in production.
 * @param {string | undefined} raw
 * @param {string | undefined} nodeEnv
 */
export function resolveRoot(raw, nodeEnv) {
  const value = raw && raw.trim() ? raw : "./data/uploads";
  if (nodeEnv === "production" && !path.isAbsolute(value)) throw new UsageError("STORAGE_LOCAL_PATH must be an absolute path in production.");
  return path.resolve(value);
}

function assertContained(root, target) {
  const rel = path.relative(root, target);
  if (rel === "" || path.isAbsolute(rel) || rel.startsWith("..")) throw new Error("Path escapes the storage root");
}

const isMissing = (err) => err?.code === "ENOENT";

async function entries(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

/**
 * Relative path segments of a managed entry, rebuilt from its kind and name
 * and validated against the namespace patterns; null if it isn't one.
 * @param {{ kind: "key" | "temp" | "probe", name: string }} entry
 * @returns {string[] | null}
 */
export function managedSegments(entry) {
  if (entry.kind === "key" && MEDIA_KEY_PATTERN.test(entry.name)) return [entry.name.slice(0, 2), entry.name.slice(2, 4), entry.name];
  if (entry.kind === "temp" && TEMP_FILE_PATTERN.test(entry.name)) return [TEMP_DIR, entry.name];
  if (entry.kind === "probe" && PROBE_FILE_PATTERN.test(entry.name)) return [entry.name];
  return null;
}

/**
 * Scans the managed namespace. Returns key files, temp files and probes (kind,
 * name, modification time; no paths) and counts of everything else.
 * `configuredRoot` and the real `root` are kept so deletion can verify the
 * root hasn't changed since.
 * @param {string} configuredRoot
 */
export async function scanStorage(configuredRoot) {
  /** @typedef {{ kind: "key" | "temp" | "probe", name: string, key?: string, mtimeMs: number }} Entry */
  /** @type {{ keys: Entry[], temps: Entry[], probes: Entry[], unexpected: number, symlinks: number, rootExists: boolean, root: string, configuredRoot: string }} */
  const result = { keys: [], temps: [], probes: [], unexpected: 0, symlinks: 0, rootExists: false, root: configuredRoot, configuredRoot };
  let root;
  try {
    root = await realpath(configuredRoot);
  } catch (err) {
    if (isMissing(err)) return result;
    throw err;
  }
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error("Storage root is not a directory");
  result.rootExists = true;
  result.root = root;

  for (const top of await entries(root)) {
    const topPath = path.join(root, top.name);
    if (top.isSymbolicLink()) {
      result.symlinks++;
    } else if (top.isFile() && PROBE_FILE_PATTERN.test(top.name)) {
      result.probes.push({ kind: "probe", name: top.name, mtimeMs: (await lstat(topPath)).mtimeMs });
    } else if (top.isDirectory() && top.name === TEMP_DIR) {
      for (const t of await entries(topPath)) {
        const tPath = path.join(topPath, t.name);
        if (t.isSymbolicLink()) result.symlinks++;
        else if (t.isFile() && TEMP_FILE_PATTERN.test(t.name)) result.temps.push({ kind: "temp", name: t.name, mtimeMs: (await lstat(tPath)).mtimeMs });
        else result.unexpected++;
      }
    } else if (top.isDirectory() && SHARD_PATTERN.test(top.name)) {
      for (const mid of await entries(topPath)) {
        const midPath = path.join(topPath, mid.name);
        if (mid.isSymbolicLink()) {
          result.symlinks++;
          continue;
        }
        if (!mid.isDirectory() || !SHARD_PATTERN.test(mid.name)) {
          result.unexpected++;
          continue;
        }
        for (const leaf of await entries(midPath)) {
          const leafPath = path.join(midPath, leaf.name);
          if (leaf.isSymbolicLink()) result.symlinks++;
          else if (leaf.isFile() && MEDIA_KEY_PATTERN.test(leaf.name) && leaf.name.slice(0, 2) === top.name && leaf.name.slice(2, 4) === mid.name) {
            result.keys.push({ kind: "key", name: leaf.name, key: leaf.name, mtimeMs: (await lstat(leafPath)).mtimeMs });
          } else result.unexpected++;
        }
      }
    } else {
      result.unexpected++;
    }
  }
  return result;
}

/**
 * Classifies a scan against the live keys.
 * @param {Awaited<ReturnType<typeof scanStorage>>} scan
 * @param {Set<string>} liveKeys
 * @param {{ now: number, minAgeHours: number | null }} opts
 */
export function planGc(scan, liveKeys, { now, minAgeHours }) {
  const oldEnough = (mtimeMs) => minAgeHours !== null && now - mtimeMs >= minAgeHours * 3_600_000;
  const orphans = scan.keys.filter((k) => !liveKeys.has(k.key));
  const fileKeys = new Set(scan.keys.map((k) => k.key));
  return {
    orphans,
    staleTemps: scan.temps,
    staleProbes: scan.probes,
    eligible: [...orphans, ...scan.temps, ...scan.probes].filter((e) => oldEnough(e.mtimeMs)),
    missingFiles: [...liveKeys].filter((k) => !fileKeys.has(k)).length,
    live: scan.keys.length - orphans.length,
  };
}

/**
 * The current, revalidated absolute path of a managed entry, or null when
 * anything differs from what the scan saw: the configured root no longer
 * resolves to the scanned real root, the root or an intermediate directory is
 * missing, isn't a directory, is a symlink/junction or resolves elsewhere, or
 * the leaf isn't a regular file.
 * @param {{ root: string, configuredRoot: string }} scan
 * @param {string[]} segments validated relative segments
 */
async function revalidate(scan, segments) {
  if ((await realpath(scan.configuredRoot)) !== scan.root) return null;
  const rootStat = await lstat(scan.root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
  let dir = scan.root;
  for (const segment of segments.slice(0, -1)) {
    dir = path.join(dir, segment);
    const st = await lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    if ((await realpath(dir)) !== dir) return null;
  }
  const target = path.join(dir, segments[segments.length - 1]);
  assertContained(scan.root, target);
  const leaf = await lstat(target);
  if (leaf.isSymbolicLink() || !leaf.isFile()) return null;
  return target;
}

/**
 * Deletes the eligible entries. The path is never taken from the scan: it is
 * rebuilt from the entry's validated relative segments, and the root, every
 * directory on the way and the leaf are revalidated immediately before the
 * unlink, after the live-row recheck for keys (`hasLiveRow`). Changed,
 * missing, redirected or suspicious entries are skipped.
 *
 * Residual window: Node has no `unlinkat`/`O_NOFOLLOW` for directories, so a
 * swap made between the last check and the unlink itself (microseconds, by
 * someone who can already write to the storage root) isn't excluded.
 * @param {{ root: string, configuredRoot: string }} scan
 * @param {{ kind: "key" | "temp" | "probe", name: string, key?: string }[]} eligible
 * @param {(key: string) => Promise<boolean>} hasLiveRow
 */
export async function applyGc(scan, eligible, hasLiveRow) {
  let deleted = 0;
  let skipped = 0;
  for (const entry of eligible) {
    try {
      const segments = managedSegments(entry);
      if (!segments) {
        skipped++;
        continue;
      }
      if (entry.kind === "key" && (await hasLiveRow(entry.name))) {
        skipped++;
        continue;
      }
      const target = await revalidate(scan, segments);
      if (!target) {
        skipped++;
        continue;
      }
      await unlink(target);
      deleted++;
    } catch {
      // Missing or unreadable entries (including a vanished root) are skipped, never retried elsewhere.
      skipped++;
    }
  }
  return { deleted, skipped };
}

/** Bounded, path-free summary lines. */
export function report(plan, scan, { apply, minAgeHours }, applied) {
  const lines = [
    `[media:gc] mode: ${apply ? `apply (files older than ${minAgeHours} h)` : "dry run (nothing is deleted)"}`,
    `[media:gc] storage root ${scan.rootExists ? "found" : "missing (nothing to scan)"}`,
    `[media:gc] stored files with a live row: ${plan.live}`,
    `[media:gc] orphan files (no live row): ${plan.orphans.length}`,
    `[media:gc] leftover temp files: ${plan.staleTemps.length}; leftover readiness probes: ${plan.staleProbes.length}`,
    `[media:gc] live rows without a file: ${plan.missingFiles}`,
    `[media:gc] unexpected entries (never touched): ${scan.unexpected}; symlinks (never followed): ${scan.symlinks}`,
  ];
  if (plan.orphans.length) {
    const shown = plan.orphans.slice(0, MAX_LISTED).map((o) => o.key);
    lines.push(`[media:gc] orphan keys${plan.orphans.length > MAX_LISTED ? ` (first ${MAX_LISTED})` : ""}: ${shown.join(", ")}`);
  }
  if (minAgeHours !== null) lines.push(`[media:gc] older than ${minAgeHours} h and eligible for deletion: ${plan.eligible.length}`);
  if (applied) lines.push(`[media:gc] deleted: ${applied.deleted}; skipped on re-check: ${applied.skipped}`);
  return lines;
}
