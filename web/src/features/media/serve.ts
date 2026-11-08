import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { mediaAssets } from "@/db/schema";
import { logger } from "@/lib/logger";
import { mediaResponseHeaders } from "@/lib/security/headers";
import { isMediaKey } from "./layout.mjs";
import { mediaStorage, type MediaStorage } from "./storage";

/**
 * `GET /media/{key}`. The key must match the exact pattern and a
 * live `media_assets` row must exist before any path is derived or file
 * opened: a deleted row means 404 at once, even while an orphan file
 * remains. Unknown, malformed and deleted keys get the same 404. The URL is
 * an unguessable capability: anyone holding it can fetch the image, so
 * immutable caching is allowed; deletion can't recall copies already cached
 * by browsers or CDNs.
 */

export const IMMUTABLE = "public, max-age=31536000, immutable";

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { ...mediaResponseHeaders(), "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function serveMedia(key: string, storage: MediaStorage = mediaStorage()): Promise<Response> {
  if (!isMediaKey(key)) return notFound();
  const row = await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.storageKey, key), columns: { storageKey: true } });
  if (!row) return notFound();
  let data: Buffer | null;
  try {
    data = await storage.read(row.storageKey);
  } catch (err) {
    logger.error({ storageKey: row.storageKey, errName: (err as Error)?.name }, "Media file unreadable");
    return notFound();
  }
  if (!data) {
    logger.warn({ storageKey: row.storageKey }, "Media row has no file");
    return notFound();
  }
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      ...mediaResponseHeaders(),
      "content-type": "image/webp",
      "content-length": String(data.length),
      "cache-control": IMMUTABLE,
    },
  });
}
