import { beforeAll, describe, expect, it } from "vitest";
import * as svc from "@/features/profiles/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { resetDatabase, testSql } from "../support/db";

/**
 * Content blocks on the public page over real HTTP against `next start`. Fixture
 * writes come from this test process (no eviction signal), and the published
 * JSON is sometimes tampered with directly to stand in for older or foreign
 * data. Each tamper bumps the revision so the server sees a new cache key,
 * as a real publish would.
 */
const BASE = process.env.E2E_BASE_URL!;
const PASSWORD = "correct-horse-battery";
let ip = 1;

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { "x-forwarded-for": `198.18.2.${ip++ % 250}` }, redirect: "manual" });
  return { res, html: await res.text() };
}

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const header = { header: { displayName: "Blocks Owner", bio: "" }, seo: { noindex: false } };
const blockIds = (html: string) => [...html.matchAll(/data-block-id="([^"]+)"/g)].map((m) => m[1]);

let ownerId = "";
let profileId = "";
let revision = 0;

/** Rewrites the published snapshot in place (as foreign/older data), under a new revision. */
async function tamperPublished(mutate: (doc: { blocks: unknown[]; settings: Record<string, unknown> }) => void) {
  const [{ published }] = (await testSql()`select published from profiles where id = ${profileId}`) as unknown as {
    published: { blocks: unknown[]; settings: Record<string, unknown> };
  }[];
  mutate(published);
  revision += 1;
  await testSql()`update profiles set published = ${testSql().json(published)}, draft = ${testSql().json(published)},
    draft_revision = ${revision}, published_revision = ${revision} where id = ${profileId}`;
}

