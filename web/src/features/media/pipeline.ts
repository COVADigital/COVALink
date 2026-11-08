import "server-only";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import {
  MAX_INPUT_BYTES,
  MAX_INPUT_DIMENSION,
  MAX_INPUT_PIXELS,
  OUTPUT_BOX,
  OUTPUT_QUALITY,
  type MediaKind,
} from "./constants";
import { sniffImage, type SniffResult } from "./sniff";

/**
 * Image normalization. The input is checked structurally
 * (`sniffImage`), then its metadata, then fully decoded and re-encoded:
 * oriented, fitted inside the kind's box without enlargement, WebP quality
 * 82, every piece of metadata dropped. Only the re-encoded pixels are kept,
 * so nothing from the original file (EXIF/GPS, ICC, comments, appended data)
 * reaches storage. No global sharp setting is changed.
 */

export const PROCESS_TIMEOUT_SECONDS = 15;

/**
 * One libvips worker thread per image. libvips otherwise sizes
 * its pool from the host's cores, not the container's CPU quota, and memory
 * per decode grows with threads: on a 32-core host two worst-case 40 MP
 * decodes needed ~1 GiB and were OOM-killed under a 1 GiB limit, against
 * ~360 MiB with one thread each (and no slower). The decode gate's two active
 * slots supply the parallelism.
 */
export const LIBVIPS_THREADS_PER_IMAGE = 1;
sharp.concurrency(LIBVIPS_THREADS_PER_IMAGE);

export type ImageRejection =
  | "empty"
  | "too_large"
  | "unsupported"
  | "svg"
  | "gif"
  | "animated"
  | "trailing"
  | "malformed"
  | "dimensions"
  | "pixels"
  | "timeout";

export class ImageRejectedError extends Error {
  constructor(readonly reason: ImageRejection) {
    super(`Image rejected: ${reason}`);
    this.name = "ImageRejectedError";
  }
}

export interface ProcessedImage {
  data: Buffer;
  width: number;
  height: number;
}

const inputOptions = { failOn: "warning", limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true } as const;

function rejectSniff(r: SniffResult): asserts r is Extract<SniffResult, { ok: true }> {
  if (!r.ok) throw new ImageRejectedError(r.reason);
}

/** Decoder errors are reported as a malformed image; the pixel limit and sharp's timeout as such. */
function decodeFailure(err: unknown): never {
  const message = err instanceof Error ? err.message : "";
  throw new ImageRejectedError(/pixel limit/i.test(message) ? "pixels" : /timeout/i.test(message) ? "timeout" : "malformed");
}

/**
 * Every sharp instance used on upload bytes: the strict input options and the
 * processing timeout. Both phases (metadata and the full
 * decode/re-encode) are built here.
 *
 * Note: sharp 0.35.5 enforces `timeout()` in its pipeline worker
 * (`src/pipeline.cc`) but its metadata worker (`src/metadata.cc`) has no
 * timeout or progress hook, so for `metadata()` the setting is carried but
 * not enforced by the library. That phase is a header parse of an in-memory
 * input of at most 5 MiB; a decode slot is still released only when it
 * really settles.
 */
export function decoder(bytes: Buffer) {
  return sharp(bytes, inputOptions).timeout({ seconds: PROCESS_TIMEOUT_SECONDS });
}

export async function processImage(inputPath: string, kind: MediaKind, makeDecoder: typeof decoder = decoder): Promise<ProcessedImage> {
  const bytes = await readFile(inputPath);
  if (bytes.length === 0) throw new ImageRejectedError("empty");
  if (bytes.length > MAX_INPUT_BYTES) throw new ImageRejectedError("too_large");
  const sniffed = sniffImage(bytes);
  rejectSniff(sniffed);

  const meta = await makeDecoder(bytes).metadata().catch(decodeFailure);
  if (meta.format !== sniffed.format) throw new ImageRejectedError("malformed");
  if ((meta.pages ?? 1) !== 1) throw new ImageRejectedError("animated");
  const { width, height } = meta;
  if (!width || !height) throw new ImageRejectedError("malformed");
  if (width > MAX_INPUT_DIMENSION || height > MAX_INPUT_DIMENSION) throw new ImageRejectedError("dimensions");
  if (width * height > MAX_INPUT_PIXELS) throw new ImageRejectedError("pixels");

  const box = OUTPUT_BOX[kind];
  const { data, info } = await makeDecoder(bytes)
    .autoOrient()
    .resize({ width: box, height: box, fit: "inside", withoutEnlargement: true })
    .webp({ quality: OUTPUT_QUALITY })
    .toBuffer({ resolveWithObject: true })
    .catch(decodeFailure);

  if (info.format !== "webp" || data.length === 0 || info.width < 1 || info.height < 1 || info.width > box || info.height > box) {
    throw new ImageRejectedError("malformed");
  }
  return { data, width: info.width, height: info.height };
}
