import jsQR from "jsqr";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import * as svc from "@/features/profiles/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { resetDatabase, testSql } from "../support/db";

/**
 * Analytics over real HTTP against the production server (next start or,
 * in container mode, the hardened image). The E2E servers run with
 * TRUST_PROXY=true, so X-Forwarded-For selects the (trusted) client address
 * and views get visitor hashes here; the untrusted default is covered by the
 * integration suite and the deployment smoke.
 */
const BASE = process.env.E2E_BASE_URL!;
const PASSWORD = "correct-horse-battery";
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
const SENTINEL_IP = "198.18.77.77";
const SENTINEL_UA = `${BROWSER} SentinelAgent/7.7`;
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let ip = 1;
const nextIp = () => `198.18.70.${ip++ % 250}`;

let ownerId = "";
let otherId = "";
let profileId = "";
let ownerCookie = "";
let otherCookie = "";

async function signUpAndIn(name: string, email: string) {
  const up = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": nextIp() },
    body: JSON.stringify({ name, email, password: PASSWORD }),
  });
  expect(up.status).toBe(200);
  return up.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !c.endsWith("=")).join("; ");
}

const beacon = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${BASE}/api/v`, {
    method: "POST",
    headers: { origin: BASE, "sec-fetch-site": "same-origin", "content-type": "application/json", "user-agent": BROWSER, "x-forwarded-for": nextIp(), ...headers },
    body: JSON.stringify(body),
  });
const go = (blockId: string, headers: Record<string, string> = {}) =>
  fetch(`${BASE}/go/${profileId}/${blockId}`, { redirect: "manual", headers: { "user-agent": BROWSER, "x-forwarded-for": nextIp(), ...headers } });
const rows = async () =>
  (await testSql()`select type, block_id, visitor_hash, referrer_host, device, source from analytics_events where profile_id = ${profileId} order by id`) as unknown as {
    type: string;
    block_id: string | null;
    visitor_hash: string | null;
    referrer_host: string | null;
    device: string;
    source: string | null;
  }[];
const page = (path: string, cookie?: string) => fetch(`${BASE}${path}`, { redirect: "manual", headers: { "x-forwarded-for": nextIp(), ...(cookie ? { cookie } : {}) } });

beforeAll(async () => {
  await resetDatabase();
  await bootstrapSuperAdmin({ token: process.env.E2E_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: PASSWORD });
  ownerCookie = await signUpAndIn("Ana", "ana@example.com");
  otherCookie = await signUpAndIn("Ben", "ben@example.com");
  [{ id: ownerId }] = (await testSql()`select id from users where email = 'ana@example.com'`) as unknown as { id: string }[];
  [{ id: otherId }] = (await testSql()`select id from users where email = 'ben@example.com'`) as unknown as { id: string }[];
  ({ id: profileId } = await svc.createProfile(ownerId, { handle: "ana", label: "Ana", displayName: "Ana" }));
  await svc.createProfile(otherId, { handle: "ben", label: "Ben", displayName: "Ben" });
  await svc.publishProfile(ownerId, profileId, {
    expectedRevision: 0,
    patch: {
      header: { displayName: "Ana", bio: "" },
      seo: { noindex: false },
      blocks: [
        { id: ID(1), type: "link", visible: true, config: { title: "Shop", url: "https://shop.example.com/sale" } },
        { id: ID(2), type: "link", visible: false, config: { title: "Hidden", url: "https://hidden.example.com" } },
        { id: ID(3), type: "text", visible: true, config: { markdown: "[docs](https://docs.example.com)", align: "inherit" } },
      ],
    },
  });
});

describe("public page, beacon and /go", () => {
  it("public HTML routes link blocks through /go, keeps Markdown links direct, and sets no cookie", async () => {
    const res = await page("/ana");
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    const html = await res.text();
    expect(html).toContain(`href="/go/${profileId}/${ID(1)}"`);
    expect(html).toContain('href="https://docs.example.com/"');
    expect(html).not.toContain("shop.example.com");
    expect(html).toMatch(/<link rel="canonical" href="http:\/\/localhost:3100\/ana"/);
  });

  it("the beacon records one view per trusted visitor per 30 minutes, with a hash and no cookie", async () => {
    const visitor = { "x-forwarded-for": SENTINEL_IP, "user-agent": SENTINEL_UA };
    const first = await beacon({ p: profileId, r: "https://news.example.org/story?id=1" }, visitor);
    expect(first.status).toBe(204);
    expect(first.headers.getSetCookie()).toEqual([]);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect((await beacon({ p: profileId }, visitor)).status).toBe(204); // repeat
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ type: "view", referrer_host: "news.example.org", device: "desktop", source: null });
    expect(r[0].visitor_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects cross-site beacons", async () => {
    expect((await beacon({ p: profileId }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await beacon({ p: profileId }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(await rows()).toHaveLength(1);
  });

  it("records a QR-sourced view as qr and ignores other sources", async () => {
    expect((await beacon({ p: profileId, s: "qr" })).status).toBe(204);
    expect((await beacon({ p: profileId, s: "billboard" })).status).toBe(204);
    expect((await rows()).slice(-2).map((r) => r.source)).toEqual(["qr", null]);
  });

  it("/go redirects to the stored destination with no-store and no cookie, and records the click", async () => {
    const res = await go(ID(1), { "x-forwarded-for": SENTINEL_IP, "user-agent": SENTINEL_UA });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://shop.example.com/sale");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect((await rows()).at(-1)).toMatchObject({ type: "click", block_id: ID(1) });
    for (const bad of [ID(2), ID(3), ID(99)]) expect((await go(bad)).status).toBe(404);
    expect((await fetch(`${BASE}/go/${profileId}/not-a-uuid`, { redirect: "manual" })).status).toBe(404);
    expect((await fetch(`${BASE}/go/${profileId}/${ID(1)}?to=https://evil.example`, { redirect: "manual" })).headers.get("location")).toBe("https://shop.example.com/sale");
  });

  it("HEAD (Next.js answers it through the route) validates and redirects like GET but records no click", async () => {
    const before = (await rows()).length;
    const head = (blockId: string, extra: Record<string, string> = {}) =>
      fetch(`${BASE}/go/${profileId}/${blockId}`, { method: "HEAD", redirect: "manual", headers: { "user-agent": BROWSER, "x-forwarded-for": nextIp(), ...extra } });
    for (let i = 0; i < 5; i++) {
      const res = await head(ID(1));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://shop.example.com/sale");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    for (const bad of [ID(2), ID(3), ID(99)]) expect((await head(bad)).status).toBe(404);
    expect((await fetch(`${BASE}/go/${profileId}/not-a-uuid`, { method: "HEAD", redirect: "manual" })).status).toBe(404);
    expect((await rows()).length).toBe(before);
    // GET still records exactly one click.
    expect((await go(ID(1))).status).toBe(302);
    expect((await rows()).length).toBe(before + 1);
  });

  it("owner traffic, bots and prefetches are redirected/accepted but not recorded, and no cookie is set", async () => {
    const before = (await rows()).length;
    const ownerBeacon = await beacon({ p: profileId }, { cookie: ownerCookie });
    expect([ownerBeacon.status, ownerBeacon.headers.getSetCookie().length]).toEqual([204, 0]);
    const ownerClick = await go(ID(1), { cookie: ownerCookie });
    expect([ownerClick.status, ownerClick.headers.getSetCookie().length]).toEqual([302, 0]);
    expect((await go(ID(1), { "user-agent": "curl/8.9" })).status).toBe(302);
    expect((await go(ID(1), { "sec-purpose": "prefetch" })).status).toBe(302);
    expect((await beacon({ p: profileId }, { "user-agent": "Googlebot/2.1" })).status).toBe(204);
    expect((await rows()).length).toBe(before);
    // Another signed-in user is an ordinary visitor.
    expect((await beacon({ p: profileId }, { cookie: otherCookie })).status).toBe(204);
    expect((await rows()).length).toBe(before + 1);
  });

  it("click p95 after warm-up (host, informational; the budget is measured in the deployment smoke)", async () => {
    for (let i = 0; i < 5; i++) await go(ID(1));
    const ms: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      expect((await go(ID(1))).status).toBe(302);
      ms.push(performance.now() - t0);
    }
    ms.sort((a, b) => a - b);
    expect(ms[Math.ceil(ms.length * 0.95) - 1]).toBeLessThan(500);
  });
});

