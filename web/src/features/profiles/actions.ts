"use server";

import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth/session";
import { AppError, type ActionResult } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { ACTIVE_PROFILE_COOKIE } from "./active";
import { invalidatePublicProfilesBestEffort, publicTags } from "./cache";
import * as service from "./service";

/**
 * Server Actions are public HTTP endpoints: each one re-checks the session and
 * delegates to the service layer, which validates input (narrow contracts) and scopes every query to the caller's own profiles. Successful
 * mutations evict the affected public cache entries.
 */
async function run<T>(name: string, fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Your session has expired. Please sign in again." };
  try {
    return { ok: true, data: await fn(user.id) };
  } catch (err) {
    if (err instanceof AppError) {
      return { ok: false, error: err.message, fieldErrors: err.fieldErrors, blockErrors: err.blockErrors, code: err.code };
    }
    logger.error({ err, action: name, userId: user.id }, "Server action failed");
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}

async function setActiveCookie(profileId: string) {
  (await cookies()).set(ACTIVE_PROFILE_COOKIE, profileId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

const evict = (operation: string, r: { id: string; handle: string }) =>
  invalidatePublicProfilesBestEffort([publicTags.profile(r.id), publicTags.handle(r.handle)], {
    operation,
    profileId: r.id,
  });

export async function createProfileAction(input: unknown) {
  return run("createProfile", async (userId) => {
    const row = await service.createProfile(userId, input);
    await setActiveCookie(row.id);
    return row;
  });
}

export async function selectProfileAction(profileId: string) {
  return run("selectProfile", async (userId) => {
    await service.getOwnedProfile(userId, profileId); // ownership check before trusting the id
    await setActiveCookie(profileId);
    return null;
  });
}

export async function updateProfileMetaAction(profileId: string, input: unknown) {
  return run("updateProfileMeta", async (userId) => {
    const r = await service.updateProfileMeta(userId, profileId, input);
    invalidatePublicProfilesBestEffort(
      [publicTags.profile(r.id), publicTags.handle(r.previousHandle), publicTags.handle(r.handle)],
      { operation: "profile.rename", profileId: r.id },
    );
    return { handle: r.handle };
  });
}

export async function saveDraftAction(profileId: string, input: unknown) {
  return run("saveDraft", async (userId) => {
    const r = await service.saveDraft(userId, profileId, input);
    return { revision: r.revision, savedAt: r.savedAt.toISOString(), blocks: r.blocks, theme: r.theme, appearance: r.appearance };
  });
}

export async function publishAction(profileId: string, input: unknown) {
  return run("publish", async (userId) => {
    const r = await service.publishProfile(userId, profileId, input);
    evict("profile.publish", r);
    return { revision: r.revision, publishedAt: r.publishedAt.toISOString(), blocks: r.blocks, theme: r.theme, appearance: r.appearance };
  });
}

export async function unpublishAction(profileId: string) {
  return run("unpublish", async (userId) => {
    evict("profile.unpublish", await service.unpublishProfile(userId, profileId));
    return null;
  });
}

export async function revertDraftAction(profileId: string, input: unknown) {
  return run("revertDraft", async (userId) => {
    const r = await service.revertDraft(userId, profileId, input);
    const p = await service.getOwnedProfile(userId, profileId);
    return { revision: r.revision, draft: p.draft, protectedBlocks: p.protectedBlocks, appearance: p.appearance };
  });
}

export async function deleteProfileAction(profileId: string) {
  return run("deleteProfile", async (userId) => {
    evict("profile.delete", await service.deleteProfile(userId, profileId));
    const jar = await cookies();
    if (jar.get(ACTIVE_PROFILE_COOKIE)?.value === profileId) jar.delete(ACTIVE_PROFILE_COOKIE);
    return null;
  });
}
