import "server-only";
import { cookies } from "next/headers";
import { listProfiles, type ProfileSummary } from "./service";

export const ACTIVE_PROFILE_COOKIE = "covalink_active_profile";

/**
 * The cookie is only a preference: it is matched against the user's own
 * profiles, so a tampered or foreign id falls back to the first owned profile.
 */
export async function resolveActiveProfile(
  ownerId: string,
  preferredId: string | undefined,
): Promise<{ active: ProfileSummary | null; all: ProfileSummary[] }> {
  const all = await listProfiles(ownerId);
  const active = all.find((p) => p.id === preferredId) ?? all[0] ?? null;
  return { active, all };
}

export async function getActiveProfile(ownerId: string) {
  return resolveActiveProfile(ownerId, (await cookies()).get(ACTIVE_PROFILE_COOKIE)?.value);
}
