import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDatabase, testSql } from "../support/db";
import { captureMail, linkToken } from "../support/mail";
import { TEST_APP_URL, TEST_SETUP_TOKEN } from "../support/test-env";

/**
 * Account self-service with REQUIRE_EMAIL_VERIFICATION=true. Better Auth reads the setting
 * once, when `lib/auth/server` is created, so this file loads a fresh copy of
 * the application modules after switching the variable (the shared setup
 * file loaded them with verification off).
 */
const original = await import("@/db");
process.env.REQUIRE_EMAIL_VERIFICATION = "true";
vi.resetModules();
const { auth } = await import("@/lib/auth/server");
const { setMailTransport } = await import("@/lib/mail");
const { verifyEmailToken } = await import("@/features/account/service");
const { bootstrapSuperAdmin } = await import("@/features/setup/service");
const { pgClient } = await import("@/db");

afterAll(async () => {
  setMailTransport(null);
  await pgClient.end({ timeout: 1 });
  await original.pgClient.end({ timeout: 1 });
  process.env.REQUIRE_EMAIL_VERIFICATION = "false";
});

const PASSWORD = "correct-horse-battery";
const mail = captureMail(setMailTransport);

beforeEach(async () => {
  await resetDatabase();
  // Registration opens once the installation is set up (it is closed before that).
  await bootstrapSuperAdmin({ token: TEST_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: PASSWORD });
  mail.clear();
});
afterEach(() => vi.useRealTimers());

const request = (path: string, body: unknown, cookie?: string) =>
  auth.handler(
    new Request(`${TEST_APP_URL}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_APP_URL, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
  );
const signUp = (email: string) => request("/sign-up/email", { name: email.split("@")[0], email, password: PASSWORD });
const signIn = (email: string) => request("/sign-in/email", { email, password: PASSWORD });
const row = async (email: string) =>
  (await testSql()`select id, email_verified, banned from users where email = ${email}`)[0] as { id: string; email_verified: boolean; banned: boolean } | undefined;
const sessions = async (id: string) => Number((await testSql()`select count(*)::int as n from sessions where user_id = ${id}`)[0].n);
const noHeaders = () => new Headers();

async function signedUpToken(email: string) {
  const res = await signUp(email);
  expect(res.status).toBe(200);
  // No session until the address is verified.
  expect((await res.json()).token).toBeNull();
  const msg = (await mail.waitFor(1)).find((m) => m.to === email)!;
  expect(msg.text).toContain(`${TEST_APP_URL}/verify-email#token=`);
  return linkToken(msg, "/verify-email");
}

describe("email verification required", () => {
  it("refuses sign-in until verified; the link verifies, signs in once, and a replay changes nothing", async () => {
    const token = await signedUpToken("alice@example.com");
    const { id } = (await row("alice@example.com"))!;
    const refused = await signIn("alice@example.com");
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("EMAIL_NOT_VERIFIED");
    expect(await sessions(id)).toBe(0);

    expect(await verifyEmailToken(noHeaders(), { token })).toBe("verified");
    expect((await row("alice@example.com"))!.email_verified).toBe(true);
    // Better Auth's automatic sign-in after verification.
    expect(await sessions(id)).toBe(1);

    expect(await verifyEmailToken(noHeaders(), { token })).toBe("already-verified");
    expect(await sessions(id)).toBe(1);
    expect((await signIn("alice@example.com")).status).toBe(200);
  });

  it("reports expired, tampered and malformed tokens without changing state", async () => {
    const token = await signedUpToken("alice@example.com");
    const { id } = (await row("alice@example.com"))!;
    const [head, payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ email: "owner@example.com", iat: 1, exp: 9999999999 })).toString("base64url");
    for (const bad of [`${head}.${payload}.${sig.slice(0, -2)}xx`, `${head}.${forged}.${sig}`, "not-a-jwt", "a.b.c", "", "x".repeat(3000)]) {
      expect(await verifyEmailToken(noHeaders(), { token: bad }), bad.slice(0, 12)).toBe("invalid");
    }
    expect(await verifyEmailToken(noHeaders(), { token, extra: 1 })).toBe("invalid");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    expect(await verifyEmailToken(noHeaders(), { token })).toBe("expired");
    vi.useRealTimers();

    expect((await row("alice@example.com"))!.email_verified).toBe(false);
    expect(await sessions(id)).toBe(0);
  });

  it("never verifies or signs in a disabled account", async () => {
    const token = await signedUpToken("alice@example.com");
    const { id } = (await row("alice@example.com"))!;
    await testSql()`update users set banned = true where id = ${id}`;
    expect(await verifyEmailToken(noHeaders(), { token })).toBe("invalid");
    expect((await row("alice@example.com"))!.email_verified).toBe(false);
    expect(await sessions(id)).toBe(0);
  });

  it("keeps the bootstrap super administrator verified and able to sign in", async () => {
    expect((await row("owner@example.com"))!.email_verified).toBe(true);
    expect((await signIn("owner@example.com")).status).toBe(200);
    await mail.settle();
    expect(mail.sent).toEqual([]);
  });

  it("resends only to the active unverified account, with one generic answer", async () => {
    await signedUpToken("unverified@example.com");
    await signUp("banned@example.com");
    await mail.waitFor(2);
    await testSql()`update users set banned = true where email = 'banned@example.com'`;
    mail.clear();
    const replies = [];
    for (const email of ["unverified@example.com", "owner@example.com", "nobody@example.com", "banned@example.com"]) {
      const res = await request("/send-verification-email", { email });
      replies.push({ status: res.status, body: await res.text() });
    }
    for (const r of replies) expect(r).toEqual(replies[0]);
    expect(replies[0].status).toBe(200);
    await mail.waitFor(1);
    await mail.settle();
    expect(mail.sent.map((m) => m.to)).toEqual(["unverified@example.com"]);
    // The resent link works.
    expect(await verifyEmailToken(noHeaders(), { token: linkToken(mail.sent[0], "/verify-email") })).toBe("verified");
  });

  it("lets an unverified user reset their password (mail is sent), but sign-in still needs verification", async () => {
    await signedUpToken("alice@example.com");
    mail.clear();
    expect((await request("/request-password-reset", { email: "alice@example.com" })).status).toBe(200);
    const token = linkToken((await mail.waitFor(1))[0], "/reset-password");
    expect((await request("/reset-password", { token, newPassword: "a-brand-new-password" })).status).toBe(200);
    const res = await request("/sign-in/email", { email: "alice@example.com", password: "a-brand-new-password" });
    expect(res.status).toBe(403);
  });
});
