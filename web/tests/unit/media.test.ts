import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_INPUT_BYTES, MAX_INPUT_PIXELS } from "@/features/media/constants";
import { ConcurrencyGate, DeadlineError, GateSaturatedError, withDeadline } from "@/features/media/gate";
import { IntakeError, readBodyToFile, writeFully } from "@/features/media/intake";
import { isMediaKey, keySegments, mediaKeyFromUrl, mediaUrl } from "@/features/media/layout.mjs";
import { decoder, ImageRejectedError, LIBVIPS_THREADS_PER_IMAGE, PROCESS_TIMEOUT_SECONDS, processImage } from "@/features/media/pipeline";
import { collectMediaReferences, expectedKind, referencedKeys } from "@/features/media/references";
import { isSameOrigin, sanitizeOriginalName } from "@/features/media/request";
import { sniffImage } from "@/features/media/sniff";
import { assertContained, configuredRoot, LocalStorage, StorageError } from "@/features/media/storage";
import { parseImageSrc } from "@/lib/validation/media";
import * as img from "../support/images";

const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e.webp";
const KEY2 = "7c9e6679-7425-40de-944b-e07fc1f90ae7.webp";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "covalink-media-test-unit-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let fileCount = 0;
async function inputFile(bytes: Buffer, name = `in-${++fileCount}.bin`) {
  const p = path.join(dir, name);
  await writeFile(p, bytes);
  return p;
}

