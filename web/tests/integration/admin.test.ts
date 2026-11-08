import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
}));

// Server Actions resolve the session from request headers; here it is chosen per test.
const session = vi.hoisted(() => ({ user: null as null | { id: string; name: string; email: string; emailVerified: boolean; role: "user" | "admin" | "super_admin" } }));
vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: async () => session.user,
}));

import * as actions from "@/features/admin/actions";
import { listAuditEntries } from "@/features/admin/audit";
import { getInstallationSummary, getSystemStatus } from "@/features/admin/status";
import { changeUserRole, getUserDetail, listUsers, setUserBanned, USERS_PAGE_SIZE } from "@/features/admin/users";
import { getLiveProfile } from "@/features/profiles/public";
import * as svc from "@/features/profiles/service";
import { SETTING_SPECS } from "@/features/settings/catalog";
import { getAdminSettings, getSetting, setSetting, type SettingKey } from "@/features/settings/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { resolveSessionUser } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { cookieFrom, signIn, signUp } from "../support/auth-http";
import { resetDatabase, testSql } from "../support/db";
import { TEST_SETUP_TOKEN } from "../support/test-env";

/** Administration services and actions against the guarded test database. */

let superId = "";
let admin = "";
let admin2 = "";
let alice = "";
let bob = "";
let banned = "";

const idOf = async (email: string) => ((await testSql()`select id from users where email = ${email}`)[0] as { id: string }).id;
const audits = async () => Number((await testSql()`select count(*)::int as n from audit_logs where action <> 'system.bootstrap'`)[0].n);
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof AppError ? e.code : `non-AppError: ${String(e)}`));
const as = (id: string | null, role: "user" | "admin" | "super_admin" = "user") => {
  session.user = id ? { id, name: id, email: `${id}@example.com`, emailVerified: true, role } : null;
};

beforeEach(async () => {
  await resetDatabase();
  session.user = null;
  ({ userId: superId } = await bootstrapSuperAdmin({ token: TEST_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: "correct-horse-battery" }));
  for (const email of ["admin@example.com", "admin2@example.com", "alice@example.com", "bob@example.com", "banned@example.com"]) {
    expect((await signUp(email)).status).toBe(200);
  }
  [admin, admin2, alice, bob, banned] = await Promise.all(["admin@example.com", "admin2@example.com", "alice@example.com", "bob@example.com", "banned@example.com"].map(idOf));
  await changeUserRole(superId, admin, "admin");
  await changeUserRole(superId, admin2, "admin");
  await changeUserRole(superId, banned, "admin");
  await setUserBanned(superId, banned, true);
  await testSql()`delete from audit_logs where action <> 'system.bootstrap'`;
});

describe("authorized reads (every service checks the actor itself)", () => {
  const reads = (actor: string) => [
    listUsers(actor, {}),
    getUserDetail(actor, alice),
    getAdminSettings(actor),
    listAuditEntries(actor, {}),
    getSystemStatus(actor, { storageProbe: async () => "ok" }),
    getInstallationSummary(actor),
  ];

  it("lets the super administrator and administrators read", async () => {
    for (const actor of [superId, admin]) expect(await Promise.all(reads(actor).map(code))).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
  });

  it("refuses ordinary users, a banned administrator, unknown and malformed actors", async () => {
    for (const actor of [alice, banned, "no-such-user", "", "x".repeat(65)]) {
      expect(await Promise.all(reads(actor).map(code)), actor.slice(0, 12)).toEqual(Array(6).fill("FORBIDDEN"));
    }
    for (const actor of [null, undefined, 42, { id: superId, role: "super_admin" }] as unknown[]) {
      expect(await code(listUsers(actor as string, {}))).toBe("FORBIDDEN");
    }
  });

  it("re-reads the role: a demoted administrator loses access at once", async () => {
    await changeUserRole(superId, admin, "user");
    expect(await code(listUsers(admin, {}))).toBe("FORBIDDEN");
    expect(await code(listAuditEntries(admin, {}))).toBe("FORBIDDEN");
  });

  it("security settings are readable by administrators but editable only by the super administrator", async () => {
    const forAdmin = new Map((await getAdminSettings(admin)).map((s) => [s.key, s]));
    const forSuper = new Map((await getAdminSettings(superId)).map((s) => [s.key, s]));
    expect(forAdmin.get("registration.enabled")).toMatchObject({ editable: false, value: true, source: "default" });
    expect(forAdmin.get("site.name")).toMatchObject({ editable: true, value: "COVALink" });
    expect(forSuper.get("registration.inviteOnly")).toMatchObject({ editable: true });
    expect([...forAdmin.keys()].sort()).toEqual(
      ["analytics.retentionDays", "media.quotaMb", "media.uploadsPerHour", "profiles.maxPerUser", "registration.enabled", "registration.inviteOnly", "site.name"].sort(),
    );
  });
});

