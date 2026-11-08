import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, formatAuditEntry, formatSettingValue } from "@/features/admin/audit-format";
import { AUDIT_CURSOR, auditQuerySchema, containsPattern, isNoOpBan, isNoOpRole, userListQuerySchema } from "@/features/admin/queries";
import { CHECK_LABELS, statusRows, versionLabel, type CheckState, type SystemStatus } from "@/features/admin/status-format";
import { SETTING_SPECS } from "@/features/settings/catalog";
import { can, canChangeRole, canModerateUser, ROLES, type Capability, type Role } from "@/lib/auth/permissions";

/** Pure administration contracts. */

const actor = (role: Role, id = `a-${role}`) => ({ id, role });
const target = (role: Role, id = `t-${role}`) => ({ id, role });

describe("capability and escalation matrix", () => {
  const caps: Capability[] = ["admin.access", "users.view", "users.manage", "users.assignAdmin", "settings.manage", "settings.manageSecurity", "audit.view"];
  it("grants exactly the documented capabilities", () => {
    const table = Object.fromEntries(ROLES.map((r) => [r, caps.filter((c) => can(r, c))]));
    expect(table).toEqual({
      super_admin: caps,
      admin: ["admin.access", "users.view", "users.manage", "settings.manage", "audit.view"],
      user: [],
    });
  });

  it("moderation: only strictly lower roles, never oneself", () => {
    const allowed = ROLES.flatMap((a) => ROLES.filter((t) => canModerateUser(actor(a), target(t))).map((t) => `${a}>${t}`));
    expect(allowed.sort()).toEqual(["admin>user", "super_admin>admin", "super_admin>user"]);
    for (const r of ROLES) expect(canModerateUser(actor(r, "same"), target(r, "same"))).toBe(false);
  });

  it("role changes: only the super administrator grants or removes admin; super_admin can't be granted or changed", () => {
    const allowed: string[] = [];
    for (const a of ROLES) for (const t of ROLES) for (const next of ROLES) if (canChangeRole(actor(a), target(t), next)) allowed.push(`${a}:${t}->${next}`);
    // Same-role pairs (x->x) pass the rule but are no-ops in changeUserRole: nothing is written or audited.
    expect(allowed.sort()).toEqual(["admin:user->user", "super_admin:admin->admin", "super_admin:admin->user", "super_admin:user->admin", "super_admin:user->user"]);
    expect(canChangeRole(actor("super_admin", "x"), target("user", "x"), "admin")).toBe(false); // self
  });
});

describe("no-op rules", () => {
  it("treats a request for the current state as a no-op", () => {
    expect([isNoOpBan(true, true), isNoOpBan(false, false), isNoOpBan(true, false), isNoOpBan(false, true)]).toEqual([true, true, false, false]);
    expect([isNoOpRole("admin", "admin"), isNoOpRole("user", "admin")]).toEqual([true, false]);
  });
});

