import "server-only";
import { and, eq } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { cache } from "react";
import { z } from "zod";
import { db } from "@/db";
import { profiles, users } from "@/db/schema";
import { publicTags } from "./cache";
import { readDocument, type ProfileDocument } from "./document";
import { isValidHandle } from "./handle";

/**
 * Public profile reads. Two steps:
 *
 * 1. `getLiveProfile` (uncached, one indexed lookup per request, deduped per
 *    render): is this handle currently published by an owner who exists and
 *    isn't banned, and which published revision is current? Unpublish, rename,
 *    delete, ban, unban and account deletion are therefore effective on the very
 *    next request, on every replica, independent of cache invalidation.
 * 2. `getPublishedDocument` (`use cache`): the published JSON for a specific
 *    (profile, revision). A new publish creates a new cache key, so cached
 *    content can't be stale. Tags (profile, owner, handle) let mutations evict
 *    entries eagerly; they are memory hygiene, not the correctness mechanism.
 *
 * Only the published snapshot is ever read here; drafts never reach public
 * HTML or metadata.
 */

export interface LiveProfile {
  id: string;
  ownerId: string;
  handle: string;
  verified: boolean;
  publishedRevision: number;
}

export const getLiveProfile = cache(async (handle: string): Promise<LiveProfile | null> => {
  if (!isValidHandle(handle)) return null;
  const [row] = await db
    .select({
      id: profiles.id,
      ownerId: profiles.ownerId,
      handle: profiles.handle,
      verified: profiles.verified,
      publishedRevision: profiles.publishedRevision,
    })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.ownerId))
    .where(and(eq(profiles.handle, handle), eq(profiles.isPublished, true), eq(users.banned, false)))
    .limit(1);
  if (!row || row.publishedRevision === null) return null;
  return { ...row, publishedRevision: row.publishedRevision };
});

/**
 * The same live check by profile id, for analytics (the view beacon and
 * `/go`): currently published, owner exists and isn't banned. Uncached.
 */
export const getLiveProfileById = cache(async (profileId: string): Promise<LiveProfile | null> => {
  if (!z.uuid().safeParse(profileId).success) return null;
  const [row] = await db
    .select({
      id: profiles.id,
      ownerId: profiles.ownerId,
      handle: profiles.handle,
      verified: profiles.verified,
      publishedRevision: profiles.publishedRevision,
    })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.ownerId))
    .where(and(eq(profiles.id, profileId), eq(profiles.isPublished, true), eq(users.banned, false)))
    .limit(1);
  if (!row || row.publishedRevision === null) return null;
  return { ...row, publishedRevision: row.publishedRevision };
});

export async function getPublishedDocument(live: LiveProfile): Promise<ProfileDocument | null> {
  return publishedDocumentByRevision(live.id, live.publishedRevision, live.ownerId, live.handle);
}

async function publishedDocumentByRevision(
  profileId: string,
  revision: number,
  ownerId: string,
  handle: string,
): Promise<ProfileDocument | null> {
  "use cache";
  cacheTag(publicTags.profile(profileId), publicTags.owner(ownerId), publicTags.handle(handle));
  cacheLife("hours");
  const [row] = await db
    .select({ published: profiles.published, label: profiles.label })
    .from(profiles)
    .where(and(eq(profiles.id, profileId), eq(profiles.publishedRevision, revision)))
    .limit(1);
  if (!row?.published) return null;
  return readDocument(row.published, row.label).doc;
}
