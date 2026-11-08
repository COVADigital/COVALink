import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyGc, parseArgs, planGc, report, resolveRoot, scanStorage, UsageError } from "../../scripts/media-gc-core.mjs";

const LIVE = "0f8fad5b-d9cb-469f-a165-70867728950e.webp";
const ORPHAN = "7c9e6679-7425-40de-944b-e07fc1f90ae7.webp";
const FRESH_ORPHAN = "16fd2706-8baf-433b-82eb-8c7fada847da.webp";
const HOUR = 3_600_000;

let base = "";
beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "covalink-media-test-gc-"));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

async function put(root: string, rel: string, ageHours: number, content = "x") {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  const t = new Date(Date.now() - ageHours * HOUR);
  await utimes(file, t, t);
  return file;
}
const keyPath = (k: string) => path.join(k.slice(0, 2), k.slice(2, 4), k);

describe("media:gc arguments", () => {
  it("is a dry run by default and refuses --apply without an explicit age", () => {
    expect(parseArgs([])).toEqual({ apply: false, minAgeHours: null });
    expect(parseArgs(["--min-age-hours=24"])).toEqual({ apply: false, minAgeHours: 24 });
    expect(parseArgs(["--apply", "--min-age-hours=24"])).toEqual({ apply: true, minAgeHours: 24 });
    expect(() => parseArgs(["--apply"])).toThrow(UsageError);
    for (const bad of [["--min-age-hours=0"], ["--min-age-hours=-1"], ["--min-age-hours=1.5"], ["--min-age-hours="], ["--force"], ["--apply", "--min-age-hours=abc"]]) {
      expect(() => parseArgs(bad), bad.join(" ")).toThrow(UsageError);
    }
  });

  it("refuses a relative storage root in production", () => {
    expect(() => resolveRoot("./data/uploads", "production")).toThrow(UsageError);
    expect(resolveRoot(undefined, "development")).toBe(path.resolve("./data/uploads"));
  });
});

