import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { accounts, auditLogs, systemBootstrap, users } from "@/db/schema";
import { env } from "@/lib/env";
import { AppError, isUniqueViolation } from "@/lib/errors";
import { logger } from "@/lib/logger";

/** Arbitrary constant identifying the bootstrap advisory lock. */
const BOOTSTRAP_LOCK_ID = 727_002;

export const bootstrapInput = z.object({
  token: z.string().min(1, "Enter the setup token"),
  name: z.string().trim().min(1, "Enter your name").max(80),
  email: z.email("Enter a valid email address").max(254).transform((e) => e.trim().toLowerCase()),
  password: z.string().min(10, "Use at least 10 characters").max(128),
});

export async function isBootstrapped(): Promise<boolean> {
  const [row] = await db.select({ id: systemBootstrap.id }).from(systemBootstrap).limit(1);
  return Boolean(row);
}

export async function getBootstrapInfo(): Promise<{ completedAt: Date } | null> {
  const [row] = await db.select({ completedAt: systemBootstrap.completedAt }).from(systemBootstrap).limit(1);
  return row ?? null;
}

export function setupEnabled(): boolean {
  return Boolean(env().SETUP_TOKEN);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison against the configured SETUP_TOKEN. */
export function verifySetupToken(candidate: string): boolean {
  const expected = env().SETUP_TOKEN;
  if (!expected) return false;
  return timingSafeEqual(digest(candidate), digest(expected));
}

export interface BootstrapHooks {
  /** Test seam: runs inside the transaction after all inserts, before commit. */
  beforeCommit?: (tx: Tx) => Promise<void>;
}

/**
 * Creates the one and only super administrator. Authorization is the operator
 * secret SETUP_TOKEN, never a public sign-up. Safety properties:
 *  - all writes (user, credential, bootstrap record, audit entry) happen in one
 *    transaction, so a failure leaves no partial state and setup stays open;
 *  - a transaction-scoped advisory lock serializes concurrent attempts;
 *  - the `system_bootstrap` singleton row and the `users_single_super_admin`
 *    unique index enforce "at most once" even if the lock were bypassed.
 */
export async function bootstrapSuperAdmin(input: unknown, hooks: BootstrapHooks = {}): Promise<{ userId: string }> {
  if (!setupEnabled()) throw new AppError("Setup is disabled on this server.", "FORBIDDEN");
  const parsed = bootstrapInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError("Please fix the highlighted fields.", "VALIDATION", z.flattenError(parsed.error).fieldErrors as Record<string, string[]>);
  }
  const data = parsed.data;
  if (!verifySetupToken(data.token)) {
    logger.warn("Rejected setup attempt with an invalid token");
    throw new AppError("The setup token is not valid.", "FORBIDDEN", { token: ["The setup token is not valid"] });
  }

  // Hash outside the transaction: scrypt is slow and must not hold the lock.
  const passwordHash = await hashPassword(data.password);
  const userId = crypto.randomUUID();

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_ID})`);
      const [done] = await tx.select({ id: systemBootstrap.id }).from(systemBootstrap).limit(1);
      if (done) throw new AppError("This server has already been set up.", "CONFLICT");
      const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, data.email)).limit(1);
      if (existing) {
        throw new AppError("An account with this email already exists.", "CONFLICT", { email: ["An account with this email already exists"] });
      }
      await tx.insert(users).values({ id: userId, name: data.name, email: data.email, emailVerified: true, role: "super_admin" });
      await tx.insert(accounts).values({
        id: crypto.randomUUID(),
        accountId: userId,
        providerId: "credential",
        userId,
        password: passwordHash,
      });
      await tx.insert(systemBootstrap).values({ id: 1, superAdminId: userId });
      await tx.insert(auditLogs).values({ actorId: userId, action: "system.bootstrap", targetType: "user", targetId: userId });
      await hooks.beforeCommit?.(tx);
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    // Constraint backstop (e.g. a concurrent writer that bypassed the lock).
    if (isUniqueViolation(err)) throw new AppError("This server has already been set up.", "CONFLICT");
    throw err;
  }
  logger.info({ userId }, "Super administrator bootstrapped");
  return { userId };
}
