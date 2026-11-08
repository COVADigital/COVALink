import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Content blocks against the real database: the block-list contract,
 * ordering, compatibility with stored (unrecognized, v1, unreadable) blocks,
 * publication isolation, concurrency and authorization. Server Actions are
 * exercised with a mocked session, as in profile-actions.test.ts.
 */
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
}));
const session = vi.hoisted(() => ({ user: null as null | { id: string; name: string; email: string; emailVerified: boolean; role: "user" } }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => session.user }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));

import { toBlockInput, toEditorItems } from "@/components/editor/block-items";
import { ProfileView } from "@/components/profile/profile-view";
import { MAX_BLOCKS } from "@/features/blocks/input";
import * as actions from "@/features/profiles/actions";
import { createDefaultDocument } from "@/features/profiles/document";
import { getLiveProfile, getPublishedDocument } from "@/features/profiles/public";
import * as svc from "@/features/profiles/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { AppError } from "@/lib/errors";
import { signUp } from "../support/auth-http";
import { resetDatabase, testSql } from "../support/db";
import { TEST_SETUP_TOKEN } from "../support/test-env";

let alice: string;
let bob: string;

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const idOf = async (email: string) => ((await testSql()`select id from users where email = ${email}`)[0] as { id: string }).id;
const header = { header: { displayName: "Alice", bio: "" }, seo: { noindex: false } };

type StoredBlock = { id: string; type: string; version: number; visible: boolean; config: Record<string, unknown> };
type Row = {
  is_published: boolean;
  draft_revision: number;
  published_revision: number | null;
  draft: { blocks: StoredBlock[]; header: { displayName: string } };
  published: { blocks: StoredBlock[] } | null;
};
const row = async (id: string) =>
  (await testSql()`select is_published, draft_revision, published_revision, draft, published from profiles where id = ${id}`)[0] as Row;
const order = (blocks: { id: string }[] | undefined) => (blocks ?? []).map((b) => b.id);

const L = (n: number, title = `Link ${n}`) => ({ id: ID(n), type: "link", visible: true, config: { title, url: `https://example.com/${n}` } });
const H = (n: number, text = `Heading ${n}`) => ({ id: ID(n), type: "heading", visible: true, config: { text, size: "md", align: "inherit" } });
const T = (n: number, markdown = `Text ${n}`) => ({ id: ID(n), type: "text", visible: true, config: { markdown, align: "inherit" } });
const D = (n: number) => ({ id: ID(n), type: "divider", visible: true, config: { style: "line" } });

