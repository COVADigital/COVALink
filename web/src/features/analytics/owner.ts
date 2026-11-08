import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { getSessionCookie } from "better-auth/cookies";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";

/**
 * Is this request from the profile's owner, signed in?. Owner traffic
 * is excluded from analytics. Better Auth's `getSession` is deliberately not
 * used here: it may refresh the session or clear stale cookies, and the
 * beacon and `/go` must never set a cookie. Instead the signed session cookie
 * is verified the way Better Auth signs it (HMAC-SHA-256 of the token with
 * the auth secret, base64) and the session row is read: unexpired, user not
 * banned. Read-only; requests without a session cookie cost nothing.
 */
export async function isOwnerRequest(headers: Headers, ownerId: string, secret: string): Promise<boolean> {
  const value = getSessionCookie(headers);
  if (!value) return false;
  const token = verifiedSessionToken(value, secret);
  if (!token) return false;
  const [row] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, sql`now()`), eq(users.banned, false)))
    .limit(1);
  return row?.userId === ownerId;
}

/** The session token of a `token.signature` cookie value whose signature is valid, else null. */
export function verifiedSessionToken(value: string, secret: string): string | null {
  const dot = value.lastIndexOf(".");
  if (dot < 1 || value.length > 512) return null;
  const token = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (signature.length !== 44 || !signature.endsWith("=")) return null;
  const expected = createHmac("sha256", secret).update(token).digest();
  const given = Buffer.from(signature, "base64");
  if (given.length !== expected.length) return null;
  return timingSafeEqual(given, expected) ? token : null;
}
