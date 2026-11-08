import "server-only";
import { db } from "@/db";
import { auditLogs } from "@/db/schema";
import { logger } from "@/lib/logger";

export type AccountAuditAction = "account.password_reset" | "account.password_changed" | "account.deleted";

type Insert = (row: typeof auditLogs.$inferInsert) => Promise<unknown>;
const defaultInsert: Insert = (row) => db.insert(auditLogs).values(row);
let insert: Insert = defaultInsert;
/** Replaces the audit insert (tests only: failure injection; `null` restores it). */
export function setAccountAuditInsert(fn: Insert | null) {
  insert = fn ?? defaultInsert;
}

/**
 * Records a sensitive account event. Called after Better Auth has
 * committed the change, so it is best-effort and never throws: a failure here
 * must not make a completed password change, reset or deletion look failed.
 * A crash or database failure between Better Auth's commit and this insert
 * loses the entry. Stored: action, account id and the timestamp only.
 * A deleted account can't be the actor (the row is gone), so `account.deleted`
 * has a null actor and the deleted id as its target.
 */
export async function recordAccountEvent(action: AccountAuditAction, accountId: string): Promise<void> {
  try {
    await insert({
      actorId: action === "account.deleted" ? null : accountId,
      action,
      targetType: "user",
      targetId: accountId,
    });
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    logger.error({ action, ...(typeof code === "string" && /^[A-Z0-9_]{1,10}$/.test(code) && { code }) }, "Account audit entry not recorded");
  }
}