describe("strict query schemas and pagination", () => {
  it("user list: defaults, bounds and unknown keys", () => {
    expect(userListQuerySchema.parse({})).toEqual({ q: "", role: "all", status: "all", page: 1 });
    expect(userListQuerySchema.parse({ q: "  Ann  ", page: "3", role: "admin", status: "disabled" })).toEqual({ q: "Ann", role: "admin", status: "disabled", page: 3 });
    for (const bad of [{ page: "0" }, { page: "1.5" }, { page: "10001" }, { page: "-1" }, { role: "root" }, { status: "x" }, { q: "x".repeat(101) }, { order: "email" }]) {
      expect(userListQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("escapes LIKE wildcards and the escape character", () => {
    expect(containsPattern("a_b%c\\d")).toBe("%a\\_b\\%c\\\\d%");
    expect(containsPattern("plain")).toBe("%plain%");
  });

  it("audit: allowlisted actions, bounded ids, real UTC days, ordered range and a strict cursor", () => {
    expect(auditQuerySchema.parse({})).toEqual({ action: "all" });
    expect(auditQuerySchema.parse({ action: "user.ban", actor: "abc-123", from: "2026-01-01", to: "2026-01-01" })).toMatchObject({ action: "user.ban", actor: "abc-123" });
    expect(auditQuerySchema.parse({ actor: "", target: "", cursor: "" })).toEqual({ action: "all" });
    const good = "2026-11-02T10:00:00.123456Z_42";
    expect(AUDIT_CURSOR.test(good)).toBe(true);
    expect(auditQuerySchema.parse({ cursor: good }).cursor).toBe(good);
    for (const bad of [
      { action: "user.delete" },
      { actor: "a b" },
      { actor: "x".repeat(65) },
      { target: "' or 1=1" },
      { from: "2026-02-30" },
      { from: "2026-03-02", to: "2026-03-01" },
      { cursor: "2026-11-02T10:00:00.123Z_42" },
      { cursor: "2026-11-02T10:00:00.123456Z_" },
      { cursor: "2026-11-02T10:00:00.123456Z_1;drop" },
      { page: "2" },
    ]) {
      expect(auditQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("audit display (allowlisted formatters)", () => {
  it("formats each known action from allowlisted fields only", () => {
    expect(formatAuditEntry("user.role_change", "u1", { from: "user", to: "admin", note: "<script>" })).toEqual({
      title: "Role changed",
      detail: null,
      change: { label: "Role", from: "User", to: "Administrator" },
    });
    expect(formatAuditEntry("user.role_change", "u1", { from: "root", to: 5 }).change).toEqual({ label: "Role", from: "Unknown", to: "Unknown" });
    expect(formatAuditEntry("settings.update", "registration.enabled", { from: null, to: false })).toEqual({
      title: "Setting changed",
      detail: "Public sign-up",
      change: { label: "Public sign-up", from: "Default", to: "Off" },
    });
    expect(formatAuditEntry("settings.update", "media.quotaMb", { from: 50, to: "75" }).change).toEqual({ label: "Image storage per account", from: "50 MB", to: "—" });
    expect(formatAuditEntry("settings.update", "smtp.password", { from: "a", to: "b" })).toEqual({ title: "Setting changed", detail: "Unknown setting", change: null });
    expect(formatAuditEntry("user.ban", "u1", { reason: "x".repeat(200) }).detail).toHaveLength(8 + 80);
    expect(formatAuditEntry("user.ban", "u1", null).detail).toBeNull();
    expect(formatAuditEntry("user.unban", "u1", { secret: "s" })).toEqual({ title: "Account re-enabled", detail: null, change: null });
    expect(formatAuditEntry("system.bootstrap", "u1", null).title).toBe("Installation set up");
    expect(formatAuditEntry("something.new", null, { password: "p" })).toEqual({ title: "Other event", detail: "something.new", change: null });
    for (const action of AUDIT_ACTIONS) {
      expect(JSON.stringify(formatAuditEntry(action, "site.name", { password: "hunter2", token: "t", email: "e@x" }))).not.toMatch(/hunter2|"t"|e@x/);
    }
  });

  it("formats setting values by kind and rejects mismatched types", () => {
    expect(formatSettingValue("site.name", "x".repeat(100))).toHaveLength(80);
    expect(formatSettingValue("site.name", 5)).toBe("—");
    expect(formatSettingValue("analytics.retentionDays", 395)).toBe("395 days");
    expect(formatSettingValue("registration.inviteOnly", true)).toBe("On");
    expect(formatSettingValue("registration.inviteOnly", "true")).toBe("—");
  });
});

describe("system status vocabulary", () => {
  const base: SystemStatus = { version: "abc123", database: "ok", storage: "ok", emailConfigured: true, migrations: 5, retentionDays: 395 };

  it("uses only fixed labels and validated values", () => {
    const states: CheckState[] = ["ok", "unavailable", "timeout"];
    expect(states.map((s) => CHECK_LABELS[s])).toEqual(["Ready", "Unavailable", "Not responding"]);
    const rows = statusRows({ ...base, storage: "unavailable", emailConfigured: false, migrations: null });
    expect(rows.map((r) => [r.id, r.value, r.tone])).toEqual([
      ["version", "abc123", "neutral"],
      ["database", "Ready", "ok"],
      ["storage", "Unavailable", "warn"],
      ["email", "No", "warn"],
      ["migrations", "Unknown", "neutral"],
      ["retention", "395 days", "neutral"],
      ["purge", "Scheduled outside COVALink; last run unknown", "neutral"],
    ]);
  });

  it("shows a version only when it is a plain identifier", () => {
    expect(versionLabel("3f9a1c7e5b2d")).toBe("3f9a1c7e5b2d");
    expect(versionLabel("v1.2.3-rc_1")).toBe("v1.2.3-rc_1");
    for (const bad of [undefined, "", "unknown", "postgresql://u:p@h/db", "/app/data", "a b", "x".repeat(65), 7]) expect(versionLabel(bad)).toBe("Unknown");
  });
});

describe("settings catalog", () => {
  it("covers exactly the seven installation settings, with security flags on registration only", () => {
    expect(SETTING_SPECS.map((s) => s.key)).toEqual([
      "site.name",
      "registration.enabled",
      "registration.inviteOnly",
      "profiles.maxPerUser",
      "media.quotaMb",
      "media.uploadsPerHour",
      "analytics.retentionDays",
    ]);
    expect(SETTING_SPECS.filter((s) => s.security).map((s) => s.key)).toEqual(["registration.enabled", "registration.inviteOnly"]);
  });
});
