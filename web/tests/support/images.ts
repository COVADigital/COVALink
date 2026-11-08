import { crc32 } from "node:zlib";
import sharp from "sharp";

/**
 * Test images generated at run time with sharp (no binary fixtures). The
 * EXIF/orientation helpers use `withMetadata`/`withExif` deliberately: they
 * build hostile inputs; the production pipeline never calls them.
 */

const solid = (width: number, height: number, background = "#3366cc") =>
  sharp({ create: { width, height, channels: 3, background } });

export const jpeg = (w = 64, h = 32, background?: string) => solid(w, h, background).jpeg().toBuffer();
export const png = (w = 64, h = 32, background?: string) => solid(w, h, background).png().toBuffer();
export const webp = (w = 64, h = 32, background?: string) => solid(w, h, background).webp().toBuffer();
export const gif = () => solid(16, 16).gif().toBuffer();
export const svg = () =>
  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>');

/** A JPEG whose EXIF says "rotate 90° clockwise" (6) and carries identifying text and GPS data. */
export const orientedJpegWithExif = (w = 64, h = 32) =>
  solid(w, h)
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExif({ IFD0: { Artist: "SECRET-ARTIST", Copyright: "SECRET-EXIF" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } })
    .toBuffer();

export async function animatedWebp() {
  const f1 = await solid(16, 16, "#ff0000").png().toBuffer();
  const f2 = await solid(16, 16, "#0000ff").png().toBuffer();
  return sharp([f1, f2], { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
}

function pngChunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A PNG with an `acTL` chunk after IHDR: an APNG declaring two frames (decoders show the first). */
export async function apng() {
  const base = await png(16, 16);
  const ihdrEnd = 8 + 12 + 13;
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(2, 0);
  actl.writeUInt32BE(0, 4);
  return Buffer.concat([base.subarray(0, ihdrEnd), pngChunk("acTL", actl), base.subarray(ihdrEnd)]);
}

export const withTrailing = (img: Buffer, payload = "<html><script>alert(1)</script></html>PK\x03\x04") =>
  Buffer.concat([img, Buffer.from(payload, "binary")]);

/** A WebP whose RIFF size is extended to cover an appended payload (structurally consistent, foreign chunk). */
export function webpWithForeignChunk(img: Buffer, payload = "<?php system($_GET[1]); ?>") {
  const data = Buffer.from(payload, "binary");
  const pad = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  const header = Buffer.alloc(8);
  header.write("ZZZZ", 0, "ascii");
  header.writeUInt32LE(data.length, 4);
  const out = Buffer.concat([img, header, data, pad]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

export const truncated = (img: Buffer, keep = 0.6) => img.subarray(0, Math.floor(img.length * keep));
