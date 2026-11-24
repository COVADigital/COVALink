import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { audienceContacts, profiles } from "@/db/schema";

/** An emailed confirm link works this long; a pending row is deleted this long after its latest sign-up. */
export const PENDING_TTL_HOURS = 48;

export const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const pendingCutoff = () => new Date(Date.now() - PENDING_TTL_HOURS * 3600_000);

/**
 * Records a sign-up as pending with fresh confirm and remove tokens, and
 * returns them so the caller can email the links. An address that is already
 * confirmed is left alone and gets no email (`null`). A repeated pending
 * sign-up keeps its earlier link until the replacement email is accepted: it
 * returns `replace`, which the caller runs only then, to switch the row to the
 * new tokens and details and restart the 48 hours. Expired pending rows, of
 * every profile, are deleted first.
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
  /**
   * Whether an email will go out (false: the recipient is over quota). Either way an existing pending sign-up keeps
   * everything tied to its emailed link (tokens, source, block, details, consent wording, and the time its 48 hours run
   * from) for now, so that link confirms exactly what its email offered, while what the owner sees (latest sign-up time
   * and source) changes the same way, so the owner can't tell the two apart. Only with an email is `replace` returned. A
   * new address is stored as pending either way.
   */
  rotate?: boolean;
}): Promise<{ confirmToken: string; removeToken: string; replace?: () => Promise<void> } | null> {
  const confirmToken = newToken();
  const removeToken = newToken();
  return db.transaction(async (tx) => {
    // shortcut: swept on each sign-up (at most the global limit per hour), not on a timer; an install with no sign-ups
    // keeps its last expired rows until the next one. Move to a scheduled job if one is added.
    await tx.delete(audienceContacts).where(and(eq(audienceContacts.status, "pending"), lt(audienceContacts.lastSignupAt, pendingCutoff())));
    const source = input.blockId ? ("block" as const) : ("card" as const);
    const now = new Date();
    const seen = { lastSignupAt: now, lastSource: source };
    // What the emailed link confirms; `seen` is only what the owner's list shows.
    const bound = {
      source,
      blockId: input.blockId,
      name: input.name ?? null,
      phone: input.phone ?? null,
      note: input.note ?? null,
      consentText: input.consentText,
      confirmTokenHash: hashToken(confirmToken),
      removeTokenHash: hashToken(removeToken),
      createdAt: now,
    };
    const values = { ...seen, ...bound };
    const [row] = await tx
      .insert(audienceContacts)
      .values({ profileId: input.profileId, email: input.email, status: "pending", ...values })
      .onConflictDoUpdate({
        target: [audienceContacts.profileId, audienceContacts.email],
        set: seen,
        setWhere: sql`${audienceContacts.status} = 'pending'`,
      })
      .returning({ id: audienceContacts.id, confirmTokenHash: audienceContacts.confirmTokenHash });
    if (!row) return null;
    // A new row already holds these tokens; an existing pending one switches to them only once their email is accepted.
    if (row.confirmTokenHash === values.confirmTokenHash || input.rotate === false) return { confirmToken, removeToken };
    const replace = async () => {
      await db
        .update(audienceContacts)
        .set(bound)
        // Only over an older link: a later repeat whose email was accepted first keeps its own. Two repeats in the same
        // millisecond: the first accepted wins and the other email's link never works (its earlier link still does).
        .where(and(eq(audienceContacts.id, row.id), eq(audienceContacts.status, "pending"), lt(audienceContacts.createdAt, now)));
    };
    return { confirmToken, removeToken, replace };
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

/**
 * What confirming the token would share, for the confirm page: the profile's handle and, for a card sign-up, the
 * name, phone and note. Null when the token is unknown, used or expired. Only the inbox holder has the token.
 */
export async function previewSignup(token: string): Promise<{ handle: string; name: string | null; phone: string | null; note: string | null } | null> {
  const [row] = await db
    .select({ handle: profiles.handle, name: audienceContacts.name, phone: audienceContacts.phone, note: audienceContacts.note })
    .from(audienceContacts)
    .innerJoin(profiles, eq(profiles.id, audienceContacts.profileId))
    .where(
      and(
        eq(audienceContacts.confirmTokenHash, hashToken(token)),
        eq(audienceContacts.status, "pending"),
        gt(audienceContacts.createdAt, pendingCutoff()),
      ),
    )
    .limit(1);
  return row ?? null;
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
  /** The latest sign-up for this address. */
  createdAt: Date;
  confirmedAt: Date | null;
}

/** A card sign-up's details are the owner's to see only once the visitor confirmed them (until then anyone could have typed them). */
const onceConfirmed = (column: typeof audienceContacts.name | typeof audienceContacts.phone | typeof audienceContacts.note) =>
  sql<string | null>`case when ${audienceContacts.status} = 'confirmed' then ${column} end`;

/** `v•••@example.com`: the visitor hasn't agreed to share an unconfirmed address yet. */
export const maskEmail = (email: string) => `${email[0]}•••${email.slice(email.lastIndexOf("@"))}`;

/**
 * The profile's contacts, newest first; expired pending rows are left out, and pending rows show only a masked email
 * and their latest sign-up's time and source. Scoped to the owner.
 */
export async function listContacts(ownerId: string, profileId: string): Promise<AudienceContact[]> {
  const rows = await db
    .select({
      id: audienceContacts.id,
      email: audienceContacts.email,
      name: onceConfirmed(audienceContacts.name),
      phone: onceConfirmed(audienceContacts.phone),
      note: onceConfirmed(audienceContacts.note),
      source: sql<"block" | "card">`case when ${audienceContacts.status} = 'confirmed' then ${audienceContacts.source} else ${audienceContacts.lastSource} end`,
      status: audienceContacts.status,
      createdAt: audienceContacts.lastSignupAt,
      confirmedAt: audienceContacts.confirmedAt,
    })
    .from(audienceContacts)
    .innerJoin(profiles, eq(profiles.id, audienceContacts.profileId))
    .where(
      and(
        eq(audienceContacts.profileId, profileId),
        eq(profiles.ownerId, ownerId),
        or(eq(audienceContacts.status, "confirmed"), gt(audienceContacts.lastSignupAt, pendingCutoff())),
      ),
    )
    .orderBy(desc(audienceContacts.lastSignupAt));
  return rows.map((r) => (r.status === "pending" ? { ...r, email: maskEmail(r.email) } : r));
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
