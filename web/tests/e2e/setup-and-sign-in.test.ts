import { beforeAll, describe, expect, it } from "vitest";
import { setUserBanned } from "@/features/admin/users";
import { setSetting } from "@/features/settings/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { resetDatabase, testSql } from "../support/db";

/**
 * Black-box checks against `next start` (production build, Cache Components
 * on). Requests go over real HTTP; the test process touches the isolated E2E
 * database only for fixtures that have no UI yet (bootstrap, ban, settings).
 */
const BASE = process.env.E2E_BASE_URL!;
const DOWN = process.env.E2E_DOWN_URL!;
const HUNG = process.env.E2E_HUNG_URL!;
const PASSWORD = "correct-horse-battery";

let ipCounter = 1;
const freshIp = () => `203.0.113.${ipCounter++ % 250}`;

async function http(path: string, init: { method?: string; body?: unknown; cookie?: string; origin?: string; ip?: string; base?: string } = {}) {
  const headers = new Headers({ "x-forwarded-for": init.ip ?? freshIp() });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.origin ?? init.method === "POST") headers.set("origin", init.origin ?? BASE);
  return fetch(`${init.base ?? BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: "manual",
  });
}

const cookieFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => !c.endsWith("="))
    .join("; ");

async function signUp(email: string) {
  return http("/api/auth/sign-up/email", { method: "POST", body: { name: email.split("@")[0], email, password: PASSWORD } });
}
async function signIn(email: string, password = PASSWORD, ip?: string) {
  return http("/api/auth/sign-in/email", { method: "POST", body: { email, password }, ip });
}
async function page(path: string, cookie?: string) {
  const res = await http(path, { cookie });
  return { res, html: await res.text() };
}
/**
 * A `redirect()` thrown inside a Suspense boundary after the static shell was
 * sent is streamed as an error digest plus a meta refresh (HTTP status stays
 * 200). Match the exact digest Next.js emits.
 */
const redirectsTo = (html: string, target: string) => html.includes(`NEXT_REDIRECT;replace;${target};307;`);

let ownerId = "";
const cookies: Record<string, string> = {};

beforeAll(async () => {
  await resetDatabase();
});

describe("liveness and readiness", () => {
  it("health is 200 and readiness is 200 with the database up", async () => {
    const health = await http("/api/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(health.headers.get("cache-control")).toContain("no-store");
    const ready = await http("/api/ready");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready", checks: { database: "ok", storage: "ok" } });
  });

  it("with PostgreSQL unreachable: health stays 200, readiness is 503 and sanitized", async () => {
    expect((await http("/api/health", { base: DOWN })).status).toBe(200);
    const ready = await http("/api/ready", { base: DOWN });
    expect(ready.status).toBe(503);
    const text = await ready.text();
    expect(JSON.parse(text)).toEqual({ status: "not_ready", checks: { database: "unavailable", storage: "ok" } });
    for (const leak of ["not-a-secret", "127.0.0.1", "postgresql://", "probe", "Error", "stack"]) expect(text).not.toContain(leak);
  });

  it("with PostgreSQL hung: readiness times out within the bound and returns 503", async () => {
    expect((await http("/api/health", { base: HUNG })).status).toBe(200);
    const started = performance.now();
    const ready = await http("/api/ready", { base: HUNG });
    const elapsed = performance.now() - started;
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: "not_ready", checks: { database: "timeout", storage: "ok" } });
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("security headers on production responses", () => {
  function expectHardened(res: Response, label: string) {
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp, label).toContain("frame-ancestors 'none'");
    expect(csp, label).toContain("object-src 'none'");
    expect(csp, label).toContain("default-src 'self'");
    expect(csp, label).not.toContain("unsafe-eval");
    expect(res.headers.get("x-content-type-options"), label).toBe("nosniff");
    expect(res.headers.get("x-frame-options"), label).toBe("DENY");
    expect(res.headers.get("referrer-policy"), label).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("cross-origin-opener-policy"), label).toBe("same-origin");
    expect(res.headers.get("permissions-policy"), label).toContain("camera=()");
    expect(res.headers.get("x-powered-by"), label).toBeNull();
  }

  it("are present on static pages, auth pages, API routes and proxy redirects", async () => {
    for (const path of ["/", "/login", "/register", "/setup", "/api/health", "/api/ready"]) {
      expectHardened(await http(path), path);
    }
    const redirect = await http("/dashboard");
    expect(redirect.status).toBe(307);
    expectHardened(redirect, "proxy 307");
  });
});

describe("before setup", () => {
  it("offers /setup, refuses public sign-up and says so on /register", async () => {
    expect((await page("/setup")).html).toContain("Setup token");
    expect((await signUp("early@example.com")).status).toBe(403);
    expect((await page("/register")).html).toContain("set up yet");
  });

  it("after authorized bootstrap, /setup reports already set up", async () => {
    ({ userId: ownerId } = await bootstrapSuperAdmin({
      token: process.env.E2E_SETUP_TOKEN,
      name: "Owner",
      email: "owner@example.com",
      password: PASSWORD,
    }));
    const { html } = await page("/setup");
    expect(html).toContain("already set up");
    expect(html).not.toContain("Setup token");
  });
});

describe("authentication over HTTP", () => {
  it("rejects anonymous access to private pages with a server redirect", async () => {
    for (const path of ["/dashboard", "/admin"]) {
      const res = await http(path);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent(path)}`);
    }
  });

  it("registers an ordinary user who sees their own dashboard", async () => {
    const res = await signUp("alice@example.com");
    expect(res.status).toBe(200);
    cookies.alice = cookieFrom(res);
    const { res: dash, html } = await page("/dashboard", cookies.alice);
    expect(dash.status).toBe(200);
    expect(html).toContain("alice@example.com");
    expect(html).toContain('data-role="user"');
    expect(dash.headers.get("cache-control") ?? "").toMatch(/private|no-store|no-cache/);
    expect(dash.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("keeps the session across reloads", async () => {
    for (let i = 0; i < 2; i++) expect((await page("/dashboard", cookies.alice)).html).toContain("alice@example.com");
  });

  it("rejects invalid credentials and accepts valid ones", async () => {
    expect((await signIn("alice@example.com", "wrong-password-123")).status).toBe(401);
    expect((await signIn("nobody@example.com")).status).toBe(401);
    const ok = await signIn("owner@example.com");
    expect(ok.status).toBe(200);
    cookies.owner = cookieFrom(ok);
  });

  it("shows the trusted server-side role and gates /admin by role", async () => {
    const owner = await page("/dashboard", cookies.owner);
    expect(owner.html).toContain('data-role="super_admin"');
    const adminForOwner = await page("/admin", cookies.owner);
    expect(adminForOwner.html).toContain('data-testid="user-count"');

    const adminForAlice = await page("/admin", cookies.alice);
    expect(adminForAlice.html).not.toContain('data-testid="user-count"');
    expect(redirectsTo(adminForAlice.html, "/dashboard?denied=1")).toBe(true);
  });

  it("never mixes up two users' dashboards under concurrent requests", async () => {
    expect((await signUp("bob@example.com")).status).toBe(200);
    cookies.bob = cookieFrom(await signIn("bob@example.com"));
    const who = Array.from({ length: 12 }, (_, i) => (i % 2 ? "alice" : "bob"));
    const pages = await Promise.all(who.map((w) => page("/dashboard", cookies[w])));
    pages.forEach(({ html }, i) => {
      const me = who[i];
      const other = me === "alice" ? "bob" : "alice";
      expect(html).toContain(`${me}@example.com`);
      expect(html).not.toContain(`${other}@example.com`);
    });
  });

  it("rejects cross-origin state changes that carry the session cookie", async () => {
    const res = await http("/api/auth/update-user", { method: "POST", cookie: cookies.alice, origin: "https://evil.example", body: { name: "Pwned" } });
    expect(res.status).toBe(403);
  });

  it("logout invalidates the session cookie", async () => {
    const out = await http("/api/auth/sign-out", { method: "POST", cookie: cookies.alice, body: {} });
    expect(out.status).toBe(200);
    const { html } = await page("/dashboard", cookies.alice);
    expect(html).not.toContain("alice@example.com");
    expect(redirectsTo(html, "/login")).toBe(true);
  });

  it("a ban takes effect on an already-issued session", async () => {
    expect((await page("/dashboard", cookies.bob)).html).toContain("bob@example.com");
    const [{ id }] = await testSql()`select id from users where email = 'bob@example.com'`;
    await setUserBanned(ownerId, id as string, true, "e2e");
    const { html } = await page("/dashboard", cookies.bob);
    expect(html).not.toContain("bob@example.com");
    expect(redirectsTo(html, "/login")).toBe(true);
    expect((await signIn("bob@example.com")).status).toBe(403);
  });

  it("an expired session is treated as signed out", async () => {
    expect((await signUp("carol@example.com")).status).toBe(200);
    const carol = cookieFrom(await signIn("carol@example.com"));
    await testSql()`update sessions set expires_at = now() - interval '1 minute' where user_id = (select id from users where email = 'carol@example.com')`;
    const { html } = await page("/dashboard", carol);
    expect(html).not.toContain("carol@example.com");
    expect(redirectsTo(html, "/login")).toBe(true);
  });

  it("rate-limits repeated sign-in attempts from one client", async () => {
    const ip = "198.51.100.7";
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await signIn("owner@example.com", "wrong-password-123", ip)).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it("enforces closed registration on the live endpoint", async () => {
    await setSetting("registration.enabled", false, ownerId);
    expect((await signUp("late@example.com")).status).toBe(403);
    expect((await page("/register")).html).toContain("Registration is closed");
    const [row] = await testSql()`select 1 from users where email = 'late@example.com'`;
    expect(row).toBeUndefined();
  });
});
