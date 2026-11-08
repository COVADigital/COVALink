// Storage-key and on-disk layout rules for uploaded media. Plain ESM
// with no imports so the same rules are used by the app (browser and server)
// and by scripts/media-gc.mjs without TypeScript tooling.

/** Path prefix under which uploaded media is served by this app. */
export const MEDIA_PATH_PREFIX = "/media/";

/** A storage key: a lowercase random (v4) UUID plus `.webp`. Nothing else is ever a key. */
export const MEDIA_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/;

/** The canonical public URL of a key: `/media/{key}`. */
export const MEDIA_URL_PATTERN = /^\/media\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp)$/;

/** Temporary files under `{root}/tmp/`: upload intake and processed output before it is published. */
export const TEMP_DIR = "tmp";
export const TEMP_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:upload|webp\.tmp)$/;

/** Readiness probe files, created and removed in `{root}` by the storage probe. */
export const PROBE_FILE_PATTERN = /^\.readiness-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.probe$/;

/** Two-character shard directory names. */
export const SHARD_PATTERN = /^[0-9a-f]{2}$/;

/** @param {unknown} key */
export function isMediaKey(key) {
  return typeof key === "string" && MEDIA_KEY_PATTERN.test(key);
}

/** @param {string} key */
export function mediaUrl(key) {
  if (!isMediaKey(key)) throw new Error("Not a media key");
  return `${MEDIA_PATH_PREFIX}${key}`;
}

/**
 * The key of an exact canonical media URL, or null. No trimming, decoding or
 * normalization: anything that isn't exactly `/media/{key}` is not a reference.
 * @param {unknown} value
 * @returns {string | null}
 */
export function mediaKeyFromUrl(value) {
  if (typeof value !== "string") return null;
  const m = MEDIA_URL_PATTERN.exec(value);
  return m ? m[1] : null;
}

/**
 * Path segments of a key relative to the storage root: `[k0k1, k2k3, key]`.
 * @param {string} key
 * @returns {[string, string, string]}
 */
export function keySegments(key) {
  if (!isMediaKey(key)) throw new Error("Not a media key");
  return [key.slice(0, 2), key.slice(2, 4), key];
}
