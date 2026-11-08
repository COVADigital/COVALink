import { beforeAll, describe, expect, it } from "vitest";
import { setUserBanned } from "@/features/admin/users";
import * as svc from "@/features/profiles/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { resetDatabase, testSql } from "../support/db";
import { deleteAccountOverHttp } from "../support/server-actions";

/**
 * Public profile pages over real HTTP against `next start`. Fixtures are
 * written by this test process directly to the E2E database, so the server
 * gets no cache-eviction signal for them: like a second replica, every
 * visibility change must be picked up by the server's per-request live check
 * and revision-keyed cache.
 */
const BASE = process.env.E2E_BASE_URL!;
const PASSWORD = "correct-horse-battery";
let ip = 1;

async function get(path: string, init: { cookie?: string } = {}) {
  const headers = new Headers({ "x-forwarded-for": `198.18.0.${ip++ % 250}` });
  if (init.cookie) headers.set("cookie", init.cookie);
  const res = await fetch(`${BASE}${path}`, { headers, redirect: "manual" });
  return { res, html: await res.text() };
}

async function post(path: string, body: unknown, cookie?: string) {
  const headers = new Headers({ "content-type": "application/json", origin: BASE, "x-forwarded-for": `198.18.1.${ip++ % 250}` });
  if (cookie) headers.set("cookie", cookie);
  return fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual" });
}

const cookieFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => !c.endsWith("="))
    .join("; ");

const header = (displayName: string, extra: { bio?: string; avatarUrl?: string; title?: string; noindex?: boolean } = {}) => ({
  header: { displayName, bio: extra.bio ?? "", avatarUrl: extra.avatarUrl },
  seo: { title: extra.title, description: undefined, noindex: extra.noindex ?? false },
});

let ownerId = "";
let aliceId = "";
let aliceCookie = "";
let profileId = "";
let revision = 0;

async function republish(displayName: string, extra?: Parameters<typeof header>[1]) {
  const r = await svc.publishProfile(aliceId, profileId, { expectedRevision: revision, patch: header(displayName, extra) });
  revision = r.revision;
}

beforeAll(async () => {
  await resetDatabase();
  ({ userId: ownerId } = await bootstrapSuperAdmin({
    token: process.env.E2E_SETUP_TOKEN,
    name: "Owner",
    email: "owner@example.com",
    password: PASSWORD,
  }));
  const res = await post("/api/auth/sign-up/email", { name: "Alice", email: "alice@example.com", password: PASSWORD });
  expect(res.status).toBe(200);
  aliceCookie = cookieFrom(res);
  [{ id: aliceId }] = (await testSql()`select id from users where email = 'alice@example.com'`) as unknown as { id: string }[];
  ({ id: profileId } = await svc.createProfile(aliceId, { handle: "alice", label: "Main", displayName: "Alice" }));
  await republish("Alice Public", { bio: "Published bio line", avatarUrl: "https://images.example.com/alice.png", title: "Alice on COVALink" });
});