describe("media keys and URLs (exact canonical form only)", () => {
  it("accepts only lowercase v4 UUID .webp keys and builds /media/{key}", () => {
    expect(isMediaKey(KEY)).toBe(true);
    expect(mediaUrl(KEY)).toBe(`/media/${KEY}`);
    expect(keySegments(KEY)).toEqual(["0f", "8f", KEY]);
    for (const bad of [
      KEY.toUpperCase(),
      KEY.replace(".webp", ".png"),
      KEY.replace("-469f-", "-169f-"), // not v4
      `../${KEY}`,
      `a/${KEY}`,
      `${KEY}\u0000`,
      ` ${KEY}`,
      "",
      "0f8fad5b-d9cb-469f-a165-70867728950e.webp.webp",
    ]) {
      expect(isMediaKey(bad), bad).toBe(false);
      expect(() => keySegments(bad)).toThrow();
    }
  });

  it("recognizes a media URL only when it is exactly canonical", () => {
    expect(mediaKeyFromUrl(`/media/${KEY}`)).toBe(KEY);
    for (const bad of [
      ` /media/${KEY}`,
      `/media/${KEY} `,
      `/media/${KEY}?v=1`,
      `/media/${KEY}#x`,
      `/MEDIA/${KEY}`,
      `/media//${KEY}`,
      `/media/../media/${KEY}`,
      `/media/%2e%2e/${KEY}`,
      `https://example.com/media/${KEY}`,
      `x/media/${KEY}`,
      "/media/avatar.png",
    ]) {
      expect(mediaKeyFromUrl(bad), bad).toBeNull();
    }
    expect(mediaKeyFromUrl(42)).toBeNull();
  });

  it("parseImageSrc keeps canonical media URLs and https, and rejects legacy /media paths", () => {
    expect(parseImageSrc(`/media/${KEY}`)).toBe(`/media/${KEY}`);
    expect(parseImageSrc("https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
    expect(parseImageSrc("/media/user/avatar.png")).toBeNull();
    expect(parseImageSrc("/media/../etc/passwd.webp")).toBeNull();
    expect(parseImageSrc("javascript:alert(1)")).toBeNull();
  });
});

describe("container sniffing (bytes decide, never the name or Content-Type)", () => {
  it("accepts static JPEG, PNG and WebP", async () => {
    expect(sniffImage(await img.jpeg())).toEqual({ ok: true, format: "jpeg" });
    expect(sniffImage(await img.png())).toEqual({ ok: true, format: "png" });
    expect(sniffImage(await img.webp())).toEqual({ ok: true, format: "webp" });
  });

  it("rejects SVG, GIF, HTML and archives before any decoder runs", async () => {
    expect(sniffImage(img.svg())).toEqual({ ok: false, reason: "svg" });
    expect(sniffImage(Buffer.from('\uFEFF  <?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toEqual({ ok: false, reason: "svg" });
    expect(sniffImage(await img.gif())).toEqual({ ok: false, reason: "gif" });
    expect(sniffImage(Buffer.from("<html><script>alert(1)</script></html>"))).toEqual({ ok: false, reason: "unsupported" });
    expect(sniffImage(Buffer.from("PK\x03\x04rest-of-zip", "binary"))).toEqual({ ok: false, reason: "unsupported" });
    expect(sniffImage(Buffer.alloc(0))).toEqual({ ok: false, reason: "unsupported" });
  });

  it("rejects animation: APNG and animated WebP", async () => {
    expect(sniffImage(await img.apng())).toEqual({ ok: false, reason: "animated" });
    expect(sniffImage(await img.animatedWebp())).toEqual({ ok: false, reason: "animated" });
  });

  it("rejects data appended after the image (polyglots) in every format", async () => {
    expect(sniffImage(img.withTrailing(await img.jpeg()))).toEqual({ ok: false, reason: "trailing" });
    expect(sniffImage(img.withTrailing(await img.png(), "<?php echo 1; ?>"))).toEqual({ ok: false, reason: "trailing" });
    expect(sniffImage(img.withTrailing(await img.webp()))).toEqual({ ok: false, reason: "trailing" });
    // A second JPEG after EOI (multi-picture) is trailing data too; zero padding is not.
    const j = await img.jpeg();
    expect(sniffImage(Buffer.concat([j, j]))).toEqual({ ok: false, reason: "trailing" });
    expect(sniffImage(Buffer.concat([j, Buffer.alloc(16)]))).toEqual({ ok: true, format: "jpeg" });
  });

  it("rejects malformed and truncated containers", async () => {
    expect(sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 0x41)]))).toEqual({ ok: false, reason: "malformed" });
    expect(sniffImage(img.truncated(await img.jpeg()))).toEqual({ ok: false, reason: "malformed" });
    expect(sniffImage(img.truncated(await img.png()))).toEqual({ ok: false, reason: "malformed" });
    expect(sniffImage(img.truncated(await img.webp()))).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("processImage (full decode and WebP re-encode)", () => {
  it.each([
    ["jpeg", img.jpeg],
    ["png", img.png],
    ["webp", img.webp],
  ] as const)("normalizes %s to WebP within the box, without enlargement", async (_, make) => {
    const out = await processImage(await inputFile(await make(64, 32)), "avatar");
    const meta = await sharp(out.data).metadata();
    expect(meta.format).toBe("webp");
    expect([out.width, out.height, meta.width, meta.height]).toEqual([64, 32, 64, 32]);
  });

  it("fits avatars inside 512 × 512 and backgrounds inside 2048 × 2048", async () => {
    const avatar = await processImage(await inputFile(await img.png(1000, 600)), "avatar");
    expect([avatar.width, avatar.height]).toEqual([512, 307]);
    const background = await processImage(await inputFile(await img.jpeg(3000, 1000)), "background");
    expect([background.width, background.height]).toEqual([2048, 683]);
  });

  it("ignores the file name: an SVG named .jpg and a JPEG named .svg are judged by their bytes", async () => {
    await expect(processImage(await inputFile(img.svg(), "photo.jpg"), "avatar")).rejects.toMatchObject({ reason: "svg" });
    const ok = await processImage(await inputFile(await img.jpeg(), "image.svg"), "avatar");
    expect((await sharp(ok.data).metadata()).format).toBe("webp");
  });

  it("applies EXIF orientation before resizing and strips all metadata (EXIF, GPS, ICC, XMP)", async () => {
    const input = await img.orientedJpegWithExif(64, 32);
    expect(input.includes("SECRET-ARTIST")).toBe(true);
    const out = await processImage(await inputFile(input), "avatar");
    expect([out.width, out.height]).toEqual([32, 64]); // rotated
    const meta = await sharp(out.data).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    for (const marker of ["SECRET-ARTIST", "SECRET-EXIF", "GPS", "Exif"]) expect(out.data.includes(marker), marker).toBe(false);
  });

  it("re-encoding drops foreign chunks: a structurally valid WebP carrying a PHP payload comes out clean", async () => {
    const input = img.webpWithForeignChunk(await img.webp());
    expect(sniffImage(input)).toEqual({ ok: true, format: "webp" });
    const out = await processImage(await inputFile(input), "avatar");
    expect(out.data.includes("<?php")).toBe(false);
    expect(out.data.includes("ZZZZ")).toBe(false);
  });

  it.each([
    ["SVG", () => Promise.resolve(img.svg()), "svg"],
    ["GIF", img.gif, "gif"],
    ["animated WebP", img.animatedWebp, "animated"],
    ["APNG", img.apng, "animated"],
    ["JPEG + HTML/ZIP payload", async () => img.withTrailing(await img.jpeg()), "trailing"],
    ["garbage behind a JPEG signature", async () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 0x41)]), "malformed"],
    ["truncated JPEG", async () => img.truncated(await img.jpeg()), "malformed"],
    ["truncated PNG (valid header, broken data)", async () => img.truncated(await img.png(256, 256), 0.7), "malformed"],
    ["empty file", () => Promise.resolve(Buffer.alloc(0)), "empty"],
  ])("rejects %s", async (_, make, reason) => {
    const err = await processImage(await inputFile(await make()), "avatar").catch((e) => e);
    expect(err).toBeInstanceOf(ImageRejectedError);
    expect(err.reason).toBe(reason);
  });

  it("decodes fully: a PNG whose structure and header are valid but whose pixel data is corrupt is rejected", async () => {
    const good = Buffer.from(await sharp({ create: { width: 128, height: 128, channels: 3, background: "#000000", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).png().toBuffer());
    const idat = good.indexOf("IDAT");
    const corrupt = Buffer.from(good);
    for (let i = idat + 40; i < idat + 200; i++) corrupt[i] ^= 0x5a;
    expect(sniffImage(corrupt)).toEqual({ ok: true, format: "png" }); // container intact
    await expect(sharp(corrupt).metadata()).resolves.toMatchObject({ format: "png", width: 128 }); // metadata alone passes
    await expect(processImage(await inputFile(corrupt), "avatar")).rejects.toMatchObject({ reason: "malformed" });
  });

  it("enforces the input ceilings: bytes, 8192 px per side, 40 megapixels", async () => {
    const big = Buffer.concat([await img.jpeg(), Buffer.alloc(MAX_INPUT_BYTES)]);
    await expect(processImage(await inputFile(big), "avatar")).rejects.toMatchObject({ reason: "too_large" });
    await expect(processImage(await inputFile(await img.png(8193, 8)), "background")).rejects.toMatchObject({ reason: "dimensions" });
    // 7000 × 7000 = 49 MP: each side is allowed, the area is not.
    const huge = await sharp({ create: { width: 7000, height: 7000, channels: 3, background: "#000" } }).png({ compressionLevel: 9 }).toBuffer();
    await expect(processImage(await inputFile(huge), "background")).rejects.toMatchObject({ reason: "pixels" });
  });
});

describe("every sharp phase carries the processing timeout", () => {
  type Opts = { timeoutSeconds: number; input: { failOn: string; limitInputPixels: number; sequentialRead: boolean } };
  const recording = () => {
    const seen: Opts[] = [];
    const make = (b: Buffer) => {
      const s = decoder(b);
      seen.push((s as unknown as { options: Opts }).options);
      return s;
    };
    return { seen, make };
  };

  it("builds both the metadata and the decode/re-encode instance with the timeout and strict input options", async () => {
    const { seen, make } = recording();
    const out = await processImage(await inputFile(await img.png(800, 600)), "avatar", make);
    expect([out.width, out.height]).toEqual([512, 384]);
    expect(seen).toHaveLength(2); // metadata(), then the full pipeline
    for (const o of seen) {
      expect(o.timeoutSeconds).toBe(PROCESS_TIMEOUT_SECONDS);
      expect(o.input).toMatchObject({ failOn: "warning", limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true });
    }
    expect(PROCESS_TIMEOUT_SECONDS).toBe(15);
  });

  it("keeps the rejection mapping: container rejections never reach sharp, metadata rejections stop after one instance", async () => {
    const svg = recording();
    await expect(processImage(await inputFile(img.svg()), "avatar", svg.make)).rejects.toMatchObject({ reason: "svg" });
    expect(svg.seen).toHaveLength(0);
    const wide = recording();
    await expect(processImage(await inputFile(await img.png(8193, 8)), "background", wide.make)).rejects.toMatchObject({ reason: "dimensions" });
    expect(wide.seen).toHaveLength(1);
    expect(wide.seen[0].timeoutSeconds).toBe(PROCESS_TIMEOUT_SECONDS);
  });
});

describe("libvips threads per image", () => {
  it("uses one worker thread per image, independent of the host's core count", () => {
    expect(LIBVIPS_THREADS_PER_IMAGE).toBe(1);
    expect(sharp.concurrency()).toBe(1);
  });
});

describe("intake writes every byte despite partial writes", () => {
  /** Persists at most `max` bytes per call into memory, like a short write. */
  const shortWriter = (max: number) => {
    const out: number[] = [];
    let calls = 0;
    return {
      out,
      calls: () => calls,
      async write(buffer: Uint8Array, offset: number, length: number) {
        calls++;
        const n = Math.min(max, length);
        for (let i = 0; i < n; i++) out.push(buffer[offset + i]);
        return { bytesWritten: n };
      },
    };
  };

  it("continues from bytesWritten until the whole chunk is persisted, with no loss or duplication", async () => {
    const chunks = [Uint8Array.from({ length: 1000 }, (_, i) => i % 251), new Uint8Array([7]), Uint8Array.from({ length: 333 }, (_, i) => 255 - (i % 256))];
    const w = shortWriter(7);
    for (const c of chunks) await writeFully(w, c);
    expect(Buffer.from(w.out).equals(Buffer.concat(chunks))).toBe(true);
    expect(w.calls()).toBe(Math.ceil(1000 / 7) + 1 + Math.ceil(333 / 7));
  });

  it("treats a zero-progress or impossible write as an I/O failure instead of looping", async () => {
    const stuck = { write: async () => ({ bytesWritten: 0 }) };
    await expect(writeFully(stuck, new Uint8Array(10))).rejects.toThrow(/no progress/);
    const bogus = { write: async (_b: Uint8Array, _o: number, length: number) => ({ bytesWritten: length + 1 }) };
    await expect(writeFully(bogus, new Uint8Array(10))).rejects.toThrow(/no progress/);
    await expect(writeFully(stuck, new Uint8Array(0))).resolves.toBeUndefined();
  });

  it("readBodyToFile reports bytes accepted from the request and the file equals the body exactly", async () => {
    const target = path.join(dir, "intake-exact.upload");
    const parts = [Uint8Array.from({ length: 70_001 }, (_, i) => (i * 31) % 256), Uint8Array.from({ length: 3 }, () => 9)];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(p);
        c.close();
      },
    });
    await expect(readBodyToFile(stream, target, { maxBytes: MAX_INPUT_BYTES, timeoutMs: 5_000 })).resolves.toBe(70_004);
    expect((await readFile(target)).equals(Buffer.concat(parts))).toBe(true);
  });
});

describe("decode gate and deadline", () => {
  it("bounds active and queued work and refuses beyond it", async () => {
    const gate = new ConcurrencyGate({ maxActive: 1, maxQueued: 1, queueTimeoutMs: 5_000 });
    let release!: () => void;
    const first = gate.run(() => new Promise<void>((r) => (release = r)));
    const second = gate.run(async () => "second");
    expect(gate.active).toBe(1);
    expect(gate.queued).toBe(1);
    await expect(gate.run(async () => "third")).rejects.toBeInstanceOf(GateSaturatedError);
    release();
    await first;
    await expect(second).resolves.toBe("second");
    expect([gate.active, gate.queued]).toEqual([0, 0]);
  });

  it("times out queued waiters and keeps the slot until the running task really settles", async () => {
    const gate = new ConcurrencyGate({ maxActive: 1, maxQueued: 2, queueTimeoutMs: 50 });
    let release!: () => void;
    const running = gate.run(() => new Promise<void>((r) => (release = r)));
    await expect(gate.run(async () => 1)).rejects.toBeInstanceOf(GateSaturatedError);
    // The caller gives up on the running task, but its slot isn't freed early.
    await expect(withDeadline(running, 20)).rejects.toBeInstanceOf(DeadlineError);
    expect(gate.active).toBe(1);
    release();
    await running;
    expect(gate.active).toBe(0);
  });
});

/** A body stream that counts what was pulled; endless unless `total` is given. */
function countingStream(chunk: number, total = Infinity) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= total) return controller.close();
      state.pulled += chunk;
      controller.enqueue(new Uint8Array(chunk));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

