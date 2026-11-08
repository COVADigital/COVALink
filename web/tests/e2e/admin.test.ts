import { renameSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { changeUserRole } from "@/features/admin/users";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { resetDatabase, testSql } from "../support/db";

/**
 * Administration over real HTTP against the production server (next
 * start, or the hardened image in container mode). Server Actions are called
 * the way a forged request would: with the action id taken from the client
 * bundle the admin page loads, posted directly.
 */
const BASE = process.env.E2E_BASE_URL!;
const DOWN = process.env.E2E_DOWN_URL!;
const PASSWORD = "correct-horse-battery";
const CONTAINER = Boolean(process.env.E2E_SERVER_IMAGE);
let ip = 1;
const nextIp = () => `198.18.80.${ip++ % 250}`;

let superId = "";
let adminId = "";
let userId = "";
let victimId = "";
const cookies: Record<"super" | "admin" | "user", string> = { super: "", admin: "", user: "" };

async function signIn(email: string) {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": nextIp() },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !c.endsWith("=")).join("; ");
}
async function signUp(name: string, email: string) {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": nextIp() },
    body: JSON.stringify({ name, email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
}
const get = async (path: string, cookie?: string) => {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual", headers: { "x-forwarded-for": nextIp(), ...(cookie ? { cookie } : {}) } });
  return { res, html: await res.text() };
};
const audits = async () => Number((await testSql()`select count(*)::int as n from audit_logs where action <> 'system.bootstrap'`)[0].n);
const DENIED = "NEXT_REDIRECT;replace;/dashboard?denied=1;307;";

/** Server Action ids, read from the client chunks an admin page loads (as a browser would get them). */
async function actionIds(): Promise<Record<string, string>> {
  const { html } = await get(`/admin/users/${victimId}`, cookies.super);
  const chunks = [...new Set([...html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]))];
  const ids: Record<string, string> = {};
  for (const src of chunks) {
    const js = await (await fetch(`${BASE}${src}`)).text();
    for (const m of js.matchAll(/createServerReference\)?\(\s*"([0-9a-f]{40,})"[^()]*?"(setUserDisabledAction|changeUserRoleAction|updateSettingAction)"/g)) ids[m[2]] = m[1];
  }
  return ids;
}
async function callAction(id: string, args: unknown[], cookie: string) {
  const res = await fetch(`${BASE}/admin/users/${victimId}`, {
    method: "POST",
    redirect: "manual",
    headers: { "next-action": id, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component", origin: BASE, cookie, "x-forwarded-for": nextIp() },
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.text() };
}

beforeAll(async () => {
  await resetDatabase();
  ({ userId: superId } = await bootstrapSuperAdmin({ token: process.env.E2E_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: PASSWORD }));
  await signUp("Ada Admin", "ada-admin@example.com");
  await signUp("Uma User", "uma-user@example.com");
  await signUp("Vic Victim", "vic-victim@example.com");
  [{ id: adminId }] = (await testSql()`select id from users where email = 'ada-admin@example.com'`) as unknown as { id: string }[];
  [{ id: userId }] = (await testSql()`select id from users where email = 'uma-user@example.com'`) as unknown as { id: string }[];
  [{ id: victimId }] = (await testSql()`select id from users where email = 'vic-victim@example.com'`) as unknown as { id: string }[];
  await changeUserRole(superId, adminId, "admin");
  await testSql()`delete from audit_logs where action <> 'system.bootstrap'`;
  cookies.super = await signIn("owner@example.com");
  cookies.admin = await signIn("ada-admin@example.com");
  cookies.user = await signIn("uma-user@example.com");
});

const PAGES = ["/admin", "/admin/users", `/admin/users/VICTIM`, "/admin/settings", "/admin/audit"];
const path = (p: string) => p.replace("VICTIM", victimId);

describe("admin routes by role", () => {
  it("signed out: every admin route redirects to sign-in", async () => {
    for (const p of PAGES) {
      const { res } = await get(path(p));
      expect(res.status, p).toBe(307);
      expect(res.headers.get("location"), p).toMatch(/\/login\?next=%2Fadmin/);
    }
  });

  it("an ordinary user is denied everywhere and sees no admin data", async () => {
    for (const p of PAGES) {
      const { html } = await get(path(p), cookies.user);
      expect(html, p).toContain(DENIED);
      for (const leak of ["vic-victim@example.com", "ada-admin@example.com", 'data-testid="users-table"', 'data-testid="audit-table"', 'data-testid="system-status"', "setting-site.name"]) {
        expect(html, `${p} leaks ${leak}`).not.toContain(leak);
      }
    }
  });

  it("administrators and the super administrator open every section", async () => {
    for (const who of ["admin", "super"] as const) {
      expect((await get("/admin", cookies[who])).html).toContain('data-testid="system-status"');
      expect((await get("/admin/users", cookies[who])).html).toContain("vic-victim@example.com");
      expect((await get(path("/admin/users/VICTIM"), cookies[who])).html).toContain("Vic Victim");
      expect((await get("/admin/settings", cookies[who])).html).toContain('data-testid="setting-site.name"');
      expect((await get("/admin/audit", cookies[who])).html).toContain("Audit log");
    }
  });

  it("an unknown account id is a 404 inside the admin area", async () => {
    expect((await get("/admin/users/no-such-account", cookies.admin)).html).toContain("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});

describe("Server Actions over HTTP (forged and legitimate)", () => {
  it("refuse an ordinary user and a signed-out caller, change nothing; allow an administrator; audit exactly once", async () => {
    const ids = await actionIds();
    expect(Object.keys(ids).sort()).toEqual(["changeUserRoleAction", "setUserDisabledAction"]);
    // Ordinary user: refused (the result says so), nothing changes.
    const forged = await callAction(ids.setUserDisabledAction, [{ userId: victimId, disabled: true }], cookies.user);
    expect(forged.status).toBe(200);
    expect(forged.body).toContain("You don't have permission to do that.");
    const forgedRole = await callAction(ids.changeUserRoleAction, [{ userId: userId, role: "admin" }], cookies.user);
    expect(forgedRole.body).toContain("You don't have permission to do that.");
    // Signed out: the proxy's auth gate redirects before the action runs (the action's own check is covered by integration tests).
    const anon = await callAction(ids.setUserDisabledAction, [{ userId: victimId, disabled: true }], "");
    expect([anon.status, anon.body]).toEqual([307, expect.stringContaining("/login")]);
    // An administrator can't grant admin.
    expect((await callAction(ids.changeUserRoleAction, [{ userId: userId, role: "admin" }], cookies.admin)).body).toContain("You don't have permission");
    expect((await testSql()`select banned from users where id = ${victimId}`)[0].banned).toBe(false);
    expect((await testSql()`select role from users where id = ${userId}`)[0].role).toBe("user");
    expect(await audits()).toBe(0);
    // Administrator disables the victim: one audit row; a repeat is a no-op.
    expect((await callAction(ids.setUserDisabledAction, [{ userId: victimId, disabled: true }], cookies.admin)).body).toContain('"changed":true');
    expect((await callAction(ids.setUserDisabledAction, [{ userId: victimId, disabled: true }], cookies.admin)).body).toContain('"changed":false');
    expect(await audits()).toBe(1);
    expect((await testSql()`select banned from users where id = ${victimId}`)[0].banned).toBe(true);
    // Re-enable for later tests.
    expect((await callAction(ids.setUserDisabledAction, [{ userId: victimId, disabled: false }], cookies.super)).body).toContain('"changed":true');
    expect(await audits()).toBe(2);
  });

  it("an ordinary user can't tell an existing account id from an unknown one; administrators get not found", async () => {
    const ids = await actionIds();
    const ghost = crypto.randomUUID().replaceAll("-", "");
    const before = await testSql()`select id, role, banned from users order by id`;
    const auditsBefore = await audits();
    // The Server Action's result object inside the RSC response.
    const result = (body: string) => /\{"ok":false[^\n]*\}/.exec(body)?.[0];
    const forbidden = JSON.stringify({ ok: false, error: "You don't have permission to do that.", code: "FORBIDDEN" });
    for (const target of [victimId, adminId, superId, ghost]) {
      for (const [action, input] of [
        ["setUserDisabledAction", { userId: target, disabled: true }],
        ["setUserDisabledAction", { userId: target, disabled: false }],
        ["changeUserRoleAction", { userId: target, role: "admin" }],
        ["changeUserRoleAction", { userId: target, role: "user" }],
      ] as const) {
        const res = await callAction(ids[action], [input], cookies.user);
        expect(res.status, `${action} ${target}`).toBe(200);
        expect(result(res.body), `${action} ${target}`).toBe(forbidden);
      }
    }
    expect(await testSql()`select id, role, banned from users order by id`).toEqual(before);
    expect(await audits()).toBe(auditsBefore);
    for (const [action, input] of [
      ["setUserDisabledAction", { userId: ghost, disabled: true }],
      ["changeUserRoleAction", { userId: ghost, role: "user" }],
    ] as const) {
      expect(result((await callAction(ids[action], [input], cookies.admin)).body)).toBe(JSON.stringify({ ok: false, error: "User not found", code: "NOT_FOUND" }));
    }
    expect(await audits()).toBe(auditsBefore);
  });

  it("the settings action refuses security settings for administrators and records allowed changes", async () => {
    const settingsHtml = (await get("/admin/settings", cookies.super)).html;
    const chunks = [...new Set([...settingsHtml.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]))];
    let id = "";
    for (const src of chunks) {
      const m = /createServerReference\)?\(\s*"([0-9a-f]{40,})"[^()]*?"updateSettingAction"/.exec(await (await fetch(`${BASE}${src}`)).text());
      if (m) id = m[1];
    }
    expect(id).not.toBe("");
    const before = await audits();
    expect((await callAction(id, [{ key: "registration.enabled", value: false }], cookies.admin)).body).toContain("You don't have permission");
    expect((await callAction(id, [{ key: "site.name", value: "Hacked" }], cookies.user)).body).toContain("You don't have permission");
    expect((await callAction(id, [{ key: "site.name", value: "Admin Links" }], cookies.admin)).body).toContain('"changed":true');
    expect(await audits()).toBe(before + 1);
    expect((await testSql()`select value from system_settings where key = 'site.name'`)[0].value).toBe("Admin Links");
  });
});

describe("audit and status pages", () => {
  it("the audit page shows formatted entries only, and the status page only the fixed vocabulary", async () => {
    const audit = (await get("/admin/audit", cookies.admin)).html;
    expect(audit).toContain("Account disabled");
    expect(audit).toContain("Setting changed");
    expect(audit).not.toMatch(/&quot;from&quot;|"metadata"/);
    const status = (await get("/admin", cookies.super)).html;
    for (const forbidden of [/postgres(ql)?:\/\//i, /covalink-media-test/, /127\.0\.0\.1:\d+\//, /host\.docker\.internal/, /password/i, /BETTER_AUTH/]) expect(status).not.toMatch(forbidden);
    expect(status).toMatch(/data-testid="status-database"[^>]*>Ready</);
    expect(status).toMatch(/data-testid="status-version"[^>]*>(Unknown|[A-Za-z0-9._-]+)</);
  });

  it.skipIf(CONTAINER)("reports media storage unavailable while sign-in and the database work (host mode)", async () => {
    const root = process.env.E2E_STORAGE_ROOT!;
    const moved = `${root}-unavailable`;
    renameSync(root, moved);
    try {
      const html = (await get("/admin", cookies.super)).html;
      expect(html).toMatch(/data-testid="status-storage" data-tone="warn"[^>]*>Unavailable</);
      expect(html).toMatch(/data-testid="status-database"[^>]*>Ready</);
      expect(html).not.toContain(root);
    } finally {
      renameSync(moved, root);
    }
    expect((await get("/admin", cookies.super)).html).toMatch(/data-testid="status-storage"[^>]*>Ready</);
  });

  it("database outages are reported by /api/ready (the admin page can't authenticate without the database)", async () => {
    const res = await fetch(`${DOWN}/api/ready`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "not_ready", checks: { database: "unavailable", storage: "ok" } });
  });
});
