import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Uploaded image blocks against the guarded test database and a throwaway
 * storage root: server-stamped sizes, draft privacy, the
 * refused-write matrix (atomic, on save and publish), contextual reference
 * checks, the v1 legacy policy, the media lifecycle, deterministic
 * delete-versus-write ordering, and linked-image `/go` behavior.
 */
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
}));

import { toBlockInput, toEditorItems } from "@/components/editor/block-items";
import { ProfileView } from "@/components/profile/profile-view";
import { setUserBanned } from "@/features/admin/users";
import { handleClick } from "@/features/analytics/click";
import { getProfileAnalytics } from "@/features/analytics/service";
import { IMAGE_NOT_IN_LIBRARY } from "@/features/blocks/input";
import type { MediaKind } from "@/features/media/constants";
import { mediaUrl } from "@/features/media/layout.mjs";
import { processImage, type ProcessedImage } from "@/features/media/pipeline";
import { referencedKeys } from "@/features/media/references";
import * as media from "@/features/media/service";
import { LocalStorage, mediaStorage } from "@/features/media/storage";
import { createDefaultDocument, type ProfileDocument } from "@/features/profiles/document";
import { getLiveProfile, getPublishedDocument } from "@/features/profiles/public";
import * as svc from "@/features/profiles/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { AppError } from "@/lib/errors";
import { cookieFrom, deleteAccount, signIn, signUp } from "../support/auth-http";
import { resetDatabase, testSql } from "../support/db";
import * as img from "../support/images";
import { TEST_APP_URL, TEST_SETUP_TOKEN } from "../support/test-env";

const PASSWORD = "correct-horse-battery";
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HEADER = { header: { displayName: "Ivy", bio: "" }, seo: { noindex: false } };
const GUESSED = mediaUrl("7c9e6679-7425-40de-944b-e07fc1f90ae7.webp");

let superId = "";
let alice = "";
let bob = "";
let aliceCookie = "";
let profileId = "";
let bobProfileId = "";
let root = "";

const idOf = async (email: string) => ((await testSql()`select id from users where email = ${email}`)[0] as { id: string }).id;
/** The AppError a write was refused with, or null when it succeeded; anything else fails the test. */
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => {
      if (e instanceof AppError) return e;
      throw e;
    },
  );
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
      is_published, draft_updated_at, published_at, updated_at from profiles where id = ${id}`
  )[0];

const processedCache: Partial<Record<MediaKind, ProcessedImage>> = {};
async function processed(kind: MediaKind): Promise<ProcessedImage> {
  if (!processedCache[kind]) {
    const p = path.join(await mkdtemp(path.join(tmpdir(), "covalink-image-src-")), "in.png");
    await writeFile(p, await img.png(kind === "avatar" ? 300 : 1200, kind === "avatar" ? 300 : 700, "#335577"));
    processedCache[kind] = await processImage(p, kind);
    await rm(path.dirname(p), { recursive: true, force: true });
  }
  return processedCache[kind]!;
}
const asset = async (owner: string, kind: MediaKind = "background") => (await media.storeAsset(owner, kind, await processed(kind), `${kind}.png`)).asset;

const keyOf = (url: string) => url.slice("/media/".length);
const keyFile = (key: string) => path.join(root, key.slice(0, 2), key.slice(2, 4), key);
async function list(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

/** An image block as the editor sends it: no version, no dimensions. */
const IMG = (n: number, src: string, extra: Record<string, unknown> = {}, visible = true) => ({
  id: ID(n),
  type: "image",
  visible,
  config: { src, alt: "A red bicycle", decorative: false, caption: "", href: "", aspect: "auto", ...extra },
});
const L = (n: number) => ({ id: ID(n), type: "link", visible: true, config: { title: `Link ${n}`, url: `https://example.com/${n}` } });
const H = (n: number, text: string) => ({ id: ID(n), type: "heading", visible: true, config: { text, size: "md", align: "inherit" } });

const save = (owner: string, id: string, expectedRevision: number, blocks?: unknown[]) =>
  svc.saveDraft(owner, id, { expectedRevision, patch: { ...HEADER, ...(blocks ? { blocks } : {}) } });
const publish = (owner: string, id: string, revision: number, blocks?: unknown[]) =>
  svc.publishProfile(owner, id, { expectedRevision: revision, ...(blocks ? { patch: { ...HEADER, blocks } } : {}) });

