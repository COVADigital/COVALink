import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Video and music blocks against the guarded test database: the persistence matrix, atomic refused writes on save and publish,
 * legacy v1 protection, draft privacy, tenant isolation and `/go` refusal.
 */
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
}));

import { toBlockInput, toEditorItems } from "@/components/editor/block-items";
import { ProfileView } from "@/components/profile/profile-view";
import { handleClick, handleSocialClick } from "@/features/analytics/click";
import { createDefaultDocument } from "@/features/profiles/document";
import { getLiveProfile, getPublishedDocument } from "@/features/profiles/public";
import * as svc from "@/features/profiles/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { AppError } from "@/lib/errors";
import { signUp } from "../support/auth-http";
import { resetDatabase, testSql } from "../support/db";
import { TEST_APP_URL, TEST_SETUP_TOKEN } from "../support/test-env";

const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const header = { header: { displayName: "Ana", bio: "" }, seo: { noindex: false } };
const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const SPOTIFY = "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC";

let alice = "";
let bob = "";
let profileId = "";
let bobProfileId = "";

const idOf = async (email: string) => ((await testSql()`select id from users where email = ${email}`)[0] as { id: string }).id;
const eventCount = async () => Number((await testSql()`select count(*)::int as n from analytics_events`)[0].n);

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

const V = (n: number, url = YT, extra: object = {}) => ({ id: ID(n), type: "video", visible: true, config: { url, title: "", ...extra } });
const M = (n: number, url = SPOTIFY, extra: object = {}) => ({ id: ID(n), type: "music", visible: true, config: { url, title: "", ...extra } });

const save = (owner: string, id: string, expectedRevision: number, blocks?: unknown[]) =>
  svc.saveDraft(owner, id, { expectedRevision, patch: { ...header, ...(blocks ? { blocks } : {}) } });
const publish = (owner: string, id: string, revision: number, blocks?: unknown[]) =>
  svc.publishProfile(owner, id, { expectedRevision: revision, ...(blocks ? { patch: { ...header, blocks } } : {}) });
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => {
      if (e instanceof AppError) return e;
      throw e;
    },
  );

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

async function publicHtml(handle: string) {
  const live = await getLiveProfile(handle);
  const doc = live ? await getPublishedDocument(live) : null;
  if (!live || !doc) return null;
  return renderToStaticMarkup(createElement(ProfileView, { document: doc, verified: false, mode: "public", clickTrackingProfileId: live.id }));
}
const blockTypes = (html: string) => [...html.matchAll(/data-block-type="([^"]+)"/g)].map((m) => m[1]);

beforeEach(async () => {
  await resetDatabase();
  await bootstrapSuperAdmin({ token: TEST_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: "correct-horse-battery" });
  for (const email of ["alice@example.com", "bob@example.com"]) expect((await signUp(email)).status).toBe(200);
  [alice, bob] = await Promise.all(["alice@example.com", "bob@example.com"].map(idOf));
  profileId = (await svc.createProfile(alice, { handle: "ana", label: "ana", displayName: "Ana" })).id;
  bobProfileId = (await svc.createProfile(bob, { handle: "bob", label: "bob", displayName: "Bob" })).id;
});

