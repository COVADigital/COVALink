import { beforeEach, describe, expect, it } from "vitest";
import { setUserBanned } from "@/features/admin/users";
import { setSetting } from "@/features/settings/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { auth } from "@/lib/auth/server";
import { resolveSessionUser } from "@/lib/auth/session";
import { authRequest, cookieFrom, signIn, signUp } from "../support/auth-http";
import { resetDatabase, testSql } from "../support/db";
import { TEST_SETUP_TOKEN } from "../support/test-env";

let superAdminId: string;

beforeEach(async () => {
  await resetDatabase();
  ({ userId: superAdminId } = await bootstrapSuperAdmin({
    token: TEST_SETUP_TOKEN,
    name: "Owner",
    email: "owner@example.com",
    password: "correct-horse-battery",
  }));
});

const userRow = async (email: string) =>
  (await testSql()`select id, role, banned from users where email = ${email}`)[0] as
    | { id: string; role: string; banned: boolean }
    | undefined;

const userFromCookie = (cookie: string) => resolveSessionUser(new Headers({ cookie }));

async function signedInCookie(email: string) {
  const res = await signIn(email);
  expect(res.status).toBe(200);
  return cookieFrom(res);
}

describe("registration policy (enforced in the Better Auth flow)", () => {
  it("creates an ordinary user when registration is open", async () => {
    const res = await signUp("alice@example.com");
    expect(res.status).toBe(200);
    expect(await userRow("alice@example.com")).toMatchObject({ role: "user", banned: false });
  });

  it("ignores injected role/banned fields on sign-up", async () => {
    const res = await signUp("mallory@example.com", { role: "super_admin", banned: false, emailVerified: true });
    expect(res.status).toBe(200);
    expect(await userRow("mallory@example.com")).toMatchObject({ role: "user", banned: false });
    const [{ verified }] = await testSql()`select email_verified as verified from users where email = 'mallory@example.com'`;
    expect(verified).toBe(false);
    const [{ supers }] = await testSql()`select count(*)::int as supers from users where role in ('super_admin', 'admin')`;
    expect(supers).toBe(1);
  });

  it("rejects role changes through the update-user endpoint", async () => {
    await signUp("eve@example.com");
    const cookie = await signedInCookie("eve@example.com");
    const res = await authRequest("/update-user", { cookie, body: { role: "super_admin" } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const res2 = await authRequest("/update-user", { cookie, body: { banned: false, role: "admin", name: "Eve" } });
    expect(res2.status).toBeGreaterThanOrEqual(400);
    expect(await userRow("eve@example.com")).toMatchObject({ role: "user" });
  });

  it("blocks sign-up over HTTP and via direct server API calls when closed", async () => {
    await setSetting("registration.enabled", false, superAdminId);
    const res = await signUp("closed@example.com");
    expect(res.status).toBe(403);
    await expect(
      auth.api.signUpEmail({ body: { name: "Direct", email: "direct@example.com", password: "correct-horse-battery" } }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await userRow("closed@example.com")).toBeUndefined();
    expect(await userRow("direct@example.com")).toBeUndefined();
  });

  it("treats invite-only as closed until invitations exist", async () => {
    await setSetting("registration.inviteOnly", true, superAdminId);
    expect((await signUp("invitee@example.com")).status).toBe(403);
    expect(await userRow("invitee@example.com")).toBeUndefined();
  });

  it("rejects cross-origin requests that carry a session cookie (CSRF)", async () => {
    await signUp("victim@example.com");
    const cookie = await signedInCookie("victim@example.com");
    const res = await authRequest("/update-user", { cookie, origin: "https://evil.example", body: { name: "Pwned" } });
    expect(res.status).toBe(403);
    const missing = await authRequest("/update-user", { cookie, origin: null, body: { name: "Pwned" } });
    expect(missing.status).toBe(403);
    const [{ name }] = await testSql()`select name from users where email = 'victim@example.com'`;
    expect(name).toBe("victim");
  });

  it("rejects browser-style cross-site sign-up/sign-in (login CSRF)", async () => {
    const res = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "cors",
          "sec-fetch-dest": "empty",
        },
        body: JSON.stringify({ name: "X", email: "csrf@example.com", password: "correct-horse-battery" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await userRow("csrf@example.com")).toBeUndefined();
  });
});

describe("login, session and logout", () => {
  beforeEach(async () => {
    expect((await signUp("alice@example.com")).status).toBe(200);
  });

  it("issues a session for valid credentials that resolves to the right user and role", async () => {
    const cookie = await signedInCookie("alice@example.com");
    const user = await userFromCookie(cookie);
    expect(user).toMatchObject({ email: "alice@example.com", role: "user" });
    // Same cookie again (a page reload) still resolves.
    expect(await userFromCookie(cookie)).toMatchObject({ email: "alice@example.com" });
  });

  it("rejects wrong passwords and unknown accounts with 401 and no cookie", async () => {
    const bad = await signIn("alice@example.com", "wrong-password-123");
    expect(bad.status).toBe(401);
    expect(cookieFrom(bad)).toBe("");
    const unknown = await signIn("nobody@example.com");
    expect(unknown.status).toBe(401);
  });

  it("logout deletes the session so the old cookie is useless", async () => {
    const cookie = await signedInCookie("alice@example.com");
    const out = await authRequest("/sign-out", { cookie, body: {} });
    expect(out.status).toBe(200);
    expect(await userFromCookie(cookie)).toBeNull();
    // The session token is the cookie value before the signature.
    const token = decodeURIComponent(cookie.split("=")[1]).split(".")[0];
    const [{ n }] = await testSql()`select count(*)::int as n from sessions where token = ${token}`;
    expect(n).toBe(0);
  });

  it("treats expired sessions as signed out", async () => {
    const cookie = await signedInCookie("alice@example.com");
    await testSql()`update sessions set expires_at = now() - interval '1 minute'`;
    expect(await userFromCookie(cookie)).toBeNull();
  });

  it("returns null for missing or forged cookies", async () => {
    expect(await resolveSessionUser(new Headers())).toBeNull();
    expect(await userFromCookie("better-auth.session_token=forged.value")).toBeNull();
  });

  it("keeps two users' sessions isolated", async () => {
    expect((await signUp("bob@example.com")).status).toBe(200);
    const [a, b] = await Promise.all([signedInCookie("alice@example.com"), signedInCookie("bob@example.com")]);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => userFromCookie(i % 2 ? a : b)));
    results.forEach((u, i) => expect(u?.email).toBe(i % 2 ? "alice@example.com" : "bob@example.com"));
  });
});

describe("account blocking", () => {
  beforeEach(async () => {
    expect((await signUp("alice@example.com")).status).toBe(200);
  });

  it("banning revokes already-issued sessions and blocks new sign-ins", async () => {
    const cookie = await signedInCookie("alice@example.com");
    const alice = (await userRow("alice@example.com"))!;
    await setUserBanned(superAdminId, alice.id, true, "spam");

    expect(await userFromCookie(cookie)).toBeNull();
    const [{ n }] = await testSql()`select count(*)::int as n from sessions where user_id = ${alice.id}`;
    expect(n).toBe(0);
    expect((await signIn("alice@example.com")).status).toBe(403);
    const [audit] = await testSql()`select action, actor_id, target_id from audit_logs where action = 'user.ban'`;
    expect(audit).toEqual({ action: "user.ban", actor_id: superAdminId, target_id: alice.id });
  });

  it("rejects a surviving session if the banned flag is set without revocation", async () => {
    const cookie = await signedInCookie("alice@example.com");
    await testSql()`update users set banned = true where email = 'alice@example.com'`;
    expect(await userFromCookie(cookie)).toBeNull();
  });

  it("unbanning restores the ability to sign in", async () => {
    const alice = (await userRow("alice@example.com"))!;
    await setUserBanned(superAdminId, alice.id, true);
    await setUserBanned(superAdminId, alice.id, false);
    expect((await signIn("alice@example.com")).status).toBe(200);
  });
});
