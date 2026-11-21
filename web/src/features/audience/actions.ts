"use server";

import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { deleteContact } from "./service";

const ids = z.object({ profileId: z.uuid(), contactId: z.uuid() }).strict();

/** Deletes one contact. A public endpoint: re-checks the session, and the delete is scoped to the caller's profiles. */
export async function deleteContactAction(input: unknown): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Your session has expired. Please sign in again." };
  const parsed = ids.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That contact couldn't be found." };
  try {
    const deleted = await deleteContact(user.id, parsed.data.profileId, parsed.data.contactId);
    return deleted ? { ok: true, data: undefined } : { ok: false, error: "That contact couldn't be found. It may already be deleted." };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.name : "unknown", action: "deleteContact", userId: user.id }, "Server action failed");
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
