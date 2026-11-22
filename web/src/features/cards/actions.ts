"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { profiles } from "@/db/schema";
import { readDocument } from "@/features/profiles/document";
import { getCurrentUser } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { cardPatchSchema, cardSchema, readCard, type CardSettings } from "./card";

/** `expectSaveContact`: the Save contact state the caller's form showed; a mismatch means another tab changed it. */
const input = z.object({ profileId: z.uuid(), patch: z.unknown(), expectSaveContact: z.boolean().optional() }).strict();

/** `contact.firstName` → `firstName`, so the form can show the error on its field. */
function fieldErrors(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path.at(-1) ?? "form");
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/**
 * Changes some of a profile's business card settings and returns the saved card. A public endpoint: re-checks the
 * session, and the row is locked and updated only among the caller's profiles. Only `card` changes; the draft, the
 * published page and the revisions are untouched.
 */
export async function saveCardAction(raw: unknown): Promise<ActionResult<CardSettings>> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Your session has expired. Please sign in again." };
  const outer = input.safeParse(raw);
  if (!outer.success) return { ok: false, error: "That profile couldn't be found." };
  const patch = cardPatchSchema.safeParse(outer.data.patch);
  if (!patch.success) return { ok: false, error: "Check the highlighted fields.", fieldErrors: fieldErrors(patch.error) };
  try {
    return await db.transaction(async (tx) => {
      const where = and(eq(profiles.id, outer.data.profileId), eq(profiles.ownerId, user.id));
      const [row] = await tx.select({ card: profiles.card, draft: profiles.draft, label: profiles.label }).from(profiles).where(where).for("update");
      if (!row) return { ok: false, error: "That profile couldn't be found.", code: "NOT_FOUND" } as const;
      const current = readCard(row.card, readDocument(row.draft, row.label).doc.header.displayName);
      // Details edited while the form showed Save contact off must not go public because another tab turned it on.
      const expected = outer.data.expectSaveContact;
      if (expected !== undefined && current.saveContact !== expected) {
        const error = "Save contact was changed in another tab. Reload the page to review it before saving.";
        return { ok: false, error, code: "CONFLICT" } as const;
      }
      const next = cardSchema.safeParse({ ...current, ...patch.data });
      if (!next.success) return { ok: false, error: next.error.issues[0]?.message ?? "Check the highlighted fields.", fieldErrors: fieldErrors(next.error) } as const;
      await tx.update(profiles).set({ card: next.data }).where(where);
      return { ok: true, data: next.data } as const;
    });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.name : "unknown", action: "saveCard", userId: user.id }, "Server action failed");
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