describe("edit, publish and discard", () => {
  it("creates, canonicalizes, hides, duplicates, reorders, deletes, publishes and discards", async () => {
    // Create: every accepted form is stored canonically, with the server's version.
    let r = await save(alice, profileId, 0, [
      V(1, "https://youtu.be/dQw4w9WgXcQ?si=abc", { title: "  My video  " }),
      V(2, "https://player.vimeo.com/video/76979871?dnt=1"),
      M(3, "https://open.spotify.com/intl-de/embed/album/4aawyAB9vmqN3uQ7FjRGTy?si=x"),
      M(4, "https://m.soundcloud.com/forss/sets/soulhack", { title: "A set" }),
    ]);
    let draft = (await row(profileId)).draft.blocks;
    expect(draft.map((b) => [b.type, b.version, b.config.url, b.config.title])).toEqual([
      ["video", 2, YT, "My video"],
      ["video", 2, "https://vimeo.com/76979871", undefined],
      ["music", 2, "https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy", undefined],
      ["music", 2, "https://soundcloud.com/forss/sets/soulhack", "A set"],
    ]);

    // Draft privacy: nothing is public yet.
    expect(await publicHtml("ana")).toBeNull();

    // What the editor sends back reads and saves unchanged, surviving a reload.
    const reloaded = await svc.getOwnedProfile(alice, profileId);
    expect(reloaded.protectedBlocks).toBe(0);
    const again = toBlockInput(toEditorItems(reloaded.draft.blocks));
    r = await save(alice, profileId, r.revision, again);
    expect((await row(profileId)).draft.blocks).toEqual(draft);

    // Hide, duplicate (a new id), reorder and delete.
    const [v1, v2, m3, m4] = again;
    r = await save(alice, profileId, r.revision, [m4, { ...v1, visible: false }, { ...v1, id: ID(5) }, m3]);
    draft = (await row(profileId)).draft.blocks;
    expect(draft.map((b) => [b.id, b.visible])).toEqual([[ID(4), true], [ID(1), false], [ID(5), true], [ID(3), true]]);
    expect(v2.id).toBe(ID(2));

    // Publish: the hidden block stays off the page; order holds.
    const p = await publish(alice, profileId, r.revision);
    const html = (await publicHtml("ana"))!;
    expect(blockTypes(html)).toEqual(["music", "video", "music"]);
    expect(html).toContain('aria-label="A set"');
    expect(html).not.toMatch(/<iframe/i);

    // A later draft stays private, and discarding restores the published blocks.
    const edited = await save(alice, profileId, p.revision, [V(6, YT, { title: "Unpublished" })]);
    expect(await publicHtml("ana")).not.toContain("Unpublished");
    await svc.revertDraft(alice, profileId, { expectedRevision: edited.revision });
    expect((await row(profileId)).draft.blocks.map((b) => b.id)).toEqual([ID(4), ID(1), ID(5), ID(3)]);
  });
});

describe("refused writes", () => {
  const BAD: [string, unknown][] = [
    ["a host suffix", V(1, "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ")],
    ["http:", V(1, "http://www.youtube.com/watch?v=dQw4w9WgXcQ")],
    ["credentials", V(1, "https://user@www.youtube.com/watch?v=dQw4w9WgXcQ")],
    ["a port", V(1, "https://www.youtube.com:443/watch?v=dQw4w9WgXcQ")],
    ["javascript:", V(1, "javascript:alert(1)")],
    ["a pasted iframe", V(1, '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>')],
    ["an unlisted Vimeo link", V(1, "https://vimeo.com/76979871/abcdef")],
    ["a repeated v", V(1, "https://www.youtube.com/watch?v=dQw4w9WgXcQ&v=aaaaaaaaaaa")],
    ["a music link in a video block", V(1, SPOTIFY)],
    ["a video link in a music block", M(1, YT)],
    ["a shortener", M(1, "https://on.soundcloud.com/abc")],
    ["a SoundCloud user page", M(1, "https://soundcloud.com/forss")],
    ["an unknown config key", V(1, YT, { html: "<b>" })],
    ["a client version inside the config", V(1, YT, { version: 2 })],
    ["a client version on the block", { ...V(1), version: 2 }],
    ["a control character in the title", V(1, YT, { title: "a b" })],
    ["an over-long title", V(1, YT, { title: "a".repeat(101) })],
    ["a preserve reference", { id: ID(1), preserve: true }],
  ];

  it.each(BAD)("refuses %s atomically on save and save-and-publish", async (_label, block) => {
    const p = await publish(alice, profileId, 0, [V(9)]);
    const before = await rawRow(profileId);
    for (const write of [() => save(alice, profileId, p.revision, [block]), () => publish(alice, profileId, p.revision, [block])]) {
      const err = await failure(write());
      expect(err?.code).toBe("VALIDATION");
      expect(err?.blockErrors?.items).toHaveLength(1);
    }
    expect(await rawRow(profileId)).toEqual(before);
  });

  it("reports the problem on the field, in the owner's terms", async () => {
    const err = await failure(save(alice, profileId, 0, [V(1, SPOTIFY)]));
    expect(err?.blockErrors).toEqual({ list: [], items: [{ index: 0, id: ID(1), fields: { url: ["That's a Spotify link. Use a Music block for it."] } }] });
  });
});

