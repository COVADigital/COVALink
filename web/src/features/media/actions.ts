"use server";

import { getCurrentUser } from "@/lib/auth/session";
import { AppError, type ActionResult } from "@/lib/errors";
import { logger } from "@/lib/logger";
import * as service from "./service";

/**
 * Server Actions for the media library. Each one re-checks the session and
 * delegates to the service, which scopes every query to the caller's own
 * images. Uploads go through `POST /api/media` (streamed, bounded body).
 */
async function run<T>(name: string, fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Your session has expired. Please sign in again." };
  try {
    return { ok: true, data: await fn(user.id) };
  } catch (err) {
    if (err instanceof AppError) return { ok: false, error: err.message, code: err.code };
    logger.error({ err, action: name, userId: user.id }, "Server action failed");
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}

export async function listMediaAction() {
  return run("listMedia", (userId) => service.listMedia(userId));
}

export async function deleteMediaAction(assetId: string) {
  return run("deleteMedia", async (userId) => {
    await service.deleteMedia(userId, assetId);
    return service.listMedia(userId);
  });
}