describe("bounded intake", () => {
  it("writes a body within the limit to an exclusive file", async () => {
    const target = path.join(dir, "intake-ok.upload");
    const { stream } = countingStream(64 * 1024, 256 * 1024);
    await expect(readBodyToFile(stream, target, { maxBytes: MAX_INPUT_BYTES, timeoutMs: 5_000 })).resolves.toBe(256 * 1024);
    expect((await stat(target)).size).toBe(256 * 1024);
    await expect(readBodyToFile(countingStream(1, 1).stream, target, { maxBytes: 10, timeoutMs: 1000 })).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("stops an endless body right after 5 MiB, cancels it and removes the partial file", async () => {
    const target = path.join(dir, "intake-big.upload");
    const { stream, state } = countingStream(64 * 1024);
    const err = await readBodyToFile(stream, target, { maxBytes: MAX_INPUT_BYTES, timeoutMs: 10_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(IntakeError);
    expect(err.reason).toBe("too_large");
    expect(state.cancelled).toBe(true);
    // Read stops within one chunk (plus the stream's small queue) of the limit, never the whole body.
    expect(state.pulled).toBeLessThanOrEqual(MAX_INPUT_BYTES + 3 * 64 * 1024);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("times out a stalled body and removes the partial file", async () => {
    const target = path.join(dir, "intake-stall.upload");
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readBodyToFile(stream, target, { maxBytes: 1000, timeoutMs: 100 })).rejects.toMatchObject({ reason: "timeout" });
    expect(cancelled).toBe(true);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports an aborted body and an empty body, leaving no file", async () => {
    const aborted = path.join(dir, "intake-abort.upload");
    const failing = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(10));
      },
      pull(c) {
        c.error(new Error("client went away"));
      },
    });
    await expect(readBodyToFile(failing, aborted, { maxBytes: 1000, timeoutMs: 1000 })).rejects.toMatchObject({ reason: "aborted" });
    await expect(lstat(aborted)).rejects.toMatchObject({ code: "ENOENT" });
    const empty = path.join(dir, "intake-empty.upload");
    await expect(readBodyToFile(countingStream(1, 0).stream, empty, { maxBytes: 1000, timeoutMs: 1000 })).rejects.toMatchObject({ reason: "empty" });
    await expect(readBodyToFile(null, empty, { maxBytes: 1000, timeoutMs: 1000 })).rejects.toMatchObject({ reason: "empty" });
    await expect(lstat(empty)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("local storage paths", () => {
  it("checks containment with path.relative, not string prefixes", () => {
    const root = path.resolve(dir, "root");
    expect(() => assertContained(root, path.join(root, "0f", "8f", KEY))).not.toThrow();
    for (const bad of [root, path.resolve(root, ".."), `${root}-evil${path.sep}x`, path.resolve(root, "..", "root-evil", "x"), path.parse(root).root]) {
      expect(() => assertContained(root, bad), bad).toThrow(StorageError);
    }
  });

  it("refuses a relative storage root in production only", () => {
    expect(() => configuredRoot("./data/uploads", "production")).toThrow(/absolute/);
    expect(configuredRoot("./data/uploads", "development")).toBe(path.resolve("./data/uploads"));
    expect(configuredRoot(path.resolve(dir, "abs"), "production")).toBe(path.resolve(dir, "abs"));
    expect(() => configuredRoot("  ", "development")).toThrow();
  });

  it("publishes atomically into the sharded layout, reads back, never overwrites, and removes", async () => {
    const storage = new LocalStorage(path.join(dir, "store-a"));
    const temp = await storage.writeTemp(Buffer.from("webp-bytes"));
    expect(path.basename(path.dirname(temp))).toBe("tmp");
    await storage.publish(temp, KEY);
    const root = await storage.root();
    expect((await stat(path.join(root, "0f", "8f", KEY))).isFile()).toBe(true);
    await expect(lstat(temp)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await storage.read(KEY))?.toString()).toBe("webp-bytes");
    const again = await storage.writeTemp(Buffer.from("other"));
    await expect(storage.publish(again, KEY)).rejects.toThrow(/already exists/);
    await storage.removeTemp(again);
    expect(await storage.remove(KEY)).toBe(true);
    expect(await storage.remove(KEY)).toBe(false);
    expect(await storage.read(KEY)).toBeNull();
    expect(await storage.read(KEY2)).toBeNull(); // shard directories don't exist: no file, no creation
    expect(await readdir(path.join(root, "tmp"))).toEqual([]);
  });

  it("rejects invalid keys and temp paths outside its own temp area", async () => {
    const storage = new LocalStorage(path.join(dir, "store-b"));
    for (const bad of ["../x.webp", `../../${KEY}`, KEY.toUpperCase(), "x.webp", ""]) {
      await expect(storage.read(bad), bad).rejects.toThrow(StorageError);
      await expect(storage.remove(bad), bad).rejects.toThrow(StorageError);
    }
    const outside = path.join(dir, "outside.webp.tmp");
    await writeFile(outside, "x");
    await expect(storage.publish(outside, KEY)).rejects.toThrow(StorageError);
    await expect(storage.removeTemp(outside)).rejects.toThrow(StorageError);
    await expect(stat(outside)).resolves.toBeTruthy();
  });

  it("never follows a symlinked shard directory or file out of the root", async () => {
    const storage = new LocalStorage(path.join(dir, "store-c"));
    const root = await storage.root();
    const elsewhere = path.join(dir, "elsewhere");
    await mkdir(path.join(elsewhere, "8f"), { recursive: true });
    await writeFile(path.join(elsewhere, "8f", KEY), "secret outside the root");
    // A directory junction needs no special rights on Windows; a symlink elsewhere.
    await symlink(elsewhere, path.join(root, "0f"), process.platform === "win32" ? "junction" : "dir");
    await expect(storage.read(KEY)).rejects.toThrow(StorageError);
    await expect(storage.remove(KEY)).rejects.toThrow(StorageError);
    const temp = await storage.writeTemp(Buffer.from("x"));
    await expect(storage.publish(temp, KEY)).rejects.toThrow(StorageError);
    await storage.removeTemp(temp);
    await expect(stat(path.join(elsewhere, "8f", KEY))).resolves.toBeTruthy();
  });

  it("the readiness probe creates and deletes its file, leaving nothing behind", async () => {
    const storage = new LocalStorage(path.join(dir, "store-d"));
    await storage.probe();
    await storage.probe();
    expect(await readdir(await storage.root())).toEqual([]);
  });
});

describe("structural media references", () => {
  const url = `/media/${KEY}`;

  it("finds exact URLs anywhere, including unknown and deeply nested fields", () => {
    const doc = {
      header: { avatarUrl: url },
      theme: { background: { imageUrl: `/media/${KEY2}` } },
      future: { list: [{ x: { y: [url] } }] },
      blocks: [{ type: "image-v9", config: { src: url } }],
    };
    expect(collectMediaReferences(doc).map((r) => r.path.join("."))).toEqual([
      "header.avatarUrl",
      "theme.background.imageUrl",
      "future.list.0.x.y.0",
      "blocks.0.config.src",
    ]);
    expect([...referencedKeys(doc)].sort()).toEqual([KEY, KEY2].sort());
    expect(expectedKind(["header", "avatarUrl"])).toBe("avatar");
    expect(expectedKind(["theme", "background", "imageUrl"])).toBe("background");
    expect(expectedKind(["blocks", 0, "config", "src"])).toBeNull();
  });

  it("ignores substrings, object keys and non-canonical spellings", () => {
    expect(collectMediaReferences({ a: `see ${url}`, [url]: 1, b: ` ${url}`, c: url.toUpperCase(), d: `https://x.test${url}` })).toEqual([]);
  });

  it("scans arbitrarily deep JSON without recursion limits", () => {
    let deep: unknown = url;
    for (let i = 0; i < 20_000; i++) deep = { n: deep };
    expect(collectMediaReferences(deep)).toHaveLength(1);
  });
});

describe("upload request helpers", () => {
  const req = (headers: Record<string, string>) => new Request("http://localhost:3000/api/media", { method: "POST", headers });

  it("accepts only same-origin requests", () => {
    const app = "http://localhost:3000";
    expect(isSameOrigin(req({ origin: app }), app)).toBe(true);
    expect(isSameOrigin(req({ origin: app, "sec-fetch-site": "same-origin" }), app)).toBe(true);
    expect(isSameOrigin(req({}), app)).toBe(false);
    expect(isSameOrigin(req({ origin: "https://evil.example" }), app)).toBe(false);
    expect(isSameOrigin(req({ origin: "null" }), app)).toBe(false);
    expect(isSameOrigin(req({ origin: app, "sec-fetch-site": "cross-site" }), app)).toBe(false);
    expect(isSameOrigin(req({ origin: app, "sec-fetch-site": "same-site" }), app)).toBe(false);
  });

  it("sanitizes the display name and never keeps a path", () => {
    expect(sanitizeOriginalName(encodeURIComponent("Holiday photo.JPG"))).toBe("Holiday photo.JPG");
    expect(sanitizeOriginalName(encodeURIComponent("C:\\Users\\me\\..\\secret.png"))).toBe("secret.png");
    expect(sanitizeOriginalName(encodeURIComponent("../../etc/passwd"))).toBe("passwd");
    expect(sanitizeOriginalName(encodeURIComponent("a\u202Egnp.exe\u0000\n"))).toBe("agnp.exe");
    expect(sanitizeOriginalName(encodeURIComponent("x".repeat(300)))).toHaveLength(100);
    expect(sanitizeOriginalName("%E0%A4%A")).toBeNull();
    expect(sanitizeOriginalName(encodeURIComponent("   "))).toBeNull();
    expect(sanitizeOriginalName(null)).toBeNull();
    expect(sanitizeOriginalName("a".repeat(513))).toBeNull();
  });
});
