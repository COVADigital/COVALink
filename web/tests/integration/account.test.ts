import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as routeGET, POST as routePOST } from "@/app/api/auth/[...all]/route";
import { setAccountAuditInsert } from "@/features/account/audit";
import { DELETE_CONFIRMATION } from "@/features/account/schema";
import { deleteOwnAccount, SessionRequiredError } from "@/features/account/service";
import { changeUserRole } from "@/features/admin/users";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { auth } from "@/lib/auth/server";
import { resolveSessionUser } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { setMailTransport } from "@/lib/mail";
import { authRequest, cookieFrom, deleteAccount, signIn, signUp } from "../support/auth-http";
import { resetDatabase, testSql } from "../support/db";
import { captureMail, linkToken } from "../support/mail";
import { TEST_APP_URL, TEST_SETUP_TOKEN } from "../support/test-env";

/**
 * Account self-service against the real Better Auth handler and database.
 * Email verification is not required here; the
 * verification-required configuration is covered in account-verification.test.ts.
 */

const PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "a-brand-new-password";
const mail = captureMail(setMailTransport);
let superId = "";

beforeEach(async () => {
  await resetDatabase();
  mail.clear();
  ({ userId: superId } = await bootstrapSuperAdmin({ token: TEST_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: PASSWORD }));
});
afterEach(() => {
  setAccountAuditInsert(null);
  vi.restoreAllMocks();
});
afterAll(() => setMailTransport(null));

const idOf = async (email: string) => ((await testSql()`select id from users where email = ${email}`)[0] as { id: string } | undefined)?.id;
const sessions = async (userId: string) => Number((await testSql()`select count(*)::int as n from sessions where user_id = ${userId}`)[0].n);
const audits = async (action?: string) =>
  (await testSql()`select actor_id, action, target_type, target_id, metadata from audit_logs where action <> 'system.bootstrap' ${action ? testSql()`and action = ${action}` : testSql()``} order by id`) as unknown as {
    actor_id: string | null;
    action: string;
    target_type: string;
    target_id: string;
    metadata: unknown;
  }[];
const signedIn = async (email: string, password = PASSWORD) => {
  const res = await signIn(email, password);
  expect(res.status).toBe(200);
  return cookieFrom(res);
};
const user = async (email: string) => {
  expect((await signUp(email)).status).toBe(200);
  return (await idOf(email))!;
};
const reply = async (res: Response) => ({ status: res.status, body: await res.text() });
const requestReset = (email: string) => authRequest("/request-password-reset", { body: { email } });
const resend = (email: string) => authRequest("/send-verification-email", { body: { email } });
const resetWith = (token: unknown, newPassword = NEW_PASSWORD) => authRequest("/reset-password", { body: { token, newPassword } });