/** Valid stored v1 blocks, which read as v2. */
const VIDEO = { id: ID(90), type: "video", version: 1, visible: true, config: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } };
const MUSIC = { id: ID(91), type: "music", version: 1, visible: true, config: { url: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC" } };
const LINK_V1 = {
  id: ID(80),
  type: "link",
  version: 1,
  visible: true,
  config: { title: "Legacy", url: "https://legacy.example.com/", description: "Old link", icon: "star", thumbnailUrl: "https://img.example.com/t.png", featured: true },
};
const UNREADABLE = { id: ID(70), type: "future-widget", version: 1, visible: true, config: { x: 1 } };
/** A block with an unknown config key and extra envelope keys, which the editor can't carry. */
const VIDEO_EXTRA = {
  id: ID(93),
  type: "video",
  version: 1,
  visible: true,
  pinned: true,
  note: "keep me",
  config: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", startAt: 42, title: "  spaced  " },
};
/** A block with an unknown nested key, which the editor can't carry. */
const MUSIC_NESTED = {
  id: ID(94),
  type: "music",
  version: 1,
  visible: false,
  config: { url: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", focal: { x: 0.5, label: "extra" } },
};

/** Exact stored state, as text, for byte-level stability checks. */
const rawRow = async (id: string) =>
  (
    await testSql()`select draft::text as draft, published::text as published, draft_revision, published_revision,
      is_published, draft_updated_at, published_at from profiles where id = ${id}`
  )[0];

const resetProfiles = () => testSql()`delete from profiles`;

/** Header save, editor block save, publish (stored draft) and save-and-publish: all refused, nothing changes. */
async function expectEveryWriteRefused(id: string, revision: number, editorBlocks: unknown[] = [L(1)]) {
  const before = await rawRow(id);
  const err = await save(alice, id, revision).catch((e: unknown) => e);
  expect((err as AppError).code).toBe("VALIDATION");
  expect((err as AppError).message).toMatch(/can't edit without losing data/);
  expect(await code(save(alice, id, revision, editorBlocks))).toBe("VALIDATION");
  expect(await code(svc.publishProfile(alice, id, { expectedRevision: revision }))).toBe("VALIDATION");
  expect(await code(svc.publishProfile(alice, id, { expectedRevision: revision, patch: { ...header, blocks: editorBlocks } }))).toBe("VALIDATION");
  expect(await rawRow(id)).toEqual(before);
}

async function code(p: Promise<unknown>): Promise<string | null> {
  return p.then(
    () => null,
    (e: unknown) => (e instanceof AppError ? e.code : `non-AppError: ${String(e)}`),
  );
}

async function createFor(owner: string, handle: string) {
  return (await svc.createProfile(owner, { handle, label: handle, displayName: "Alice" })).id;
}

const save = (owner: string, id: string, expectedRevision: number, blocks?: unknown[]) =>
  svc.saveDraft(owner, id, { expectedRevision, patch: { ...header, ...(blocks ? { blocks } : {}) } });

/** Writes stored JSON directly (as an older version or another tool might have), live and consistent. */
async function seed(id: string, draftBlocks: unknown[], publishedBlocks?: unknown[]) {
  const base = createDefaultDocument("Alice");
  const draft = { ...base, blocks: draftBlocks };
  if (publishedBlocks) {
    const published = { ...base, blocks: publishedBlocks };
    await testSql()`update profiles set draft = ${testSql().json(draft)}, published = ${testSql().json(published)},
      draft_revision = 1, published_revision = 1, is_published = true, published_at = now() where id = ${id}`;
  } else {
    await testSql()`update profiles set draft = ${testSql().json(draft)} where id = ${id}`;
  }
}

async function publicHtml(handle: string) {
  const live = await getLiveProfile(handle);
  const doc = live ? await getPublishedDocument(live) : null;
  if (!doc) return null;
  return renderToStaticMarkup(createElement(ProfileView, { document: doc, verified: false, mode: "public" }));
}

beforeEach(async () => {
  await resetDatabase();
  session.user = null;
  await bootstrapSuperAdmin({ token: TEST_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: "correct-horse-battery" });
  for (const email of ["alice@example.com", "bob@example.com"]) expect((await signUp(email)).status).toBe(200);
  [alice, bob] = await Promise.all(["alice@example.com", "bob@example.com"].map(idOf));
});

describe("saving blocks", () => {
  it("persists the submitted order with server-stamped versions and normalized values; the published page is untouched", async () => {
    const id = await createFor(alice, "alice");
    await svc.publishProfile(alice, id, { expectedRevision: 0 });
    const r = await save(alice, id, 0, [T(3), { ...L(1), config: { title: " Shop ", url: "shop.example.com" } }, H(2), D(4)]);
    expect(r.revision).toBe(1);
    expect(order(r.blocks)).toEqual([ID(3), ID(1), ID(2), ID(4)]);

    const stored = await row(id);
    expect(order(stored.draft.blocks)).toEqual([ID(3), ID(1), ID(2), ID(4)]);
    expect(stored.draft.blocks.map((b) => b.version)).toEqual([1, 2, 1, 1]);
    expect(stored.draft.blocks[1].config).toEqual({ title: "Shop", url: "https://shop.example.com/" });
    expect(stored.published?.blocks).toEqual([]);
    expect(await publicHtml("alice")).not.toContain("pp-block");

    const owned = await svc.getOwnedProfile(alice, id);
    expect(order(owned.draft.blocks)).toEqual([ID(3), ID(1), ID(2), ID(4)]);
    expect(owned.hasUnpublishedChanges).toBe(true);
  });

  it("stores a reorder exactly, and a save without `blocks` keeps the stored list", async () => {
    const id = await createFor(alice, "alice");
    await save(alice, id, 0, [L(1), L(2), L(3)]);
    await save(alice, id, 1, [L(3), L(1), L(2)]);
    expect(order((await row(id)).draft.blocks)).toEqual([ID(3), ID(1), ID(2)]);
    await save(alice, id, 2);
    expect(order((await row(id)).draft.blocks)).toEqual([ID(3), ID(1), ID(2)]);
    await save(alice, id, 3, []);
    expect((await row(id)).draft.blocks).toEqual([]);
  });

  it("rejects invalid block lists and theme/settings injection without changing anything", async () => {
    const id = await createFor(alice, "alice");
    await save(alice, id, 0, [L(1)]);
    const before = await row(id);
    const bad: unknown[][] = [
      [{ ...L(2), version: 2 }],
      [{ ...L(2), extra: true }],
      [{ ...L(2), config: { ...L(2).config, icon: "star" } }],
      [{ ...L(2), config: { title: "x", url: "javascript:alert(1)" } }],
      [{ ...L(2), config: { title: "x", url: "//evil.com" } }],
      [{ ...L(2), id: "1" }],
      [L(2), L(2)],
      [{ id: ID(2), type: "video", visible: true, config: { url: "http://www.youtube.com/watch?v=dQw4w9WgXcQ" } }],
      [{ id: ID(2), type: "html", visible: true, config: { html: "<script>" } }],
      [{ ...H(1) }], // id 1 is a link: type change
      Array.from({ length: 101 }, (_, i) => L(100 + i)),
    ];
    for (const blocks of bad) expect(await code(save(alice, id, 1, blocks))).toBe("VALIDATION");
    for (const extra of [{ theme: { preset: "neon" } }, { settings: { showBranding: false } }, { settings: { openLinksInNewTab: true } }]) {
      expect(await code(svc.saveDraft(alice, id, { expectedRevision: 1, patch: { ...header, blocks: [L(1)], ...extra } }))).toBe("VALIDATION");
    }
    expect(await code(svc.publishProfile(alice, id, { expectedRevision: 1, patch: { ...header, blocks: [L(1, "")] } }))).toBe("VALIDATION");
    expect(await row(id)).toEqual(before);
  });

  it("carries safe, structured block errors on the AppError", async () => {
    const id = await createFor(alice, "alice");
    const err = await save(alice, id, 0, [{ ...L(1), config: { title: "", url: "foo" } }, { ...L(2), id: "nope" }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).blockErrors).toEqual({
      list: [],
      items: [
        { index: 0, id: ID(1), fields: { title: ["Add a title"], url: ["Enter a valid http(s) address, like example.com"] } },
        { index: 1, message: "This block has an invalid id." },
      ],
    });
  });

  it("never lets a block id change type, even if it now only exists in the published snapshot", async () => {
    const id = await createFor(alice, "alice");
    await svc.publishProfile(alice, id, { expectedRevision: 0, patch: { ...header, blocks: [H(1)] } });
    await save(alice, id, 1, []);
    expect(await code(save(alice, id, 2, [L(1)]))).toBe("VALIDATION");
    expect(await code(save(alice, id, 2, [H(1, "Back again")]))).toBeNull();
  });
});

describe("compatibility with stored blocks", () => {
  it("reads valid v1 video and music as v2: a header save keeps their JSON, an editor save canonicalizes them, and they render", async () => {
    const id = await createFor(alice, "alice");
    await seed(id, [VIDEO, { ...L(1), version: 2 }, MUSIC], [VIDEO, MUSIC]);
    const owned = await svc.getOwnedProfile(alice, id);
    expect(owned.protectedBlocks).toBe(0);

    await save(alice, id, 1); // header-only
    expect((await row(id)).draft.blocks).toEqual([VIDEO, { ...L(1), version: 2 }, MUSIC]);

    await save(alice, id, 2, toBlockInput(toEditorItems(owned.draft.blocks)).reverse());
    let r = await row(id);
    expect(order(r.draft.blocks)).toEqual([ID(91), ID(1), ID(90)]);
    expect(r.draft.blocks.find((b) => b.id === ID(90))).toEqual({ ...VIDEO, version: 2 });

    await svc.publishProfile(alice, id, { expectedRevision: 3 });
    r = await row(id);
    expect(order(r.published?.blocks)).toEqual([ID(91), ID(1), ID(90)]);
    const html = (await publicHtml("alice"))!;
    expect([...html.matchAll(/data-block-type="([^"]+)"/g)].map((m) => m[1])).toEqual(["music", "link", "video"]);
    expect(html).not.toMatch(/<iframe/i);

    await save(alice, id, 3, [L(1)]); // the owner deletes both
    expect(order((await row(id)).draft.blocks)).toEqual([ID(1)]);
    await svc.revertDraft(alice, id, { expectedRevision: 4 });
    expect((await row(id)).draft.blocks.find((b) => b.id === ID(90))).toEqual({ ...VIDEO, version: 2 });
  });

  it("migrates a stored v1 link predictably through read, edit, save, publish and public rendering", async () => {
    const id = await createFor(alice, "alice");
    await seed(id, [LINK_V1], [LINK_V1]);

    // Public page (published v1) renders via the migration.
    expect(await publicHtml("alice")).toContain('href="https://legacy.example.com/"');

    const owned = await svc.getOwnedProfile(alice, id);
    expect(owned.protectedBlocks).toBe(0);
    expect(owned.draft.blocks).toEqual([
      { id: ID(80), type: "link", version: 2, visible: true, config: { title: "Legacy", url: "https://legacy.example.com/", description: "Old link" } },
    ]);

    await save(alice, id, 1, [{ id: ID(80), type: "link", visible: true, config: { title: "Legacy, edited", url: "legacy.example.com/new", description: "Old link" } }]);
    const draft = (await row(id)).draft.blocks[0];
    expect(draft).toEqual({ id: ID(80), type: "link", version: 2, visible: true, config: { title: "Legacy, edited", url: "https://legacy.example.com/new", description: "Old link" } });

    await svc.publishProfile(alice, id, { expectedRevision: 2 });
    expect((await row(id)).published?.blocks[0]).toEqual(draft);
    const html = (await publicHtml("alice"))!;
    expect(html).toContain("Legacy, edited");
    expect(html).toContain('href="https://legacy.example.com/new"');
  });

  it("never rewrites a draft containing unreadable blocks, and the public page still works", async () => {
    const id = await createFor(alice, "alice");
    await seed(id, [UNREADABLE, { ...L(1), version: 2 }], [UNREADABLE, { ...L(1), version: 2 }]);
    expect((await svc.getOwnedProfile(alice, id)).protectedBlocks).toBe(1);
    await expectEveryWriteRefused(id, 1);

    const html = (await publicHtml("alice"))!;
    expect(html).toContain("Link 1");
    expect(html).not.toContain("future-widget");
  });

  it("protects a draft whose video or music block holds fields the editor can't carry, and discarding restores the published version", async () => {
    for (const stored of [VIDEO_EXTRA, MUSIC_NESTED, { ...VIDEO, pinned: true }]) {
      await resetProfiles();
      const id = await createFor(alice, "alice");
      await seed(id, [stored, { ...L(1), version: 2 }, VIDEO], [{ ...L(1), version: 2 }]);
      expect((await svc.getOwnedProfile(alice, id)).protectedBlocks).toBe(1);
      await expectEveryWriteRefused(id, 1);
      expect((await row(id)).draft.blocks[0]).toEqual(stored);
      await svc.revertDraft(alice, id, { expectedRevision: 1 });
      expect(order((await row(id)).draft.blocks)).toEqual([ID(1)]);
    }
  });

  it("refuses every write when an editable-type block holds fields the editor can't carry", async () => {
    for (const lossy of [
      { ...H(5), version: 1, config: { ...H(5).config, color: "red" } },
      { ...L(5), version: 2, pinned: true },
      // Blank or null unknown keys are still data the editor would strip (M3-001A).
      { ...H(5), version: 1, config: { ...H(5).config, futureField: "" } },
      { ...T(5), version: 1, config: { ...T(5).config, futureField: null } },
      { ...D(5), version: 1, config: { ...D(5).config, futureField: "" } },
      { ...LINK_V1, id: ID(5), config: { ...LINK_V1.config, futureField: null } },
    ]) {
      await resetProfiles();
      const id = await createFor(alice, "alice");
      await seed(id, [lossy, { ...L(1), version: 2 }], [{ ...L(1), version: 2 }]);
      expect((await svc.getOwnedProfile(alice, id)).protectedBlocks).toBe(1);
      await expectEveryWriteRefused(id, 1);
    }
  });

  it("treats schema defaults as additions, not losses: such blocks stay editable", async () => {
    const id = await createFor(alice, "alice");
    const bare = { id: ID(6), type: "heading", version: 1, visible: true, config: { text: "Bare" } };
    await seed(id, [bare]);
    const owned = await svc.getOwnedProfile(alice, id);
    expect(owned.protectedBlocks).toBe(0);
    await save(alice, id, 0);
    expect((await row(id)).draft.blocks).toEqual([bare]); // header save: untouched
    await save(alice, id, 1, toBlockInput(toEditorItems(owned.draft.blocks)));
    expect((await row(id)).draft.blocks).toEqual([{ ...bare, config: { text: "Bare", size: "md", align: "inherit" } }]);
  });

  it("keeps a blank recognized optional field editable: it normalizes away, it isn't an unknown key", async () => {
    const id = await createFor(alice, "alice");
    const blank = { ...L(6), version: 2, config: { ...L(6).config, description: "" } };
    await seed(id, [blank]);
    const owned = await svc.getOwnedProfile(alice, id);
    expect(owned.protectedBlocks).toBe(0);
    await save(alice, id, 0, toBlockInput(toEditorItems(owned.draft.blocks)));
    expect((await row(id)).draft.blocks).toEqual([{ ...L(6), version: 2 }]);
  });

  it("refuses to rewrite a draft with more than 100 valid stored blocks; public shows 100; discard stays explicit and revision-checked", async () => {
    const id = await createFor(alice, "alice");
    const many = Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => ({ ...L(i + 1), version: 2 }));
    await seed(id, many, many);

    const owned = await svc.getOwnedProfile(alice, id);
    expect(owned.draft.blocks).toHaveLength(MAX_BLOCKS);
    expect(owned.protectedBlocks).toBe(1);
    // The editor's full-list save of the 100 blocks it shows would have deleted the 101st.
    await expectEveryWriteRefused(id, 1, toBlockInput(toEditorItems(owned.draft.blocks)));

    const live = await getLiveProfile("alice");
    expect((await getPublishedDocument(live!))?.blocks).toHaveLength(MAX_BLOCKS);

    const before = await rawRow(id);
    expect(await code(svc.revertDraft(alice, id, { expectedRevision: 0 }))).toBe("CONFLICT");
    expect(await rawRow(id)).toEqual(before);
    await svc.revertDraft(alice, id, { expectedRevision: 1 });
    expect((await row(id)).draft.blocks).toHaveLength(MAX_BLOCKS + 1);
  });
});

describe("publication", () => {
  it("publishes exactly the saved blocks; discard restores them", async () => {
    const id = await createFor(alice, "alice");
    await svc.publishProfile(alice, id, { expectedRevision: 0, patch: { ...header, blocks: [L(1), { ...L(2), visible: false }, T(3)] } });
    let html = (await publicHtml("alice"))!;
    expect([...html.matchAll(/data-block-id="([^"]+)"/g)].map((m) => m[1])).toEqual([ID(1), ID(3)]);
    expect(html).not.toContain("Link 2");

    await save(alice, id, 1, [T(3), L(4, "DRAFT ONLY")]);
    html = (await publicHtml("alice"))!;
    expect(html).not.toContain("DRAFT ONLY");
    expect((await row(id)).published?.blocks.map((b) => b.id)).toEqual([ID(1), ID(2), ID(3)]);

    await svc.revertDraft(alice, id, { expectedRevision: 2 });
    expect(order((await row(id)).draft.blocks)).toEqual([ID(1), ID(2), ID(3)]);
  });

  it("a failed save-and-publish leaves draft and published untouched", async () => {
    const id = await createFor(alice, "alice");
    await svc.publishProfile(alice, id, { expectedRevision: 0, patch: { ...header, blocks: [L(1)] } });
    const before = await row(id);
    expect(await code(svc.publishProfile(alice, id, { expectedRevision: 1, patch: { ...header, blocks: [L(1), L(2, "")] } }))).toBe("VALIDATION");
    expect(await row(id)).toEqual(before);
  });
});

describe("concurrency", () => {
  it("rejects a stale block save", async () => {
    const id = await createFor(alice, "alice");
    await save(alice, id, 0, [L(1), L(2)]);
    const before = await row(id);
    expect(await code(save(alice, id, 0, [L(2), L(1)]))).toBe("CONFLICT");
    expect(await row(id)).toEqual(before);
  });

  it("concurrent reorders from the same revision: exactly one wins and the stored order is exactly the winner's", async () => {
    const base = [1, 2, 3, 4, 5].map((n) => L(n));
    const a = [5, 4, 3, 2, 1].map((n) => L(n));
    const b = [2, 1, 3, 5, 4].map((n) => L(n));
    for (let round = 0; round < 10; round++) {
      const id = await createFor(alice, `reorder${round}`);
      await save(alice, id, 0, base);
      const results = await Promise.allSettled([save(alice, id, 1, a), save(alice, id, 1, b)]);
      const won = results.map((r) => r.status === "fulfilled");
      expect(won.filter(Boolean)).toHaveLength(1);
      const loser = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
      expect((loser.reason as AppError).code).toBe("CONFLICT");
      const stored = await row(id);
      expect(stored.draft_revision).toBe(2);
      expect(order(stored.draft.blocks)).toEqual(order(won[0] ? a : b));
      expect(order(stored.draft.blocks).sort()).toEqual(order(base).sort());
      await svc.deleteProfile(alice, id); // stay under the per-user profile limit
    }
  });

  it("a concurrent block save can never cause a different block list to be published", async () => {
    for (let round = 0; round < 10; round++) {
      const id = await createFor(alice, `pubrace${round}`);
      await save(alice, id, 0, [L(1), L(2)]);
      const [saved, published] = await Promise.allSettled([
        save(alice, id, 1, [L(2), L(1), L(3)]),
        svc.publishProfile(alice, id, { expectedRevision: 1, patch: { ...header, blocks: [L(1)] } }),
      ]);
      expect([saved.status, published.status].filter((s) => s === "fulfilled")).toHaveLength(1);
      const r = await row(id);
      if (published.status === "fulfilled") {
        expect(order(r.published?.blocks)).toEqual([ID(1)]);
        expect(order(r.draft.blocks)).toEqual([ID(1)]);
      } else {
        expect(r.published).toBeNull();
        expect(order(r.draft.blocks)).toEqual([ID(2), ID(1), ID(3)]);
      }
      await svc.deleteProfile(alice, id);
    }
  });
});

describe("authorization", () => {
  it("another user can't change or publish someone else's blocks", async () => {
    const id = await createFor(alice, "alice");
    await save(alice, id, 0, [L(1)]);
    const before = await row(id);
    expect(await code(save(bob, id, 1, [L(9, "Pwned")]))).toBe("NOT_FOUND");
    expect(await code(svc.publishProfile(bob, id, { expectedRevision: 1, patch: { ...header, blocks: [] } }))).toBe("NOT_FOUND");
    expect(await row(id)).toEqual(before);
  });

  it("the save action needs a session, scopes to the owner and returns only safe block errors", async () => {
    const id = await createFor(alice, "alice");
    const input = { expectedRevision: 0, patch: { ...header, blocks: [L(1)] } };

    session.user = null;
    expect(await actions.saveDraftAction(id, input)).toEqual({ ok: false, error: "Your session has expired. Please sign in again." });

    session.user = { id: bob, name: "bob", email: "bob@example.com", emailVerified: true, role: "user" };
    expect(await actions.saveDraftAction(id, input)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect((await row(id)).draft_revision).toBe(0);

    session.user = { id: alice, name: "alice", email: "alice@example.com", emailVerified: true, role: "user" };
    const bad = await actions.saveDraftAction(id, { expectedRevision: 0, patch: { ...header, blocks: [{ ...L(1), config: { title: "x", url: "data:text/html,x" } }] } });
    expect(bad).toEqual({
      ok: false,
      error: "Some blocks need attention.",
      code: "VALIDATION",
      fieldErrors: undefined,
      blockErrors: { list: [], items: [{ index: 0, id: ID(1), fields: { url: ["Enter a valid http(s) address, like example.com"] } }] },
    });

    const ok = await actions.saveDraftAction(id, input);
    expect(ok).toMatchObject({ ok: true, data: { revision: 1, blocks: [{ id: ID(1), version: 2 }] } });
  });
});
