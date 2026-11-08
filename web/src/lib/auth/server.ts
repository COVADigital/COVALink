import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { recordAccountEvent } from "@/features/account/audit";
import { ACCOUNT_NAME_MESSAGE, normalizeAccountName } from "@/features/account/schema";
import { ownerStorageKeys, removeStoredFiles } from "@/features/media/service";
import { invalidateOwnerPublicProfilesBestEffort, ownerProfileKeys } from "@/features/profiles/cache";
import { registrationDecision } from "@/features/setup/registration";
import { BLOCKED_AUTH_PATHS } from "@/lib/auth/blocked-paths";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { actionEmail, dispatchMail, tokenLink } from "@/lib/mail";
import { TRUSTED_IP_HEADERS } from "@/lib/security/client-address";

const e = env();

/** Profile keys captured in `beforeDelete`, consumed in `afterDelete` (same request). */
const pendingDeletionKeys = new Map<string, { id: string; handle: string }[]>();
/** Media storage keys captured in `beforeDelete`; their files are removed in `afterDelete`. */
const pendingMediaKeys = new Map<string, string[]>();

/** One hour, for both reset and verification links. */
const TOKEN_LIFETIME_SECONDS = 60 * 60;

const isBanned = (user: object) => (user as { banned?: boolean | null }).banned === true;

/** The account-name rule at the trusted boundary: every sign-up and every name update, however it arrives. */
function checkedName(name: unknown): string {
  const normalized = normalizeAccountName(name);
  if (normalized === null) throw new APIError("BAD_REQUEST", { message: ACCOUNT_NAME_MESSAGE });
  return normalized;
}