beforeAll(async () => {
  await resetDatabase();
  await bootstrapSuperAdmin({ token: process.env.E2E_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: PASSWORD });
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": "198.18.3.1" },
    body: JSON.stringify({ name: "Blocks", email: "blocks@example.com", password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  [{ id: ownerId }] = (await testSql()`select id from users where email = 'blocks@example.com'`) as unknown as { id: string }[];
  ({ id: profileId } = await svc.createProfile(ownerId, { handle: "blocks", label: "Blocks", displayName: "Blocks Owner" }));

  const r = await svc.publishProfile(ownerId, profileId, {
    expectedRevision: 0,
    patch: {
      ...header,
      blocks: [
        { id: ID(1), type: "heading", visible: true, config: { text: "My links", size: "lg", align: "inherit" } },
        { id: ID(2), type: "link", visible: true, config: { title: "Shop", url: "shop.example.com", description: "New stuff" } },
        { id: ID(3), type: "link", visible: false, config: { title: "HIDDEN LINK", url: "https://hidden.example.com" } },
        {
          id: ID(4),
          type: "text",
          visible: true,
          config: { markdown: "Hello **world** <script>alert(1)</script> [x](javascript:alert(1)) [ok](https://ok.example.com)", align: "inherit" },
        },
        { id: ID(5), type: "divider", visible: true, config: { style: "fade" } },
        { id: ID(6), type: "link", visible: true, config: { title: "Plain HTTP", url: "http://plain.example.com/" } },
      ],
    },
  });
  revision = r.revision;
  // A draft-only change must never appear publicly.
  await svc.saveDraft(ownerId, profileId, {
    expectedRevision: revision,
    patch: { ...header, blocks: [{ id: ID(7), type: "link", visible: true, config: { title: "DRAFT ONLY", url: "https://draft.example.com" } }] },
  });
  revision += 1;
  // Restore the draft to the published state so later tampering stays consistent.
  await svc.revertDraft(ownerId, profileId, { expectedRevision: revision });
  revision += 1;
});

describe("published blocks over HTTP", () => {
  it("renders only visible, valid content blocks, in order; link blocks go through /go, Markdown links stay direct", async () => {
    const { res, html } = await get("/blocks");
    expect(res.status).toBe(200);
    expect(blockIds(html)).toEqual([ID(1), ID(2), ID(4), ID(5), ID(6)]);
    expect(html).toContain(`<a class="pp-btn" href="/go/${profileId}/${ID(2)}" rel="noopener nofollow ugc">`);
    expect(html).toContain(`href="/go/${profileId}/${ID(6)}" rel="noopener nofollow ugc"`);
    // Destinations are never in the public link markup, only behind /go.
    expect(html).not.toContain('href="https://shop.example.com/"');
    expect(html).not.toMatch(/target="_blank"/);
    expect(html).not.toContain("HIDDEN LINK");
    expect(html).not.toContain("hidden.example.com");
    expect(html).not.toContain("DRAFT ONLY");
  });

  it("uses h2 for headings and escapes text", async () => {
    const { html } = await get("/blocks");
    expect(html).toMatch(/<h2 class="pp-heading" data-size="lg">My links<\/h2>/);
    expect(html).toContain("<strong>world</strong>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).toContain('<a href="https://ok.example.com/" rel="noopener nofollow ugc">ok</a>');
  });

  it("honors the stored openLinksInNewTab setting", async () => {
    await tamperPublished((doc) => {
      doc.settings.openLinksInNewTab = true;
    });
    const { html } = await get("/blocks");
    expect(html).toContain(`href="/go/${profileId}/${ID(2)}" target="_blank" rel="noopener noreferrer nofollow ugc"`);
    expect(html).toContain('href="https://ok.example.com/" target="_blank" rel="noopener noreferrer nofollow ugc"');
    await tamperPublished((doc) => {
      doc.settings.openLinksInNewTab = false;
    });
  });

  it("keeps the page online with unrecognized, legacy and invalid stored blocks, rendering only the reviewed ones", async () => {
    await tamperPublished((doc) => {
      doc.blocks.unshift(
        { id: ID(92), type: "image", version: 1, visible: true, config: { src: "https://img.example.com/x.png", alt: "x", aspect: "auto" } },
        { id: ID(70), type: "future-widget", version: 1, visible: true, config: {} },
        { id: ID(71), type: "link", version: 2, visible: true, config: { title: "Tampered", url: "javascript:alert(1)" } },
        { id: ID(72), type: "link", version: 9, visible: true, config: { title: "From the future", url: "https://future.example.com" } },
        {
          id: ID(80),
          type: "link",
          version: 1,
          visible: true,
          config: { title: "Legacy v1", url: "https://legacy.example.com/", icon: "star", thumbnailUrl: "https://img.example.com/t.png", featured: true },
        },
      );
    });
    const { res, html } = await get("/blocks");
    expect(res.status).toBe(200);
    expect(blockIds(html)).toEqual([ID(80), ID(1), ID(2), ID(4), ID(5), ID(6)]);
    expect(html).toContain(`href="/go/${profileId}/${ID(80)}"`);
    const legacy = await fetch(`${BASE}/go/${profileId}/${ID(80)}`, { redirect: "manual", headers: { "user-agent": "curl/8" } });
    expect([legacy.status, legacy.headers.get("location")]).toEqual([302, "https://legacy.example.com/"]);
    for (const tampered of [ID(71), ID(72), ID(70)]) {
      expect((await fetch(`${BASE}/go/${profileId}/${tampered}`, { redirect: "manual" })).status).toBe(404);
    }
    // (The text block shows "[x](javascript:alert(1))" as escaped plain text, so only an href would be a problem.)
    // A v1 image is legacy and never rendered (image v2 is covered by image-blocks, video and music by embed-blocks).
    for (const forbidden of [/<iframe/i, /youtube/i, /spotify/i, /img\.example\.com/, /Tampered/, /future\.example\.com/, /href="javascript:/i]) {
      expect(html).not.toMatch(forbidden);
    }
  });

  it("serves the page when every stored block is invalid", async () => {
    await tamperPublished((doc) => {
      doc.blocks = [{ id: "nope", type: "link" }, { type: "heading" }, null, "x"];
    });
    const { res, html } = await get("/blocks");
    expect(res.status).toBe(200);
    expect(html).toContain("Blocks Owner");
    expect(blockIds(html)).toEqual([]);
  });
});
