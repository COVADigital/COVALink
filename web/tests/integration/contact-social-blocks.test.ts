import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Contact, social and spacer blocks against the guarded test database:
 * the edit/publish/discard matrix, tenant isolation,
 * stored-data compatibility, refused writes, the vCard download matrix and
 * the social `/go` matrix.
 */
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
}));

import { setUserBanned } from "@/features/admin/users";
import { handleClick, handleSocialClick } from "@/features/analytics/click";
import { getProfileAnalytics } from "@/features/analytics/service";
import { ProfileView } from "@/components/profile/profile-view";
import { createDefaultDocument } from "@/features/profiles/document";
import { getLiveProfile, getPublishedDocument } from "@/features/profiles/public";
import * as svc from "@/features/profiles/service";
import { handleVcard } from "@/features/profiles/vcard-download";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { AppError } from "@/lib/errors";
import { vcardResponseHeaders } from "@/lib/security/headers";
import { signUp } from "../support/auth-http";
import { resetDatabase, testSql } from "../support/db";
import { TEST_APP_URL, TEST_SETUP_TOKEN } from "../support/test-env";
import { parseVCard, unescapeText } from "../support/vcard-parse";

const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const header = { header: { displayName: "Ana", bio: "" }, seo: { noindex: false } };

let superId = "";
let alice = "";
let bob = "";
let profileId = "";
let bobProfileId = "";

const idOf = async (email: string) => ((await testSql()`select id from users where email = ${email}`)[0] as { id: string }).id;
const eventCount = async () => Number((await testSql()`select count(*)::int as n from analytics_events`)[0].n);
const clickBlocks = async () => ((await testSql()`select block_id from analytics_events where type = 'click' order by id`) as unknown as { block_id: string }[]).map((r) => r.block_id);

type Stored = { id: string; type: string; version: number; visible: boolean; config: Record<string, unknown> };
const row = async (id: string) =>
  (await testSql()`select draft, published, draft_revision from profiles where id = ${id}`)[0] as {
    draft: { blocks: Stored[] };
    published: { blocks: Stored[] } | null;
    draft_revision: number;
  };
const rawRow = async (id: string) =>
  (
    await testSql()`select draft::text as draft, published::text as published, draft_revision, published_revision,
      is_published, draft_updated_at, published_at from profiles where id = ${id}`
  )[0];

const SOC = (n: number, extra: object = {}) => ({
  id: ID(n),
  type: "social",
  visible: true,
  config: { items: [{ platform: "github", url: "github.com/ana" }, { platform: "website", url: "https://ana.example" }], style: "pill", ...extra },
});
const EM = (n: number, label = "Write me") => ({ id: ID(n), type: "email", visible: true, config: { label, email: "ana@example.com", subject: "Hello there" } });
const PH = (n: number, phone = "+1 (555) 010-0100") => ({ id: ID(n), type: "phone", visible: true, config: { label: "Call me", phone } });
const CT = (n: number, extra: object = {}) => ({
  id: ID(n),
  type: "contact",
  visible: true,
  config: {
    label: "Save contact",
    firstName: "Ana",
    lastName: "Ruiz",
    organization: "Acme, Inc.",
    jobTitle: "",
    email: "ana@example.com",
    phone: "+1 555 0100",
    website: "acme.example",
    note: "Line 1\nLine 2",
    ...extra,
  },
});
const SP = (n: number, size = "lg") => ({ id: ID(n), type: "spacer", visible: true, config: { size } });
const L = (n: number) => ({ id: ID(n), type: "link", visible: true, config: { title: `Link ${n}`, url: `https://example.com/${n}` } });

const save = (owner: string, id: string, expectedRevision: number, blocks?: unknown[]) =>
  svc.saveDraft(owner, id, { expectedRevision, patch: { ...header, ...(blocks ? { blocks } : {}) } });
const publish = (owner: string, id: string, revision: number, blocks?: unknown[]) =>
  svc.publishProfile(owner, id, { expectedRevision: revision, ...(blocks ? { patch: { ...header, blocks } } : {}) });

