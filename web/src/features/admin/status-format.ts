/**
 * System-status display. Pure and client-safe; every value shown
 * comes from this fixed vocabulary or is a validated number or identifier.
 * Nothing here can carry a URL, path, hostname, credential or error text.
 */

export type CheckState = "ok" | "unavailable" | "timeout";

export interface SystemStatus {
  version: string;
  database: CheckState;
  storage: CheckState;
  emailConfigured: boolean;
  migrations: number | null;
  retentionDays: number;
}

export const CHECK_LABELS: Record<CheckState, string> = { ok: "Ready", unavailable: "Unavailable", timeout: "Not responding" };

const VERSION = /^[A-Za-z0-9._-]{1,64}$/;

/** The build identifier (the image's `COVALINK_GIT_SHA`), or "Unknown" for anything else. */
export function versionLabel(raw: unknown): string {
  return typeof raw === "string" && VERSION.test(raw) && raw !== "unknown" ? raw : "Unknown";
}

export interface StatusRow {
  id: string;
  label: string;
  value: string;
  tone: "ok" | "warn" | "neutral";
}

export function statusRows(s: SystemStatus): StatusRow[] {
  const check = (state: CheckState): Pick<StatusRow, "value" | "tone"> => ({ value: CHECK_LABELS[state], tone: state === "ok" ? "ok" : "warn" });
  return [
    { id: "version", label: "Version", value: s.version, tone: "neutral" },
    { id: "database", label: "Database", ...check(s.database) },
    { id: "storage", label: "Media storage", ...check(s.storage) },
    { id: "email", label: "Email delivery configured", value: s.emailConfigured ? "Yes" : "No", tone: s.emailConfigured ? "ok" : "warn" },
    { id: "migrations", label: "Database migrations applied", value: s.migrations === null ? "Unknown" : String(s.migrations), tone: "neutral" },
    { id: "retention", label: "Analytics retention", value: `${s.retentionDays} days`, tone: "neutral" },
    { id: "purge", label: "Analytics purge", value: "Scheduled outside COVALink; last run unknown", tone: "neutral" },
  ];
}
