import "server-only";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";
import { MAX_STORED_BYTES } from "./constants";
import { isMediaKey, keySegments, PROBE_FILE_PATTERN, TEMP_DIR, TEMP_FILE_PATTERN } from "./layout.mjs";

/**
 * Media storage. `MediaStorage` is the only interface the rest of the
 * app uses, so another backend (S3-compatible) can be added later; the local
 * filesystem is the only implementation.
 *
 * Local layout under the configured root (resolved once to its real path):
 *   {k0k1}/{k2k3}/{uuid}.webp   published files, named only by server keys
 *   tmp/{uuid}.upload           upload intake
 *   tmp/{uuid}.webp.tmp         processed output before it is published
 *   .readiness-{uuid}.probe     transient readiness probe
 *
 * Every path is built from validated server-generated names, checked for
 * containment with `path.relative`, and every directory and file on the way
 * is `lstat`-ed and refused if it is a symlink. Directories are created 0700
 * and files 0600.
 */
export interface MediaStorage {
  /** A new exclusive intake path in the temp area (the file isn't created). */
  intakePath(): Promise<string>;
  /** Writes processed output to a new temp file and returns its path. */
  writeTemp(data: Uint8Array): Promise<string>;
  /** Moves a temp file into place for `key`; never overwrites. */
  publish(tempPath: string, key: string): Promise<void>;
  /** Removes a temp file if it exists. */
  removeTemp(tempPath: string): Promise<void>;
  /** The stored bytes for `key`, or null when there is no regular file for it. */
  read(key: string): Promise<Buffer | null>;
  /** Removes the file for `key`; false when there was none. */
  remove(key: string): Promise<boolean>;
  /** Creates, writes and deletes an exclusive probe file in the root. */
  probe(): Promise<void>;
}

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

/** Absolute storage root for a configured value; relative paths are refused in production. */
export function configuredRoot(raw: string, nodeEnv: string): string {
  if (!raw.trim()) throw new StorageError("STORAGE_LOCAL_PATH is empty");
  if (nodeEnv === "production" && !path.isAbsolute(raw)) {
    throw new StorageError("STORAGE_LOCAL_PATH must be an absolute path in production");
  }
  return path.resolve(raw);
}

/** Throws unless `target` is strictly inside `root` (never by string prefix). */
export function assertContained(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel === "" || path.isAbsolute(rel) || rel.startsWith("..")) throw new StorageError("Path escapes the storage root");
}

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === "ENOENT";
// O_NOFOLLOW where the platform has it (not on Windows); lstat/fstat checks cover the rest.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

export class LocalStorage implements MediaStorage {
  #root: Promise<string> | undefined;

  constructor(readonly configured: string) {}

