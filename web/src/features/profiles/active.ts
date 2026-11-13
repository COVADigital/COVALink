import "server-only";
import { cookies } from "next/headers";
import { listProfiles, type ProfileSummary } from "./service";

export const ACTIVE_PROFILE_COOKIE = "covalink_active_profile";

/**
 * The cookie is only a preference: it is matched against the user's own
 * profiles, so a tampered or foreign id falls back to the first owned profile.
 * A page about one profile passes it as `viewedId`; an owned one wins over the
 * cookie, and `sync` is set when the cookie should be updated to it.
 */
export async function resolveActiveProfile(
  ownerId: string,
  preferredId: string | undefined,
  viewedId?: string,
): Promise<{ active: ProfileSummary | null; all: ProfileSummary[]; sync: boolean }> {
  const all = await listProfiles(ownerId);
  const viewed = viewedId ? all.find((p) => p.id === viewedId) : undefined;
  const active = viewed ?? all.find((p) => p.id === preferredId) ?? all[0] ?? null;
  return { active, all, sync: viewed !== undefined && viewed.id !== preferredId };
}

export async function getActiveProfile(ownerId: string, viewedId?: string) {
  return resolveActiveProfile(ownerId, (await cookies()).get(ACTIVE_PROFILE_COOKIE)?.value, viewedId);
}