/** Writes stored JSON directly (as another version or tool might have). */
async function seed(id: string, draftBlocks: unknown[], publishedBlocks?: unknown[]) {
  const base = createDefaultDocument("Ivy");
  const draft = { ...base, blocks: draftBlocks };
  if (publishedBlocks) {
    await testSql()`update profiles set draft = ${testSql().json(draft)}, published = ${testSql().json({ ...base, blocks: publishedBlocks })},
      draft_revision = 1, published_revision = 1, is_published = true, published_at = now() where id = ${id}`;
  } else {
    await testSql()`update profiles set draft = ${testSql().json(draft)}, draft_revision = 1 where id = ${id}`;
  }
}

/** A stored v2 image block with the given size (as the server would have stamped it). */
const storedImage = (n: number, src: string, width: number, height: number, extra: Record<string, unknown> = {}) => ({
  id: ID(n),
  type: "image",
  version: 2,
  visible: true,
  config: { src, width, height, alt: "A red bicycle", decorative: false, aspect: "auto", ...extra },
});

async function publicHtml(handle: string) {
  const live = await getLiveProfile(handle);
  const doc = live ? await getPublishedDocument(live) : null;
  if (!live || !doc) return null;
  return renderToStaticMarkup(createElement(ProfileView, { document: doc, verified: false, mode: "public", clickTrackingProfileId: live.id }));
}
const previewHtml = (doc: ProfileDocument) => renderToStaticMarkup(createElement(ProfileView, { document: doc, verified: false, mode: "preview" }));
const figures = (html: string) => [...html.matchAll(/<figure[\s\S]*?<\/figure>/g)].map((m) => m[0]);

const req = (p: string, method = "GET") => new Request(`${TEST_APP_URL}${p}`, { method, headers: { "user-agent": BROWSER } });
const go = (pid: string, bid: string, method = "GET") => handleClick(req(`/go/${pid}/${bid}`, method), pid, bid);
const shape = async (res: Response) => ({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() });

/** Every canonical reference in every stored document has a live `media_assets` row. */
async function danglingReferences(): Promise<string[]> {
  const docs = await testSql()`select draft, published from profiles`;
  const keys = new Set((await testSql()`select storage_key from media_assets`).map((r) => r.storage_key as string));
  return [...referencedKeys(...docs.flatMap((d) => [d.draft, d.published]))].filter((k) => !keys.has(k));
}

beforeEach(async () => {
  await resetDatabase();
  root = await (mediaStorage() as LocalStorage).root();
  for (const entry of await list(root)) await rm(path.join(root, entry), { recursive: true, force: true });
  ({ userId: superId } = await bootstrapSuperAdmin({ token: TEST_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: PASSWORD }));
  for (const email of ["alice@example.com", "bob@example.com"]) expect((await signUp(email)).status).toBe(200);
  [alice, bob] = await Promise.all(["alice@example.com", "bob@example.com"].map(idOf));
  aliceCookie = cookieFrom(await signIn("alice@example.com"));
  profileId = (await svc.createProfile(alice, { handle: "ivy", label: "ivy", displayName: "Ivy" })).id;
  bobProfileId = (await svc.createProfile(bob, { handle: "bob", label: "bob", displayName: "Bob" })).id;
});