describe("mutations: capability and escalation matrix, with exact audit cardinality", () => {
  it("administrators disable and re-enable ordinary users, one audit row each", async () => {
    expect(await setUserBanned(admin, alice, true)).toEqual({ changed: true });
    expect(await setUserBanned(admin, alice, false)).toEqual({ changed: true });
    const rows = await testSql()`select actor_id, action, target_id from audit_logs where action like 'user.%ban' order by id`;
    expect(rows).toEqual([
      { actor_id: admin, action: "user.ban", target_id: alice },
      { actor_id: admin, action: "user.unban", target_id: alice },
    ]);
  });

  it("refuses administrators acting on themselves, administrators and the super administrator; zero audit rows", async () => {
    for (const [actor, target] of [
      [admin, admin],
      [admin, admin2],
      [admin, superId],
      [superId, superId],
      [alice, bob],
      [banned, alice],
    ]) {
      expect(await code(setUserBanned(actor, target, true)), `${actor}->${target}`).toBe("FORBIDDEN");
    }
    expect(await code(setUserBanned(admin, "no-such-user", true))).toBe("NOT_FOUND");
    expect(await audits()).toBe(0);
    expect((await testSql()`select count(*)::int as n from users where banned`)[0].n).toBe(1);
  });

  it("only the super administrator grants or removes admin; super_admin is immutable", async () => {
    expect(await code(changeUserRole(admin, alice, "admin"))).toBe("FORBIDDEN");
    expect(await code(changeUserRole(admin, admin2, "user"))).toBe("FORBIDDEN");
    expect(await code(changeUserRole(superId, alice, "super_admin"))).toBe("FORBIDDEN");
    expect(await code(changeUserRole(superId, superId, "user"))).toBe("FORBIDDEN");
    expect(await code(changeUserRole(admin, superId, "user"))).toBe("FORBIDDEN");
    expect(await code(changeUserRole(superId, alice, "owner"))).toBe("VALIDATION");
    expect(await audits()).toBe(0);
    expect(await changeUserRole(superId, alice, "admin")).toEqual({ changed: true });
    expect(await changeUserRole(superId, alice, "user")).toEqual({ changed: true });
    expect(await testSql()`select metadata from audit_logs where action = 'user.role_change' order by id`).toEqual([
      { metadata: { from: "user", to: "admin" } },
      { metadata: { from: "admin", to: "user" } },
    ]);
  });

  it("no-ops change nothing and audit nothing: already disabled, same role, same setting value, the default value", async () => {
    await setUserBanned(admin, alice, true);
    await testSql()`delete from audit_logs where action <> 'system.bootstrap'`;
    expect(await setUserBanned(admin, alice, true)).toEqual({ changed: false });
    expect(await setUserBanned(superId, bob, false)).toEqual({ changed: false });
    expect(await changeUserRole(superId, admin, "admin")).toEqual({ changed: false });
    expect(await setSetting("site.name", "COVALink", admin)).toEqual({ changed: false }); // equals the default, unset
    expect(await testSql()`select key from system_settings`).toEqual([]);
    expect(await setSetting("site.name", "Links", admin)).toEqual({ changed: true });
    expect(await setSetting("site.name", "Links", admin)).toEqual({ changed: false });
    expect(await audits()).toBe(1);
    // Authorization comes first: a refused no-op is still refused.
    expect(await code(setUserBanned(alice, bob, false))).toBe("FORBIDDEN");
  });

  it("each change is atomic with its audit row: a failing audit insert rolls the change back", async () => {
    await testSql()`alter table audit_logs add constraint admin_test_reject check (action not in ('user.ban', 'user.role_change', 'settings.update'))`;
    try {
      const aliceSession = cookieFrom(await signIn("alice@example.com"));
      expect(await code(setUserBanned(admin, alice, true))).toMatch(/^non-AppError/);
      expect(await code(changeUserRole(superId, bob, "admin"))).toMatch(/^non-AppError/);
      expect(await code(setSetting("site.name", "Never", admin))).toMatch(/^non-AppError/);
      expect((await testSql()`select banned from users where id = ${alice}`)[0].banned).toBe(false);
      expect((await testSql()`select role from users where id = ${bob}`)[0].role).toBe("user");
      expect(await testSql()`select key from system_settings`).toEqual([]);
      expect(await resolveSessionUser(new Headers({ cookie: aliceSession }))).not.toBeNull(); // sessions kept
      expect(await audits()).toBe(0);
    } finally {
      await testSql()`alter table audit_logs drop constraint admin_test_reject`;
    }
  });
});

