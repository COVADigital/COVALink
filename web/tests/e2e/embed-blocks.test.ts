import { beforeAll, describe, expect, it } from "vitest";
import * as svc from "@/features/profiles/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { contentSecurityPolicy, profileSecurityHeaders } from "@/lib/security/headers";
import { resetDatabase, testSql } from "../support/db";

/**
 * Video and music blocks over real HTTP against the production server
 * (`next start`, or the hardened image in container mode): the CSP split on
 * every kind of route, one CSP per response, server HTML with no iframe and no
 * provider resource, no cookies, and `/go` refusal. Nothing contacts a provider.
 */
const BASE = process.env.E2E_BASE_URL!;
const PASSWORD = "correct-horse-battery";
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const header = { header: { displayName: "Embed Owner", bio: "" }, seo: { noindex: false } };
const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const PROVIDER_HOSTS = /youtube-nocookie\.com|youtube\.com|youtu\.be|vimeo\.com|spotify\.com|scdn\.co|soundcloud\.com|ytimg\.com/;
const PAGE_CSP = contentSecurityPolicy({ isDev: false });
const PROFILE_CSP = profileSecurityHeaders({ isDev: false }).find((h) => h.key === "Content-Security-Policy")!.value;
let ip = 1;
const nextIp = () => `198.18.14.${ip++ % 250}`;

let profileId = "";
let cookie = "";

async function get(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual", ...init, headers: { "user-agent": BROWSER, "x-forwarded-for": nextIp(), ...init.headers } });
  return { res, body: init.method === "HEAD" ? "" : await res.text() };
}
const csps = (res: Response) => res.headers.get("content-security-policy");

beforeAll(async () => {
  await resetDatabase();
  await bootstrapSuperAdmin({ token: process.env.E2E_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: PASSWORD });
  const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": "198.18.15.1" },
    body: JSON.stringify({ name: "Embeds", email: "embeds@example.com", password: PASSWORD }),
  });
  expect(signUp.status).toBe(200);
  cookie = signUp.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => !c.endsWith("="))
    .join("; ");
  const [{ id: ownerId }] = (await testSql()`select id from users where email = 'embeds@example.com'`) as unknown as { id: string }[];
  ({ id: profileId } = await svc.createProfile(ownerId, { handle: "embeds", label: "Embeds", displayName: "Embed Owner" }));
  await svc.publishProfile(ownerId, profileId, {
    expectedRevision: 0,
    patch: {
      ...header,
      blocks: [
        { id: ID(1), type: "video", visible: true, config: { url: "https://youtu.be/dQw4w9WgXcQ", title: "My video" } },
        { id: ID(2), type: "video", visible: true, config: { url: "https://vimeo.com/76979871" } },
        { id: ID(3), type: "music", visible: true, config: { url: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC" } },
        { id: ID(4), type: "music", visible: true, config: { url: "https://soundcloud.com/forss/sets/soulhack" } },
        { id: ID(5), type: "video", visible: false, config: { url: "https://vimeo.com/22439234", title: "Hidden" } },
      ],
    },
  });
});

describe("public page", () => {
  it("renders the boxes with no iframe and no provider resource, and sets no cookies", async () => {
    const { res, body } = await get("/embeds");
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(body).not.toMatch(/<iframe/i);
    // Only the Open links may name a provider in the markup; none is a resource the browser would fetch.
    const markup = body.replace(/<script[\s\S]*?<\/script>/g, "");
    const resources = [...markup.matchAll(/<(?:img|link|script|source|video|audio|embed|object)\b[^>]*>/gi)].map((m) => m[0]);
    expect(resources.filter((r) => PROVIDER_HOSTS.test(r))).toEqual([]);
    const providerAttrs = [...markup.matchAll(/\b(?:src|srcset|poster|data)="([^"]*)"/g)].map((m) => m[1]).filter((v) => PROVIDER_HOSTS.test(v));
    expect(providerAttrs).toEqual([]);
    expect([...markup.matchAll(/data-block-type="([^"]+)"/g)].map((m) => m[1])).toEqual(["video", "video", "music", "music"]);
    expect(markup).toContain(`href="${YT}" target="_blank" rel="noopener nofollow ugc"`);
    expect(markup).toContain('href="https://soundcloud.com/forss/sets/soulhack"');
    expect(body).not.toContain("22439234");
    expect(body).not.toContain("Hidden");
  });

  it("has exactly the reviewed embed policy", async () => {
    const { res } = await get("/embeds");
    expect(csps(res)).toBe(PROFILE_CSP);
    expect(PROFILE_CSP).toContain(
      "frame-src https://www.youtube-nocookie.com/embed/ https://player.vimeo.com/video/ https://open.spotify.com/embed/ https://w.soundcloud.com/player/",
    );
    expect(res.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("a handle-shaped 404 also has it (accepted: headers can't see liveness) but renders no iframe", async () => {
    const { res, body } = await get("/no-such-profile");
    expect(res.status).toBe(404);
    expect(csps(res)).toBe(PROFILE_CSP);
    expect(body).not.toMatch(/<iframe/i);
  });
});

describe("every other route keeps frame-src 'none'", () => {
  it.each([
    ["/", 200],
    ["/login", 200],
    ["/register", 200],
    ["/forgot-password", 200],
    ["/setup", 200],
    ["/api/health", 200],
    ["/a", 404],
    ["/-bad", 404],
    ["/embeds/extra", 404],
    ["/@embeds", 308],
  ])("%s", async (path, status) => {
    const { res } = await get(path);
    expect(res.status, path).toBe(status);
    expect(csps(res), path).toBe(PAGE_CSP);
  });

  it("the dashboard, admin and editor routes", async () => {
    for (const path of ["/dashboard", "/dashboard/profiles", `/dashboard/profiles/${profileId}`, "/dashboard/account", "/admin"]) {
      const { res } = await get(path, { headers: { cookie } });
      expect(csps(res), path).toBe(PAGE_CSP);
    }
  });

  it("token pages and media responses keep their own policy", async () => {
    for (const path of ["/reset-password", "/verify-email"]) expect(csps((await get(path)).res), path).toBe(PAGE_CSP);
    const media = await get("/media/7c9e6679-7425-40de-944b-e07fc1f90ae7.webp");
    expect(csps(media.res)).toBe("sandbox; default-src 'none'");
  });

  it("sends one CSP per response", async () => {
    for (const path of ["/embeds", "/no-such-profile", "/login", "/dashboard"]) {
      const { res } = await get(path, { method: "HEAD" });
      expect(res.headers.get("content-security-policy")?.includes(","), path).toBe(false);
    }
  });
});

describe("/go", () => {
  it("answers 404 for these blocks with nothing recorded", async () => {
    for (const id of [ID(1), ID(3)]) {
      for (const method of ["GET", "HEAD"]) expect((await get(`/go/${profileId}/${id}`, { method })).res.status).toBe(404);
      expect((await get(`/go/${profileId}/${id}/0`)).res.status).toBe(404);
    }
    const [{ n }] = await testSql()`select count(*)::int as n from analytics_events where type = 'click'`;
    expect(n).toBe(0);
  });
});
