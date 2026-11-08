"use server";

import { AppError, type ActionResult } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { bootstrapSuperAdmin } from "./service";

/** Public endpoint by nature; authorization is the SETUP_TOKEN checked in the service. */
export async function bootstrapAction(input: unknown): Promise<ActionResult> {
  try {
    await bootstrapSuperAdmin(input);
    return { ok: true, data: undefined };
  } catch (err) {
    if (err instanceof AppError) return { ok: false, error: err.message, fieldErrors: err.fieldErrors };
    logger.error({ err }, "Bootstrap failed");
    return { ok: false, error: "Setup failed. Nothing was saved; please try again." };
  }
}