describe("authorization before existence", () => {
  const failure = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof AppError ? `${e.code}: ${e.message}` : `non-AppError: ${String(e)}`));
  const unknownId = () => crypto.randomUUID().replaceAll("-", ""); // the shape of a real id, but no such account
  const state = () => testSql()`select id, role, banned from users order by id`;

  it("refuses unauthorized actors identically for existing, unknown and malformed targets; nothing changes", async () => {
    const before = await state();
    const targets = [bob, admin2, superId, unknownId(), unknownId(), "", "x".repeat(65)];
    for (const actor of [alice, banned, "no-such-user", ""]) {
      const results = new Set<string>();
      for (const target of targets) {
        results.add(await failure(setUserBanned(actor, target, true)));
        results.add(await failure(setUserBanned(actor, target, false)));
        results.add(await failure(changeUserRole(actor, target, "admin")));
        results.add(await failure(changeUserRole(actor, target, "user")));
      }
      expect([...results], actor.slice(0, 12)).toEqual(["FORBIDDEN: You don't have permission to do that."]);
    }
    expect(await state()).toEqual(before);
    expect(await audits()).toBe(0);
  });

  it("authorized administrators still learn NOT_FOUND for unknown and malformed targets", async () => {
    for (const actor of [admin, superId]) {
      for (const target of [unknownId(), "", "x".repeat(65)]) {
        expect(await code(setUserBanned(actor, target, true))).toBe("NOT_FOUND");
        expect(await code(changeUserRole(actor, target, "user"))).toBe("NOT_FOUND");
      }
    }
    expect(await audits()).toBe(0);
  });

  it("through the Server Actions: an ordinary user's result is the same for an existing and an unknown account", async () => {
    const before = await state();
    const ghost = unknownId();
    as(alice);
    const forbidden = { ok: false, error: "You don't have permission to do that.", code: "FORBIDDEN" };
    for (const userId of [bob, admin, superId, ghost]) {
      expect(await actions.setUserDisabledAction({ userId, disabled: true }), userId).toEqual(forbidden);
      expect(await actions.setUserDisabledAction({ userId, disabled: false }), userId).toEqual(forbidden);
      expect(await actions.changeUserRoleAction({ userId, role: "admin" }), userId).toEqual(forbidden);
      expect(await actions.changeUserRoleAction({ userId, role: "user" }), userId).toEqual(forbidden);
    }
    as(admin, "admin");
    expect(await actions.setUserDisabledAction({ userId: ghost, disabled: true })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await actions.changeUserRoleAction({ userId: ghost, role: "user" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await state()).toEqual(before);
    expect(await audits()).toBe(0);
  });
});