async function code(p: Promise<unknown>): Promise<string | null> {
  return p.then(
    () => null,
    (e: unknown) => (e instanceof AppError ? e.code : `non-AppError: ${String(e)}`),
  );
}

/** Writes stored JSON directly (as another version or tool might have). */
async function seed(id: string, draftBlocks: unknown[], publishedBlocks?: unknown[]) {
  const base = createDefaultDocument("Ana");
  const draft = { ...base, blocks: draftBlocks };
  if (publishedBlocks) {
    const published = { ...base, blocks: publishedBlocks };
    await testSql()`update profiles set draft = ${testSql().json(draft)}, published = ${testSql().json(published)},
      draft_revision = 1, published_revision = 1, is_published = true, published_at = now() where id = ${id}`;
  } else {
    await testSql()`update profiles set draft = ${testSql().json(draft)}, draft_revision = 1 where id = ${id}`;
  }
}

/** The public page's block markup, rendered as `/{handle}` does (with the live profile id). */
async function publicHtml(handle: string) {
  const live = await getLiveProfile(handle);
  const doc = live ? await getPublishedDocument(live) : null;
  if (!live || !doc) return null;
  return renderToStaticMarkup(createElement(ProfileView, { document: doc, verified: false, mode: "public", clickTrackingProfileId: live.id }));
}

const req = (path: string, method = "GET") => new Request(`${TEST_APP_URL}${path}`, { method, headers: { "user-agent": BROWSER } });
const vcard = (pid: string, bid: string, method = "GET") => handleVcard(req(`/api/vcard/${pid}/${bid}`, method), pid, bid);
const social = (pid: string, bid: string, index: string, method = "GET") => handleSocialClick(req(`/go/${pid}/${bid}/${index}`, method), pid, bid, index);
const shape = async (res: Response) => ({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() });

beforeEach(async () => {
  await resetDatabase();
  ({ userId: superId } = await bootstrapSuperAdmin({ token: TEST_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: "correct-horse-battery" }));
  for (const email of ["alice@example.com", "bob@example.com"]) expect((await signUp(email)).status).toBe(200);
  [alice, bob] = await Promise.all(["alice@example.com", "bob@example.com"].map(idOf));
  profileId = (await svc.createProfile(alice, { handle: "ana", label: "ana", displayName: "Ana" })).id;
  bobProfileId = (await svc.createProfile(bob, { handle: "bob", label: "bob", displayName: "Bob" })).id;
});

