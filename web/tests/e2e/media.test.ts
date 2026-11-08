import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as svc from "@/features/profiles/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { getPreset } from "@/features/themes/presets";
import { resetDatabase, testSql } from "../support/db";
import * as img from "../support/images";
import { deleteAccountOverHttp } from "../support/server-actions";

/**
 * Media over real HTTP against `next start`: the upload endpoint, the
 * `/media/{key}` responses and headers, uniform 404s, published pages using
 * uploaded images, readiness and account deletion. The server's storage root
 * is E2E_STORAGE_ROOT (created and checked by scripts/run-e2e.mjs).
 */
const BASE = process.env.E2E_BASE_URL!;
const ROOT = process.env.E2E_STORAGE_ROOT!;
const PASSWORD = "correct-horse-battery";
const MEDIA_CSP = "sandbox; default-src 'none'";
let ip = 1;
const nextIp = () => `198.18.7.${ip++ % 250}`;

const cookieFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => !c.endsWith("="))
    .join("; ");

async function account(email: string) {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": nextIp() },
    body: JSON.stringify({ name: email.split("@")[0], email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const [{ id }] = (await testSql()`select id from users where email = ${email}`) as unknown as { id: string }[];
  return { id, cookie: cookieFrom(res) };
}

function upload(kind: string, body: BodyInit, { cookie, origin = BASE, headers = {} }: { cookie?: string; origin?: string; headers?: Record<string, string> }) {
  return fetch(`${BASE}/api/media?kind=${kind}`, {
    method: "POST",
    headers: { origin, "content-type": "application/octet-stream", "x-forwarded-for": nextIp(), ...(cookie ? { cookie } : {}), ...headers },
    body,
    duplex: "half",
  } as RequestInit);
}

const keyFile = (key: string) => path.join(ROOT, key.slice(0, 2), key.slice(2, 4), key);

let owner = { id: "", cookie: "" };
let avatarUrl = "";
let backgroundUrl = "";

beforeAll(async () => {
  await resetDatabase();
  await bootstrapSuperAdmin({ token: process.env.E2E_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: PASSWORD });
  owner = await account("media-owner@example.com");
});

describe("upload endpoint over HTTP", () => {
  it("stores a re-encoded avatar and background for the signed-in owner", async () => {
    const a = await upload("avatar", await img.jpeg(900, 900), { cookie: owner.cookie, headers: { "x-upload-filename": encodeURIComponent("me.jpg") } });
    expect(a.status).toBe(201);
    expect(a.headers.getSetCookie()).toEqual([]);
    const asset = (await a.json()).asset;
    expect(asset).toMatchObject({ kind: "avatar", width: 512, height: 512, originalName: "me.jpg" });
    avatarUrl = asset.url;
    const b = await upload("background", await img.png(2400, 1200), { cookie: owner.cookie });
    expect(b.status).toBe(201);
    backgroundUrl = (await b.json()).asset.url;
    expect((await lstat(keyFile(avatarUrl.slice(7)))).isFile()).toBe(true);
    expect(await readdir(path.join(ROOT, "tmp"))).toEqual([]);
  });

  it("refuses unauthenticated and cross-origin uploads", async () => {
    const png = await img.png();
    expect((await upload("avatar", png, {})).status).toBe(401);
    expect((await upload("avatar", png, { cookie: owner.cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await upload("avatar", png, { cookie: owner.cookie, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
  });

  it("rejects an SVG disguised as a PNG and a polyglot", async () => {
    const svg = await upload("avatar", img.svg(), { cookie: owner.cookie, headers: { "content-type": "image/png", "x-upload-filename": "a.png" } });
    expect(svg.status).toBe(415);
    const poly = await upload("avatar", img.withTrailing(await img.png()), { cookie: owner.cookie });
    expect(poly.status).toBe(422);
  });

  it("stops a streamed body larger than 5 MiB with 413", async () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent > 64 * 1024 * 1024) return c.close();
        sent += 256 * 1024;
        c.enqueue(new Uint8Array(256 * 1024));
      },
    });
    const res = await upload("background", stream, { cookie: owner.cookie }).catch((e: Error) => e);
    // The server answers 413 as soon as the limit is crossed; it never reads the whole 64 MiB.
    if (res instanceof Error) throw res;
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(64 * 1024 * 1024);
    expect(await readdir(path.join(ROOT, "tmp"))).toEqual([]);
  });
});

describe("GET /media/{key}", () => {
  it("serves the image with the media headers, exactly one CSP, and no cookies", async () => {
    const res = await fetch(`${BASE}${avatarUrl}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("content-security-policy")).toBe(MEDIA_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.getSetCookie()).toEqual([]);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString()).toBe("WEBP");
  });

  it("answers unknown, malformed and traversal paths with 404 and never leaks files", async () => {
    for (const p of [
      "/media/7c9e6679-7425-40de-944b-e07fc1f90ae7.webp",
      "/media/x.webp",
      `/media/${avatarUrl.slice(7).toUpperCase()}`,
      "/media/..%2F..%2Fpackage.json",
      "/media/%2e%2e%2f%2e%2e%2f.env",
      "/media/..%5C..%5C.env",
      `/media/tmp`,
      `/media/${avatarUrl.slice(7, 9)}`,
    ]) {
      const res = await fetch(`${BASE}${p}`, { redirect: "manual" });
      expect(res.status, p).toBe(404);
      const text = await res.text();
      expect(text, p).not.toContain("BETTER_AUTH_SECRET");
      expect(text, p).not.toContain('"dependencies"');
    }
    const media404 = await fetch(`${BASE}/media/7c9e6679-7425-40de-944b-e07fc1f90ae7.webp`);
    expect(media404.headers.get("content-security-policy")).toBe(MEDIA_CSP);
    expect(media404.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps the page security headers everywhere else", async () => {
    for (const p of ["/", "/login", "/api/ready", "/mediaplayer"]) {
      const csp = (await fetch(`${BASE}${p}`, { redirect: "manual" })).headers.get("content-security-policy") ?? "";
      expect(csp, p).toContain("default-src 'self'");
      expect(csp, p).toContain("img-src 'self' data: blob: https:");
    }
  });
});

describe("published pages with uploaded images", () => {
  it("render the uploaded avatar and the background image with its overlay", async () => {
    const { id } = await svc.createProfile(owner.id, { handle: "mediapage", label: "Media", displayName: "Media Owner" });
    const theme = JSON.parse(JSON.stringify(getPreset("midnight").theme));
    theme.background = { ...theme.background, type: "image", imageUrl: backgroundUrl, overlayOpacity: 0.7 };
    theme.text = { color: "#ffffff", muted: "#e4e4e7" };
    theme.accent = "#ffffff";
    theme.button = { ...theme.button, variant: "fill", color: "#ffffff", textColor: "#111111" };
    await svc.publishProfile(owner.id, id, {
      expectedRevision: 0,
      patch: { header: { displayName: "Media Owner", bio: "", avatarUrl }, seo: { noindex: false }, theme },
    });
    const res = await fetch(`${BASE}/mediapage`, { headers: { "x-forwarded-for": nextIp() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`src="${avatarUrl}"`);
    expect(html).toContain(`url(&quot;${backgroundUrl}&quot;) center / cover no-repeat`);
    expect(res.headers.get("content-security-policy")).toContain("img-src 'self'");
  });
});

describe("account deletion over HTTP", () => {
  it("deletes the account, its media rows and its files; the URLs then 404", async () => {
    const other = await account("media-leaver@example.com");
    const res = await upload("avatar", await img.png(), { cookie: other.cookie });
    const url = (await res.json()).asset.url as string;
    expect((await fetch(`${BASE}${url}`)).status).toBe(200);
    // Only the account page's confirmed Server Action deletes accounts.
    expect((await deleteAccountOverHttp(BASE, other.cookie, PASSWORD)).result).toMatchObject({ ok: true });
    expect(await testSql()`select 1 from media_assets where owner_id = ${other.id}`).toHaveLength(0);
    await expect(lstat(keyFile(url.slice(7)))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fetch(`${BASE}${url}`)).status).toBe(404);
    // The other owner's files are untouched.
    expect((await fetch(`${BASE}${avatarUrl}`)).status).toBe(200);
  });
});