describe("concurrent setting writes", () => {
  const resetSettings = async () => {
    await testSql()`delete from system_settings`;
    await testSql()`delete from audit_logs where action <> 'system.bootstrap'`;
  };

  it("concurrent first writes of one value: exactly one change, one row and one audit entry", async () => {
    for (let round = 0; round < 5; round++) {
      await resetSettings();
      const results = await Promise.all(Array.from({ length: 8 }, () => setSetting("site.name", "Concurrent Links", admin)));
      expect(results.filter((r) => r.changed), `round ${round}`).toHaveLength(1);
      expect(results.filter((r) => !r.changed), `round ${round}`).toHaveLength(7);
      expect(await testSql()`select key, value from system_settings`).toEqual([{ key: "site.name", value: "Concurrent Links" }]);
      expect(await testSql()`select metadata from audit_logs where action = 'settings.update'`).toEqual([{ metadata: { from: null, to: "Concurrent Links" } }]);
    }
  });

  it("concurrent first writes of different values form an accurate audit chain ending at the stored value", async () => {
    for (let round = 0; round < 10; round++) {
      await resetSettings();
      const values = Array.from({ length: 6 }, (_, i) => `Round ${round} value ${i}`);
      const results = await Promise.all(values.map((v) => setSetting("site.name", v, superId)));
      expect(results.every((r) => r.changed), `round ${round}`).toBe(true);
      const chain = (await testSql()`select metadata from audit_logs where action = 'settings.update' order by id`).map(
        (r) => r.metadata as { from: string | null; to: string },
      );
      expect(chain).toHaveLength(values.length);
      // `from: null` means nothing was stored (the default was in effect).
      let effective: string | null = null;
      for (const entry of chain) {
        expect(entry.from, `round ${round}`).toBe(effective);
        effective = entry.to;
      }
      expect(chain.map((e) => e.to).sort()).toEqual([...values].sort());
      expect((await testSql()`select value from system_settings where key = 'site.name'`)[0].value).toBe(effective);
      expect(await getSetting("site.name")).toBe(effective);
    }
  });
});

describe("disabling and re-enabling", () => {
  it("ends every session, takes public profiles offline immediately, and requires a new sign-in after re-enabling", async () => {
    const { id } = await svc.createProfile(alice, { handle: "alice", label: "Alice", displayName: "Alice" });
    await svc.publishProfile(alice, id, { expectedRevision: 0, patch: { header: { displayName: "Alice", bio: "" }, seo: { noindex: false } } });
    const first = cookieFrom(await signIn("alice@example.com"));
    const second = cookieFrom(await signIn("alice@example.com"));
    expect(await getLiveProfile("alice")).not.toBeNull();

    await setUserBanned(admin, alice, true);
    expect((await testSql()`select count(*)::int as n from sessions where user_id = ${alice}`)[0].n).toBe(0);
    for (const c of [first, second]) expect(await resolveSessionUser(new Headers({ cookie: c }))).toBeNull();
    expect(await getLiveProfile("alice")).toBeNull();
    expect((await signIn("alice@example.com")).status).not.toBe(200);

    await setUserBanned(admin, alice, false);
    expect(await getLiveProfile("alice")).not.toBeNull();
    expect(await resolveSessionUser(new Headers({ cookie: first }))).toBeNull(); // old sessions stay gone
    expect((await signIn("alice@example.com")).status).toBe(200);
  });
});