describe("password reset", () => {
  it("sends a fragment link; the token resets once, revokes sessions and replaces the password", async () => {
    const id = await user("alice@example.com");
    const c1 = await signedIn("alice@example.com");
    await signedIn("alice@example.com");
    // Sign-up signs in too.
    expect(await sessions(id)).toBe(3);

    expect((await requestReset("alice@example.com")).status).toBe(200);
    const [msg] = await mail.waitFor(1);
    expect(msg.to).toBe("alice@example.com");
    const token = linkToken(msg, "/reset-password");
    // The token travels only in the fragment: never in a path or query string.
    expect(msg.text).toContain(`${TEST_APP_URL}/reset-password#token=`);
    expect(msg.text + msg.html).not.toMatch(/reset-password\/[A-Za-z0-9]|[?&]token=|callbackURL/);

    expect((await resetWith(token)).status).toBe(200);
    expect(await sessions(id)).toBe(0);
    expect(await resolveSessionUser(new Headers({ cookie: c1 }))).toBeNull();
    expect((await signIn("alice@example.com", PASSWORD)).status).toBe(401);
    expect((await signIn("alice@example.com", NEW_PASSWORD)).status).toBe(200);

    // Single use.
    const replay = await resetWith(token, "yet-another-password");
    expect(replay.status).toBe(400);
    expect((await replay.json()).code).toBe("INVALID_TOKEN");
    expect((await signIn("alice@example.com", NEW_PASSWORD)).status).toBe(200);
    expect(await audits()).toEqual([{ actor_id: id, action: "account.password_reset", target_type: "user", target_id: id, metadata: null }]);
  });

  it("refuses expired, malformed and missing tokens without changing anything", async () => {
    const id = await user("alice@example.com");
    await requestReset("alice@example.com");
    const token = linkToken((await mail.waitFor(1))[0], "/reset-password");
    await testSql()`update verifications set expires_at = now() - interval '1 second' where identifier = ${`reset-password:${token}`}`;
    for (const bad of [token, "x", "", "../../etc", "a".repeat(5000)]) {
      const res = await resetWith(bad);
      expect(res.status, String(bad).slice(0, 10)).toBe(400);
    }
    expect((await authRequest("/reset-password", { body: { newPassword: NEW_PASSWORD } })).status).toBe(400);
    expect((await resetWith(123)).status).toBe(400);
    expect((await signIn("alice@example.com", PASSWORD)).status).toBe(200);
    expect(await audits()).toEqual([]);
    expect(id).toBeTruthy();
  });

  it("refuses a real token in the query string without touching anything; the same token then works once in the body", async () => {
    const id = await user("alice@example.com");
    const c1 = await signedIn("alice@example.com");
    expect(await sessions(id)).toBe(2);
    await requestReset("alice@example.com");
    const token = linkToken((await mail.waitFor(1))[0], "/reset-password");
    const hash = async () => (await testSql()`select password from accounts where user_id = ${id} and provider_id = 'credential'`)[0].password as string;
    const pending = async () => Number((await testSql()`select count(*)::int as n from verifications where identifier = ${`reset-password:${token}`}`)[0].n);
    const before = await hash();
    expect(await pending()).toBe(1);

    // Through the Next.js catch-all, as an external request arrives.
    const post = (path: string, body: unknown) =>
      routePOST(new Request(`${TEST_APP_URL}${path}`, { method: "POST", headers: { origin: TEST_APP_URL, "content-type": "application/json" }, body: JSON.stringify(body) }));
    const q = encodeURIComponent(token);
    for (const path of [`/api/auth/reset-password?token=${q}`, `/api/auth/reset-password?callbackURL=%2F&token=${q}`, `/api/auth/RESET-PASSWORD?token=${q}`, `/api/auth/reset-password/?%74oken=${q}`]) {
      const res = await post(path, { newPassword: NEW_PASSWORD });
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe("Not Found");
    }
    // A body token doesn't make the query form acceptable either.
    expect((await post(`/api/auth/reset-password?token=${q}`, { token, newPassword: NEW_PASSWORD })).status).toBe(404);

    expect(await hash()).toBe(before);
    expect(await pending()).toBe(1);
    expect(await sessions(id)).toBe(2);
    expect(await resolveSessionUser(new Headers({ cookie: c1 }))).not.toBeNull();
    expect(await audits()).toEqual([]);
    expect(mail.sent).toHaveLength(1);

    // The same token in the JSON body, through the same route.
    const done = await post("/api/auth/reset-password", { token, newPassword: NEW_PASSWORD });
    expect(done.status).toBe(200);
    expect(await hash()).not.toBe(before);
    expect(await pending()).toBe(0);
    expect(await sessions(id)).toBe(0);
    expect(await resolveSessionUser(new Headers({ cookie: c1 }))).toBeNull();
    const replay = await post("/api/auth/reset-password", { token, newPassword: "yet-another-password" });
    expect(replay.status).toBe(400);
    expect((await replay.json()).code).toBe("INVALID_TOKEN");
    expect((await signIn("alice@example.com", PASSWORD)).status).toBe(401);
    expect((await signIn("alice@example.com", NEW_PASSWORD)).status).toBe(200);
    expect(await audits()).toEqual([{ actor_id: id, action: "account.password_reset", target_type: "user", target_id: id, metadata: null }]);
  });

  it("guards a real gap: Better Auth itself accepts the query form, so the catch-all must refuse it", async () => {
    // If a Better Auth upgrade stops reading `ctx.query.token`, this fails and the guard can be revisited.
    const id = await user("alice@example.com");
    await requestReset("alice@example.com");
    const token = linkToken((await mail.waitFor(1))[0], "/reset-password");
    expect((await authRequest(`/reset-password?token=${encodeURIComponent(token)}`, { body: { newPassword: NEW_PASSWORD } })).status).toBe(200);
    expect((await signIn("alice@example.com", NEW_PASSWORD)).status).toBe(200);
    expect(id).toBeTruthy();
  });

  it("answers every address class identically and mails only active accounts", async () => {
    await user("verified@example.com");
    await user("unverified@example.com");
    await user("banned@example.com");
    await testSql()`update users set email_verified = true where email = 'verified@example.com'`;
    await testSql()`update users set banned = true where email = 'banned@example.com'`;
    const replies = [];
    for (const email of ["verified@example.com", "unverified@example.com", "unknown@example.com", "banned@example.com", "owner@example.com"]) {
      replies.push(await reply(await requestReset(email)));
    }
    for (const r of replies) expect(r).toEqual(replies[0]);
    expect(replies[0].status).toBe(200);
    await mail.waitFor(3);
    await mail.settle();
    expect(mail.sent.map((m) => m.to).sort()).toEqual(["owner@example.com", "unverified@example.com", "verified@example.com"]);
  });

  it("never re-enables a banned account, even when its reset token is used", async () => {
    const id = await user("banned@example.com");
    await testSql()`update users set banned = true where id = ${id}`;
    await requestReset("banned@example.com");
    await mail.settle();
    expect(mail.sent).toEqual([]);
    // Better Auth still stores a token for the existing address; nobody receives it.
    const [{ identifier }] = await testSql()`select identifier from verifications where value = ${id}`;
    expect((await resetWith(String(identifier).replace("reset-password:", ""))).status).toBe(200);
    expect((await testSql()`select banned from users where id = ${id}`)[0].banned).toBe(true);
    expect((await signIn("banned@example.com", NEW_PASSWORD)).status).toBe(403);
    expect(await sessions(id)).toBe(0);
  });

  it("doesn't wait for slow mail and keeps the answer generic when delivery fails; the log has no token or address", async () => {
    await user("alice@example.com");
    const unknown = await reply(await requestReset("nobody@example.com"));

    mail.mode = { delayMs: 3000 };
    const started = Date.now();
    const slow = await reply(await requestReset("alice@example.com"));
    expect(Date.now() - started).toBeLessThan(1500);
    expect(slow).toEqual(unknown);
    expect(mail.sent).toHaveLength(0);
    await mail.waitFor(1, 6000);

    mail.clear();
    const errorLog = vi.spyOn(logger, "error");
    mail.mode = { fail: true };
    const failed = await reply(await requestReset("alice@example.com"));
    expect(failed).toEqual(unknown);
    await vi.waitFor(() => expect(errorLog).toHaveBeenCalledWith({ kind: "password-reset", error: { name: "Error", code: "EENVELOPE", responseCode: 550 } }, "Email delivery failed"));
    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).not.toMatch(/alice@example\.com|#token=|reset-password#/);
  });

  it("refuses external, protocol-relative and javascript: redirect targets", async () => {
    await user("alice@example.com");
    for (const redirectTo of ["https://evil.example/steal", "//evil.example", "javascript:alert(1)"]) {
      const res = await authRequest("/request-password-reset", { body: { email: "alice@example.com", redirectTo } });
      expect(res.status, redirectTo).toBe(403);
      const res2 = await authRequest("/send-verification-email", { body: { email: "alice@example.com", callbackURL: redirectTo } });
      expect(res2.status, redirectTo).toBe(403);
    }
    await mail.settle();
    expect(mail.sent).toEqual([]);
  });
});

