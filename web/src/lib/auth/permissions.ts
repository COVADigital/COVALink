/**
 * Central role → capability map. Every authorization check in services goes
 * through `can()` so adding a role means editing only this file.
 */
export const ROLES = ["super_admin", "admin", "user"] as const;
export type Role = (typeof ROLES)[number];

export type Capability =
  | "admin.access"
  | "users.view"
  | "users.manage"
  | "users.assignAdmin"
  | "settings.manage"
  | "settings.manageSecurity"
  | "audit.view"
  | "profiles.moderate";

const CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  super_admin: new Set<Capability>([
    "admin.access",
    "users.view",
    "users.manage",
    "users.assignAdmin",
    "settings.manage",
    "settings.manageSecurity",
    "audit.view",
    "profiles.moderate",
  ]),
  admin: new Set<Capability>(["admin.access", "users.view", "users.manage", "settings.manage", "audit.view", "profiles.moderate"]),
  user: new Set<Capability>(),
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function can(role: Role, capability: Capability): boolean {
  return CAPABILITIES[role].has(capability);
}

const RANK: Record<Role, number> = { user: 0, admin: 1, super_admin: 2 };

/**
 * Whether `actor` may change `target`'s role to `next`. Prevents privilege
 * escalation: nobody can grant a role above their own, admins cannot touch
 * other admins, and the super admin role is never assigned through the UI.
 */
export function canChangeRole(actor: { id: string; role: Role }, target: { id: string; role: Role }, next: Role): boolean {
  if (actor.id === target.id) return false;
  if (next === "super_admin" || target.role === "super_admin") return false;
  if (!can(actor.role, "users.manage")) return false;
  if (next === "admin" && !can(actor.role, "users.assignAdmin")) return false;
  return RANK[actor.role] > RANK[target.role];
}

/** Whether `actor` may ban/unban or delete `target`. */
export function canModerateUser(actor: { id: string; role: Role }, target: { id: string; role: Role }): boolean {
  if (actor.id === target.id) return false;
  if (!can(actor.role, "users.manage")) return false;
  return RANK[actor.role] > RANK[target.role];
}