describe("save, publish and render", () => {
  it("stamps the asset's stored size, keeps drafts private until publish, and every operation persists", async () => {
    const a = await asset(alice);
    const b = await asset(alice);
    expect([a.width, a.height]).toEqual([1200, 700]);

    const saved = await save(alice, profileId, 0, [IMG(1, a.url, { caption: "Summer", href: "shop.example.com" }), L(2)]);
    expect(saved.blocks[0]).toMatchObject({ type: "image", version: 2, config: { width: 1200, height: 700, href: "https://shop.example.com/" } });
    const stored = (await row(profileId)).draft.blocks[0];
    expect(stored).toEqual({
      id: ID(1),
      type: "image",
      version: 2,
      visible: true,
      config: { src: a.url, width: a.width, height: a.height, alt: "A red bicycle", decorative: false, caption: "Summer", href: "https://shop.example.com/", aspect: "auto" },
    });
    const [assetRow] = await testSql()`select width, height, kind from media_assets where storage_key = ${keyOf(a.url)}`;
    expect([stored.config.width, stored.config.height, assetRow.kind]).toEqual([assetRow.width, assetRow.height, "background"]);
    expect(await publicHtml("ivy")).toBeNull(); // never published

    await publish(alice, profileId, 1);
    expect(figures((await publicHtml("ivy"))!)).toHaveLength(1);

    // Edit (another image, decorative), duplicate, hide, reorder: private until published, then all persist.
    const editor = toEditorItems((await svc.getOwnedProfile(alice, profileId)).draft.blocks);
    const input = toBlockInput(editor) as ReturnType<typeof IMG>[];
    const edited = [
      L(2),
      IMG(1, b.url, { alt: "", decorative: true, caption: "", href: "", aspect: "wide" }),
      { ...input[0], id: ID(3), visible: false },
    ];
    await save(alice, profileId, 1, edited);
    const html = (await publicHtml("ivy"))!;
    expect(html).toContain(`src="${a.url}"`);
    expect(html).not.toContain(b.url);

    await publish(alice, profileId, 2);
    const reloaded = await svc.getOwnedProfile(alice, profileId);
    expect(reloaded.draft.blocks.map((x) => [x.id, x.type, x.visible])).toEqual([
      [ID(2), "link", true],
      [ID(1), "image", true],
      [ID(3), "image", false],
    ]);
    expect(reloaded.draft.blocks[1].config).toMatchObject({ src: b.url, width: b.width, height: b.height, alt: "", decorative: true, aspect: "wide" });
    const pub = (await publicHtml("ivy"))!;
    expect(figures(pub)).toEqual([`<figure class="pp-figure" data-aspect="wide"><img class="pp-image" src="${b.url}" alt="" width="1200" height="700" loading="lazy" decoding="async"/></figure>`]);

    // Delete the images.
    await save(alice, profileId, 2, [L(2)]);
    await publish(alice, profileId, 3);
    expect(figures((await publicHtml("ivy"))!)).toEqual([]);
  });

  it("preview and public rendering agree apart from the link target", async () => {
    const a = await asset(alice);
    await publish(alice, profileId, 0, [IMG(1, a.url, { caption: "Ride", href: "https://shop.example.com/bike", aspect: "square" })]);
    const owned = await svc.getOwnedProfile(alice, profileId);
    const pub = figures((await publicHtml("ivy"))!);
    const pre = figures(previewHtml(owned.draft));
    expect(pub[0]).toContain(`href="/go/${profileId}/${ID(1)}" rel="noopener nofollow ugc"`);
    expect(pre[0]).toContain(`href="https://shop.example.com/bike" target="_blank" rel="noopener noreferrer nofollow ugc"`);
    const strip = (s: string) => s.replace(/ href="[^"]*"( target="_blank")? rel="[^"]*"/, "");
    expect(strip(pre[0])).toBe(strip(pub[0]));
    expect(strip(pub[0])).toBe(
      `<figure class="pp-figure" data-aspect="square"><a class="pp-image-link"><img class="pp-image" src="${a.url}" alt="A red bicycle" width="1200" height="700" loading="lazy" decoding="async"/></a><figcaption class="pp-caption">Ride</figcaption></figure>`,
    );
  });
});

