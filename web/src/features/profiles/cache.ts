import "server-only";
import { eq } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { profiles } from "@/db/schema";
import { logger } from "@/lib/logger";
import { isValidHandle } from "./handle";

/**
 * Cache tags for public profile content. Tags are built only from
 * values that were validated first, so request input can never produce an
 * oversized or malformed tag.
 */
export const publicTags = {
  handle(handle: string): string {
    if (!isValidHandle(handle)) throw new Error("publicTags.handle: invalid handle");
    return `profile-handle:${handle}`;
  },
  profile(profileId: string): string {
    if (!z.uuid().safeParse(profileId).success) throw new Error("publicTags.profile: invalid id");
    return `profile:${profileId}`;
  },
  owner(ownerId: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(ownerId)) throw new Error("publicTags.owner: invalid id");
    return `profile-owner:${ownerId}`;
  },
};

type Invalidator = (tags: string[]) => void;

/** Immediate expiry; valid in Server Actions and Route Handlers alike. */
const nextInvalidator: Invalidator = (tags) => {
  for (const tag of tags) revalidateTag(tag, { expire: 0 });
};

let invalidator: Invalidator = nextInvalidator;

export function invalidatePublicProfiles(tags: string[]): void {
  if (tags.length) invalidator([...new Set(tags)]);
}

/**
 * Public correctness does not depend on eviction, so an eviction
 * failure after a committed mutation is logged rather than reported as if the
 * database operation failed.
 */
export function invalidatePublicProfilesBestEffort(tags: string[], context: Record<string, unknown>): void {
  try {
    invalidatePublicProfiles(tags);
  } catch (err) {
    logger.warn({ err, ...context }, "Public profile cache invalidation failed");
  }
}

/**
 * Invalidates every public entry belonging to an owner: the owner tag plus each
 * profile and handle tag. Pass `known` when the rows are about to disappear
 * (account deletion); otherwise they are looked up.
 */
export async function invalidateOwnerPublicProfiles(
  ownerId: string,
  known?: { id: string; handle: string }[],
): Promise<void> {
  const rows = known ?? (await ownerProfileKeys(ownerId));
  invalidatePublicProfiles([
    publicTags.owner(ownerId),
    ...rows.flatMap((r) => [publicTags.profile(r.id), publicTags.handle(r.handle)]),
  ]);
}

export async function invalidateOwnerPublicProfilesBestEffort(
  ownerId: string,
  known: { id: string; handle: string }[] | undefined,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await invalidateOwnerPublicProfiles(ownerId, known);
  } catch (err) {
    logger.warn({ err, ownerId, ...context }, "Owner profile cache invalidation failed");
  }
}

export async function ownerProfileKeys(ownerId: string): Promise<{ id: string; handle: string }[]> {
  return db.select({ id: profiles.id, handle: profiles.handle }).from(profiles).where(eq(profiles.ownerId, ownerId));
}

/** Test seam: services run outside a Next.js request in integration tests. */
export function setPublicCacheInvalidator(fn: Invalidator | null): void {
  invalidator = fn ?? nextInvalidator;
}
