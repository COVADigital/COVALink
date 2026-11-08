import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db, type Tx } from "@/db";
import { mediaAssets, mediaUploadAttempts, profiles, users } from "@/db/schema";
import { IMAGE_NOT_IN_LIBRARY, type ImageMediaLookup } from "@/features/blocks/input";
import { getSetting } from "@/features/settings/service";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { OUTPUT_MIME, type MediaKind } from "./constants";
import { mediaKeyFromUrl, mediaUrl } from "./layout.mjs";
import type { ProcessedImage } from "./pipeline";
import { AVATAR_PATH, BACKGROUND_PATH, collectMediaReferences, expectedKind, imageBlockAt, referencedKeys, type MediaReference } from "./references";
import { mediaStorage, type MediaStorage } from "./storage";
import type { MediaAssetView, MediaLibrary, MediaUsage } from "./types";

/**
 * Media ownership, limits and references. Every function
 * takes the acting user's id and scopes queries by `owner_id`; another user's
 * asset id yields NOT_FOUND. Files are written and removed only through
 * `MediaStorage`.
 */

const MIB = 1024 * 1024;

export type { MediaAssetView, MediaLibrary, MediaUsage };

// ---------------------------------------------------------------- limits --

/**
 * Consumes one upload attempt for the current fixed hourly window, before the
 * body is read. One atomic upsert: the row is created at 1 or incremented
 * only while below the limit, so concurrent attempts can't overshoot. Rows
 * from earlier windows are pruned. Deleting media never frees attempts.
 */
export async function consumeUploadAttempt(userId: string): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const limit = await getSetting("media.uploadsPerHour");
  const rows = await db
    .insert(mediaUploadAttempts)
    .values({ userId, windowStart: sql`date_trunc('hour', now())`, attempts: 1 })
    .onConflictDoUpdate({
      target: [mediaUploadAttempts.userId, mediaUploadAttempts.windowStart],
      set: { attempts: sql`${mediaUploadAttempts.attempts} + 1` },
      setWhere: sql`${mediaUploadAttempts.attempts} < ${limit}`,
    })
    .returning({ attempts: mediaUploadAttempts.attempts });
  await db
    .delete(mediaUploadAttempts)
    .where(and(eq(mediaUploadAttempts.userId, userId), lt(mediaUploadAttempts.windowStart, sql`now() - interval '1 day'`)));
  if (rows.length > 0) return { ok: true };
  const now = Date.now();
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((3_600_000 - (now % 3_600_000)) / 1000)) };
}

async function usedBytes(q: Tx | typeof db, ownerId: string): Promise<number> {
  const [row] = await q
    .select({ used: sql<number>`coalesce(sum(${mediaAssets.sizeBytes}), 0)::bigint`.mapWith(Number) })
    .from(mediaAssets)
    .where(eq(mediaAssets.ownerId, ownerId));
  return row?.used ?? 0;
}

export async function mediaUsage(ownerId: string): Promise<MediaUsage> {
  const [used, quotaMb] = await Promise.all([usedBytes(db, ownerId), getSetting("media.quotaMb")]);
  return { usedBytes: used, quotaBytes: quotaMb * MIB };
}

export const QUOTA_MESSAGE = "You've used all of your image storage. Delete images you no longer use, then try again.";

// ----------------------------------------------------------------- store --

/**
 * Stores processed output for `ownerId`. The decode already happened; here
 * the output is written to a temp file, then one short transaction locks the
 * owner's user row (serializing that owner's uploads), checks the quota
 * against stored usage, inserts the row and moves the file into place. If
 * anything fails after the move, the published file is removed; the temp
 * file is always removed.
 */
export async function storeAsset(
  ownerId: string,
  kind: MediaKind,
  image: ProcessedImage,
  originalName: string | null,
  storage: MediaStorage = mediaStorage(),
): Promise<{ asset: MediaAssetView; usage: MediaUsage }> {
  const quotaBytes = (await getSetting("media.quotaMb")) * MIB;
  const key = `${randomUUID()}.webp`;
  const tempPath = await storage.writeTemp(image.data);
  let published = false;
  try {
    const result = await db.transaction(async (tx) => {
      const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).for("update");
      if (!owner) throw new AppError("Your session has expired. Please sign in again.", "FORBIDDEN");
      const used = await usedBytes(tx, ownerId);
      if (used + image.data.length > quotaBytes) throw new AppError(QUOTA_MESSAGE, "LIMIT");
      const [row] = await tx
        .insert(mediaAssets)
        .values({
          ownerId,
          kind,
          storageKey: key,
          mimeType: OUTPUT_MIME,
          sizeBytes: image.data.length,
          width: image.width,
          height: image.height,
          originalName,
        })
        .returning();
      await storage.publish(tempPath, key);
      published = true;
      return { row, usedBytes: used + image.data.length };
    });
    return { asset: toView(result.row, []), usage: { usedBytes: result.usedBytes, quotaBytes } };
  } catch (err) {
    if (published) await removeStoredFile(key, "media.store_rollback", storage);
    throw err;
  } finally {
    await storage.removeTemp(tempPath).catch((err) => logger.warn({ errCode: err?.code }, "Media temp cleanup failed"));
  }
}

