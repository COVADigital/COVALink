import { connection } from "next/server";
import { pgClient } from "@/db";
import { mediaStorage } from "@/features/media/storage";
import { probeDatabase } from "@/lib/health/db-probe";
import { readinessResponse } from "@/lib/health/readiness";
import { probeStorage } from "@/lib/health/storage-probe";
import { logger } from "@/lib/logger";

/**
 * Readiness: 200 when PostgreSQL answers `select 1` and the media storage
 * root accepts a probe file, each within the deadline; otherwise 503 with
 * each check reported separately.
 */
export async function GET() {
  await connection();
  const storage = (() => {
    try {
      return mediaStorage();
    } catch (err) {
      // Misconfigured root (e.g. relative in production); the message names the setting, not a path.
      logger.warn({ err: (err as Error)?.message }, "Storage readiness probe misconfigured");
      return null;
    }
  })();
  const [database, storageOutcome] = await Promise.all([
    probeDatabase(pgClient),
    storage ? probeStorage(storage) : Promise.resolve("unavailable" as const),
  ]);
  return readinessResponse({ database, storage: storageOutcome });
}
