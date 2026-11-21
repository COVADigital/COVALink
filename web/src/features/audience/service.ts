import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { audienceContacts, profiles } from "@/db/schema";

/** Unconfirmed sign-ups are deleted after this long. */
export const PENDING_TTL_HOURS = 48;

export const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const pendingCutoff = () => new Date(Date.now() - PENDING_TTL_HOURS * 3600_000);

/**
 * Records a sign-up as pending with fresh confirm and remove tokens, and
 * returns them so the caller can email the links. An address that is already
 * confirmed is left alone and gets no email (`null`). A repeated pending
 * sign-up replaces its tokens and restarts the 48 hours. Expired pending rows,
 * of every profile, are deleted first.
 */
export async function recordSignup(input: {
  profileId: string;
  /** A Subscribe block's id, or null for the business card's share-back form. */
  blockId: string | null;
  /** What a card sign-up shared besides the email. */
  name?: string;
  phone?: string;
  note?: string;
  email: string;
  consentText: string;
}): Promise<{ confirmToken: string; removeToken: string } | null> {
  const confirmToken = newToken();
  const removeToken = newToken();
  return db.transaction(async (tx) => {
    // shortcut: swept on each sign-up (at most the global limit per hour), not on a timer; an install with no sign-ups
    // keeps its last expired rows until the next one. Move to a scheduled job if one is added.
    await tx.delete(audienceContacts).where(and(eq(audienceContacts.status, "pending"), lt(audienceContacts.createdAt, pendingCutoff())));
    const values = {
      source: input.blockId ? ("block" as const) : ("card" as const),
      blockId: input.blockId,
      name: input.name ?? null,
      phone: input.phone ?? null,
      note: input.note ?? null,
      consentText: input.consentText,
      confirmTokenHash: hashToken(confirmToken),
      removeTokenHash: hashToken(removeToken),
      createdAt: new Date(),
    };
    const rows = await tx
      .insert(audienceContacts)
      .values({ profileId: input.profileId, email: input.email, status: "pending", ...values })
      .onConflictDoUpdate({
        target: [audienceContacts.profileId, audienceContacts.email],
        set: values,
        setWhere: sql`${audienceContacts.status} = 'pending'`,
      })
      .returning({ id: audienceContacts.id });
    return rows.length ? { confirmToken, removeToken } : null;
  });
}

/** Confirms the pending sign-up the token belongs to. False when it's unknown, used or expired. */
export async function confirmSignup(token: string): Promise<boolean> {
  const rows = await db
    .update(audienceContacts)
    .set({ status: "confirmed", confirmTokenHash: null, confirmedAt: new Date() })
    .where(
      and(
        eq(audienceContacts.confirmTokenHash, hashToken(token)),
        eq(audienceContacts.status, "pending"),
        gt(audienceContacts.createdAt, pendingCutoff()),
      ),
    )
    .returning({ id: audienceContacts.id });
  return rows.length > 0;
}

/** Deletes the contact the remove token belongs to, pending or confirmed. False when it's unknown. */
export async function removeSignup(token: string): Promise<boolean> {
  const rows = await db
    .delete(audienceContacts)
    .where(eq(audienceContacts.removeTokenHash, hashToken(token)))
    .returning({ id: audienceContacts.id });
  return rows.length > 0;
}

export interface AudienceContact {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  note: string | null;
  source: "block" | "card";
  status: "pending" | "confirmed";
  createdAt: Date;
  confirmedAt: Date | null;
}

/** A card sign-up's details are the owner's to see only once the visitor confirmed them (until then anyone could have typed them). */
const onceConfirmed = (column: typeof audienceContacts.name | typeof audienceContacts.phone | typeof audienceContacts.note) =>
  sql<string | null>`case when ${audienceContacts.status} = 'confirmed' then ${column} end`;

/** The profile's contacts, newest first; expired pending rows are left out, and pending rows show only the email. Scoped to the owner. */
export async function listContacts(ownerId: string, profileId: string): Promise<AudienceContact[]> {
  return db
    .select({
      id: audienceContacts.id,
      email: audienceContacts.email,
      name: onceConfirmed(audienceContacts.name),
      phone: onceConfirmed(audienceContacts.phone),
      note: onceConfirmed(audienceContacts.note),
      source: audienceContacts.source,
      status: audienceContacts.status,
      createdAt: audienceContacts.createdAt,
      confirmedAt: audienceContacts.confirmedAt,
    })
    .from(audienceContacts)
    .innerJoin(profiles, eq(profiles.id, audienceContacts.profileId))
    .where(
      and(
        eq(audienceContacts.profileId, profileId),
        eq(profiles.ownerId, ownerId),
        or(eq(audienceContacts.status, "confirmed"), gt(audienceContacts.createdAt, pendingCutoff())),
      ),
    )
    .orderBy(desc(audienceContacts.createdAt));
}

/** Confirmed contacts for the CSV export, oldest first. Scoped to the owner. */
export async function exportContacts(ownerId: string, profileId: string) {
  return db
    .select({
      email: audienceContacts.email,
      name: audienceContacts.name,
      phone: audienceContacts.phone,
      note: audienceContacts.note,
      source: audienceContacts.source,
      confirmedAt: audienceContacts.confirmedAt,
      consentText: audienceContacts.consentText,
    })
    .from(audienceContacts)
    .innerJoin(profiles, eq(profiles.id, audienceContacts.profileId))
    .where(and(eq(audienceContacts.profileId, profileId), eq(profiles.ownerId, ownerId), eq(audienceContacts.status, "confirmed")))
    .orderBy(audienceContacts.confirmedAt);
}

/** Deletes one contact of a profile the owner owns. False when nothing matched. */
export async function deleteContact(ownerId: string, profileId: string, contactId: string): Promise<boolean> {
  const rows = await db
    .delete(audienceContacts)
    .where(
      and(
        eq(audienceContacts.id, contactId),
        eq(audienceContacts.profileId, profileId),
        sql`exists (select 1 from ${profiles} where ${profiles.id} = ${audienceContacts.profileId} and ${profiles.ownerId} = ${ownerId})`,
      ),
    )
    .returning({ id: audienceContacts.id });
  return rows.length > 0;
}