function toView(row: typeof mediaAssets.$inferSelect, usedBy: MediaAssetView["usedBy"]): MediaAssetView {
  return {
    id: row.id,
    kind: row.kind,
    url: mediaUrl(row.storageKey),
    width: row.width,
    height: row.height,
    sizeBytes: row.sizeBytes,
    originalName: row.originalName,
    createdAt: row.createdAt.toISOString(),
    usedBy,
  };
}

// --------------------------------------------------------------- library --

export async function listMedia(ownerId: string): Promise<MediaLibrary> {
  const [rows, owned, usage] = await Promise.all([
    db.select().from(mediaAssets).where(eq(mediaAssets.ownerId, ownerId)).orderBy(desc(mediaAssets.createdAt), desc(mediaAssets.id)),
    db.select({ id: profiles.id, handle: profiles.handle, draft: profiles.draft, published: profiles.published }).from(profiles).where(eq(profiles.ownerId, ownerId)),
    mediaUsage(ownerId),
  ]);
  const refs = owned.map((p) => ({ id: p.id, handle: p.handle, draft: referencedKeys(p.draft), published: referencedKeys(p.published) }));
  const assets = rows.map((row) =>
    toView(
      row,
      refs
        .filter((p) => p.draft.has(row.storageKey) || p.published.has(row.storageKey))
        .map((p) => ({ profileId: p.id, handle: p.handle, draft: p.draft.has(row.storageKey), published: p.published.has(row.storageKey) })),
    ),
  );
  return { assets, ...usage };
}

/** True when any profile's draft or published document holds the exact URL anywhere (structural). */
const referencesUrl = (doc: AnyPgColumn, url: string) =>
  sql`coalesce(jsonb_path_exists(${doc}, 'strict $.** ? (@ == $url)', jsonb_build_object('url', ${url}::text)), false)`;

/**
 * Deletes one of the owner's images. The asset row is locked first, so a
 * concurrent save or publish that checks the same image (FOR SHARE) either
 * commits its reference before this check runs, or finds the row gone.
 * Refused while any profile's stored draft or published document references
 * the URL anywhere. The file is removed after commit; once the row is gone
 * the origin serves 404 even if file removal fails (GC recovers the file).
 */
export async function deleteMedia(ownerId: string, assetId: string, storage: MediaStorage = mediaStorage()): Promise<{ id: string }> {
  if (!z.uuid().safeParse(assetId).success) throw new AppError("Image not found", "NOT_FOUND");
  const removed = await db.transaction(async (tx) => {
    const [asset] = await tx
      .select({ id: mediaAssets.id, storageKey: mediaAssets.storageKey })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.ownerId, ownerId)))
      .for("update");
    if (!asset) throw new AppError("Image not found", "NOT_FOUND");
    const url = mediaUrl(asset.storageKey);
    const referencing = await tx
      .select({ handle: profiles.handle, ownerId: profiles.ownerId })
      .from(profiles)
      .where(sql`${referencesUrl(profiles.draft, url)} or ${referencesUrl(profiles.published, url)}`);
    if (referencing.length > 0) {
      const own = referencing.filter((p) => p.ownerId === ownerId).map((p) => `/${p.handle}`);
      const where = own.length ? own.join(", ") : "a profile";
      throw new AppError(`This image is still used by ${where}. Choose a different image there (and publish, if it's on your public page), then delete it.`, "VALIDATION");
    }
    await tx.delete(mediaAssets).where(eq(mediaAssets.id, asset.id));
    return asset;
  });
  await removeStoredFile(removed.storageKey, "media.delete", storage);
  return { id: removed.id };
}

