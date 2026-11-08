import "server-only";
import { isAPIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { auth } from "@/lib/auth/server";
import { resolveSessionUser } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { DELETE_CONFIRMATION, deleteAccountInput, verifyEmailInput, type VerifyOutcome } from "./schema";
import { consumeAttempt } from "./throttle";

/** Deletion attempts per account; Better Auth's HTTP limiter doesn't cover `auth.api` calls. */
const DELETE_ATTEMPTS = { windowSeconds: 10 * 60, max: 5 };

export class SessionRequiredError extends Error {}

const errorCode = (err: unknown) => (err as { body?: { code?: unknown } }).body?.code;

/**
 * Deletes the signed-in user's own account. The order matters:
 * session, input shape, typed confirmation, role, attempt limit, and only then
 * Better Auth's `deleteUser`, which checks the password and runs the existing
 * `beforeDelete` (role check again, cache and media capture) and `afterDelete`
 * (cleanup, audit) hooks. Nothing is reimplemented here.
 */
export async function deleteOwnAccount(requestHeaders: Headers, input: unknown): Promise<void> {
  const user = await resolveSessionUser(requestHeaders);
  if (!user) throw new SessionRequiredError();
  const parsed = deleteAccountInput.safeParse(input);
  if (!parsed.success) throw new AppError("That request isn't valid.", "VALIDATION");
  if (parsed.data.confirmation !== DELETE_CONFIRMATION) {
    throw new AppError(`Type "${DELETE_CONFIRMATION}" exactly to confirm.`, "VALIDATION", { confirmation: [`Type "${DELETE_CONFIRMATION}" exactly.`] });
  }
  if (user.role !== "user") {
    throw new AppError(
      user.role === "super_admin"
        ? "The super administrator account can't be deleted."
        : "Administrators can't delete their own account. Ask the super administrator to remove your administrator role first.",
      "FORBIDDEN",
    );
  }
  if (!(await consumeAttempt(`account-delete|${user.id}`, DELETE_ATTEMPTS.windowSeconds, DELETE_ATTEMPTS.max))) {
    throw new AppError("Too many attempts. Please wait a few minutes and try again.", "LIMIT");
  }
  try {
    await auth.api.deleteUser({ body: { password: parsed.data.password }, headers: requestHeaders });
  } catch (err) {
    if (!isAPIError(err)) throw err;
    if (errorCode(err) === "INVALID_PASSWORD") throw new AppError("That password isn't correct.", "VALIDATION", { password: ["That password isn't correct."] });
    if (err.status === "FORBIDDEN") throw new AppError(err.message || "You can't delete this account.", "FORBIDDEN");
    if (err.status === "UNAUTHORIZED") throw new SessionRequiredError();
    throw err;
  }
}

/** The address a verification JWT names, read without trusting it: it only labels the outcome. */
function claimedEmail(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const email = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown }).email;
    return typeof email === "string" && email.length <= 320 ? email.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Completes an email verification with a token taken from a link fragment.
 * Better Auth verifies the signed token, marks the address verified
 * and signs the user in (cookie set through the `nextCookies` plugin inside a
 * Server Action). A replay of a completed link changes nothing and creates no
 * session; it is reported as already verified. A disabled account is refused
 * by the `beforeEmailVerification` hook and reported as invalid.
 */
export async function verifyEmailToken(requestHeaders: Headers, input: unknown): Promise<VerifyOutcome> {
  const parsed = verifyEmailInput.safeParse(input);
  if (!parsed.success) return "invalid";
  const email = claimedEmail(parsed.data.token);
  if (!email) return "invalid";
  const before = await db.query.users.findFirst({ where: eq(users.email, email), columns: { emailVerified: true } });
  try {
    await auth.api.verifyEmail({ query: { token: parsed.data.token }, headers: requestHeaders });
  } catch (err) {
    if (!isAPIError(err)) throw err;
    return errorCode(err) === "TOKEN_EXPIRED" ? "expired" : "invalid";
  }
  return before?.emailVerified ? "already-verified" : "verified";
}
