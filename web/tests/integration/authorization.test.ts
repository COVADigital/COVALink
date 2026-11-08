import { beforeEach, describe, expect, it } from "vitest";
import { changeUserRole, setUserBanned } from "@/features/admin/users";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { auth } from "@/lib/auth/server";
import { AppError } from "@/lib/errors";
import { authRequest, cookieFrom, deleteAccount, signIn, signUp } from "../support/auth-http";
import { resetDatabase, testSql } from "../support/db";
import { TEST_SETUP_TOKEN } from "../support/test-env";

let superId: string;
let adminId: string;
let userId: string;
let user2Id: string;

const idOf = async (email: string) => ((await testSql()`select id from users where email = ${email}`)[0] as { id: string }).id;
const roleOf = async (id: string) => ((await testSql()`select role from users where id = ${id}`)[0] as { role: string }).role;

async function denied(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe("FORBIDDEN");
}

beforeEach(async () => {
  await resetDatabase();
  ({ userId: superId } = await bootstrapSuperAdmin({
    token: TEST_SETUP_TOKEN,
    name: "Owner",
    email: "owner@example.com",
    password: "correct-horse-battery",
  }));
  for (const email of ["admin@example.com", "user@example.com", "user2@example.com"]) {
    expect((await signUp(email)).status).toBe(200);
  }
  [adminId, userId, user2Id] = await Promise.all(["admin@example.com", "user@example.com", "user2@example.com"].map(idOf));
  await changeUserRole(superId, adminId, "admin");
});

describe("privileged user management", () => {
  it("lets the super admin promote a user, with an audit entry", async () => {
    expect(await roleOf(adminId)).toBe("admin");
    const [log] = await testSql()`select action, metadata from audit_logs where action = 'user.role_change'`;
    expect(log).toEqual({ action: "user.role_change", metadata: { from: "user", to: "admin" } });
  });

  it("denies ordinary users every privileged action, including self-promotion", async () => {
    await denied(changeUserRole(userId, userId, "admin"));
    await denied(changeUserRole(userId, user2Id, "admin"));
    await denied(setUserBanned(userId, user2Id, true));
    await denied(setUserBanned(userId, superId, true));
    expect(await roleOf(userId)).toBe("user");
  });

  it("limits admins: no granting admin, no touching admins or the super admin", async () => {
    await denied(changeUserRole(adminId, userId, "admin"));
    await denied(changeUserRole(adminId, superId, "user"));
    await denied(setUserBanned(adminId, superId, true));
    await denied(changeUserRole(adminId, adminId, "super_admin"));
    await setUserBanned(adminId, userId, true); // allowed: admin over user
  });

  it("never assigns super_admin, even when requested by the super admin", async () => {
    await denied(changeUserRole(superId, userId, "super_admin"));
    await expect(changeUserRole(superId, userId, "root")).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("re-reads the actor's role from the database (a demoted or banned admin loses power)", async () => {
    await changeUserRole(superId, adminId, "user");
    await denied(setUserBanned(adminId, userId, true));
    await changeUserRole(superId, adminId, "admin");
    await setUserBanned(superId, adminId, true);
    await denied(setUserBanned(adminId, userId, true));
  });

  it("refuses to delete the super administrator account (account service and Better Auth hook)", async () => {
    const cookie = cookieFrom(await signIn("owner@example.com"));
    await expect(deleteAccount(cookie)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Even a direct server call that skips the service's own role check is refused by beforeDelete.
    await expect(auth.api.deleteUser({ body: { password: "correct-horse-battery" }, headers: new Headers({ cookie }) })).rejects.toMatchObject({ status: "FORBIDDEN" });
    // Better Auth's own endpoint is unreachable over HTTP.
    expect((await authRequest("/delete-user", { cookie, body: { password: "correct-horse-battery" } })).status).toBe(404);
    expect(await roleOf(superId)).toBe("super_admin");
  });
});
