import { beforeEach, describe, expect, it } from "vitest";
import { changeUserRole, setUserBanned } from "@/features/admin/users";
import { getSetting, setSetting, settingCapability } from "@/features/settings/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { AppError } from "@/lib/errors";
import { signUp } from "../support/auth-http";
import { resetDatabase, testSql } from "../support/db";
import { TEST_SETUP_TOKEN } from "../support/test-env";

let superId: string;
let adminId: string;
let userId: string;

const idOf = async (email: string) => ((await testSql()`select id from users where email = ${email}`)[0] as { id: string }).id;
const settingRows = async () => testSql()`select key, value, updated_by from system_settings order by key`;
const auditRows = async () => testSql()`select actor_id, target_id, metadata from audit_logs where action = 'settings.update' order by id`;

async function forbidden(p: Promise<unknown>) {
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
  for (const email of ["admin@example.com", "user@example.com"]) expect((await signUp(email)).status).toBe(200);
  [adminId, userId] = await Promise.all(["admin@example.com", "user@example.com"].map(idOf));
  await changeUserRole(superId, adminId, "admin");
});

describe("setting classification", () => {
  it("treats registration settings as security settings", () => {
    expect(settingCapability("registration.enabled")).toBe("settings.manageSecurity");
    expect(settingCapability("registration.inviteOnly")).toBe("settings.manageSecurity");
    expect(settingCapability("site.name")).toBe("settings.manage");
  });
});

describe("global settings write boundary", () => {
  it("rejects ordinary users for every setting and writes nothing", async () => {
    await forbidden(setSetting("site.name", "Hijacked", userId));
    await forbidden(setSetting("registration.enabled", true, userId));
    await forbidden(setSetting("profiles.maxPerUser", 100, userId));
    expect(await settingRows()).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it("lets admins change ordinary settings but not registration/security settings", async () => {
    await setSetting("site.name", "Family Links", adminId);
    await setSetting("profiles.maxPerUser", 3, adminId);
    expect(await getSetting("site.name")).toBe("Family Links");
    expect(await getSetting("profiles.maxPerUser")).toBe(3);

    await forbidden(setSetting("registration.enabled", false, adminId));
    await forbidden(setSetting("registration.inviteOnly", true, adminId));
    expect(await getSetting("registration.enabled")).toBe(true); // test env default unchanged
  });

  it("lets only the super admin change registration settings, audit-logged with before/after", async () => {
    await setSetting("registration.enabled", false, superId);
    await setSetting("registration.enabled", true, superId);
    expect(await getSetting("registration.enabled")).toBe(true);
    const audit = await auditRows();
    expect(audit).toEqual([
      { actor_id: superId, target_id: "registration.enabled", metadata: { from: null, to: false } },
      { actor_id: superId, target_id: "registration.enabled", metadata: { from: false, to: true } },
    ]);
    const [row] = await settingRows();
    expect(row).toMatchObject({ key: "registration.enabled", value: true, updated_by: superId });
  });

  it("rejects a demoted admin and a banned admin", async () => {
    await changeUserRole(superId, adminId, "user");
    await forbidden(setSetting("site.name", "Demoted", adminId));
    await changeUserRole(superId, adminId, "admin");
    await setUserBanned(superId, adminId, true);
    await forbidden(setSetting("site.name", "Banned", adminId));
    expect(await settingRows()).toHaveLength(0);
  });

  it("rejects unknown or deleted actors", async () => {
    await forbidden(setSetting("site.name", "Ghost", "00000000-0000-0000-0000-000000000000"));
    await forbidden(setSetting("site.name", "Empty", ""));
  });

  it("cannot be bypassed by supplying a role or actor object instead of a trusted id", async () => {
    const spoofed = { id: superId, role: "super_admin" } as unknown as string;
    await forbidden(setSetting("registration.enabled", false, spoofed));
    const spoofedArray = [superId] as unknown as string;
    await forbidden(setSetting("registration.enabled", false, spoofedArray));
    // An ordinary user's real id stays ordinary no matter what else is passed around.
    await forbidden(setSetting("registration.enabled", false, userId));
    expect(await getSetting("registration.enabled")).toBe(true);
  });

  it("rejects unknown keys and invalid values without writing", async () => {
    await expect(setSetting("auth.secret" as never, "x" as never, superId)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(setSetting("profiles.maxPerUser", 0, superId)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(setSetting("registration.enabled", "yes" as never, superId)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await settingRows()).toHaveLength(0);
  });

  it("rolls back the setting if the audit write fails", async () => {
    // Temporary constraint on the guarded test database only; removed in `finally`.
    await testSql()`alter table audit_logs drop constraint if exists tmp_block_settings_audit`;
    await testSql()`alter table audit_logs add constraint tmp_block_settings_audit check (action <> 'settings.update') not valid`;
    try {
      await expect(setSetting("site.name", "Unaudited", superId)).rejects.toThrow();
      expect(await settingRows()).toHaveLength(0);
    } finally {
      await testSql()`alter table audit_logs drop constraint tmp_block_settings_audit`;
    }
  });
});