describe("refused writes are atomic", () => {
  it("refuses every invalid image on save and on publish, leaving the stored row byte-identical", async () => {
    const a = await asset(alice);
    const avatar = await asset(alice, "avatar");
    const bobs = await asset(bob);
    await publish(alice, profileId, 0, [IMG(1, a.url), L(2)]);
    const before = await rawRow(profileId);

    const notInLibrary = { src: [IMAGE_NOT_IN_LIBRARY] };
    const cases: [string, unknown, Record<string, string[]> | null, string | null][] = [
      ["another user's image", IMG(1, bobs.url), notInLibrary, null],
      ["a missing image", IMG(1, GUESSED), notInLibrary, null],
      ["an avatar", IMG(1, avatar.url), { src: ["Choose one of your uploaded images here. Avatars can't be used in image blocks."] }, null],
      ["an external source", IMG(1, "https://images.example.com/a.png"), { src: ["Choose or upload an image"] }, null],
      ["an absolute own-origin source", IMG(1, `${TEST_APP_URL}${a.url}`), { src: ["Choose or upload an image"] }, null],
      ["an encoded source", IMG(1, a.url.replace("/media/", "/media/%2e/")), { src: ["Choose or upload an image"] }, null],
      ["missing alt text", IMG(1, a.url, { alt: " " }), { alt: ["Describe the image, or mark it as decorative"] }, null],
      ["decorative with alt text", IMG(1, a.url, { decorative: true }), { alt: ["Leave the description empty for a decorative image"] }, null],
      ["decorative with a link", IMG(1, a.url, { alt: "", decorative: true, href: "https://example.com" }), { href: ["A decorative image can't be a link. Add a description instead."] }, null],
      ["an unknown key", IMG(1, a.url, { focal: 0.5 }), null, "This block has fields that aren't supported."],
      ["an injected width", IMG(1, a.url, { width: 1 }), null, "This block has fields that aren't supported."],
      ["an injected height", IMG(1, a.url, { height: 2048 }), null, "This block has fields that aren't supported."],
      ["injected dimensions", IMG(1, a.url, { width: a.width, height: a.height }), null, "This block has fields that aren't supported."],
      ["an injected version", { ...IMG(1, a.url), version: 2 }, null, "This block is malformed."],
    ];
    const errors: Record<string, unknown> = {};
    for (const [label, block, fields, message] of cases) {
      for (const [op, write] of [
        ["save", () => save(alice, profileId, 1, [block, L(2)])],
        ["publish", () => publish(alice, profileId, 1, [block, L(2)])],
      ] as const) {
        const err = await failure(write());
        expect(err?.code, `${label} (${op})`).toBe("VALIDATION");
        const item = err?.blockErrors?.items[0];
        expect(item?.index, `${label} (${op})`).toBe(0);
        if (fields) expect(item?.fields, `${label} (${op})`).toEqual(fields);
        if (message) expect(item?.message, `${label} (${op})`).toBe(message);
        expect(await rawRow(profileId), `${label} (${op})`).toEqual(before);
        errors[`${label} ${op}`] = { message: err?.message, fieldErrors: err?.fieldErrors, blockErrors: err?.blockErrors };
      }
    }
    // Another user's image and a missing one are indistinguishable.
    expect(errors["another user's image save"]).toEqual(errors["a missing image save"]);
    expect(errors["another user's image publish"]).toEqual(errors["a missing image publish"]);
  });

  it("publishing checks every stored reference: another user's image, the wrong kind or a size that doesn't match", async () => {
    const a = await asset(alice);
    const avatar = await asset(alice, "avatar");
    const bobs = await asset(bob);
    for (const [label, block] of [
      ["another user's image", storedImage(1, bobs.url, bobs.width, bobs.height)],
      ["a missing image", storedImage(1, GUESSED, 1200, 700)],
      ["an avatar", storedImage(1, avatar.url, avatar.width, avatar.height)],
      ["a tampered width", storedImage(1, a.url, a.width - 1, a.height)],
      ["a tampered height", storedImage(1, a.url, a.width, 2048)],
    ] as const) {
      await seed(profileId, [block]);
      const before = await rawRow(profileId);
      const err = await failure(publish(alice, profileId, 1));
      expect(err?.message, label).toBe("This profile refers to uploaded images that aren't in your library.");
      expect(await rawRow(profileId), label).toEqual(before);
    }
    await seed(profileId, [storedImage(1, a.url, a.width, a.height)]);
    await publish(alice, profileId, 1);
    expect((await row(profileId)).published?.blocks[0].config).toMatchObject({ src: a.url });
  });

  it("a header-only save keeps untouched stored blocks verbatim; a block save checks every reference in the blocks it submits", async () => {
    const bobs = await asset(bob);
    const block = storedImage(1, bobs.url, bobs.width, bobs.height);
    await seed(profileId, [block, { ...L(2), version: 2 }]);
    await save(alice, profileId, 1); // header only: blocks untouched (checked at publish)
    expect((await row(profileId)).draft.blocks[0]).toEqual(block);
    const before = await rawRow(profileId);

    const editor = toBlockInput(toEditorItems((await svc.getOwnedProfile(alice, profileId)).draft.blocks));
    expect((await failure(save(alice, profileId, 2, editor)))?.blockErrors?.items[0]).toMatchObject({ index: 0, fields: { src: [IMAGE_NOT_IN_LIBRARY] } });
    // Not only image sources: any canonical reference inside a submitted block counts.
    expect((await failure(save(alice, profileId, 2, [H(3, bobs.url)])))?.message).toBe("This profile refers to uploaded images that aren't in your library.");
    expect((await failure(save(alice, profileId, 2, [H(3, GUESSED)])))?.message).toBe("This profile refers to uploaded images that aren't in your library.");
    expect(await rawRow(profileId)).toEqual(before);
    expect((await failure(publish(alice, profileId, 2)))?.code).toBe("VALIDATION");
  });

  it("v1 image blocks are legacy: the draft is protected, its JSON preserved, nothing rendered or redirected", async () => {
    const a = await asset(alice);
    const legacy = [
      { id: ID(1), type: "image", version: 1, visible: true, config: { src: "https://images.example.com/a.png", alt: "Old", href: "https://example.com" } },
      { id: ID(2), type: "image", version: 1, visible: true, config: { src: a.url, width: a.width, height: a.height, alt: "Shaped like v2", decorative: false, aspect: "auto", href: "https://example.com" } },
    ];
    await seed(profileId, [...legacy, { ...L(3), version: 2 }], [legacy[1], { ...L(3), version: 2 }]);
    const owned = await svc.getOwnedProfile(alice, profileId);
    expect(owned.protectedBlocks).toBe(2);
    expect(owned.draft.blocks.map((b) => b.type)).toEqual(["link"]);
    const before = await rawRow(profileId);
    for (const write of [() => save(alice, profileId, 1), () => save(alice, profileId, 1, [L(3)]), () => publish(alice, profileId, 1), () => publish(alice, profileId, 1, [L(3)])]) {
      expect((await failure(write()))?.message).toMatch(/can't edit without losing data/);
    }
    expect(await rawRow(profileId)).toEqual(before);
    expect(JSON.parse(before.draft as string).blocks.slice(0, 2)).toEqual(legacy);
    const html = (await publicHtml("ivy"))!;
    expect(figures(html)).toEqual([]);
    expect(html).toContain("Link 3");
    expect((await go(profileId, ID(2))).status).toBe(404);
    // Its image is still referenced, so it can't be deleted.
    expect((await failure(media.deleteMedia(alice, a.id)))?.message).toMatch(/still used by \/ivy/);
    // Discarding restores the published snapshot (which still holds the legacy block, so the draft stays protected).
    await svc.revertDraft(alice, profileId, { expectedRevision: 1 });
    expect((await svc.getOwnedProfile(alice, profileId)).protectedBlocks).toBe(1);
  });
});

describe("media lifecycle", () => {
  it("an image used by an image block can't be deleted from a draft or a published page", async () => {
    const a = await asset(alice);
    await save(alice, profileId, 0, [IMG(1, a.url)]);
    expect((await failure(media.deleteMedia(alice, a.id)))?.message).toMatch(/still used by \/ivy/);
    await publish(alice, profileId, 1);
    await save(alice, profileId, 1, [L(2)]); // the draft drops it; the published page still uses it
    expect((await failure(media.deleteMedia(alice, a.id)))?.message).toMatch(/still used by \/ivy/);
    expect((await media.listMedia(alice)).assets[0].usedBy).toEqual([{ profileId, handle: "ivy", draft: false, published: true }]);
    await publish(alice, profileId, 2);
    await media.deleteMedia(alice, a.id);
    await expect(lstat(keyFile(keyOf(a.url)))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("media:gc never removes an image a block uses; account deletion removes it", async () => {
    const a = await asset(alice);
    await publish(alice, profileId, 0, [IMG(1, a.url)]);
    const old = new Date(Date.now() - 48 * 3_600_000);
    await utimes(keyFile(keyOf(a.url)), old, old);
    const gc = spawnSync(process.execPath, ["scripts/media-gc.mjs", "--apply", "--min-age-hours=24"], {
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, STORAGE_LOCAL_PATH: root, NODE_ENV: "test" },
      encoding: "utf8",
    });
    expect(gc.status).toBe(0);
    expect(gc.stdout).toContain("deleted: 0");
    expect((await lstat(keyFile(keyOf(a.url)))).isFile()).toBe(true);

    await deleteAccount(aliceCookie, PASSWORD);
    expect(await testSql()`select 1 from media_assets where owner_id = ${alice}`).toHaveLength(0);
    await expect(lstat(keyFile(keyOf(a.url)))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

/**
 * Deterministic ordering of a profile write and a deletion. A
 * test-only trigger in the guarded test database makes one side wait on an
 * advisory lock the test holds, while that side's transaction already holds
 * its row locks; the test starts the other side, checks it is waiting on a
 * row lock, then releases the first.
 */
describe("deletion versus save and publish", () => {
  const GATE = 7_110_011;
  const until = async (label: string, check: () => Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const waitingOnGate = async () =>
    Number((await testSql()`select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = ${GATE} and not granted`)[0].n) > 0;
  const waitingOnRow = async () =>
    Number((await testSql()`select count(*)::int as n from pg_locks where locktype <> 'advisory' and not granted`)[0].n) > 0;

  async function ordered(table: "profiles" | "media_assets", event: "update" | "delete", first: () => Promise<unknown>, second: () => Promise<unknown>) {
    const gate = await testSql().reserve();
    await gate`select pg_advisory_lock(${GATE})`;
    await testSql().unsafe(
      `create or replace function image_test_gate() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(${GATE}); return coalesce(new, old); end $$`,
    );
    await testSql().unsafe(`create trigger image_test_gate before ${event} on ${table} for each row execute function image_test_gate()`);
    try {
      const a = first().then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
      await until("the first operation to hold its locks", waitingOnGate);
      const b = second().then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
      await until("the second operation to wait on a row lock", waitingOnRow);
      await gate`select pg_advisory_unlock(${GATE})`;
      return [await a, await b] as const;
    } finally {
      await gate`select pg_advisory_unlock_all()`;
      gate.release();
      await testSql().unsafe(`drop trigger if exists image_test_gate on ${table}`);
      await testSql().unsafe(`drop function if exists image_test_gate()`);
    }
  }

  for (const op of ["save", "publish"] as const) {
    const write = (src: string) => (op === "save" ? save(alice, profileId, 0, [IMG(1, src)]) : publish(alice, profileId, 0, [IMG(1, src)]));

    it(`${op} first: the deletion waits for the commit, then is refused`, async () => {
      const a = await asset(alice);
      const [w, d] = await ordered("profiles", "update", () => write(a.url), () => media.deleteMedia(alice, a.id));
      expect(w.ok).toBe(true);
      expect(!d.ok && d.e instanceof AppError && d.e.message).toMatch(/still used by \/ivy/);
      expect(await testSql()`select 1 from media_assets where id = ${a.id}`).toHaveLength(1);
      expect((await row(profileId)).draft.blocks[0].config.src).toBe(a.url);
      expect(await danglingReferences()).toEqual([]);
    });

    it(`deletion first: the ${op} waits for the commit, then is refused and changes nothing`, async () => {
      const a = await asset(alice);
      const before = await rawRow(profileId);
      const [d, w] = await ordered("media_assets", "delete", () => media.deleteMedia(alice, a.id), () => write(a.url));
      expect(d.ok).toBe(true);
      expect(!w.ok && w.e instanceof AppError && w.e.blockErrors?.items[0]?.fields).toEqual({ src: [IMAGE_NOT_IN_LIBRARY] });
      expect(await testSql()`select 1 from media_assets where id = ${a.id}`).toHaveLength(0);
      expect(await rawRow(profileId)).toEqual(before);
      expect(await danglingReferences()).toEqual([]);
    });
  }

  it("leaves no test trigger behind", async () => {
    expect(await testSql()`select 1 from pg_trigger where tgname = 'image_test_gate'`).toHaveLength(0);
    expect(await testSql()`select 1 from pg_proc where proname = 'image_test_gate'`).toHaveLength(0);
  });
});

describe("linked image /go", () => {
  let a = { url: "", width: 0, height: 0 };
  beforeEach(async () => {
    a = await asset(alice);
    const b = await asset(bob);
    await publish(alice, profileId, 0, [
      IMG(1, a.url, { href: "https://shop.example.com/bike" }),
      IMG(2, a.url),
      IMG(3, a.url, { alt: "", decorative: true }),
      IMG(4, a.url, { href: "https://shop.example.com/hidden" }, false),
      L(5),
    ]);
    await publish(bob, bobProfileId, 0, [IMG(9, b.url, { href: "https://bob.example.com" })]);
  });

  it("redirects a GET to the stored destination and records one click per GET against the block", async () => {
    const res = await go(profileId, ID(1));
    expect(res.status).toBe(302);
    expect(Object.fromEntries(res.headers)).toEqual({ location: "https://shop.example.com/bike", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" });
    expect(res.headers.getSetCookie()).toEqual([]);
    await go(profileId, ID(1));
    expect(await clickBlocks()).toEqual([ID(1), ID(1)]);
    const stats = await getProfileAnalytics(alice, profileId, { range: "7" });
    expect(stats.topLinks).toEqual([{ blockId: ID(1), title: "Image: A red bicycle", hidden: false, clicks: 2 }]);
    // Link blocks are unchanged.
    expect((await go(profileId, ID(5))).headers.get("location")).toBe("https://example.com/5");
  });

  it("validates HEAD identically but never records it", async () => {
    const head = await go(profileId, ID(1), "HEAD");
    const get = await go(profileId, ID(1));
    expect(Object.fromEntries(head.headers)).toEqual(Object.fromEntries(get.headers));
    expect(head.status).toBe(302);
    for (let i = 0; i < 3; i++) await go(profileId, ID(1), "HEAD");
    expect(await clickBlocks()).toEqual([ID(1)]);
  });

  it("answers the same 404 for every refused case and records nothing", async () => {
    // Draft-only: saved, not published.
    await save(alice, profileId, 1, [IMG(1, a.url, { href: "https://shop.example.com/bike" }), IMG(6, a.url, { href: "https://draft.example.com" })]);
    const reference = await shape(await go(profileId, ID(99)));
    expect(reference).toMatchObject({ status: 404, body: "Not found" });
    const cases: [string, string, string][] = [
      ["unlinked image", profileId, ID(2)],
      ["decorative image", profileId, ID(3)],
      ["hidden linked image", profileId, ID(4)],
      ["draft-only linked image", profileId, ID(6)],
      ["another profile's image", profileId, ID(9)],
      ["own image via another profile", bobProfileId, ID(1)],
      ["malformed ids", "x", "y"],
      ["upper-case block id", profileId, ID(1).toUpperCase().replace("0000", "000A")],
    ];
    for (const [label, pid, bid] of cases) {
      expect(await shape(await go(pid, bid)), label).toEqual(reference);
      expect((await go(pid, bid, "HEAD")).status, `${label} (HEAD)`).toBe(404);
    }
    expect(await eventCount()).toBe(0);
  });

  it("follows the current published snapshot: stale, legacy, tampered, unpublished and banned-owner cases are 404", async () => {
    await publish(alice, profileId, 1, [L(5)]); // the image is no longer published
    expect((await go(profileId, ID(1))).status).toBe(404);

    const legacy = { id: ID(7), type: "image", version: 1, visible: true, config: { src: a.url, alt: "Old", href: "https://example.com" } };
    await seed(profileId, [{ ...L(5), version: 2 }], [legacy, storedImage(8, a.url, a.width, a.height, { href: "https://ok.example.com/" })]);
    expect((await go(profileId, ID(7))).status).toBe(404);
    expect((await go(profileId, ID(8))).headers.get("location")).toBe("https://ok.example.com/");
    for (const href of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "https://u:p@ex ample.com"]) {
      await testSql()`update profiles set published = jsonb_set(published, '{blocks,1,config,href}', ${testSql().json(href)}) where id = ${profileId}`;
      expect((await go(profileId, ID(8))).status, href).toBe(404);
    }
    await testSql()`update profiles set published = jsonb_set(published, '{blocks,1,config}', ${testSql().json({ ...storedImage(8, a.url, a.width, a.height).config, alt: "", decorative: true, href: "https://ok.example.com/" })}) where id = ${profileId}`;
    expect((await go(profileId, ID(8))).status).toBe(404);

    expect((await go(bobProfileId, ID(9))).status).toBe(302);
    await setUserBanned(superId, bob, true);
    expect((await go(bobProfileId, ID(9))).status).toBe(404);
    await svc.unpublishProfile(alice, profileId);
    expect((await go(profileId, ID(8))).status).toBe(404);
    expect(await clickBlocks()).toEqual([ID(8), ID(9)]);
  });
});
