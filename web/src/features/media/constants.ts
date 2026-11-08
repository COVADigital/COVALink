/**
 * Media limits and kinds shared by the upload pipeline, the API and the editor.
 * The ceilings are fixed code constants: system settings can lower
 * the per-user quota and upload rate, never these.
 */

export const MEDIA_KINDS = ["avatar", "background"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export const isMediaKind = (v: unknown): v is MediaKind => (MEDIA_KINDS as readonly unknown[]).includes(v);

/** Raw upload body ceiling: 5 MiB. */
export const MAX_INPUT_BYTES = 5 * 1024 * 1024;
/** Either side of the decoded input. */
export const MAX_INPUT_DIMENSION = 8192;
/** Decoded area (width × height). */
export const MAX_INPUT_PIXELS = 40_000_000;
/** Output box per kind; images are fitted inside without enlargement. */
export const OUTPUT_BOX: Record<MediaKind, number> = { avatar: 512, background: 2048 };
export const OUTPUT_QUALITY = 82;
export const OUTPUT_MIME = "image/webp";
/** Largest stored file the server will read back (the DB constraint allows the same). */
export const MAX_STORED_BYTES = 16 * 1024 * 1024;
/** Longest display name kept for an upload. */
export const MAX_ORIGINAL_NAME = 100;

/** File types the picker offers; the server decides from the bytes, never from this. */
export const ACCEPT_TYPES = "image/jpeg,image/png,image/webp";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
