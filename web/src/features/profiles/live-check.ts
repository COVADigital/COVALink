import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { profiles, users } from "@/db/schema";
import { isValidHandle } from "./handle";

/**
 * Fast existence check used by Proxy to decide the HTTP status of a public
 * profile request before rendering starts (Next.js can't change the status
 * once a response streams). One indexed lookup; no content is fetched.
 */
export async function isProfileLive(handle: string): Promise<boolean> {
  if (!isValidHandle(handle)) return false;
  const [row] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.ownerId))
    .where(and(eq(profiles.handle, handle), eq(profiles.isPublished, true), eq(users.banned, false)))
    .limit(1);
  return Boolean(row);
}
