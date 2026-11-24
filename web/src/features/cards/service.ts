import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { profiles } from "@/db/schema";
import { readCard, type CardSettings } from "./card";

/**
 * A profile's saved card settings, read fresh (not cached) so a switch takes effect at once. Callers pass a profile
 * they already know is live, and its published display name as the fallback name.
 */
export async function getCard(profileId: string, fallbackName: string): Promise<CardSettings> {
  const [row] = await db.select({ card: profiles.card }).from(profiles).where(eq(profiles.id, profileId)).limit(1);
  return readCard(row?.card, fallbackName);
}
