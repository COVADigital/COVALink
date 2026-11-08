import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { changeUserRole } from "@/features/admin/users";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { contentSecurityPolicy } from "@/lib/security/headers";
import { resetDatabase, testSql } from "../support/db";
import { actionId, callAction } from "../support/server-actions";

/**
 * Account self-service over real HTTP against the production servers (next
 * start, or the hardened image in container mode):
 * - MAIN (:3100): verification off, no SMTP;
 * - MAIL (:3103): REQUIRE_EMAIL_VERIFICATION=true, SMTP to the runner's sink.
 * Both use the same E2E database. Server Actions are called the way a forged
 * request would: with the action id taken from the page's client bundle.
 */
const MAIN = process.env.E2E_BASE_URL!;
const MAIL = process.env.E2E_MAIL_BASE_URL!;
const SINK = process.env.E2E_MAIL_URL!;
const LOGS = process.env.E2E_LOG_DIR!;
const PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "a-brand-new-password";
let ip = 1;
const nextIp = () => `198.18.90.${ip++ % 250}`;
/** Every token seen in this file; none may ever appear in a server log. */
const seenTokens: string[] = [];

interface SinkMessage {
  to: string[];
  text: string;
  raw: string;
}
const sink = {
  messages: async (): Promise<SinkMessage[]> => (await fetch(`${SINK}/messages`)).json(),
  clear: () => fetch(`${SINK}/messages`, { method: "DELETE" }),
  mode: (mode: { delayMs?: number; fail?: boolean }) => fetch(`${SINK}/mode`, { method: "PUT", body: JSON.stringify(mode) }),
  async waitFor(count: number, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const list = await sink.messages();
      if (list.length >= count) return list;
      if (Date.now() > deadline) throw new Error(`expected ${count} message(s), got ${list.length}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  },
};
function linkToken(msg: SinkMessage, base: string, page: "/reset-password" | "/verify-email") {
  const m = new RegExp(`${base.replace(/[.:/]/g, (c) => `\\${c}`)}${page}#token=([^\\s"<>&]+)`).exec(msg.text);
  if (!m) throw new Error(`no ${page} link`);
  const token = decodeURIComponent(m[1]);
  seenTokens.push(token);
  return token;
}

async function post(base: string, p: string, body: unknown, cookie?: string) {
  const res = await fetch(`${base}${p}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin: base, "x-forwarded-for": nextIp(), ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text(), cookie: cookieFrom(res) };
}
const cookieFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => !c.endsWith("="))
    .join("; ");
const sessionEmail = async (base: string, cookie: string) =>
  (((await (await fetch(`${base}/api/auth/get-session`, { headers: { cookie, "x-forwarded-for": nextIp() } })).json()) as { user?: { email?: string } } | null)?.user?.email ?? null);
const idOf = async (email: string) => ((await testSql()`select id from users where email = ${email}`)[0] as { id: string } | undefined)?.id;
const signIn = (base: string, email: string, password = PASSWORD) => post(base, "/api/auth/sign-in/email", { email, password });
const signUp = (base: string, email: string) => post(base, "/api/auth/sign-up/email", { name: email.split("@")[0], email, password: PASSWORD });

/** Raw response header fields (name, value) without the client joining duplicates. */
function rawHeaders(url: string): Promise<{ status: number; fields: [string, string][]; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers: { "x-forwarded-for": nextIp() } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          const fields: [string, string][] = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) fields.push([res.rawHeaders[i].toLowerCase(), res.rawHeaders[i + 1]]);
          resolve({ status: res.statusCode!, fields, body });
        });
      })
      .on("error", reject);
  });
}

beforeAll(async () => {
  await resetDatabase();
  await bootstrapSuperAdmin({ token: process.env.E2E_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: PASSWORD });
  await sink.clear();
  await sink.mode({});
});

describe("password reset over HTTP", () => {
  it("emails a fragment link; the token resets once and every session ends", async () => {
    expect((await signUp(MAIN, "reset-me@example.com")).status).toBe(200);
    const old = (await signIn(MAIN, "reset-me@example.com")).cookie;
    await sink.clear();
    expect((await post(MAIL, "/api/auth/request-password-reset", { email: "reset-me@example.com" })).status).toBe(200);
    const [msg] = await sink.waitFor(1);
    expect(msg.to).toEqual(["reset-me@example.com"]);
    const token = linkToken(msg, MAIL, "/reset-password");
    expect(msg.text).not.toMatch(/reset-password\/[A-Za-z0-9]|[?&]token=|callbackURL/);

    const done = await post(MAIL, "/api/auth/reset-password", { token, newPassword: NEW_PASSWORD });
    expect(done.status).toBe(200);
    expect(old).toMatch(/session_token=/);
    expect(await sessionEmail(MAIN, old)).toBeNull();
    expect((await signIn(MAIN, "reset-me@example.com")).status).toBe(401);
    expect((await signIn(MAIN, "reset-me@example.com", NEW_PASSWORD)).status).toBe(200);
    const replay = await post(MAIL, "/api/auth/reset-password", { token, newPassword: "yet-another-password" });
    expect(replay.status).toBe(400);
    expect(JSON.parse(replay.body).code).toBe("INVALID_TOKEN");
    const id = await idOf("reset-me@example.com");
    expect(await testSql()`select action, actor_id from audit_logs where target_id = ${id!}`).toEqual([{ action: "account.password_reset", actor_id: id }]);
  });

  it("refuses a real token in the query string with 404 and changes nothing; the body form then works once", async () => {
    expect((await signUp(MAIN, "query-token@example.com")).status).toBe(200);
    const id = await idOf("query-token@example.com");
    const old = (await signIn(MAIN, "query-token@example.com")).cookie;
    await sink.clear();
    expect((await post(MAIL, "/api/auth/request-password-reset", { email: "query-token@example.com" })).status).toBe(200);
    const token = linkToken((await sink.waitFor(1))[0], MAIL, "/reset-password");
    const q = encodeURIComponent(token);
    for (const p of [`/api/auth/reset-password?token=${q}`, `/api/auth/reset-password?callbackURL=%2F&token=${q}`, `/api/auth/RESET-PASSWORD?token=${q}`, `/api/auth/reset-password?%74oken=${q}`]) {
      const res = await post(MAIL, p, { newPassword: NEW_PASSWORD });
      expect(res.status, p).toBe(404);
      expect(res.body, p).not.toContain(token);
    }
    expect((await post(MAIL, `/api/auth/reset-password?token=${q}`, { token, newPassword: NEW_PASSWORD })).status).toBe(404);
    expect(await sessionEmail(MAIN, old)).toBe("query-token@example.com");
    expect(await testSql()`select action from audit_logs where target_id = ${id!}`).toEqual([]);
    expect((await signIn(MAIN, "query-token@example.com", NEW_PASSWORD)).status).toBe(401);

    expect((await post(MAIL, "/api/auth/reset-password", { token, newPassword: NEW_PASSWORD })).status).toBe(200);
    expect(await sessionEmail(MAIN, old)).toBeNull();
    expect((await post(MAIL, "/api/auth/reset-password", { token, newPassword: "yet-another-password" })).status).toBe(400);
    expect((await signIn(MAIN, "query-token@example.com", NEW_PASSWORD)).status).toBe(200);
    expect(await testSql()`select action from audit_logs where target_id = ${id!}`).toEqual([{ action: "account.password_reset" }]);
  });

  it("answers active, unknown and disabled addresses identically and mails only the active one", async () => {
    await signUp(MAIN, "active@example.com");
    await signUp(MAIN, "disabled@example.com");
    await testSql()`update users set banned = true where email = 'disabled@example.com'`;
    await sink.clear();
    const replies = [];
    for (const email of ["active@example.com", "nobody@example.com", "disabled@example.com"]) {
      const r = await post(MAIL, "/api/auth/request-password-reset", { email });
      replies.push({ status: r.status, body: r.body });
    }
    for (const r of replies) expect(r).toEqual(replies[0]);
    expect(replies[0].status).toBe(200);
    await sink.waitFor(1);
    await new Promise((r) => setTimeout(r, 500));
    const sent = await sink.messages();
    expect(sent.map((m) => m.to)).toEqual([["active@example.com"]]);
    linkToken(sent[0], MAIL, "/reset-password");
  });

  it("doesn't wait for slow SMTP, and a rejecting relay changes nothing visible", async () => {
    const baseline = await post(MAIL, "/api/auth/request-password-reset", { email: "nobody@example.com" });
    await sink.clear();
    await sink.mode({ delayMs: 4000 });
    const started = Date.now();
    const slow = await post(MAIL, "/api/auth/request-password-reset", { email: "active@example.com" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect({ status: slow.status, body: slow.body }).toEqual({ status: baseline.status, body: baseline.body });
    linkToken((await sink.waitFor(1, 15_000))[0], MAIL, "/reset-password");

    await sink.mode({ fail: true });
    const failed = await post(MAIL, "/api/auth/request-password-reset", { email: "active@example.com" });
    expect({ status: failed.status, body: failed.body }).toEqual({ status: baseline.status, body: baseline.body });
    const log = path.join(LOGS, "mail.log");
    await expect.poll(() => readFileSync(log, "utf8"), { timeout: 10_000 }).toContain("Email delivery failed");
    await sink.mode({});
  });

  it("refuses external, protocol-relative and javascript: redirect targets", async () => {
    for (const target of ["https://evil.example/x", "//evil.example", "javascript:alert(1)"]) {
      expect((await post(MAIL, "/api/auth/request-password-reset", { email: "active@example.com", redirectTo: target })).status, target).toBe(403);
      expect((await post(MAIL, "/api/auth/send-verification-email", { email: "active@example.com", callbackURL: target })).status, target).toBe(403);
    }
  });

  it("serves forgot-password as a form only where mail can be sent", async () => {
    expect(await (await fetch(`${MAIN}/forgot-password`)).text()).toContain("reset-unavailable");
    const withMail = await (await fetch(`${MAIL}/forgot-password`)).text();
    expect(withMail).not.toContain("reset-unavailable");
    expect(withMail).toContain("Send reset link");
  });
});

describe("email verification over HTTP", () => {
  it("refuses unverified sign-in; the fragment link verifies through the Server Action, once", async () => {
    await sink.clear();
    const up = await signUp(MAIL, "verify-me@example.com");
    expect(up.status).toBe(200);
    expect(up.cookie).toBe("");
    const token = linkToken((await sink.waitFor(1))[0], MAIL, "/verify-email");
    const refused = await signIn(MAIL, "verify-me@example.com");
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body).code).toBe("EMAIL_NOT_VERIFIED");

    const id = await actionId(MAIL, "/verify-email", "verifyEmailAction");
    const first = await callAction(MAIL, "/verify-email", id, [{ token }]);
    expect(first.result).toEqual({ ok: true, data: { outcome: "verified" } });
    expect(first.cookie).toMatch(/session_token=/);
    expect(await sessionEmail(MAIL, first.cookie)).toBe("verify-me@example.com");
    const userId = await idOf("verify-me@example.com");
    const sessionsAfter = Number((await testSql()`select count(*)::int as n from sessions where user_id = ${userId!}`)[0].n);

    const replay = await callAction(MAIL, "/verify-email", id, [{ token }]);
    expect(replay.result).toEqual({ ok: true, data: { outcome: "already-verified" } });
    expect(replay.cookie).toBe("");
    expect(Number((await testSql()`select count(*)::int as n from sessions where user_id = ${userId!}`)[0].n)).toBe(sessionsAfter);
    expect((await callAction(MAIL, "/verify-email", id, [{ token: `${token}x` }])).result).toEqual({ ok: true, data: { outcome: "invalid" } });
    expect((await signIn(MAIL, "verify-me@example.com")).status).toBe(200);
  });

  it("resends only to an active unverified address, with one generic answer", async () => {
    await sink.clear();
    await signUp(MAIL, "resend-me@example.com");
    await sink.waitFor(1);
    await sink.clear();
    const replies = [];
    for (const email of ["resend-me@example.com", "verify-me@example.com", "nobody@example.com", "disabled@example.com"]) {
      const r = await post(MAIL, "/api/auth/send-verification-email", { email });
      replies.push({ status: r.status, body: r.body });
    }
    for (const r of replies) expect(r).toEqual(replies[0]);
    await sink.waitFor(1);
    await new Promise((r) => setTimeout(r, 500));
    const sent = await sink.messages();
    expect(sent.map((m) => m.to)).toEqual([["resend-me@example.com"]]);
    linkToken(sent[0], MAIL, "/verify-email");
  });

  it("never exposes Better Auth's token-in-URL or deletion endpoints", async () => {
    const cookie = (await signIn(MAIN, "active@example.com")).cookie;
    for (const p of ["/api/auth/verify-email?token=abc", "/api/auth/reset-password/abc?callbackURL=%2F", "/api/auth/delete-user/callback?token=x"]) {
      expect((await fetch(`${MAIN}${p}`, { redirect: "manual", headers: { cookie } })).status, p).toBe(404);
    }
    expect((await post(MAIN, "/api/auth/reset-password?token=abc", { newPassword: NEW_PASSWORD })).status).toBe(404);
    expect((await post(MAIN, "/api/auth/reset-password", { token: "abc", newPassword: NEW_PASSWORD })).status).toBe(400);
    // Next.js answers "//" and trailing slashes with a 308 before routing; the target is blocked too.
    for (const p of ["/api/auth/delete-user", "/api/auth/DELETE-USER", "/api/auth/delete%2Duser", "/api/auth//delete-user", "/api/auth/delete-user/", "/api/auth/delete-user/callback"]) {
      let res = await fetch(`${MAIN}${p}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", origin: MAIN, cookie, "x-forwarded-for": nextIp() }, body: JSON.stringify({ password: PASSWORD }) });
      if (res.status === 308) {
        const next = new URL(res.headers.get("location")!, MAIN);
        expect(next.origin, p).toBe(MAIN);
        res = await fetch(next, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", origin: MAIN, cookie, "x-forwarded-for": nextIp() }, body: JSON.stringify({ password: PASSWORD }) });
      }
      expect(res.status, p).toBe(404);
    }
    expect(await idOf("active@example.com")).toBeTruthy();
  });
});

