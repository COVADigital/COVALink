import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getSetting } from "@/features/settings/service";
import { env, smtpConfigured } from "@/lib/env";

/**
 * Whether Subscribe blocks can work: email must be configured (sign-ups are
 * confirmed by email), the server must see each visitor's own address
 * (`TRUST_PROXY`, so sign-ups can be limited per visitor), and the operator
 * must allow them. `live` is all three.
 */
export async function subscribeStatus(): Promise<{ emailReady: boolean; visitorsKnown: boolean; subscribeEnabled: boolean; live: boolean }> {
  const emailReady = smtpConfigured();
  const visitorsKnown = env().TRUST_PROXY;
  const subscribeEnabled = await getSetting("audience.subscribeEnabled");
  return { emailReady, visitorsKnown, subscribeEnabled, live: emailReady && visitorsKnown && subscribeEnabled };
}

/**
 * Only owners with a verified email address can collect sign-ups. A verified
 * mailbox is cheap, so this isn't the abuse limit: the per-owner and
 * per-recipient limits (subscribe.ts) bound the confirmation emails, and the
 * emails carry no free text the owner or the visitor typed: the page is named
 * by its handle (`[a-z0-9_-]`, at most 30 characters).
 */
export async function ownerVerified(ownerId: string): Promise<boolean> {
  const [row] = await db.select({ verified: users.emailVerified }).from(users).where(eq(users.id, ownerId)).limit(1);
  return row?.verified === true;
}