describe("edit, publish and discard", () => {
  it("creates, edits, hides, duplicates, reorders, deletes, publishes and discards all five types", async () => {
    // Create.
    let r = await save(alice, profileId, 0, [SOC(1), EM(2), PH(3), CT(4), SP(5)]);
    let draft = (await row(profileId)).draft.blocks;
    expect(draft.map((b) => [b.type, b.version])).toEqual([["social", 2], ["email", 2], ["phone", 2], ["contact", 2], ["spacer", 1]]);
    expect(draft[0].config).toEqual({ items: [{ platform: "github", url: "https://github.com/ana" }, { platform: "website", url: "https://ana.example/" }], style: "pill" });
    expect(draft[1].config).toEqual({ label: "Write me", email: "ana@example.com", subject: "Hello there" });
    expect(draft[2].config).toEqual({ label: "Call me", phone: "+1 (555) 010-0100" });
    expect(draft[3].config).toEqual({
      label: "Save contact",
      firstName: "Ana",
      lastName: "Ruiz",
      organization: "Acme, Inc.",
      email: "ana@example.com",
      phone: "+1 555 0100",
      website: "https://acme.example/",
      note: "Line 1\nLine 2",
    });
    expect(draft[4].config).toEqual({ size: "lg" });

    // Edit, hide, duplicate (new id, same config), reorder and delete in one editor save.
    const copy = { ...EM(6, "Write me"), config: { ...EM(6).config } };
    r = await save(alice, profileId, r.revision, [SP(5, "xs"), { ...SOC(1, { style: "icon" }) }, { ...PH(3, "555.0100"), visible: false }, EM(2, "Email"), copy, CT(4, { firstName: "Bea" })]);
    draft = (await row(profileId)).draft.blocks;
    expect(draft.map((b) => b.id)).toEqual([ID(5), ID(1), ID(3), ID(2), ID(6), ID(4)]);
    expect(draft.map((b) => b.visible)).toEqual([true, true, false, true, true, true]);
    expect(draft[0].config).toEqual({ size: "xs" });
    expect(draft[1].config.style).toBe("icon");
    expect(draft[2].config.phone).toBe("555.0100");
    expect(draft[3].config.label).toBe("Email");
    expect(draft[5].config.firstName).toBe("Bea");

    // Publish; the public page renders the visible blocks with the shared renderer.
    await publish(alice, profileId, r.revision);
    const published = (await row(profileId)).published!.blocks;
    expect(published).toEqual(draft);
    const html = (await publicHtml("ana"))!;
    expect([...html.matchAll(/data-block-type="([^"]+)"/g)].map((m) => m[1])).toEqual(["spacer", "social", "email", "email", "contact"]);
    expect(html).toContain(`href="/go/${profileId}/${ID(1)}/0"`);
    expect(html).toContain('href="mailto:ana@example.com?subject=Hello%20there"');
    expect(html).toContain(`href="/api/vcard/${profileId}/${ID(4)}"`);
    expect(html).not.toContain("tel:"); // the phone block is hidden

    // Edit again, then discard: the draft returns to the published blocks exactly.
    const edited = await save(alice, profileId, r.revision, [SP(5)]);
    expect((await row(profileId)).draft.blocks).toHaveLength(1);
    await svc.revertDraft(alice, profileId, { expectedRevision: edited.revision });
    expect((await row(profileId)).draft.blocks).toEqual(published);

    // Delete everything and publish: nothing is left on the page.
    const after = (await row(profileId)).draft_revision;
    await publish(alice, profileId, after, []);
    expect(await publicHtml("ana")).not.toContain("pp-block");
  });

  it("keeps other owners out: Bob can't read or write Ana's blocks", async () => {
    await save(alice, profileId, 0, [SOC(1), CT(2)]);
    const before = await rawRow(profileId);
    expect(await code(save(bob, profileId, 1, [SP(9)]))).toBe("NOT_FOUND");
    expect(await code(publish(bob, profileId, 1, [SP(9)]))).toBe("NOT_FOUND");
    expect(await code(svc.getOwnedProfile(bob, profileId))).toBe("NOT_FOUND");
    expect(await code(svc.revertDraft(bob, profileId, { expectedRevision: 1 }))).toBe("NOT_FOUND");
    expect(await rawRow(profileId)).toEqual(before);
    // Ana's block ids can't be reused across profiles to reach her data either.
    await save(bob, bobProfileId, 0, [SOC(1, { items: [{ platform: "x", url: "https://x.com/bob" }] })]);
    expect((await row(profileId)).draft.blocks[0].config).toMatchObject({ items: [{ url: "https://github.com/ana" }, { url: "https://ana.example/" }] });
  });

  it("refuses invalid writes and leaves stored JSON, revisions and timestamps unchanged", async () => {
    await save(alice, profileId, 0, [SOC(1), EM(2), PH(3), CT(4), SP(5)]);
    await publish(alice, profileId, 1);
    const before = await rawRow(profileId);
    const bad: [string, unknown][] = [
      ["http social URL", SOC(1, { items: [{ platform: "github", url: "http://github.com/ana" }] })],
      ["credentials", SOC(1, { items: [{ platform: "website", url: "https://u:p@ana.example" }] })],
      ["wrong host", SOC(1, { items: [{ platform: "instagram", url: "https://evil.example/ana" }] })],
      ["no items", SOC(1, { items: [] })],
      ["25 items", SOC(1, { items: Array.from({ length: 25 }, (_, i) => ({ platform: "website", url: `https://s${i}.example` })) })],
      ["unknown platform", SOC(1, { items: [{ platform: "myspace", url: "https://myspace.com/ana" }] })],
      ["nested extra key", SOC(1, { items: [{ platform: "github", url: "https://github.com/ana", label: "" }] })],
      ["social extra key", SOC(1, { layout: "grid" })],
      ["subject CRLF", { ...EM(2), config: { ...EM(2).config, subject: "Hi\r\nBcc: x@example.com" } }],
      ["subject tab", { ...EM(2), config: { ...EM(2).config, subject: "Hi\t" } }],
      ["subject NUL", { ...EM(2), config: { ...EM(2).config, subject: "Hi\u0000" } }],
      ["long email", { ...EM(2), config: { ...EM(2).config, email: `${"a".repeat(250)}@example.com` } }],
      ["phone extension", PH(3, "555 0100 x12")],
      ["phone second plus", PH(3, "++1 555 0100")],
      ["phone punctuation only", PH(3, "((--))")],
      ["phone 16 digits", PH(3, "+1234567890123456")],
      ["contact without a name", CT(4, { firstName: "", lastName: "", organization: "" })],
      ["contact phone extension", CT(4, { phone: "5550100;ext=1" })],
      ["contact control in name", CT(4, { firstName: "A\u001bna" })],
      ["contact extra key", CT(4, { photo: "x" })],
      ["spacer size", SP(5, "huge")],
      ["spacer extra key", { ...SP(5), config: { size: "md", px: 3 } }],
      ["client version", { ...SP(5), version: 1 }],
      ["social sent as preserved", { id: ID(1), preserve: true }],
    ];
    for (const [label, block] of bad) {
      const list = [SOC(1), EM(2), PH(3), CT(4), SP(5)].map((b) => (b.id === (block as { id: string }).id ? block : b));
      expect(await code(save(alice, profileId, 1, list)), label).toBe("VALIDATION");
      expect(await code(publish(alice, profileId, 1, list)), `${label} (publish)`).toBe("VALIDATION");
    }
    expect(await rawRow(profileId)).toEqual(before);
  });

  it("maps social item errors to items.{i}.url on the AppError", async () => {
    const err = await save(alice, profileId, 0, [SOC(1, { items: [{ platform: "github", url: "https://github.com/ok" }, { platform: "x", url: "http://x.com/a" }] })]).catch((e: unknown) => e);
    expect((err as AppError).blockErrors).toEqual({
      list: [],
      items: [{ index: 0, id: ID(1), fields: { "items.1.url": ["Enter an https:// X address, like https://x.com/you"] } }],
    });
  });
});

describe("stored-data compatibility", () => {
  const STORED_V1 = [
    { id: ID(11), type: "social", version: 1, visible: true, config: { items: [{ platform: "github", url: "https://github.com/legacy" }] } },
    { id: ID(12), type: "email", version: 1, visible: true, config: { label: "Mail", email: "legacy@example.com" } },
    { id: ID(13), type: "phone", version: 1, visible: true, config: { label: "Ring", phone: "555-0100" } },
    { id: ID(14), type: "contact", version: 1, visible: true, config: { label: "Card", organization: "Legacy Ltd" } },
    { id: ID(15), type: "spacer", version: 1, visible: true, config: { size: "sm" } },
  ];

  it("reads valid v1 blocks as editable v2, keeps them verbatim on header saves, and rewrites them as v2 only when the editor submits them", async () => {
    await seed(profileId, STORED_V1, STORED_V1);
    const owned = await svc.getOwnedProfile(alice, profileId);
    expect(owned.protectedBlocks).toBe(0);
    expect(owned.draft.blocks.map((b) => [b.type, b.version])).toEqual([["social", 2], ["email", 2], ["phone", 2], ["contact", 2], ["spacer", 1]]);
    const html = (await publicHtml("ana"))!;
    expect(html).toContain(`href="/go/${profileId}/${ID(11)}/0"`);
    expect(html).toContain('href="tel:5550100"');

    await save(alice, profileId, 1); // header only
    expect((await row(profileId)).draft.blocks).toEqual(STORED_V1);
    await save(alice, profileId, 2, [{ id: ID(12), type: "email", visible: true, config: { label: "Mail", email: "legacy@example.com", subject: "" } }]);
    expect((await row(profileId)).draft.blocks).toEqual([{ id: ID(12), type: "email", version: 2, visible: true, config: { label: "Mail", email: "legacy@example.com" } }]);
  });

  it("protects a draft whose v1 block fails the v2 rules or carries an unknown key, and keeps it off the page", async () => {
    for (const bad of [
      { id: ID(21), type: "social", version: 1, visible: true, config: { items: [{ platform: "github", url: "http://github.com/legacy" }] } },
      { id: ID(21), type: "social", version: 1, visible: true, config: { items: [] } },
      { id: ID(21), type: "social", version: 1, visible: true, config: { items: [{ platform: "github", url: "https://github.com/a", label: "" }] } },
      { id: ID(21), type: "email", version: 1, visible: true, config: { label: "Mail", email: "a@example.com", subject: "x\r\nBcc: b@example.com" } },
      { id: ID(21), type: "phone", version: 1, visible: true, config: { label: "Ring", phone: "(((-)))" } },
      { id: ID(21), type: "contact", version: 1, visible: true, config: { label: "Card", organization: "Ltd", fax: "" } },
    ]) {
      await seed(profileId, [bad, { ...L(1), version: 2 }], [bad, { ...L(1), version: 2 }]);
      expect((await svc.getOwnedProfile(alice, profileId)).protectedBlocks, JSON.stringify(bad.config)).toBe(1);
      await expectEveryWriteRefused();
      const html = (await publicHtml("ana"))!;
      expect(html).toContain("Link 1");
      expect(html).not.toContain(ID(21));
    }
  });

  it("protects a draft whose lenient v1 spacer carries an unknown key (lossy), which still renders", async () => {
    const spacer = { id: ID(22), type: "spacer", version: 1, visible: true, config: { size: "md", px: 0 } };
    await seed(profileId, [spacer, { ...L(1), version: 2 }], [spacer, { ...L(1), version: 2 }]);
    expect((await svc.getOwnedProfile(alice, profileId)).protectedBlocks).toBe(1);
    await expectEveryWriteRefused();
    expect(await publicHtml("ana")).toContain(`data-block-id="${ID(22)}" data-block-type="spacer"`);
  });

  /** Header save, editor save, publish and save-and-publish are all refused, and nothing changes. */
  async function expectEveryWriteRefused() {
    const before = await rawRow(profileId);
    for (const write of [() => save(alice, profileId, 1), () => save(alice, profileId, 1, [L(1)]), () => publish(alice, profileId, 1), () => publish(alice, profileId, 1, [L(1)])]) {
      const err = await write().catch((e: unknown) => e);
      expect((err as AppError).message).toMatch(/can't edit without losing data/);
    }
    expect(await rawRow(profileId)).toEqual(before);
  }
});

describe("vCard download", () => {
  beforeEach(async () => {
    const hidden = { ...CT(3, { firstName: "Hidden" }), visible: false };
    await publish(alice, profileId, 0, [CT(1), EM(2), hidden, SOC(4)]);
    await publish(bob, bobProfileId, 0, [CT(9, { firstName: "Bob" })]);
  });

  it("serves the published card with the required headers; HEAD matches without a body", async () => {
    const res = await vcard(profileId, ID(1));
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      "content-type": "text/vcard; charset=utf-8",
      "content-disposition": 'attachment; filename="Ana-Ruiz.vcf"',
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "content-security-policy": "sandbox; default-src 'none'",
    });
    expect(res.headers.getSetCookie()).toEqual([]);
    const body = await res.text();
    expect(res.headers.get("content-length")).toBe(String(new TextEncoder().encode(body).length));
    const props = parseVCard(body);
    expect(props.map((p) => p.name)).toEqual(["BEGIN", "VERSION", "FN", "N", "ORG", "EMAIL", "TEL", "URL", "NOTE", "END"]);
    expect(unescapeText(props.find((p) => p.name === "ORG")!.raw)).toBe("Acme, Inc.");
    expect(props.find((p) => p.name === "TEL")!.raw).toBe("tel:+15550100");

    const head = await vcard(profileId, ID(1), "HEAD");
    expect(head.status).toBe(200);
    expect(Object.fromEntries(head.headers)).toEqual(Object.fromEntries(res.headers));
    expect(await head.text()).toBe("");
    expect(await eventCount()).toBe(0);
  });

  it("answers the same plain 404 for every refused case and records nothing", async () => {
    await save(alice, profileId, 1, [CT(1), EM(2), { ...CT(3), visible: false }, SOC(4), CT(5, { firstName: "Draft" })]);
    const reference = await shape(await vcard(profileId, ID(99)));
    expect(reference).toMatchObject({ status: 404, body: "Not found", headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    expect(reference.headers).not.toHaveProperty("content-disposition");
    const cases: [string, string, string][] = [
      ["draft-only block", profileId, ID(5)],
      ["hidden block", profileId, ID(3)],
      ["email block", profileId, ID(2)],
      ["social block", profileId, ID(4)],
      ["another profile's block", profileId, ID(9)],
      ["own block via another profile", bobProfileId, ID(1)],
      ["unknown profile", ID(77), ID(1)],
      ["malformed profile id", "not-a-uuid", ID(1)],
      ["malformed block id", profileId, "1"],
      ["uppercase-only garbage", "%00", "%2e%2e"],
    ];
    for (const [label, pid, bid] of cases) {
      expect(await shape(await vcard(pid, bid)), label).toEqual(reference);
      expect(await shape(await vcard(pid, bid, "HEAD")), `${label} (HEAD)`).toEqual({ ...reference, body: "" });
    }
    // Unpublished, then a banned owner.
    expect((await vcard(bobProfileId, ID(9))).status).toBe(200);
    await svc.unpublishProfile(alice, profileId);
    expect(await shape(await vcard(profileId, ID(1)))).toEqual(reference);
    await setUserBanned(superId, bob, true);
    expect(await shape(await vcard(bobProfileId, ID(9)))).toEqual(reference);
    expect(await eventCount()).toBe(0);
  });

  it("answers every other HTTP method with 405, Allow: GET, HEAD and the route's headers", async () => {
    const route = await import("@/app/api/vcard/[profileId]/[blockId]/route");
    expect(Object.keys(route).sort()).toEqual(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
    const handlers = { POST: route.POST, PUT: route.PUT, PATCH: route.PATCH, DELETE: route.DELETE, OPTIONS: route.OPTIONS };
    for (const [method, handler] of Object.entries(handlers)) {
      const res = handler();
      expect(res.status, method).toBe(405);
      expect(Object.fromEntries(res.headers), method).toEqual({
        ...vcardResponseHeaders(),
        allow: "GET, HEAD",
        "content-length": "18",
      });
      expect(await res.text()).toBe("Method not allowed");
    }
    expect(await eventCount()).toBe(0);
  });

  it("uses only the current published snapshot and never serves tampered invalid data", async () => {
    await save(alice, profileId, 1, [CT(1, { firstName: "Changed" })]);
    expect(parseVCard(await (await vcard(profileId, ID(1))).text()).find((p) => p.name === "FN")!.raw).toBe("Ana Ruiz");
    // A stored card that fails the contact rules doesn't parse, so it isn't served.
    await testSql()`update profiles set published = jsonb_set(published, '{blocks,0,config,phone}', '"555 0100 ext 9"') where id = ${profileId}`;
    expect((await vcard(profileId, ID(1))).status).toBe(404);
    await testSql()`update profiles set published = jsonb_set(published, '{blocks,0,config}', '{"label":"x","jobTitle":"Only a title"}') where id = ${profileId}`;
    expect((await vcard(profileId, ID(1))).status).toBe(404);
  });
});

describe("social /go", () => {
  beforeEach(async () => {
    const hidden = { ...SOC(3), visible: false };
    await publish(alice, profileId, 0, [SOC(1), L(2), hidden, EM(4)]);
    await publish(bob, bobProfileId, 0, [SOC(9, { items: [{ platform: "x", url: "https://x.com/bob" }] })]);
  });

  it("redirects a valid GET to the revalidated destination and records one click per GET against the block", async () => {
    const res = await social(profileId, ID(1), "0");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://github.com/ana");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect((await social(profileId, ID(1), "1")).headers.get("location")).toBe("https://ana.example/");
    expect(await clickBlocks()).toEqual([ID(1), ID(1)]);

    const stats = await getProfileAnalytics(alice, profileId, { range: "7" });
    expect(stats.topLinks).toEqual([{ blockId: ID(1), title: "Social links", hidden: false, clicks: 2 }]);
  });

  it("validates HEAD identically but never records it", async () => {
    const get = await social(profileId, ID(1), "1");
    const head = await social(profileId, ID(1), "1", "HEAD");
    expect([head.status, head.headers.get("location")]).toEqual([get.status, get.headers.get("location")]);
    expect(Object.fromEntries(head.headers)).toEqual(Object.fromEntries(get.headers));
    for (let i = 0; i < 3; i++) await social(profileId, ID(1), "0", "HEAD");
    expect(await clickBlocks()).toEqual([ID(1)]);
  });

  it("answers the same 404 for every refused case and records nothing", async () => {
    const reference = await shape(await social(profileId, ID(1), "2"));
    expect(reference).toMatchObject({ status: 404, body: "Not found" });
    const cases: [string, string, string, string][] = [
      ["out of range", profileId, ID(1), "2"],
      ["leading zero", profileId, ID(1), "01"],
      ["double zero", profileId, ID(1), "00"],
      ["negative", profileId, ID(1), "-1"],
      ["exponent", profileId, ID(1), "1e0"],
      ["space", profileId, ID(1), " 0"],
      ["plus", profileId, ID(1), "+0"],
      ["large", profileId, ID(1), "99"],
      ["very large", profileId, ID(1), "100"],
      ["word", profileId, ID(1), "zero"],
      ["empty", profileId, ID(1), ""],
      ["hidden social block", profileId, ID(3), "0"],
      ["link block with index", profileId, ID(2), "0"],
      ["email block", profileId, ID(4), "0"],
      ["unknown block", profileId, ID(99), "0"],
      ["another profile's block", profileId, ID(9), "0"],
      ["own block via another profile", bobProfileId, ID(1), "0"],
      ["malformed ids", "x", "y", "0"],
    ];
    for (const [label, pid, bid, index] of cases) {
      expect(await shape(await social(pid, bid, index)), label).toEqual(reference);
      expect((await social(pid, bid, index, "HEAD")).status, `${label} (HEAD)`).toBe(404);
    }
    // A social block through the link route (no index) is a 404 too.
    expect((await handleClick(req(`/go/${profileId}/${ID(1)}`), profileId, ID(1))).status).toBe(404);
    expect(await eventCount()).toBe(0);
  });

  it("follows the current published document: draft-only, unpublished, banned owners and tampered destinations are 404", async () => {
    await save(alice, profileId, 1, [SOC(1), SOC(5)]);
    expect((await social(profileId, ID(5), "0")).status).toBe(404);
    await svc.unpublishProfile(alice, profileId);
    expect((await social(profileId, ID(1), "0")).status).toBe(404);
    expect((await social(bobProfileId, ID(9), "0")).status).toBe(302);
    await setUserBanned(superId, bob, true);
    expect((await social(bobProfileId, ID(9), "0")).status).toBe(404);
    expect(await clickBlocks()).toEqual([ID(9)]);
  });

  it("never redirects to a tampered destination", async () => {
    for (const url of ["javascript:alert(1)", "http://github.com/ana", "https://evil.example/x", "https://u:p@github.com/ana"]) {
      await testSql()`update profiles set published = jsonb_set(published, '{blocks,0,config,items,0,url}', ${testSql().json(url)}) where id = ${profileId}`;
      expect((await social(profileId, ID(1), "0")).status, url).toBe(404);
    }
    expect(await eventCount()).toBe(0);
  });
});
