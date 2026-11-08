/**
 * Container checks on the raw upload bytes, run before any decoder sees them.
 * The client's Content-Type and file extension are never consulted.
 * Only static, single-image JPEG, PNG and WebP files whose structure ends
 * where the image ends are accepted; anything else (SVG, GIF, AVIF/HEIC,
 * HTML, archives, animation, multi-picture JPEG, appended payloads) is
 * rejected here. Passing these checks is necessary, not sufficient: the
 * image is then fully decoded and re-encoded.
 */

export type SniffedFormat = "jpeg" | "png" | "webp";

export type SniffResult =
  | { ok: true; format: SniffedFormat }
  | { ok: false; reason: "unsupported" | "svg" | "gif" | "animated" | "trailing" | "malformed" };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len));
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
const u32le = (b: Uint8Array, at: number) => b[at] + (b[at + 1] << 8) + (b[at + 2] << 16) + ((b[at + 3] << 24) >>> 0);

export function sniffImage(bytes: Uint8Array): SniffResult {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return checkJpeg(bytes);
  if (bytes.length >= 8 && startsWith(bytes, PNG_SIGNATURE)) return checkPng(bytes);
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return checkWebp(bytes);
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return { ok: false, reason: "gif" };
  if (looksLikeSvg(bytes)) return { ok: false, reason: "svg" };
  return { ok: false, reason: "unsupported" };
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 1024)).replace(/^﻿/, "").trimStart().toLowerCase();
  return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"));
}

/**
 * Walks the marker segments from SOI to the first EOI. Entropy-coded data
 * after each SOS is skipped to the next real marker (0xFF not followed by
 * 0x00 or RSTn). After EOI only zero padding is allowed: a second image
 * (multi-picture JPEG) or any appended payload is rejected.
 */
function checkJpeg(b: Uint8Array): SniffResult {
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return { ok: false, reason: "malformed" };
    while (b[i] === 0xff) i++; // fill bytes
    if (i >= b.length) return { ok: false, reason: "malformed" };
    const marker = b[i++];
    if (marker === 0xd9) return trailingZeros(b, i);
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd8 || marker === 0x00) return { ok: false, reason: "malformed" };
    if (i + 2 > b.length) return { ok: false, reason: "malformed" };
    const len = (b[i] << 8) | b[i + 1];
    if (len < 2 || i + len > b.length) return { ok: false, reason: "malformed" };
    i += len;
    if (marker === 0xda) {
      // Entropy-coded segment: find the next marker.
      while (i < b.length) {
        if (b[i] === 0xff && i + 1 < b.length) {
          const next = b[i + 1];
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) break;
        }
        i++;
      }
      if (i >= b.length) return { ok: false, reason: "malformed" };
    }
  }
  return { ok: false, reason: "malformed" };
}

function trailingZeros(b: Uint8Array, from: number): SniffResult {
  for (let i = from; i < b.length; i++) if (b[i] !== 0x00) return { ok: false, reason: "trailing" };
  return { ok: true, format: "jpeg" };
}

/** Walks the chunks to IEND, which must end the file. Any `acTL` chunk means APNG. */
function checkPng(b: Uint8Array): SniffResult {
  let i = 8;
  let first = true;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    const type = ascii(b, i + 4, 4);
    if (first && type !== "IHDR") return { ok: false, reason: "malformed" };
    first = false;
    if (!/^[A-Za-z]{4}$/.test(type) || len > b.length - i - 12) return { ok: false, reason: "malformed" };
    if (type === "acTL" || type === "fcTL" || type === "fdAT") return { ok: false, reason: "animated" };
    i += 12 + len;
    if (type === "IEND") return i === b.length ? { ok: true, format: "png" } : { ok: false, reason: "trailing" };
  }
  return { ok: false, reason: "malformed" };
}

/**
 * The RIFF size must cover exactly the file. Animation is rejected by the
 * VP8X animation flag or an ANIM/ANMF chunk.
 */
function checkWebp(b: Uint8Array): SniffResult {
  const riffSize = u32le(b, 4);
  if (riffSize % 2 === 1 || 8 + riffSize !== b.length) return 8 + riffSize < b.length ? { ok: false, reason: "trailing" } : { ok: false, reason: "malformed" };
  let i = 12;
  while (i + 8 <= b.length) {
    const type = ascii(b, i, 4);
    const len = u32le(b, i + 4);
    if (len > b.length - i - 8) return { ok: false, reason: "malformed" };
    if (type === "ANIM" || type === "ANMF") return { ok: false, reason: "animated" };
    if (type === "VP8X" && len >= 1 && (b[i + 8] & 0x02) !== 0) return { ok: false, reason: "animated" };
    i += 8 + len + (len % 2);
  }
  return i === b.length ? { ok: true, format: "webp" } : { ok: false, reason: "malformed" };
}