describe("settings catalog matches the server schemas", () => {
  it("accepts each catalog bound and rejects one past it, through setSetting", async () => {
    for (const spec of SETTING_SPECS) {
      const key = spec.key as SettingKey;
      if (spec.kind === "integer") {
        expect(await code(setSetting(key, (spec.min! - 1) as never, superId)), `${key} min-1`).toBe("VALIDATION");
        expect(await code(setSetting(key, (spec.max! + 1) as never, superId)), `${key} max+1`).toBe("VALIDATION");
        expect(await code(setSetting(key, spec.min as never, superId)), `${key} min`).toBe("ok");
        expect(await code(setSetting(key, spec.max as never, superId)), `${key} max`).toBe("ok");
      } else if (spec.kind === "text") {
        expect(await code(setSetting(key, "x".repeat(spec.maxLength! + 1) as never, superId))).toBe("VALIDATION");
        expect(await code(setSetting(key, "x".repeat(spec.maxLength!) as never, superId))).toBe("ok");
      } else {
        expect(await code(setSetting(key, "yes" as never, superId))).toBe("VALIDATION");
        expect(await code(setSetting(key, true as never, superId))).toBe("ok");
      }
    }
  });
});

describe("settings take effect without a restart", () => {
  it("profile limit, sign-up and invite-only (which closes registration completely)", async () => {
    await setSetting("profiles.maxPerUser", 1, admin);
    await svc.createProfile(bob, { handle: "bob-one", label: "One", displayName: "Bob" });
    expect(await code(svc.createProfile(bob, { handle: "bob-two", label: "Two", displayName: "Bob" }))).toBe("LIMIT");
    expect(await getSetting("profiles.maxPerUser")).toBe(1);

    expect((await signUp("new1@example.com")).status).toBe(200);
    await setSetting("registration.inviteOnly", true, superId);
    expect((await signUp("new2@example.com")).status).not.toBe(200);
    await setSetting("registration.inviteOnly", false, superId);
    await setSetting("registration.enabled", false, superId);
    expect((await signUp("new3@example.com")).status).not.toBe(200);
    expect(await code(setSetting("registration.enabled", true, admin))).toBe("FORBIDDEN");
  });
});