  /** The real path of the root, created (0700) if missing. Retried after a failure. */
  root(): Promise<string> {
    this.#root ??= (async () => {
      await mkdir(this.configured, { recursive: true, mode: 0o700 });
      const real = await realpath(this.configured);
      const st = await lstat(real);
      if (!st.isDirectory()) throw new StorageError("Storage root is not a directory");
      return real;
    })().catch((err) => {
      this.#root = undefined;
      throw err;
    });
    return this.#root;
  }

  /**
   * Verifies (and with `create`, makes) each directory below the root. Returns
   * null when a component is missing and `create` is false.
   */
  async #dir(segments: string[], create: boolean): Promise<string | null> {
    const root = await this.root();
    let current = root;
    for (const segment of segments) {
      current = path.join(current, segment);
      assertContained(root, current);
      let st;
      try {
        st = await lstat(current);
      } catch (err) {
        if (!isMissing(err)) throw err;
        if (!create) return null;
        await mkdir(current, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== "EEXIST") throw e;
        });
        st = await lstat(current);
      }
      if (st.isSymbolicLink() || !st.isDirectory()) throw new StorageError("Unexpected entry in the storage tree");
    }
    return current;
  }

  async #keyPath(key: string, create: boolean): Promise<string | null> {
    if (!isMediaKey(key)) throw new StorageError("Invalid media key");
    const [a, b, name] = keySegments(key);
    const dir = await this.#dir([a, b], create);
    if (!dir) return null;
    const target = path.join(dir, name);
    assertContained(await this.root(), target);
    return target;
  }

  async #tempPath(name: string): Promise<string> {
    if (!TEMP_FILE_PATTERN.test(name)) throw new StorageError("Invalid temp name");
    const dir = (await this.#dir([TEMP_DIR], true))!;
    const target = path.join(dir, name);
    assertContained(await this.root(), target);
    return target;
  }

  /** A temp path built by this instance: inside `{root}/tmp`, with a temp-file name. */
  async #checkTemp(tempPath: string): Promise<string> {
    const root = await this.root();
    const resolved = path.resolve(tempPath);
    assertContained(root, resolved);
    const rel = path.relative(root, resolved).split(path.sep);
    if (rel.length !== 2 || rel[0] !== TEMP_DIR || !TEMP_FILE_PATTERN.test(rel[1])) throw new StorageError("Not a storage temp file");
    return resolved;
  }

  intakePath() {
    return this.#tempPath(`${randomUUID()}.upload`);
  }

  async writeTemp(data: Uint8Array) {
    const target = await this.#tempPath(`${randomUUID()}.webp.tmp`);
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => {});
      await unlink(target).catch(() => {});
      throw err;
    }
    await handle.close();
    return target;
  }

  async publish(tempPath: string, key: string) {
    const source = await this.#checkTemp(tempPath);
    const st = await lstat(source);
    if (st.isSymbolicLink() || !st.isFile()) throw new StorageError("Temp file is not a regular file");
    const target = (await this.#keyPath(key, true))!;
    try {
      await lstat(target);
      throw new StorageError("A file already exists for this key");
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    await rename(source, target);
  }

  async removeTemp(tempPath: string) {
    const target = await this.#checkTemp(tempPath);
    await unlink(target).catch((err) => {
      if (!isMissing(err)) throw err;
    });
  }

  async read(key: string): Promise<Buffer | null> {
    const target = await this.#keyPath(key, false);
    if (!target) return null;
    let st;
    try {
      st = await lstat(target, { bigint: true });
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    if (st.isSymbolicLink() || !st.isFile()) throw new StorageError("Stored media is not a regular file");
    if (st.size > BigInt(MAX_STORED_BYTES)) throw new StorageError("Stored media is too large");
    const handle = await open(target, READ_FLAGS);
    try {
      // The opened file must be the one that was checked (no swap between lstat and open).
      const opened = await handle.stat({ bigint: true });
      if (opened.ino !== st.ino || opened.dev !== st.dev || !opened.isFile()) throw new StorageError("Stored media changed while opening");
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async remove(key: string): Promise<boolean> {
    const target = await this.#keyPath(key, false);
    if (!target) return false;
    let st;
    try {
      st = await lstat(target);
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
    if (st.isSymbolicLink() || !st.isFile()) throw new StorageError("Stored media is not a regular file");
    await unlink(target);
    return true;
  }

  async probe() {
    const root = await this.root();
    const target = path.join(root, `.readiness-${randomUUID()}.probe`);
    assertContained(root, target);
    if (!PROBE_FILE_PATTERN.test(path.basename(target))) throw new StorageError("Invalid probe name");
    const handle = await open(target, "wx", 0o600);
    // Always close and delete; the first failure (including a failed delete) fails the probe.
    let failure: unknown;
    await handle.write(Uint8Array.of(1)).catch((e) => (failure ??= e));
    await handle.close().catch((e) => (failure ??= e));
    await unlink(target).catch((e) => (failure ??= e));
    if (failure) throw failure;
  }
}

let storage: MediaStorage | undefined;

/** The configured storage backend (local filesystem, `STORAGE_LOCAL_PATH`). */
export function mediaStorage(): MediaStorage {
  if (!storage) {
    const e = env();
    storage = new LocalStorage(configuredRoot(e.STORAGE_LOCAL_PATH, e.NODE_ENV));
  }
  return storage;
}
