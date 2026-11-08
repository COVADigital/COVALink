"use server";

import { headers } from "next/headers";
import { AppError, type ActionResult } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { VerifyOutcome } from "./schema";
import { deleteOwnAccount, SessionRequiredError, verifyEmailToken } from "./service";

/**
 * Account Server Actions. They are public HTTP endpoints: inputs are
 * validated strictly in the service, the session is re-resolved there, and
 * logs carry only the action name and an error code (never passwords, tokens
 * or addresses).
 */

const SESSION_EXPIRED = "Your session has expired. Please sign in again.";

export async function deleteAccountAction(input: unknown): Promise<ActionResult> {
  try {
    await deleteOwnAccount(await headers(), input);
    return { ok: true, data: undefined };
  } catch (err) {
    if (err instanceof SessionRequiredError) return { ok: false, error: SESSION_EXPIRED };
    if (err instanceof AppError) {
      logger.info({ action: "account.delete", code: err.code }, "Account action refused");
      return { ok: false, error: err.message, code: err.code, fieldErrors: err.fieldErrors };
    }
    logger.error({ action: "account.delete", error: (err as Error)?.name }, "Account action failed");
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}

export async function verifyEmailAction(input: unknown): Promise<ActionResult<{ outcome: VerifyOutcome }>> {
  try {
    return { ok: true, data: { outcome: await verifyEmailToken(await headers(), input) } };
  } catch (err) {
    logger.error({ action: "account.verifyEmail", error: (err as Error)?.name }, "Account action failed");
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
