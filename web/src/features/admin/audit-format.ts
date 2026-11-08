import { settingSpec } from "@/features/settings/catalog";
import { isRole, type Role } from "@/lib/auth/permissions";

/**
 * Audit-entry display. Pure and client-safe. Each known action has
 * its own formatter that reads only allowlisted metadata fields, checks their
 * types and bounds their length; nothing else in the stored JSON is ever
 * shown. Unknown actions show only their name.
 */

export const AUDIT_ACTIONS = [
  "system.bootstrap",
  "user.ban",
  "user.unban",
  "user.role_change",
  "settings.update",
  "account.password_reset",
  "account.password_changed",
  "account.deleted",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  "system.bootstrap": "Installation set up",
  "user.ban": "Account disabled",
  "user.unban": "Account re-enabled",
  "user.role_change": "Role changed",
  "settings.update": "Setting changed",
  // Recorded after Better Auth commits; the metadata is never read.
  "account.password_reset": "Password reset by email link",
  "account.password_changed": "Password changed",
  "account.deleted": "Account deleted by its owner",
};

export const ROLE_LABELS: Record<Role, string> = { super_admin: "Super administrator", admin: "Administrator", user: "User" };

export interface AuditChange {
  label: string;
  from: string;
  to: string;
}

export interface AuditDisplay {
  title: string;
  /** Optional one-line detail (e.g. which setting). */
  detail: string | null;
  change: AuditChange | null;
}

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === "string" && (AUDIT_ACTIONS as readonly string[]).includes(value);
}

const MAX_TEXT = 80;
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);
const field = (metadata: unknown, name: string): unknown =>
  metadata && typeof metadata === "object" && !Array.isArray(metadata) && Object.hasOwn(metadata, name) ? (metadata as Record<string, unknown>)[name] : undefined;

function roleLabel(value: unknown): string {
  return isRole(value) ? ROLE_LABELS[value] : "Unknown";
}

/** A setting value as text, by the setting's kind; anything unexpected is "—". */
export function formatSettingValue(key: string, value: unknown): string {
  const spec = settingSpec(key);
  if (value === null || value === undefined) return "Default";
  if (!spec) return "—";
  if (spec.kind === "boolean") return typeof value === "boolean" ? (value ? "On" : "Off") : "—";
  if (spec.kind === "integer") return typeof value === "number" && Number.isInteger(value) ? `${value}${spec.unit ? ` ${spec.unit}` : ""}` : "—";
  return typeof value === "string" ? clip(value) : "—";
}

export function formatAuditEntry(action: string, targetId: string | null, metadata: unknown): AuditDisplay {
  if (!isAuditAction(action)) return { title: "Other event", detail: clip(action), change: null };
  const title = AUDIT_ACTION_LABELS[action];
  switch (action) {
    case "user.role_change":
      return { title, detail: null, change: { label: "Role", from: roleLabel(field(metadata, "from")), to: roleLabel(field(metadata, "to")) } };
    case "settings.update": {
      const key = targetId ?? "";
      const spec = settingSpec(key);
      return {
        title,
        detail: spec ? spec.label : "Unknown setting",
        change: spec ? { label: spec.label, from: formatSettingValue(key, field(metadata, "from")), to: formatSettingValue(key, field(metadata, "to")) } : null,
      };
    }
    case "user.ban": {
      const reason = field(metadata, "reason");
      return { title, detail: typeof reason === "string" && reason.trim() ? `Reason: ${clip(reason.trim())}` : null, change: null };
    }
    default:
      return { title, detail: null, change: null };
  }
}
