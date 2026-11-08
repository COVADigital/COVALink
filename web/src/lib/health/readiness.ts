/**
 * Readiness logic, kept free of Next.js and database imports so it can be
 * unit-tested with injected probes. Responses never include error messages,
 * hosts or connection details: only a fixed status vocabulary.
 */
export const READINESS_TIMEOUT_MS = 2000;

export type ProbeOutcome = "ok" | "unavailable" | "timeout";

export interface ReadinessChecks {
  database: ProbeOutcome;
  /** Media storage: an exclusive probe file can be created and deleted in the storage root. */
  storage: ProbeOutcome;
}

export interface ReadinessBody {
  status: "ready" | "not_ready";
  checks: ReadinessChecks;
}

export const NO_STORE_HEADERS = { "cache-control": "no-store, max-age=0" } as const;

/**
 * Runs `probe` with a hard deadline. `onTimeout` lets the caller cancel the
 * in-flight query. Never throws.
 */
export async function runProbe(
  probe: () => Promise<unknown>,
  { timeoutMs = READINESS_TIMEOUT_MS, onTimeout }: { timeoutMs?: number; onTimeout?: () => void } = {},
): Promise<ProbeOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const result = await Promise.race([probe().then(() => "ok" as const), deadline]);
    if (result === "timeout") onTimeout?.();
    return result;
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timer);
  }
}

/** Ready only when every check is ok; each check is reported separately. */
export function readinessResponse(checks: ReadinessChecks): Response {
  const ready = checks.database === "ok" && checks.storage === "ok";
  const body: ReadinessBody = { status: ready ? "ready" : "not_ready", checks: { database: checks.database, storage: checks.storage } };
  return Response.json(body, { status: ready ? 200 : 503, headers: NO_STORE_HEADERS });
}
