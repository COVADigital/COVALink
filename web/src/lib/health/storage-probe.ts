import "server-only";
import type { MediaStorage } from "@/features/media/storage";
import { logger } from "@/lib/logger";
import { READINESS_TIMEOUT_MS, runProbe, type ProbeOutcome } from "./readiness";

/**
 * Writable-storage probe: creates an exclusive probe file in the storage
 * root, writes a byte and deletes it (not just `access()`). If the deadline
 * passes first the probe still finishes and deletes its file in the
 * background. Failure details go to the server log only (error code, never
 * the path).
 */
export async function probeStorage(storage: MediaStorage, timeoutMs = READINESS_TIMEOUT_MS): Promise<ProbeOutcome> {
  return runProbe(
    () =>
      storage.probe().catch((err: unknown) => {
        logger.warn({ errCode: (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.name }, "Storage readiness probe failed");
        throw err;
      }),
    { timeoutMs, onTimeout: () => logger.warn({ timeoutMs }, "Storage readiness probe timed out") },
  );
}