describe("owner-only dashboard and QR", () => {
  it("the owner sees the analytics page; another user and a guessed id get 404", async () => {
    const own = await page(`/dashboard/profiles/${profileId}/analytics?range=7`, ownerCookie);
    expect(own.status).toBe(200);
    const html = await own.text();
    expect(html).toContain('data-testid="stat-views"');
    expect(html).toContain('data-testid="daily-table"');
    expect(html).toContain("Daily views and clicks");
    // Dashboard pages stream behind Suspense, so notFound() arrives as Next's streamed 404 fallback, as for other dashboard pages.
    for (const [path, cookie] of [
      [`/dashboard/profiles/${profileId}/analytics`, otherCookie],
      [`/dashboard/profiles/${ID(55)}/analytics`, ownerCookie],
      [`/dashboard/profiles/not-a-uuid/analytics`, ownerCookie],
    ]) {
      const body = await (await page(path, cookie)).text();
      expect(body, path).toContain("NEXT_HTTP_ERROR_FALLBACK;404");
      expect(body, path).not.toContain('data-testid="stat-views"');
      expect(body, path).not.toContain("/ana?src=qr");
    }
    const signedOut = await page(`/dashboard/profiles/${profileId}/analytics`);
    expect([307, 308]).toContain(signedOut.status);
    expect(signedOut.headers.get("location")).toMatch(/\/login/);
  });

  it("a tampered active-profile cookie never opens another user's analytics", async () => {
    const body = await (await page("/dashboard/analytics", `${otherCookie}; covalink_active_profile=${profileId}`)).text();
    const [{ id: benProfile }] = (await testSql()`select id from profiles where handle = 'ben'`) as unknown as { id: string }[];
    // A streamed redirect: to Ben's own profile, never Ana's.
    expect(body).toContain(`NEXT_REDIRECT;replace;/dashboard/profiles/${benProfile}/analytics;307;`);
    expect(body).not.toContain(`/dashboard/profiles/${profileId}/analytics`);
  });

  it("the analytics page shows an error state when the data can't be read", async () => {
    await testSql()`alter table analytics_events rename to analytics_events_unavailable`;
    try {
      const html = await (await page(`/dashboard/profiles/${profileId}/analytics`, ownerCookie)).text();
      expect(html).toContain('data-testid="analytics-error"');
      expect(html).not.toContain('data-testid="stat-views"');
    } finally {
      await testSql()`alter table analytics_events_unavailable rename to analytics_events`;
    }
  });

  it("the QR SVG is an owner-only sandboxed attachment that decodes to APP_URL/{handle}?src=qr", async () => {
    const res = await page(`/dashboard/profiles/${profileId}/qr`, ownerCookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="covalink-ana-qr.svg"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const svg = Buffer.from(await res.arrayBuffer());
    const { data, info } = await sharp(svg).resize(480, 480, { kernel: "nearest" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height)?.data).toBe(`${BASE.replace("127.0.0.1", "localhost")}/ana?src=qr`);
    expect((await page(`/dashboard/profiles/${profileId}/qr`, otherCookie)).status).toBe(404);
  });
});

describe("privacy", () => {
  it("no raw IP address or user agent reaches the database", async () => {
    const dump = JSON.stringify(await testSql()`select * from analytics_events`) + JSON.stringify(await testSql()`select * from analytics_salts`);
    expect(dump).not.toContain(SENTINEL_IP);
    expect(dump).not.toContain("SentinelAgent");
    expect(dump).not.toContain("story?id");
  });
});