describe("media:gc scan, plan and apply", () => {
  it("considers only the managed namespace and deletes only old orphans and leftovers", async () => {
    const root = path.join(base, "root");
    const outside = path.join(base, "outside");
    await put(root, keyPath(LIVE), 48);
    await put(root, keyPath(ORPHAN), 48);
    await put(root, keyPath(FRESH_ORPHAN), 0);
    await put(root, path.join("tmp", "9b2a3c4d-1e2f-4a5b-8c6d-7e8f9a0b1c2d.upload"), 48);
    await put(root, ".readiness-9b2a3c4d-1e2f-4a5b-8c6d-7e8f9a0b1c2d.probe", 48);
    // Never touched: wrong shard, unexpected names, a directory where a file would be, a symlink.
    await put(root, path.join("aa", "bb", ORPHAN), 48);
    await put(root, path.join("0f", "8f", "notes.txt"), 48);
    await put(root, "README", 48);
    await put(root, path.join("tmp", "keep.me"), 48);
    await mkdir(path.join(root, "7c", "9e", "16fd2706-8baf-433b-82eb-8c7fada847db.webp"), { recursive: true });
    await put(outside, keyPath(ORPHAN), 48, "outside the root");
    await symlink(path.join(outside, "7c"), path.join(root, "ab"), process.platform === "win32" ? "junction" : "dir");

    const scan = await scanStorage(root);
    expect(scan.keys.map((k: { name: string }) => k.name).sort()).toEqual([LIVE, ORPHAN, FRESH_ORPHAN].sort());
    expect(scan.temps).toHaveLength(1);
    expect(scan.probes).toHaveLength(1);
    expect(scan.unexpected).toBe(5);
    expect(scan.symlinks).toBe(1);

    const live = new Set([LIVE, "16fd2706-8baf-433b-82eb-8c7fada847dc.webp"]);
    const dry = planGc(scan, live, { now: Date.now(), minAgeHours: null });
    expect(dry.orphans.map((o: { name: string }) => o.name).sort()).toEqual([ORPHAN, FRESH_ORPHAN].sort());
    expect(dry.eligible).toEqual([]); // no age, nothing is ever eligible
    expect(dry.missingFiles).toBe(1);
    const lines = report(dry, scan, { apply: false, minAgeHours: null });
    expect(lines.join("\n")).toContain("dry run");
    expect(lines.join("\n")).not.toContain(base); // no absolute paths

    const plan = planGc(scan, live, { now: Date.now(), minAgeHours: 24 });
    expect(plan.eligible).toHaveLength(3); // old orphan, old temp, old probe; the fresh orphan is kept
    // A row appearing for the orphan before deletion protects it.
    const applied = await applyGc(scan, plan.eligible, async (k: string) => k === "never");
    expect(applied).toEqual({ deleted: 3, skipped: 0 });

    const after = await scanStorage(root);
    expect(after.keys.map((k: { name: string }) => k.name).sort()).toEqual([LIVE, FRESH_ORPHAN].sort());
    expect(after.temps).toEqual([]);
    expect(after.probes).toEqual([]);
    expect(after.unexpected).toBe(5);
    await expect(stat(path.join(outside, keyPath(ORPHAN)))).resolves.toBeTruthy();
    expect(await readdir(path.join(root, "tmp"))).toEqual(["keep.me"]);
  });

  it("re-checks before deleting: a key that gained a live row is skipped", async () => {
    const root = path.join(base, "root2");
    await put(root, keyPath(ORPHAN), 48);
    const scan = await scanStorage(root);
    const plan = planGc(scan, new Set(), { now: Date.now(), minAgeHours: 1 });
    expect(await applyGc(scan, plan.eligible, async () => true)).toEqual({ deleted: 0, skipped: 1 });
    await expect(stat(path.join(root, keyPath(ORPHAN)))).resolves.toBeTruthy();
  });

  const link = (target: string, at: string) => symlink(target, at, process.platform === "win32" ? "junction" : "dir");
  const SWAP_KEY = "aabbccdd-eeff-4abc-8def-0123456789ab.webp";

  it("a shard directory swapped for a junction after the scan is skipped; the outside file stays intact", async () => {
    const root = path.join(base, "swap-shard");
    const outside = path.join(base, "swap-shard-outside");
    await put(root, keyPath(SWAP_KEY), 48, "inside");
    const bytes = Buffer.from("outside: must survive \u0000ÿ", "binary");
    const outsideFile = await put(outside, path.join("bb", SWAP_KEY), 48, "");
    await writeFile(outsideFile, bytes);
    const scan = await scanStorage(root);
    const plan = planGc(scan, new Set(), { now: Date.now(), minAgeHours: 1 });
    expect(plan.eligible.map((e: { name: string }) => e.name)).toEqual([SWAP_KEY]);
    // After the scan: remove root/aa and replace it with a junction to the outside directory.
    await rm(path.join(root, "aa"), { recursive: true, force: true });
    await link(outside, path.join(root, "aa"));
    expect(await applyGc(scan, plan.eligible, async () => false)).toEqual({ deleted: 0, skipped: 1 });
    expect((await readFile(outsideFile)).equals(bytes)).toBe(true);
  });

  it("a tmp directory swapped for a junction after the scan is skipped; the outside file stays intact", async () => {
    const root = path.join(base, "swap-tmp");
    const outside = path.join(base, "swap-tmp-outside");
    const temp = "9b2a3c4d-1e2f-4a5b-8c6d-7e8f9a0b1c2d.upload";
    await put(root, path.join("tmp", temp), 48, "inside");
    const outsideFile = await put(outside, temp, 48, "outside temp");
    const scan = await scanStorage(root);
    const plan = planGc(scan, new Set(), { now: Date.now(), minAgeHours: 1 });
    expect(plan.eligible).toHaveLength(1);
    await rm(path.join(root, "tmp"), { recursive: true, force: true });
    await link(outside, path.join(root, "tmp"));
    expect(await applyGc(scan, plan.eligible, async () => false)).toEqual({ deleted: 0, skipped: 1 });
    expect(await readFile(outsideFile, "utf8")).toBe("outside temp");
  });

  it("a storage root replaced after the scan (moved, or now a junction elsewhere) is refused", async () => {
    const root = path.join(base, "swap-root");
    const elsewhere = path.join(base, "swap-root-elsewhere");
    const probe = ".readiness-9b2a3c4d-1e2f-4a5b-8c6d-7e8f9a0b1c2d.probe";
    await put(root, keyPath(ORPHAN), 48, "inside");
    await put(root, probe, 48, "probe");
    const outsideKey = await put(elsewhere, keyPath(ORPHAN), 48, "elsewhere key");
    const outsideProbe = await put(elsewhere, probe, 48, "elsewhere probe");
    const scan = await scanStorage(root);
    const plan = planGc(scan, new Set(), { now: Date.now(), minAgeHours: 1 });
    expect(plan.eligible).toHaveLength(2);
    // The configured root now resolves somewhere else.
    await rename(root, `${root}-moved`);
    await link(elsewhere, root);
    expect(await applyGc(scan, plan.eligible, async () => false)).toEqual({ deleted: 0, skipped: 2 });
    expect(await readFile(outsideKey, "utf8")).toBe("elsewhere key");
    expect(await readFile(outsideProbe, "utf8")).toBe("elsewhere probe");
    // And a root that vanished is skipped, not an error.
    await rm(root, { recursive: true, force: true });
    expect(await applyGc(scan, plan.eligible, async () => false)).toEqual({ deleted: 0, skipped: 2 });
  });

  it("never deletes a path taken from the scan; entries are rebuilt from validated names only", async () => {
    const root = path.join(base, "forged");
    const victim = await put(base, "forged-victim.txt", 48, "victim");
    await put(root, keyPath(ORPHAN), 48);
    const scan = await scanStorage(root);
    const forged = [
      { kind: "key", name: "../../forged-victim.txt", key: "../../forged-victim.txt", file: victim },
      { kind: "temp", name: "..\\..\\forged-victim.txt", file: victim },
      { kind: "probe", name: "forged-victim.txt", file: victim },
      { kind: "other", name: ORPHAN, file: victim },
    ];
    expect(await applyGc(scan, forged as never, async () => false)).toEqual({ deleted: 0, skipped: 4 });
    expect(await readFile(victim, "utf8")).toBe("victim");
    // The real orphan, rebuilt from its name, is still deletable.
    const plan = planGc(scan, new Set(), { now: Date.now(), minAgeHours: 1 });
    expect(await applyGc(scan, plan.eligible, async () => false)).toEqual({ deleted: 1, skipped: 0 });
  });

  it("a leaf replaced by a directory, or by a symlink, after the scan is skipped", async () => {
    const root = path.join(base, "swap-leaf");
    await put(root, keyPath(ORPHAN), 48);
    await put(root, keyPath(FRESH_ORPHAN), 48);
    const target = await put(base, "swap-leaf-target.txt", 48, "target");
    const scan = await scanStorage(root);
    const plan = planGc(scan, new Set(), { now: Date.now(), minAgeHours: 1 });
    expect(plan.eligible).toHaveLength(2);
    await rm(path.join(root, keyPath(ORPHAN)));
    await mkdir(path.join(root, keyPath(ORPHAN)));
    await rm(path.join(root, keyPath(FRESH_ORPHAN)));
    // File symlinks may need elevation on Windows; a junction to a directory exercises the same rule.
    await link(path.dirname(target), path.join(root, keyPath(FRESH_ORPHAN)));
    expect(await applyGc(scan, plan.eligible, async () => false)).toEqual({ deleted: 0, skipped: 2 });
    expect(await readFile(target, "utf8")).toBe("target");
  });

  it("reports a missing root without failing", async () => {
    const scan = await scanStorage(path.join(base, "missing"));
    expect(scan.rootExists).toBe(false);
    expect(planGc(scan, new Set(), { now: Date.now(), minAgeHours: 1 }).eligible).toEqual([]);
  });
});
