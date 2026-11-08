import { beforeEach, describe, expect, it } from "vitest";
import { bootstrapSuperAdmin, isBootstrapped } from "@/features/setup/service";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { signIn, signUp } from "../support/auth-http";
import { resetDatabase, testSql } from "../support/db";
import { TEST_SETUP_TOKEN } from "../support/test-env";

const valid = (email = "owner@example.com") => ({
  token: TEST_SETUP_TOKEN,
  name: "Owner",
  email,
  password: "correct-horse-battery",
});

async function counts() {
  const sql = testSql();
  const [r] = await sql<{ users: number; supers: number; boot: number; accounts: number }[]>`
    select (select count(*)::int from users) as users,
           (select count(*)::int from users where role = 'super_admin') as supers,
           (select count(*)::int from system_bootstrap) as boot,
           (select count(*)::int from accounts) as accounts`;
  return r;
}

async function expectAppError(p: Promise<unknown>, code: AppError["code"]) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
}

beforeEach(resetDatabase);

describe("super-admin bootstrap authorization", () => {
  it("is refused when SETUP_TOKEN is not configured", async () => {
    const e = env();
    const saved = e.SETUP_TOKEN;
    e.SETUP_TOKEN = undefined;
    try {
      await expectAppError(bootstrapSuperAdmin(valid()), "FORBIDDEN");
    } finally {
      e.SETUP_TOKEN = saved;
    }
    expect(await counts()).toMatchObject({ users: 0, boot: 0 });
  });

  it("is refused with a wrong token and creates nothing", async () => {
    await expectAppError(bootstrapSuperAdmin({ ...valid(), token: "x".repeat(40) }), "FORBIDDEN");
    await expectAppError(bootstrapSuperAdmin({ ...valid(), token: "" }), "VALIDATION");
    expect(await counts()).toMatchObject({ users: 0, boot: 0 });
    expect(await isBootstrapped()).toBe(false);
  });

  it("creates exactly one verified super admin whose password works for sign-in", async () => {
    const { userId } = await bootstrapSuperAdmin(valid("Owner@Example.com"));
    const [user] = await testSql()`select email, role, email_verified, banned from users where id = ${userId}`;
    expect(user).toEqual({ email: "owner@example.com", role: "super_admin", email_verified: true, banned: false });
    expect(await counts()).toEqual({ users: 1, supers: 1, boot: 1, accounts: 1 });
    const [audit] = await testSql()`select action, actor_id from audit_logs`;
    expect(audit).toEqual({ action: "system.bootstrap", actor_id: userId });

    const res = await signIn("owner@example.com");
    expect(res.status).toBe(200);
  });

  it("cannot be reused after success, even with the valid token", async () => {
    await bootstrapSuperAdmin(valid());
    await expectAppError(bootstrapSuperAdmin(valid("second@example.com")), "CONFLICT");
    expect(await counts()).toMatchObject({ users: 1, supers: 1, boot: 1 });
  });

  it("allows at most one success under concurrent authorized attempts", async () => {
    const attempts = Array.from({ length: 8 }, (_, i) => bootstrapSuperAdmin(valid(`racer${i}@example.com`)));
    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    for (const r of rejected) expect((r.reason as AppError).code).toBe("CONFLICT");
    expect(await counts()).toEqual({ users: 1, supers: 1, boot: 1, accounts: 1 });
  });

  it("rolls back completely if interrupted, leaving setup open", async () => {
    await expect(
      bootstrapSuperAdmin(valid(), {
        beforeCommit: async () => {
          throw new Error("simulated crash after inserts");
        },
      }),
    ).rejects.toThrow("simulated crash");
    expect(await counts()).toEqual({ users: 0, supers: 0, boot: 0, accounts: 0 });
    expect(await isBootstrapped()).toBe(false);

    // A later legitimate attempt still succeeds.
    await bootstrapSuperAdmin(valid());
    expect(await counts()).toMatchObject({ supers: 1, boot: 1 });
  });

  it("rejects an email that already belongs to an account", async () => {
    await testSql()`insert into users (id, name, email, role) values ('pre', 'Pre', 'owner@example.com', 'user')`;
    await expectAppError(bootstrapSuperAdmin(valid()), "CONFLICT");
    expect(await counts()).toMatchObject({ supers: 0, boot: 0 });
  });
});

describe("database invariants", () => {
  it("forbids a second super admin even via direct SQL", async () => {
    await bootstrapSuperAdmin(valid());
    await expect(
      testSql()`insert into users (id, name, email, role) values ('x', 'X', 'x@example.com', 'super_admin')`,
    ).rejects.toMatchObject({ code: "23505" });
    await testSql()`insert into users (id, name, email, role) values ('y', 'Y', 'y@example.com', 'user')`;
    await expect(testSql()`update users set role = 'super_admin' where id = 'y'`).rejects.toMatchObject({ code: "23505" });
  });

  it("allows only the single bootstrap row and only known roles", async () => {
    const { userId } = await bootstrapSuperAdmin(valid());
    await expect(testSql()`insert into system_bootstrap (id, super_admin_id) values (2, ${userId})`).rejects.toMatchObject({
      code: "23514",
    });
    await expect(testSql()`insert into system_bootstrap (id, super_admin_id) values (1, ${userId})`).rejects.toMatchObject({
      code: "23505",
    });
    await expect(
      testSql()`insert into users (id, name, email, role) values ('r', 'R', 'r@example.com', 'root')`,
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("ordinary registration before setup", () => {
  it("is refused until the server has been bootstrapped", async () => {
    const res = await signUp("early@example.com");
    expect(res.status).toBe(403);
    expect(await counts()).toMatchObject({ users: 0 });
  });
});