describe("legacy v1 blocks", () => {
  const v1 = (n: number, type: string, config: object, extra: object = {}) => ({ id: ID(n), type, version: 1, visible: true, config, ...extra });

  it("a valid v1 block in a published snapshot shows without a republish, and is canonicalized on its next save", async () => {
    await seed(profileId, [v1(1, "video", { url: "https://youtu.be/dQw4w9WgXcQ" })], [v1(1, "video", { url: "https://youtu.be/dQw4w9WgXcQ" })]);
    const html = (await publicHtml("ana"))!;
    expect(blockTypes(html)).toEqual(["video"]);
    expect(html).toContain(`href="${YT}"`);
    expect(html).not.toMatch(/<iframe/i);

    const owned = await svc.getOwnedProfile(alice, profileId);
    expect(owned.protectedBlocks).toBe(0);
    expect(owned.draft.blocks[0]).toMatchObject({ version: 2, config: { url: YT } });
    await save(alice, profileId, 1); // A header save keeps it exactly.
    expect((await row(profileId)).draft.blocks[0]).toEqual(v1(1, "video", { url: "https://youtu.be/dQw4w9WgXcQ" }));
    await save(alice, profileId, 2, toBlockInput(toEditorItems(owned.draft.blocks)));
    expect((await row(profileId)).draft.blocks[0]).toEqual({ id: ID(1), type: "video", version: 2, visible: true, config: { url: YT } });
  });

  it.each([
    ["http:", v1(1, "video", { url: "http://www.youtube.com/watch?v=dQw4w9WgXcQ" })],
    ["a loose path", v1(1, "video", { url: "https://www.youtube.com/embed/dQw4w9WgXcQ/extra" })],
    ["a SoundCloud user page", v1(1, "music", { url: "https://soundcloud.com/forss" })],
    ["a Vimeo hash", v1(1, "video", { url: "https://vimeo.com/76979871/abcdef" })],
    ["an unknown key", v1(1, "video", { url: YT, startAt: 42 })],
    ["a control character", v1(1, "video", { url: YT, title: "a\tb" })],
  ])("an invalid v1 block (%s) protects its draft, keeps its JSON and stays off the page", async (_label, stored) => {
    await seed(profileId, [stored, { id: ID(2), type: "link", version: 2, visible: true, config: { title: "Shop", url: "https://shop.example.com/" } }], [stored]);
    expect((await svc.getOwnedProfile(alice, profileId)).protectedBlocks).toBe(1);
    expect(blockTypes((await publicHtml("ana"))!)).toEqual([]);

    const before = await rawRow(profileId);
    for (const write of [() => save(alice, profileId, 1), () => save(alice, profileId, 1, [V(3)]), () => publish(alice, profileId, 1), () => publish(alice, profileId, 1, [V(3)])]) {
      expect((await failure(write()))?.message).toMatch(/can't edit without losing data/);
    }
    expect(await rawRow(profileId)).toEqual(before);
  });
});

describe("tenant isolation and /go", () => {
  it("another owner can't read or write the blocks", async () => {
    await save(alice, profileId, 0, [V(1)]);
    const before = await rawRow(profileId);
    expect((await failure(save(bob, profileId, 1, [V(2)])))?.code).toBe("NOT_FOUND");
    expect((await failure(publish(bob, profileId, 1, [V(2)])))?.code).toBe("NOT_FOUND");
    expect((await failure(svc.getOwnedProfile(bob, profileId)))?.code).toBe("NOT_FOUND");
    expect(await rawRow(profileId)).toEqual(before);
    expect((await row(bobProfileId)).draft.blocks).toEqual([]);
  });

  it("/go answers 404 for published video and music blocks, on GET and HEAD, and records nothing", async () => {
    await publish(alice, profileId, 0, [V(1), M(2)]);
    const request = (path: string, method: string) => new Request(`${TEST_APP_URL}${path}`, { method, headers: { "user-agent": BROWSER } });
    for (const method of ["GET", "HEAD"]) {
      for (const id of [ID(1), ID(2)]) {
        expect((await handleClick(request(`/go/${profileId}/${id}`, method), profileId, id)).status).toBe(404);
        expect((await handleSocialClick(request(`/go/${profileId}/${id}/0`, method), profileId, id, "0")).status).toBe(404);
      }
    }
    expect(await eventCount()).toBe(0);
  });
});
