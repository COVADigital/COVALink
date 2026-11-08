import { z } from "zod";

/**
 * Account self-service rules. Pure and client-safe: the
 * forms validate with these schemas for immediate feedback, and the trusted
 * boundaries (Better Auth database hooks, the deletion Server Action) apply
 * the same rules again.
 */

/** Better Auth's limits as configured in `lib/auth/server.ts`. */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export const ACCOUNT_NAME_MAX = 80;
export const ACCOUNT_NAME_MESSAGE = `Enter an account name of 1 to ${ACCOUNT_NAME_MAX} characters.`;

/** The exact phrase the account owner must type to delete their account. */
export const DELETE_CONFIRMATION = "delete my account";

/** Longest token accepted from a link; reset tokens are 24 characters, verification JWTs a few hundred. */
export const MAX_TOKEN_LENGTH = 2048;

/**
 * The account name (the person's name on the account, not a profile's display
 * name): trimmed, 1–80 characters, no control or bidirectional-override characters. Returns null when
 * the input isn't acceptable.
 */
export function normalizeAccountName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const name = input.trim();
  if (name.length < 1 || name.length > ACCOUNT_NAME_MAX) return null;
  // Control characters, line separators and bidirectional overrides (which can disguise a name).
  if (/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(name)) return null;
  return name;
}

export const accountNameSchema = z.string().refine((v) => normalizeAccountName(v) !== null, ACCOUNT_NAME_MESSAGE);

const newPassword = z.string().min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`).max(PASSWORD_MAX, `Use at most ${PASSWORD_MAX} characters`);

export const emailRequestSchema = z.object({ email: z.email("Enter a valid email address") });

export const resetPasswordFormSchema = z
  .object({ password: newPassword, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords don't match" });

export const changePasswordFormSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password").max(PASSWORD_MAX),
    newPassword,
    confirm: z.string(),
    signOutOthers: z.boolean(),
  })
  .refine((v) => v.newPassword === v.confirm, { path: ["confirm"], message: "Passwords don't match" });

/** Strict input of the deletion Server Action. */
export const deleteAccountInput = z
  .object({
    password: z.string().min(1, "Enter your password").max(PASSWORD_MAX),
    confirmation: z.string().max(64),
  })
  .strict();

export type VerifyOutcome = "verified" | "already-verified" | "expired" | "invalid";

export const verifyEmailInput =z.object({ token: z.string().min(1).max(MAX_TOKEN_LENGTH) }).strict();

/**
 * Reads `token` from a link fragment (`#token=…`). Anything else in the
 * fragment is ignored; an absent, empty, oversized or control-character token
 * gives null.
 */
export function tokenFromFragment(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  let token: string | null;
  try {
    token = new URLSearchParams(raw).get("token");
  } catch {
    return null;
  }
  if (!token || token.length > MAX_TOKEN_LENGTH || /[\s\p{Cc}]/u.test(token)) return null;
  return token;
}