export const auth = betterAuth({
  appName: "COVALink",
  baseURL: e.APP_URL,
  secret: e.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
      rateLimit: schema.rateLimits,
    },
  }),
  // Reachable only through COVALink's own code: account deletion goes
  // through the confirmed Server Action, and token-carrying GET URLs are never used.
  // The catch-all route blocks the same paths, plus `/reset-password/<token>`.
  disabledPaths: [...BLOCKED_AUTH_PATHS],
  user: {
    additionalFields: {
      role: { type: "string", required: false, defaultValue: "user", input: false },
      banned: { type: "boolean", required: false, defaultValue: false, input: false },
    },
    deleteUser: {
      enabled: true,
      beforeDelete: async (user) => {
        const row = await db.query.users.findFirst({ where: eq(schema.users.id, user.id), columns: { role: true } });
        if (row?.role === "super_admin") {
          throw new APIError("FORBIDDEN", { message: "The super administrator account can't be deleted." });
        }
        // Privileged-account oversight: the super administrator demotes first.
        if (row?.role === "admin") {
          throw new APIError("FORBIDDEN", {
            message: "Administrators can't delete their own account. Ask the super administrator to remove your administrator role first.",
          });
        }
        // Profiles cascade away with the user; remember their keys to evict public cache entries.
        pendingDeletionKeys.set(user.id, await ownerProfileKeys(user.id));
        // Media rows cascade away too; their files are removed once the rows are gone.
        pendingMediaKeys.set(user.id, await ownerStorageKeys(user.id));
      },
      afterDelete: async (user) => {
        const keys = pendingDeletionKeys.get(user.id) ?? [];
        pendingDeletionKeys.delete(user.id);
        await invalidateOwnerPublicProfilesBestEffort(user.id, keys, { operation: "user.delete" });
        const media = pendingMediaKeys.get(user.id) ?? [];
        pendingMediaKeys.delete(user.id);
        // Best effort: failures are logged per key and recovered by `npm run media:gc`.
        await removeStoredFiles(media, "user.delete");
        await recordAccountEvent("account.deleted", user.id);
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    requireEmailVerification: e.REQUIRE_EMAIL_VERIFICATION,
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: TOKEN_LIFETIME_SECONDS,
    // Called after Better Auth created the token, for every existing address. Disabled
    // accounts get no mail; the HTTP response is the same either way.
    sendResetPassword: async ({ user, token }) => {
      if (isBanned(user)) return;
      dispatchMail(
        {
          to: user.email,
          subject: "Reset your COVALink password",
          ...actionEmail({
            heading: "Reset your password",
            body: "Someone asked to reset the password for your account. This link expires in one hour.",
            actionLabel: "Choose a new password",
            url: tokenLink("/reset-password", token),
          }),
        },
        "password-reset",
      );
    },
    // Runs after Better Auth's reset transaction has committed.
    onPasswordReset: async ({ user }) => {
      await recordAccountEvent("account.password_reset", user.id);
    },
  },
  emailVerification: {
    sendOnSignUp: e.REQUIRE_EMAIL_VERIFICATION,
    autoSignInAfterVerification: true,
    expiresIn: TOKEN_LIFETIME_SECONDS,
    sendVerificationEmail: async ({ user, token }) => {
      if (isBanned(user) || user.emailVerified) return;
      dispatchMail(
        {
          to: user.email,
          subject: "Verify your email for COVALink",
          ...actionEmail({
            heading: "Confirm your email",
            body: "Confirm this address to finish setting up your account. This link expires in one hour.",
            actionLabel: "Verify email",
            url: tokenLink("/verify-email", token),
          }),
        },
        "email-verification",
      );
    },
    // A disabled account can't be verified or signed in through a link.
    beforeEmailVerification: async (user) => {
      if (isBanned(user)) throw new APIError("FORBIDDEN", { message: "This account has been disabled." });
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  rateLimit: {
    enabled: e.NODE_ENV !== "test",
    storage: "database",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60 * 10, max: 5 },
      "/request-password-reset": { window: 60 * 10, max: 3 },
      "/send-verification-email": { window: 60 * 10, max: 3 },
      "/change-password": { window: 60 * 10, max: 10 },
    },
  },
  hooks: {
    // Password changes have no completion callback; record only a successful result.
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/change-password") return;
      const returned = ctx.context.returned;
      if (!returned || isAPIError(returned)) return;
      // The success body is `{ token, user }` for the signed-in user.
      const userId = (returned as { user?: { id?: unknown } }).user?.id;
      if (typeof userId === "string") await recordAccountEvent("account.password_changed", userId);
    }),
  },
  advanced: {
    // Explicit so origin/CSRF checks also run under NODE_ENV=test (Better Auth skips them there by default).
    disableOriginCheck: false,
    ipAddress: { ipAddressHeaders: e.TRUST_PROXY ? [...TRUSTED_IP_HEADERS] : [] },
    database: { generateId: () => crypto.randomUUID() },
  },
  databaseHooks: {
    user: {
      create: {
        // Every account created through Better Auth (public sign-up or direct API
        // calls) is an ordinary user. Privileged roles are only ever granted by
        // trusted server code: the SETUP_TOKEN bootstrap (features/setup).
        before: async (user) => {
          const name = checkedName(user.name);
          const decision = await registrationDecision();
          if (!decision.allowed) {
            logger.info({ reason: decision.reason }, "Rejected sign-up");
            throw new APIError("FORBIDDEN", { message: decision.message });
          }
          return { data: { ...user, name, role: "user", banned: false, banReason: null } };
        },
      },
      update: {
        // Only name changes are checked; Better Auth's own updates (verification, timestamps) pass through.
        before: async (data) => {
          if (!("name" in data) || data.name === undefined) return;
          return { data: { ...data, name: checkedName(data.name) } };
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          const user = await db.query.users.findFirst({
            where: eq(schema.users.id, session.userId),
            columns: { banned: true },
          });
          if (!user || user.banned) {
            throw new APIError("FORBIDDEN", { message: "This account has been disabled." });
          }
        },
      },
    },
  },
  plugins: [nextCookies()],
});

export type Auth = typeof auth;
