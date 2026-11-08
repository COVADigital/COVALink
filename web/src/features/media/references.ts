import type { MediaKind } from "./constants";
import { mediaKeyFromUrl } from "./layout.mjs";

/**
 * Structural media-reference detection. Walks raw stored JSON and
 * reports every string value that is exactly a canonical `/media/{key}` URL,
 * wherever it is: known fields, unknown keys, locked themes or future block
 * types all count, because deletion must never break a stored reference the
 * current schema doesn't understand. No substring matching.
 */

export interface MediaReference {
  key: string;
  /** Location in the document, e.g. `["header", "avatarUrl"]`. */
  path: (string | number)[];
}

/** Iterative (no recursion limit), so arbitrarily deep stored JSON is still scanned completely. */
export function collectMediaReferences(raw: unknown): MediaReference[] {
  const out: MediaReference[] = [];
  const stack: [unknown, (string | number)[]][] = [[raw, []]];
  while (stack.length) {
    const [v, path] = stack.pop()!;
    if (typeof v === "string") {
      const key = mediaKeyFromUrl(v);
      if (key) out.push({ key, path });
    } else if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push([v[i], [...path, i]]);
    } else if (v && typeof v === "object") {
      const entries = Object.entries(v);
      for (let i = entries.length - 1; i >= 0; i--) stack.push([entries[i][1], [...path, entries[i][0]]]);
    }
  }
  return out;
}

export const AVATAR_PATH = "header.avatarUrl";
export const BACKGROUND_PATH = "theme.background.imageUrl";

/**
 * The config of the image block whose `src` is at `path` in `doc`, or null.
 * Only `blocks.{i}.config.src` of a block whose stored type is `image` counts;
 * a `src` in any other block type or position isn't classified.
 */
export function imageBlockAt(path: (string | number)[], doc: unknown): Record<string, unknown> | null {
  if (path.length !== 4 || path[0] !== "blocks" || typeof path[1] !== "number" || path[2] !== "config" || path[3] !== "src") return null;
  const blocks = (doc as { blocks?: unknown } | null)?.blocks;
  const block = Array.isArray(blocks) ? (blocks[path[1]] as { type?: unknown; config?: unknown } | null) : null;
  if (!block || block.type !== "image" || !block.config || typeof block.config !== "object") return null;
  return block.config as Record<string, unknown>;
}

/**
 * The kind a reference must have at a known position, or null for any other
 * position: the avatar, the theme background, and the `src` of an image block
 * in `doc` (block images share the background library).
 */
export function expectedKind(path: (string | number)[], doc?: unknown): MediaKind | null {
  const p = path.join(".");
  if (p === AVATAR_PATH) return "avatar";
  if (p === BACKGROUND_PATH) return "background";
  if (doc !== undefined && imageBlockAt(path, doc)) return "background";
  return null;
}

/** Distinct keys referenced anywhere in the given documents. */
export function referencedKeys(...docs: unknown[]): Set<string> {
  return new Set(docs.flatMap((d) => collectMediaReferences(d).map((r) => r.key)));
}
