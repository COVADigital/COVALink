// Pure parts of analytics:purge (unit-tested). See scripts/analytics-purge.mjs.

/** Bounds of the `analytics.retentionDays` setting (features/settings/service.ts). */
export const RETENTION_MIN = 1;
export const RETENTION_MAX = 3650;
export const RETENTION_DEFAULT = 395;
export const BATCH_SIZE = 10_000;

const isRetention = (v) => Number.isInteger(v) && v >= RETENTION_MIN && v <= RETENTION_MAX;

/**
 * The effective retention period, as the application resolves it: the stored
 * setting when it is valid, otherwise ANALYTICS_RETENTION_DAYS when valid,
 * otherwise 395. Returns where the value came from, for the report.
 */
export function resolveRetention(storedValue, envValue) {
  if (isRetention(storedValue)) return { days: storedValue, from: "setting" };
  if (envValue !== undefined && envValue !== "") {
    const n = /^\d{1,4}$/.test(envValue) ? Number(envValue) : NaN;
    if (isRetention(n)) return { days: n, from: "ANALYTICS_RETENTION_DAYS" };
    throw new UsageError(`ANALYTICS_RETENTION_DAYS must be a whole number from ${RETENTION_MIN} to ${RETENTION_MAX}`);
  }
  return { days: RETENTION_DEFAULT, from: "default" };
}

export class UsageError extends Error {}

/** `--dry-run` reports what would be deleted; nothing else is accepted. */
export function parseArgs(argv) {
  const opts = { dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run") opts.dryRun = true;
    else throw new UsageError(`unknown argument (use --dry-run or nothing)`);
  }
  return opts;
}