/** Best-effort file removal after the row is gone; failures are logged (bounded: the key) for GC. */
async function removeStoredFile(key: string, operation: string, storage: MediaStorage = mediaStorage()): Promise<boolean> {
  try {
    await storage.remove(key);
    return true;
  } catch (err) {
    logger.warn({ operation, storageKey: key, errCode: (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.name }, "Media file removal failed; media:gc will recover it");
    return false;
  }
}

// --------------------------------------------------------- account delete --

/** Storage keys of every image the user owns (collected before an account deletion cascades). */
export async function ownerStorageKeys(userId: string): Promise<string[]> {
  const rows = await db.select({ key: mediaAssets.storageKey }).from(mediaAssets).where(eq(mediaAssets.ownerId, userId));
  return rows.map((r) => r.key);
}

/** Removes files whose rows are already gone (after an account deletion). Never throws. */
export async function removeStoredFiles(keys: string[], operation: string, storage: MediaStorage = mediaStorage()) {
  let removed = 0;
  let failed = 0;
  for (const key of keys) {
    if (await removeStoredFile(key, operation, storage)) removed++;
    else failed++;
  }
  if (keys.length) logger.info({ operation, removed, failed }, "Removed media files");
  return { removed, failed };
}

// ------------------------------------------------------------- references --

const NOT_IN_LIBRARY = IMAGE_NOT_IN_LIBRARY;
const WRONG_KIND: Record<MediaKind, string> = {
  avatar: "Choose one of your uploaded avatars here.",
  background: "Choose one of your uploaded background images here.",
};
const IMAGE_WRONG_KIND = "Choose one of your uploaded images here. Avatars can't be used in image blocks.";
const FIELD_FOR: Record<string, string> = { [AVATAR_PATH]: "avatarUrl", [BACKGROUND_PATH]: "theme.background.imageUrl" };

/** Which references a check covers; all of them when omitted. */
export type ReferenceScope = (ref: MediaReference) => boolean;

/**
 * Every uploaded-image reference in `doc` (or only those `scope` selects) must
 * be an existing asset owned by `ownerId`, of the right kind at the avatar,
 * background and image-block positions. An image block's stored
 * `width`/`height` must also equal the row's. The rows are locked FOR SHARE
 * until the caller's transaction ends, so a concurrent delete waits and then
 * sees the new reference. Another user's asset is reported exactly like a
 * missing one.
 */
export async function assertMediaReferences(tx: Tx, ownerId: string, doc: unknown, scope?: ReferenceScope): Promise<void> {
  let refs = collectMediaReferences(doc);
  if (scope) refs = refs.filter(scope);
  if (refs.length === 0) return;
  const keys = [...new Set(refs.map((r) => r.key))];
  const rows = await tx
    .select({ key: mediaAssets.storageKey, ownerId: mediaAssets.ownerId, kind: mediaAssets.kind, width: mediaAssets.width, height: mediaAssets.height })
    .from(mediaAssets)
    .where(inArray(mediaAssets.storageKey, keys))
    .for("share");
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const fieldErrors: Record<string, string[]> = {};
  let elsewhere = false;
  for (const ref of refs) {
    const row = byKey.get(ref.key);
    const want = expectedKind(ref.path, doc);
    const owned = row !== undefined && row.ownerId === ownerId;
    const image = imageBlockAt(ref.path, doc);
    const sized = !image || (row !== undefined && image.width === row.width && image.height === row.height);
    if (owned && (!want || row.kind === want) && sized) continue;
    const field = FIELD_FOR[ref.path.join(".")];
    if (field) (fieldErrors[field] ??= []).push(owned && want ? WRONG_KIND[want] : NOT_IN_LIBRARY);
    else elsewhere = true;
  }
  if (elsewhere) throw new AppError("This profile refers to uploaded images that aren't in your library.", "VALIDATION", fieldErrors);
  if (Object.keys(fieldErrors).length) throw new AppError("Some images need attention.", "VALIDATION", fieldErrors);
}

/**
 * Locks (FOR SHARE, until the caller's transaction ends) the owner's assets
 * behind the given image-block sources and returns their stored sizes for
 * stamping. Only the owner's rows are read, so another user's asset
 * and a missing one give the same answer. Anything but an owned
 * `background` asset is refused.
 */
export async function lockImageSizes(tx: Tx, ownerId: string, sources: readonly string[]): Promise<ImageMediaLookup> {
  const keys = [...new Set(sources.map((s) => mediaKeyFromUrl(s)).filter((k): k is string => k !== null))];
  const rows = keys.length
    ? await tx
        .select({ key: mediaAssets.storageKey, kind: mediaAssets.kind, width: mediaAssets.width, height: mediaAssets.height })
        .from(mediaAssets)
        .where(and(inArray(mediaAssets.storageKey, keys), eq(mediaAssets.ownerId, ownerId)))
        .orderBy(mediaAssets.storageKey)
        .for("share")
    : [];
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return (src) => {
    const key = mediaKeyFromUrl(src);
    const row = key ? byKey.get(key) : undefined;
    if (!row) return { error: NOT_IN_LIBRARY };
    if (row.kind !== "background") return { error: IMAGE_WRONG_KIND };
    return { width: row.width, height: row.height };
  };
}

/**
 * An `https://` avatar address pointing at this instance's own `/media/`
 * path would bypass the ownership and reference checks; uploaded images are
 * chosen from the library instead.
 */
export function assertExternalAvatar(avatarUrl: string | undefined, appUrl = env().APP_URL): void {
  if (!avatarUrl || !avatarUrl.startsWith("https:")) return;
  const url = new URL(avatarUrl);
  if (url.hostname === new URL(appUrl).hostname && url.pathname.toLowerCase().startsWith("/media/")) {
    throw new AppError("Please fix the highlighted fields.", "VALIDATION", {
      avatarUrl: ["Choose uploaded images from your library instead of using their address."],
    });
  }
}
