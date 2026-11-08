import { describe, expect, it } from "vitest";
import { can, canChangeRole, canModerateUser, isRole, type Role } from "@/lib/auth/permissions";

const u = (id: string, role: Role) => ({ id, role });
const superAdmin = u("s", "super_admin");
const admin = u("a", "admin");
const admin2 = u("a2", "admin");
const user = u("u", "user");
const user2 = u("u2", "user");

describe("capabilities", () => {
  it("grants nothing privileged to ordinary users", () => {
    expect(can("user", "admin.access")).toBe(false);
    expect(can("user", "users.manage")).toBe(false);
    expect(can("user", "settings.manage")).toBe(false);
  });
  it("reserves security settings and admin assignment for the super admin", () => {
    expect(can("admin", "settings.manageSecurity")).toBe(false);
    expect(can("admin", "users.assignAdmin")).toBe(false);
    expect(can("super_admin", "settings.manageSecurity")).toBe(true);
    expect(can("super_admin", "users.assignAdmin")).toBe(true);
  });
  it("recognizes only known roles", () => {
    expect(isRole("admin")).toBe(true);
    expect(isRole("root")).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});

describe("canChangeRole", () => {
  it("never lets anyone change their own role", () => {
    expect(canChangeRole(user, user, "admin")).toBe(false);
    expect(canChangeRole(admin, admin, "super_admin")).toBe(false);
    expect(canChangeRole(superAdmin, superAdmin, "user")).toBe(false);
  });

  it("never assigns or removes super_admin through role changes", () => {
    expect(canChangeRole(superAdmin, user, "super_admin")).toBe(false);
    expect(canChangeRole(superAdmin, admin, "super_admin")).toBe(false);
    expect(canChangeRole(admin, superAdmin, "user")).toBe(false);
  });

  it("denies ordinary users entirely", () => {
    expect(canChangeRole(user, user2, "admin")).toBe(false);
    expect(canChangeRole(user, user2, "user")).toBe(false);
  });

  it("lets admins manage users but not grant admin or touch other admins", () => {
    expect(canChangeRole(admin, user, "user")).toBe(true);
    expect(canChangeRole(admin, user, "admin")).toBe(false);
    expect(canChangeRole(admin, admin2, "user")).toBe(false);
  });

  it("lets the super admin promote and demote admins", () => {
    expect(canChangeRole(superAdmin, user, "admin")).toBe(true);
    expect(canChangeRole(superAdmin, admin, "user")).toBe(true);
  });
});

describe("canModerateUser", () => {
  it("requires strictly higher rank and never self", () => {
    expect(canModerateUser(superAdmin, admin)).toBe(true);
    expect(canModerateUser(admin, user)).toBe(true);
    expect(canModerateUser(admin, admin2)).toBe(false);
    expect(canModerateUser(admin, superAdmin)).toBe(false);
    expect(canModerateUser(user, user2)).toBe(false);
    expect(canModerateUser(admin, admin)).toBe(false);
  });
});