describe("verification resend", () => {
  it("answers every address class identically and mails only active unverified accounts", async () => {
    await user("verified@example.com");
    await user("unverified@example.com");
    await user("banned@example.com");
    await testSql()`update users set email_verified = true where email = 'verified@example.com'`;
    await testSql()`update users set banned = true where email = 'banned@example.com'`;
    const replies = [];
    for (const email of ["unverified@example.com", "verified@example.com", "unknown@example.com", "banned@example.com"]) replies.push(await reply(await resend(email)));
    for (const r of replies) expect(r).toEqual(replies[0]);
    expect(replies[0].status).toBe(200);
    await mail.waitFor(1);
    await mail.settle();
    expect(mail.sent.map((m) => m.to)).toEqual(["unverified@example.com"]);
    expect(mail.sent[0].text).toContain(`${TEST_APP_URL}/verify-email#token=`);
    expect(mail.sent[0].text).not.toMatch(/[?&]token=|callbackURL/);
  });

  it("isn't slowed down or changed by a failing transport", async () => {
    await user("unverified@example.com");
    const baseline = await reply(await resend("unknown@example.com"));
    mail.mode = { fail: true };
    const failing = await reply(await resend("unverified@example.com"));
    expect(failing).toEqual(baseline);
    mail.mode = { delayMs: 3000 };
    const started = Date.now();
    expect(await reply(await resend("unverified@example.com"))).toEqual(baseline);
    // Better Auth's 500 ms floor, but not the 3 s delivery.
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("account name", () => {
  it("trims and saves valid names; refuses bad ones over HTTP and direct server calls", async () => {
    const id = await user("alice@example.com");
    const cookie = await signedIn("alice@example.com");
    const nameOf = async () => (await testSql()`select name from users where id = ${id}`)[0].name;

    expect((await authRequest("/update-user", { cookie, body: { name: "  Alice Liddell  " } })).status).toBe(200);
    expect(await nameOf()).toBe("Alice Liddell");
    for (const bad of ["", "   ", "x".repeat(81), `a${String.fromCharCode(0x202e)}b`, `a${String.fromCharCode(0)}b`, 42, null]) {
      const res = await authRequest("/update-user", { cookie, body: { name: bad } });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    await expect(auth.api.updateUser({ body: { name: " " }, headers: new Headers({ cookie }) })).rejects.toMatchObject({ status: "BAD_REQUEST" });
    expect(await nameOf()).toBe("Alice Liddell");
    // Email changes stay unavailable.
    expect((await authRequest("/update-user", { cookie, body: { email: "new@example.com" } })).status).toBe(400);
  });

  it("applies the same rule at sign-up", async () => {
    for (const name of ["   ", "x".repeat(81)]) expect((await signUp(`n${name.length}@example.com`, { name })).status).toBe(400);
    expect((await signUp("trim@example.com", { name: "  Trim Me " })).status).toBe(200);
    expect((await testSql()`select name from users where email = 'trim@example.com'`)[0].name).toBe("Trim Me");
    expect(await idOf("n3@example.com")).toBeUndefined();
  });
});

describe("change password", () => {
  it("needs the current password, revokes the other sessions and records one audit entry", async () => {
    const id = await user("alice@example.com");
    const here = await signedIn("alice@example.com");
    const other = await signedIn("alice@example.com");

    const wrong = await authRequest("/change-password", { cookie: here, body: { currentPassword: "not-it-at-all", newPassword: NEW_PASSWORD, revokeOtherSessions: true } });
    expect(wrong.status).toBe(400);
    // Sign-up signed in as well: three sessions.
    expect(await sessions(id)).toBe(3);
    expect(await audits()).toEqual([]);

    const ok = await authRequest("/change-password", { cookie: here, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true } });
    expect(ok.status).toBe(200);
    expect(await sessions(id)).toBe(1);
    expect(await resolveSessionUser(new Headers({ cookie: other }))).toBeNull();
    expect(await resolveSessionUser(new Headers({ cookie: cookieFrom(ok) }))).toMatchObject({ id });
    expect((await signIn("alice@example.com", NEW_PASSWORD)).status).toBe(200);
    expect(await audits()).toEqual([{ actor_id: id, action: "account.password_changed", target_type: "user", target_id: id, metadata: null }]);
  });

  it("keeps other sessions when asked to", async () => {
    const id = await user("alice@example.com");
    const here = await signedIn("alice@example.com");
    const other = await signedIn("alice@example.com");
    const ok = await authRequest("/change-password", { cookie: here, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: false } });
    expect(ok.status).toBe(200);
    expect(await resolveSessionUser(new Headers({ cookie: other }))).toMatchObject({ id });
  });
});

describe("account deletion", () => {
  it("is unreachable through Better Auth's endpoints over HTTP", async () => {
    const id = await user("alice@example.com");
    const cookie = await signedIn("alice@example.com");
    expect((await authRequest("/delete-user", { cookie, body: { password: PASSWORD } })).status).toBe(404);
    expect((await authRequest("/delete-user/callback?token=x", { method: "GET", cookie })).status).toBe(404);
    // The Next.js catch-all blocks spelling variants and the token-in-URL endpoints too.
    const route = (method: "GET" | "POST", path: string) =>
      (method === "GET" ? routeGET : routePOST)(
        new Request(`${TEST_APP_URL}${path}`, {
          method,
          headers: { origin: TEST_APP_URL, cookie, "content-type": "application/json" },
          body: method === "POST" ? JSON.stringify({ password: PASSWORD }) : undefined,
        }),
      );
    for (const path of ["/api/auth/delete-user", "/api/auth/Delete-User/", "/api/auth//delete%2Duser", "/api/auth/x/../delete-user"]) {
      expect((await route("POST", path)).status, path).toBe(404);
    }
    for (const path of ["/api/auth/verify-email?token=abc", "/api/auth/reset-password/abc?callbackURL=%2F"]) {
      expect((await route("GET", path)).status, path).toBe(404);
    }
    expect(await idOf("alice@example.com")).toBe(id);
    // The body-token reset stays reachable (here: refused for lack of a token); a query token never is.
    expect((await route("POST", "/api/auth/reset-password")).status).toBe(400);
    expect((await route("POST", "/api/auth/reset-password?token=abc")).status).toBe(404);
  });

  it("needs a session, the exact phrase and the right password", async () => {
    const id = await user("alice@example.com");
    const cookie = await signedIn("alice@example.com");
    const headers = new Headers({ cookie });
    await expect(deleteOwnAccount(new Headers(), { password: PASSWORD, confirmation: DELETE_CONFIRMATION })).rejects.toBeInstanceOf(SessionRequiredError);
    for (const confirmation of ["", "Delete my account", "delete my account ", "delete  my account", "DELETE"]) {
      await expect(deleteOwnAccount(headers, { password: PASSWORD, confirmation })).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { confirmation: expect.any(Array) } });
    }
    for (const input of [null, "x", {}, { password: PASSWORD }, { password: PASSWORD, confirmation: DELETE_CONFIRMATION, extra: 1 }]) {
      await expect(deleteOwnAccount(headers, input)).rejects.toMatchObject({ code: "VALIDATION" });
    }
    await expect(deleteOwnAccount(headers, { password: "not-the-password", confirmation: DELETE_CONFIRMATION })).rejects.toMatchObject({
      code: "VALIDATION",
      fieldErrors: { password: expect.any(Array) },
    });
    expect(await idOf("alice@example.com")).toBe(id);
    expect(await audits()).toEqual([]);

    await deleteOwnAccount(headers, { password: PASSWORD, confirmation: DELETE_CONFIRMATION });
    expect(await idOf("alice@example.com")).toBeUndefined();
    expect(await sessions(id)).toBe(0);
    expect(await audits()).toEqual([{ actor_id: null, action: "account.deleted", target_type: "user", target_id: id, metadata: null }]);
  });

  it("refuses administrators and the super administrator until demoted", async () => {
    const adminId = await user("ada@example.com");
    await changeUserRole(superId, adminId, "admin");
    await testSql()`delete from audit_logs where action <> 'system.bootstrap'`;
    const adminCookie = await signedIn("ada@example.com");
    await expect(deleteAccount(adminCookie)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Better Auth's beforeDelete refuses too, even without the service's own role check.
    await expect(auth.api.deleteUser({ body: { password: PASSWORD }, headers: new Headers({ cookie: adminCookie }) })).rejects.toMatchObject({ status: "FORBIDDEN" });
    await expect(deleteAccount(await signedIn("owner@example.com"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await idOf("ada@example.com")).toBe(adminId);
    expect(await audits()).toEqual([]);

    await changeUserRole(superId, adminId, "user");
    await deleteAccount(adminCookie);
    expect(await idOf("ada@example.com")).toBeUndefined();
    // The demotion's audit row keeps its target id; its actor (the super administrator) is unaffected.
    expect((await audits()).map((a) => a.action)).toEqual(["user.role_change", "account.deleted"]);
  });

  it("limits password attempts per account", async () => {
    await user("alice@example.com");
    const cookie = await signedIn("alice@example.com");
    for (let i = 0; i < 5; i++) await expect(deleteAccount(cookie, "wrong-password-xx")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(deleteAccount(cookie)).rejects.toMatchObject({ code: "LIMIT" });
    expect(await idOf("alice@example.com")).toBeTruthy();
    // Another account isn't affected.
    await user("bob@example.com");
    await deleteAccount(await signedIn("bob@example.com"));
  });
});

describe("account audit entries are best-effort after the commit", () => {
  it("logs an audit failure but reports the completed reset, change and deletion as done", async () => {
    const id = await user("alice@example.com");
    const errorLog = vi.spyOn(logger, "error");
    setAccountAuditInsert(async () => {
      throw Object.assign(new Error("audit insert failed for alice@example.com"), { code: "53300" });
    });

    await requestReset("alice@example.com");
    const token = linkToken((await mail.waitFor(1))[0], "/reset-password");
    expect((await resetWith(token)).status).toBe(200);
    const cookie = await signedIn("alice@example.com", NEW_PASSWORD);
    const changed = await authRequest("/change-password", { cookie, body: { currentPassword: NEW_PASSWORD, newPassword: PASSWORD, revokeOtherSessions: true } });
    expect(changed.status).toBe(200);
    await deleteAccount(cookieFrom(changed));
    expect(await idOf("alice@example.com")).toBeUndefined();

    expect(await audits()).toEqual([]);
    const failures = errorLog.mock.calls.filter(([, msg]) => msg === "Account audit entry not recorded");
    expect(failures.map(([obj]) => obj)).toEqual([
      { action: "account.password_reset", code: "53300" },
      { action: "account.password_changed", code: "53300" },
      { action: "account.deleted", code: "53300" },
    ]);
    expect(JSON.stringify(failures)).not.toContain("alice@example.com");
    expect(id).toBeTruthy();
  });
});