describe("token pages", () => {
  it("send each security header once, with no-referrer, no-store and noindex, and load nothing third-party", async () => {
    const csp = contentSecurityPolicy({ isDev: false });
    for (const page of ["/reset-password", "/verify-email"]) {
      const { status, fields, body } = await rawHeaders(`${MAIN}${page}`);
      expect(status).toBe(200);
      const all = (name: string) => fields.filter(([k]) => k === name).map(([, v]) => v);
      expect(all("referrer-policy"), page).toEqual(["no-referrer"]);
      expect(all("x-robots-tag"), page).toEqual(["noindex"]);
      expect(all("content-security-policy"), page).toEqual([csp]);
      expect(all("x-frame-options"), page).toEqual(["DENY"]);
      expect(all("x-content-type-options"), page).toEqual(["nosniff"]);
      const cache = all("cache-control");
      expect(cache, page).toHaveLength(1);
      expect(cache[0]).toMatch(/no-store/);
      expect(body).toContain('name="referrer" content="no-referrer"');
      expect(body).not.toMatch(/(?:src|href)="(?:https?:)?\/\//);
    }
    // Other pages keep the normal policy.
    const login = await rawHeaders(`${MAIN}/login`);
    expect(login.fields.filter(([k]) => k === "referrer-policy").map(([, v]) => v)).toEqual(["strict-origin-when-cross-origin"]);
  });
});

describe("account deletion over HTTP", () => {
  it("works only through the confirmed Server Action; administrators are refused", async () => {
    await signUp(MAIN, "leaver@example.com");
    const cookie = (await signIn(MAIN, "leaver@example.com")).cookie;
    const id = await actionId(MAIN, "/dashboard/account", "deleteAccountAction", cookie);

    const noPhrase = await callAction(MAIN, "/dashboard/account", id, [{ password: PASSWORD, confirmation: "delete" }], cookie);
    expect(noPhrase.result).toMatchObject({ ok: false, code: "VALIDATION" });
    const wrongPassword = await callAction(MAIN, "/dashboard/account", id, [{ password: "not-the-password", confirmation: "delete my account" }], cookie);
    expect(wrongPassword.result).toMatchObject({ ok: false, code: "VALIDATION", fieldErrors: { password: expect.any(Array) } });
    const anonymous = await callAction(MAIN, "/dashboard/account", id, [{ password: PASSWORD, confirmation: "delete my account" }]);
    expect(anonymous.result?.ok).not.toBe(true);
    expect(await idOf("leaver@example.com")).toBeTruthy();

    const userId = (await idOf("leaver@example.com"))!;
    const done = await callAction(MAIN, "/dashboard/account", id, [{ password: PASSWORD, confirmation: "delete my account" }], cookie);
    expect(done.result).toMatchObject({ ok: true });
    expect(await idOf("leaver@example.com")).toBeUndefined();
    expect(await testSql()`select action, actor_id from audit_logs where target_id = ${userId}`).toEqual([{ action: "account.deleted", actor_id: null }]);

    await signUp(MAIN, "admin-leaver@example.com");
    const [{ id: superId }] = await testSql()`select id from users where email = 'owner@example.com'`;
    await changeUserRole(String(superId), (await idOf("admin-leaver@example.com"))!, "admin");
    const adminCookie = (await signIn(MAIN, "admin-leaver@example.com")).cookie;
    const refused = await callAction(MAIN, "/dashboard/account", id, [{ password: PASSWORD, confirmation: "delete my account" }], adminCookie);
    expect(refused.result).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await idOf("admin-leaver@example.com")).toBeTruthy();
  });
});

describe("production logs", () => {
  it("contain no reset or verification token, link or recipient address", () => {
    expect(seenTokens.length).toBeGreaterThanOrEqual(5);
    for (const file of readdirSync(LOGS)) {
      const text = readFileSync(path.join(LOGS, file), "utf8");
      for (const token of seenTokens) expect(text.includes(token), `${file} contains a token`).toBe(false);
      expect(text, file).not.toMatch(/#token=|reset-password\/|verify-email\?token/);
      expect(text, file).not.toMatch(/(?:reset-me|active|verify-me|resend-me)@example\.com/);
    }
  });
});
