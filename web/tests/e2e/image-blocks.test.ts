import { beforeAll, describe, expect, it } from "vitest";
import * as svc from "@/features/profiles/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { profileSecurityHeaders } from "@/lib/security/headers";
import { resetDatabase, testSql } from "../support/db";
import * as img from "../support/images";

/**
 * Image blocks over real HTTP against the production server (`next start`,
 * or the hardened image in container mode): an image uploaded through
 * `/api/media`, published in image blocks, rendered with its stored size, the
 * linked-image `/go` redirect (GET counted, HEAD not, refusals 404), the
 * unchanged page CSP and no cookies on any public response.
 */
const BASE = process.env.E2E_BASE_URL!;
const PASSWORD = "correct-horse-battery";
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const header = { header: { displayName: "Image Owner", bio: "" }, seo: { noindex: false } };
const figures = (html: string) => [...html.matchAll(/<figure[\s\S]*?<\/figure>/g)].map((m) => m[0]);
let ip = 1;
const nextIp = () => `198.18.12.${ip++ % 250}`;

let profileId = "";
let asset = { url: "", width: 0, height: 0 };

const clicks = async () =>
  ((await testSql()`select block_id from analytics_events where type = 'click' and profile_id = ${profileId} order by id`) as unknown as { block_id: string }[]).map(
    (r) => r.block_id,
  );

async function get(path: string, method = "GET") {
  const res = await fetch(`${BASE}${path}`, { method, redirect: "manual", headers: { "user-agent": BROWSER, "x-forwarded-for": nextIp() } });
  return { res, body: method === "HEAD" ? "" : await res.text() };
}

const image = (n: number, extra: Record<string, unknown> = {}, visible = true) => ({
  id: ID(n),
  type: "image",
  visible,
  config: { src: asset.url, alt: "A lighthouse at dusk", decorative: false, caption: "", href: "", aspect: "auto", ...extra },
});

beforeAll(async () => {
  await resetDatabase();
  await bootstrapSuperAdmin({ token: process.env.E2E_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: PASSWORD });
  const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": "198.18.13.1" },
    body: JSON.stringify({ name: "Images", email: "images@example.com", password: PASSWORD }),
  });
  expect(signUp.status).toBe(200);
  const cookie = signUp.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => !c.endsWith("="))
    .join("; ");
  const up = await fetch(`${BASE}/api/media?kind=background`, {
    method: "POST",
    headers: { origin: BASE, cookie, "content-type": "application/octet-stream", "x-forwarded-for": "198.18.13.2" },
    body: new Uint8Array(await img.png(1600, 900, "#224466")),
    duplex: "half",
  } as RequestInit);
  expect(up.status).toBe(201);
  asset = (await up.json()).asset;
  expect([asset.width, asset.height]).toEqual([1600, 900]);

  const [{ id: ownerId }] = (await testSql()`select id from users where email = 'images@example.com'`) as unknown as { id: string }[];
  ({ id: profileId } = await svc.createProfile(ownerId, { handle: "images", label: "Images", displayName: "Image Owner" }));
  const r = await svc.publishProfile(ownerId, profileId, {
    expectedRevision: 0,
    patch: {
      ...header,
      blocks: [
        image(1, { caption: "Point Reyes", href: "https://lighthouse.example.com/tour", aspect: "wide" }),
        image(2, { alt: "", decorative: true }),
        image(3, { href: "https://hidden.example.com" }, false),
      ],
    },
  });
  await svc.saveDraft(ownerId, profileId, {
    expectedRevision: r.revision,
    patch: { ...header, blocks: [image(4, { href: "https://draft.example.com" })] },
  });
});

describe("public rendering", () => {
  it("renders the published images with their stored size, lazily, and sets no cookies", async () => {
    const { res, body } = await get("/images");
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get("content-security-policy")).toBe(profileSecurityHeaders({ isDev: false }).find((h) => h.key === "Content-Security-Policy")?.value);
    expect(figures(body)).toEqual([
      `<figure class="pp-figure" data-aspect="wide"><a class="pp-image-link" href="/go/${profileId}/${ID(1)}" rel="noopener nofollow ugc"><img class="pp-image" src="${asset.url}" alt="A lighthouse at dusk" width="1600" height="900" loading="lazy" decoding="async"/></a><figcaption class="pp-caption">Point Reyes</figcaption></figure>`,
      `<figure class="pp-figure" data-aspect="auto"><img class="pp-image" src="${asset.url}" alt="" width="1600" height="900" loading="lazy" decoding="async"/></figure>`,
    ]);
    expect(body).not.toContain("hidden.example.com");
    expect(body).not.toContain("draft.example.com");
    expect(body).not.toContain("lighthouse.example.com");
    expect(body).not.toContain("/_next/image");
  });

  it("serves the image itself same-origin with the media headers and no cookies", async () => {
    const { res } = await get(asset.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("linked image /go", () => {
  it("GET redirects to the stored destination and records one click; HEAD redirects identically without recording", async () => {
    const head = await get(`/go/${profileId}/${ID(1)}`, "HEAD");
    expect([head.res.status, head.res.headers.get("location")]).toEqual([302, "https://lighthouse.example.com/tour"]);
    expect(await clicks()).toEqual([]);
    const res = (await get(`/go/${profileId}/${ID(1)}`)).res;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://lighthouse.example.com/tour");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await clicks()).toEqual([ID(1)]);
  });

  it("answers the same 404 for unlinked, decorative, hidden, draft-only and unknown images, recording nothing", async () => {
    const before = await clicks();
    const reference = await get(`/go/${profileId}/${ID(99)}`);
    expect(reference.res.status).toBe(404);
    for (const id of [ID(2), ID(3), ID(4)]) {
      const r = await get(`/go/${profileId}/${id}`);
      expect([r.res.status, r.body], id).toEqual([404, reference.body]);
      expect((await get(`/go/${profileId}/${id}`, "HEAD")).res.status, `${id} (HEAD)`).toBe(404);
    }
    expect(await clicks()).toEqual(before);
  });
});
