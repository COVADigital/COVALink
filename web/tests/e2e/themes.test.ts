import { beforeAll, describe, expect, it } from "vitest";
import * as svc from "@/features/profiles/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { getPreset } from "@/features/themes/presets";
import { presetTheme } from "@/features/themes/theme";
import { resetDatabase, testSql } from "../support/db";

/**
 * Themes on the public page over real HTTP against `next start`. Fixture
 * writes come from this test process; a tampered published theme bumps the
 * revision so the server sees a new cache key, as a real publish would.
 */
const BASE = process.env.E2E_BASE_URL!;
const PASSWORD = "correct-horse-battery";
let ip = 1;

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { "x-forwarded-for": `198.18.4.${ip++ % 250}` }, redirect: "manual" });
  return { res, html: await res.text() };
}

const header = { header: { displayName: "Theme Owner", bio: "" }, seo: { noindex: false } };
const GOOGLE = /fonts\.googleapis\.com|fonts\.gstatic\.com/;

let ownerId = "";
let profileId = "";
let revision = 0;

beforeAll(async () => {
  await resetDatabase();
  await bootstrapSuperAdmin({ token: process.env.E2E_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: PASSWORD });
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": "198.18.5.1" },
    body: JSON.stringify({ name: "Themes", email: "themes@example.com", password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  [{ id: ownerId }] = (await testSql()`select id from users where email = 'themes@example.com'`) as unknown as { id: string }[];
  ({ id: profileId } = await svc.createProfile(ownerId, { handle: "themes", label: "Themes", displayName: "Theme Owner" }));
  ({ revision } = await svc.publishProfile(ownerId, profileId, { expectedRevision: 0, patch: { ...header, theme: getPreset("neon").theme } }));
});

describe("published themes over HTTP", () => {
  it("renders the published theme with self-hosted fonts, no cookies and intact security headers", async () => {
    const { res, html } = await get("/themes");
    expect(res.status).toBe(200);
    expect(html).toContain("--pp-accent:#a3e635");
    expect(html).toContain("--pp-font-body:&#x27;JetBrains Mono Variable&#x27;");
    expect(html).not.toMatch(GOOGLE);
    expect(res.headers.getSetCookie()).toEqual([]);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("serves the font faces from the app origin, with no external font URL in any stylesheet", async () => {
    const { html } = await get("/themes");
    const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+\.css)"/g)].map((m) => m[1]);
    expect(sheets.length).toBeGreaterThan(0);
    const fontUrls: string[] = [];
    for (const href of sheets) {
      expect(href.startsWith("/_next/static/")).toBe(true);
      const css = await (await fetch(`${BASE}${href}`)).text();
      expect(css).not.toMatch(GOOGLE);
      for (const m of css.matchAll(/@font-face\{[^}]*\}/g)) {
        for (const u of m[0].matchAll(/url\(([^)]+)\)/g)) fontUrls.push(new URL(u[1], `${BASE}${href}`).href);
      }
    }
    // Every face resolves to this origin's static media; the JetBrains Mono Latin file is served.
    expect(fontUrls.length).toBeGreaterThan(20);
    for (const u of fontUrls) expect(u.startsWith(`${BASE}/_next/static/media/`), u).toBe(true);
    const latin = fontUrls.find((u) => /jetbrains-mono-latin-wght-normal\.[^/]+\.woff2$/.test(u));
    expect(latin).toBeDefined();
    const font = await fetch(latin!);
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
  });

  it("keeps a draft theme private, then shows it on the next request once published", async () => {
    await svc.saveDraft(ownerId, profileId, { expectedRevision: revision, patch: { ...header, theme: getPreset("music").theme } });
    revision += 1;
    const before = await get("/themes");
    expect(before.html).toContain("--pp-accent:#a3e635");
    expect(before.html).not.toContain("#f472b6");

    await svc.publishProfile(ownerId, profileId, { expectedRevision: revision });
    const after = await get("/themes");
    expect(after.html).toContain("--pp-accent:#f472b6");
    expect(after.html).toContain("linear-gradient(200deg, #2e1065, #831843)");
    expect(after.html).not.toContain("#a3e635");
  });

  it("falls back to the default theme when the published theme can't be read", async () => {
    const [{ published }] = (await testSql()`select published from profiles where id = ${profileId}`) as unknown as { published: Record<string, unknown> }[];
    revision += 1;
    const tampered = { ...published, theme: { ...presetTheme("music"), version: 2 } };
    await testSql()`update profiles set published = ${testSql().json(tampered)}, draft = ${testSql().json(tampered)},
      draft_revision = ${revision}, published_revision = ${revision} where id = ${profileId}`;
    const { res, html } = await get("/themes");
    expect(res.status).toBe(200);
    expect(html).toContain("Theme Owner");
    expect(html).toContain("--pp-bg:#fafafa");
    expect(html).not.toContain("#f472b6");
  });
});