describe("Server Actions (forged calls)", () => {
  it("refuse a missing session, ordinary users and invalid input, changing nothing", async () => {
    as(null);
    expect(await actions.setUserDisabledAction({ userId: bob, disabled: true })).toMatchObject({ ok: false });
    as(alice);
    expect(await actions.setUserDisabledAction({ userId: bob, disabled: true })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await actions.changeUserRoleAction({ userId: alice, role: "admin" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await actions.updateSettingAction({ key: "site.name", value: "Hacked" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    as(admin, "admin");
    for (const bad of [
      { userId: bob, disabled: "yes" },
      { userId: bob, disabled: true, extra: 1 },
      { userId: "", disabled: true },
      null,
      [bob, true],
    ]) {
      expect(await actions.setUserDisabledAction(bad)).toMatchObject({ ok: false, code: "VALIDATION" });
    }
    expect(await actions.changeUserRoleAction({ userId: bob, role: "super_admin" })).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(await actions.updateSettingAction({ key: "smtp.password", value: "x" })).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(await actions.updateSettingAction({ key: "profiles.maxPerUser", value: 1000 })).toMatchObject({ ok: false, code: "VALIDATION" });
    // The session claims a role, but the database decides: alice's forged "super_admin" session is still a user.
    session.user = { id: alice, name: "a", email: "a@example.com", emailVerified: true, role: "super_admin" };
    expect(await actions.changeUserRoleAction({ userId: bob, role: "admin" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await audits()).toBe(0);
  });

  it("perform allowed changes through the services", async () => {
    as(admin, "admin");
    expect(await actions.setUserDisabledAction({ userId: bob, disabled: true })).toEqual({ ok: true, data: { changed: true } });
    expect(await actions.updateSettingAction({ key: "media.quotaMb", value: 75 })).toEqual({ ok: true, data: { changed: true } });
    as(superId, "super_admin");
    expect(await actions.changeUserRoleAction({ userId: bob, role: "admin" })).toEqual({ ok: true, data: { changed: true } });
    expect(await audits()).toBe(3);
  });
});

describe("user list: search, filters and stable pagination", () => {
  it("pages deterministically with equal creation times and covers every account exactly once", async () => {
    await testSql()`insert into users (id, name, email) select 'u-' || lpad(g::text, 3, '0'), 'Person ' || g, 'person' || g || '@example.com' from generate_series(1, 60) g`;
    await testSql()`update users set created_at = '2026-01-01T00:00:00Z'`;
    const all: string[] = [];
    for (let page = 1; page <= 3; page++) all.push(...(await listUsers(admin, { page })).items.map((u) => u.id));
    const total = (await listUsers(admin, {})).total;
    expect(total).toBe(66);
    expect(all).toHaveLength(Math.min(66, 3 * USERS_PAGE_SIZE));
    expect(new Set(all).size).toBe(all.length);
    const sorted = [...all].sort().reverse();
    expect(all).toEqual(sorted); // id descending as the tie-breaker
    expect((await listUsers(admin, { page: 4 })).items).toEqual([]); // past the end: empty
  });

  it("searches name and email case-insensitively; wildcards and quotes are literal", async () => {
    await testSql()`insert into users (id, name, email) values ('w1', 'Ann_Lee 100%', 'ann@example.org'), ('w2', 'Annabel', 'annabel@example.org'), ('w3', 'O''Brien', 'ob@example.org')`;
    const names = async (q: string) => (await listUsers(admin, { q })).items.map((u) => u.name).sort();
    expect(await names("ANNA")).toEqual(["Annabel"]);
    expect(await names("ann_LEE")).toEqual(["Ann_Lee 100%"]);
    expect(await names("_")).toEqual(["Ann_Lee 100%"]);
    expect(await names("%")).toEqual(["Ann_Lee 100%"]);
    expect(await names("'")).toEqual(["O'Brien"]);
    expect(await names("' or 1=1 --")).toEqual([]);
    expect(await names("\\")).toEqual([]);
    expect(await names("EXAMPLE.ORG")).toEqual(["Ann_Lee 100%", "Annabel", "O'Brien"]);
  });

  it("filters by role and status, and validates its query strictly", async () => {
    expect((await listUsers(admin, { role: "admin" })).items.map((u) => u.id).sort()).toEqual([admin, admin2, banned].sort());
    expect((await listUsers(admin, { status: "disabled" })).items.map((u) => u.id)).toEqual([banned]);
    expect((await listUsers(admin, { role: "admin", status: "active" })).total).toBe(2);
    for (const bad of [{ page: 0 }, { page: 10_001 }, { page: "x" }, { role: "owner" }, { status: "gone" }, { q: "x".repeat(101) }, { sort: "email" }]) {
      expect(await code(listUsers(admin, bad)), JSON.stringify(bad)).toBe("VALIDATION");
    }
  });

  it("detail lists owned profiles and the actions this actor may take", async () => {
    await svc.createProfile(alice, { handle: "alice-a", label: "A", displayName: "A" });
    const d = await getUserDetail(admin, alice);
    expect(d).toMatchObject({ email: "alice@example.com", role: "user", disabled: false, allowed: { disable: true, enable: false, roles: [] } });
    expect(d.profiles.map((p) => p.handle)).toEqual(["alice-a"]);
    expect((await getUserDetail(superId, alice)).allowed.roles).toEqual(["admin"]);
    expect((await getUserDetail(admin, admin2)).allowed).toEqual({ disable: false, enable: false, roles: [] });
    expect((await getUserDetail(superId, banned)).allowed).toMatchObject({ disable: false, enable: true, roles: ["user"] });
    expect(await code(getUserDetail(admin, "no-such-user"))).toBe("NOT_FOUND");
  });
});

describe("audit log", () => {
  it("filters by action, actor, target and UTC day; renders only allowlisted fields", async () => {
    await setUserBanned(admin, alice, true);
    await setSetting("site.name", "Links", admin);
    await changeUserRole(superId, bob, "admin");
    await testSql()`insert into audit_logs (actor_id, action, target_type, target_id, metadata) values
      (${admin}, 'settings.update', 'setting', 'site.name', ${testSql().json({ from: "a", to: "b", secret: "TOPSECRET", password: "hunter2" })})`;
    const all = await listAuditEntries(admin, {});
    expect(all.entries.map((e) => e.action).slice(0, 4)).toEqual(["settings.update", "user.role_change", "settings.update", "user.ban"]);
    expect(JSON.stringify(all)).not.toMatch(/TOPSECRET|hunter2|metadata/);
    expect(all.entries[0].display).toEqual({ title: "Setting changed", detail: "Site name", change: { label: "Site name", from: "a", to: "b" } });
    expect(all.entries.find((e) => e.action === "user.role_change")?.display.change).toEqual({ label: "Role", from: "User", to: "Administrator" });
    expect((await listAuditEntries(admin, { action: "user.ban" })).entries.map((e) => e.target?.id)).toEqual([alice]);
    expect((await listAuditEntries(admin, { actor: superId })).entries.every((e) => e.actor?.id === superId)).toBe(true);
    expect((await listAuditEntries(admin, { target: bob })).entries.map((e) => e.action)).toEqual(["user.role_change"]);
    const today = new Date().toISOString().slice(0, 10);
    expect((await listAuditEntries(admin, { from: today, to: today })).entries.length).toBeGreaterThanOrEqual(4);
    expect((await listAuditEntries(admin, { from: "2020-01-01", to: "2020-01-02" })).entries).toEqual([]);
    for (const bad of [{ action: "user.delete" }, { actor: "x' or 1=1" }, { from: "2026-13-01" }, { from: "2026-02-02", to: "2026-02-01" }, { cursor: "abc" }, { page: 2 }]) {
      expect(await code(listAuditEntries(admin, bad)), JSON.stringify(bad)).toBe("VALIDATION");
    }
  });

  it("keyset pages are stable with equal timestamps and new entries written while paging", async () => {
    await testSql()`insert into audit_logs (actor_id, action, target_type, target_id, created_at)
      select ${admin}, 'user.ban', 'user', ${alice}, '2026-06-01T12:00:00.123456Z' from generate_series(1, 120)`;
    const seen: number[] = [];
    let cursor: string | undefined;
    let first = true;
    do {
      const page = await listAuditEntries(admin, { action: "user.ban", ...(cursor ? { cursor } : {}) });
      seen.push(...page.entries.map((e) => e.id));
      if (first) {
        // A new entry arrives after the first page: it must not shift later pages.
        await testSql()`insert into audit_logs (actor_id, action, target_type, target_id) values (${admin}, 'user.ban', 'user', ${bob})`;
        first = false;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
  });
});

describe("system status", () => {
  it("reports storage unavailable while the database works, using only the fixed vocabulary", async () => {
    const s = await getSystemStatus(superId, { storageProbe: async () => "unavailable" });
    const migrations = Number((await testSql()`select count(*)::int as n from drizzle.__drizzle_migrations`)[0].n);
    expect(s).toEqual({ version: "Unknown", database: "ok", storage: "unavailable", emailConfigured: false, migrations, retentionDays: 395 });
    expect(JSON.stringify(s)).not.toMatch(/postgres|:\/\/|\\|\/tmp|covalink-media|password|localhost|127\.0\.0\.1/i);
    expect(await getInstallationSummary(admin)).toMatchObject({ accounts: 6 });
  });
});
