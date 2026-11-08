import "server-only";
import type { Sql } from "postgres";
import { logger } from "@/lib/logger";
import { READINESS_TIMEOUT_MS, runProbe, type ProbeOutcome } from "./readiness";

/**
 * Read-only connectivity probe (`select 1`). The query is cancelled when the
 * deadline passes so a hung connection can't pile up probes. Failure details
 * go to the server log only.
 */
export async function probeDatabase(sql: Sql, timeoutMs = READINESS_TIMEOUT_MS): Promise<ProbeOutcome> {
  let query: ReturnType<Sql["unsafe"]> | undefined;
  const outcome = await runProbe(
    () => {
      query = sql.unsafe("select 1");
      return query.catch((err: unknown) => {
        logger.warn({ errCode: (err as { code?: string })?.code }, "Readiness probe failed");
        throw err;
      });
    },
    {
      timeoutMs,
      onTimeout: () => {
        logger.warn({ timeoutMs }, "Readiness probe timed out");
        query?.cancel();
      },
    },
  );
  return outcome;
}