describe("public profile rendering", () => {
  it("serves the published profile with SEO metadata, no cookies and hardened headers", async () => {
    const { res, html } = await get("/alice");
    expect(res.status).toBe(200);
    expect(html).toContain("Alice Public");
    expect(html).toContain("Published bio line");
    expect(html).toContain("<title>Alice on COVALink</title>");
    expect(html).toMatch(/<meta name="description" content="Published bio line"/);
    expect(html).toMatch(/<meta property="og:title" content="Alice on COVALink"/);
    expect(html).toMatch(/<meta property="og:url" content="http:\/\/localhost:3100\/alice"/);
    expect(html).toMatch(/<link rel="canonical" href="http:\/\/localhost:3100\/alice"/);
    expect(html).not.toMatch(/<meta name="robots" content="noindex/);
    expect(html).toMatch(/<img[^>]+src="https:\/\/images\.example\.com\/alice\.png"[^>]+referrerPolicy="no-referrer"|<img[^>]+referrerPolicy="no-referrer"[^>]+src="https:\/\/images\.example\.com\/alice\.png"/i);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get("content-security-policy")).toContain("img-src 'self' data: blob: https:");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("never leaks draft values into HTML or metadata", async () => {
    await svc.saveDraft(aliceId, profileId, {
      expectedRevision: revision,
      patch: header("SECRET DRAFT NAME", { bio: "SECRET DRAFT BIO", title: "SECRET DRAFT TITLE", avatarUrl: "https://secret.example.com/x.png" }),
    });
    revision += 1;
    const { html } = await get("/alice");
    expect(html).toContain("Alice Public");
    expect(html).not.toContain("SECRET");
    expect(html).not.toContain("secret.example.com");
  });

  it("shows a newly published revision immediately, without any eviction signal", async () => {
    await republish("Alice Republished", { bio: "Second version" });
    const { html } = await get("/alice");
    expect(html).toContain("Alice Republished");
    expect(html).not.toContain("Alice Public");
  });

  it("emits noindex when the owner hides the page from search engines", async () => {
    await republish("Alice Hidden", { noindex: true });
    const { html } = await get("/alice");
    expect(html).toMatch(/<meta name="robots" content="noindex, nofollow"/);
    await republish("Alice Public");
  });
});

describe("handle resolution with real HTTP status codes", () => {
  it.each(["adminfoo", "dashboarder"])("serves the valid protected-prefix handle /%s anonymously", async (handle) => {
    const { id } = await svc.createProfile(aliceId, { handle, label: handle, displayName: handle });
    await svc.publishProfile(aliceId, id, { expectedRevision: 0 });
    const { res, html } = await get(`/${handle}`);
    expect(res.status).toBe(200);
    expect(html).toContain(handle);
  });

  it.each(["/@alice", "/ALICE", "/%40alice", "/@Alice"])("redirects %s to /alice with 308", async (path) => {
    const { res } = await get(path);
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/alice");
  });

  it.each([
    ["unknown", "/nobody"],
    ["too short", "/a"],
    ["very long", `/${"a".repeat(3000)}`],
    ["encoded slash", "/alice%2Fx"],
    ["encoded null", "/alice%00"],
    ["accented", "/zo%C3%AB"],
    ["emoji", "/%F0%9F%99%82"],
    ["double @", "/@@alice"],
    ["reserved-looking file", "/robots.txt"],
  ])("returns a real 404 for %s", async (_label, path) => {
    const { res, html } = await get(path);
    expect(res.status).toBe(404);
    expect(html).not.toContain("Alice Public");
  });

  it("still routes reserved application paths to the application", async () => {
    expect((await get("/login")).res.status).toBe(200);
    expect((await get("/dashboard")).res.status).toBe(307);
    expect((await get("/dashboard/profiles")).res.status).toBe(307);
    expect((await get("/admin/users")).res.status).toBe(307);
  });
});

describe("visibility changes take effect on the next request", () => {
  it("unpublish → 404, republish → 200", async () => {
    await svc.unpublishProfile(aliceId, profileId);
    expect((await get("/alice")).res.status).toBe(404);
    await republish("Alice Public");
    expect((await get("/alice")).res.status).toBe(200);
  });

  it("ban → 404, unban → 200", async () => {
    await setUserBanned(ownerId, aliceId, true, "e2e");
    expect((await get("/alice")).res.status).toBe(404);
    await setUserBanned(ownerId, aliceId, false);
    const { res, html } = await get("/alice");
    expect(res.status).toBe(200);
    expect(html).toContain("Alice Public");
  });

  it("rename → old handle 404, new handle 200", async () => {
    await svc.updateProfileMeta(aliceId, profileId, { handle: "alice-renamed", label: "Main" });
    expect((await get("/alice")).res.status).toBe(404);
    expect((await get("/alice-renamed")).res.status).toBe(200);
    await svc.updateProfileMeta(aliceId, profileId, { handle: "alice", label: "Main" });
    expect((await get("/alice")).res.status).toBe(200);
  });

  it("delete → 404", async () => {
    const { id } = await svc.createProfile(aliceId, { handle: "alice-temp", label: "Temp", displayName: "Temp" });
    await svc.publishProfile(aliceId, id, { expectedRevision: 0 });
    expect((await get("/alice-temp")).res.status).toBe(200);
    await svc.deleteProfile(aliceId, id);
    expect((await get("/alice-temp")).res.status).toBe(404);
  });
});

describe("dashboard boundaries", () => {
  it("requires sign-in for profile management pages", async () => {
    for (const path of ["/dashboard/profiles", `/dashboard/profiles/${profileId}`]) {
      const { res } = await get(path);
      expect(res.status).toBe(307);
    }
  });

  it("shows another user's profile editor as not found, without its data", async () => {
    const res = await post("/api/auth/sign-up/email", { name: "Bob", email: "bob@example.com", password: PASSWORD });
    const bobCookie = cookieFrom(res);
    const { html } = await get(`/dashboard/profiles/${profileId}`, { cookie: bobCookie });
    expect(html).toContain("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(html).not.toContain("Alice Public");
    expect(html).not.toContain("/alice");
  });
});

describe("account deletion", () => {
  it("takes every public page of the owner offline", async () => {
    expect((await get("/alice")).res.status).toBe(200);
    // The ban test above revoked Alice's earlier sessions, so sign in again.
    const signIn = await post("/api/auth/sign-in/email", { email: "alice@example.com", password: PASSWORD });
    expect(signIn.status).toBe(200);
    aliceCookie = cookieFrom(signIn);
    // Only the account page's confirmed Server Action deletes accounts.
    expect((await post("/api/auth/delete-user", { password: PASSWORD }, aliceCookie)).status).toBe(404);
    expect((await deleteAccountOverHttp(BASE, aliceCookie, PASSWORD)).result).toMatchObject({ ok: true });
    expect((await get("/alice")).res.status).toBe(404);
  });
});
