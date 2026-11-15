import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unfinished drafts against the real database: a draft that doesn't pass
 * publishing validation is saved as typed and reopened with its problems,
 * while publishing stays strict on the server, the public page shows only
 * validated published data, and the refusals that protect stored data
 * (blocks this version can't rewrite, a locked theme, another owner's
 * profile or images) are unchanged.
 */
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
}));
const session = vi.hoisted(() => ({ user: null as null | { id: string; name: string; email: string; emailVerified: boolean; role: "user" } }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => session.user }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));

import { ProfileView } from "@/components/profile/profile-view";
import * as actions from "@/features/profiles/actions";
import { createDefaultDocument } from "@/features/profiles/document";
import { getLiveProfile, getPublishedDocument } from "@/features/profiles/public";
import * as svc from "@/features/profiles/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { getPreset } from "@/features/themes/presets";
import { AppError } from "@/lib/errors";
import { signUp } from "../support/auth-http";
import { resetDatabase, testSql } from "../support/db";
import { TEST_SETUP_TOKEN } from "../support/test-env";
import { expectKeptUnfinished } from "../support/unfinished";

let alice = "";
let bob = "";
let id = "";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const idOf = async (email: string) => ((await testSql()`select id from users where email = ${email}`)[0] as { id: string }).id;
const L = (n: number, title = `Link ${n}`, url = `https://example.com/${n}`) => ({ id: ID(n), type: "link", visible: true, config: { title, url } });
const patch = (displayName = "Alice", extra: object = {}) => ({ header: { displayName, bio: "" }, seo: { noindex: false }, ...extra });
const save = (owner: string, revision: number, p: object) => svc.saveDraft(owner, id, { expectedRevision: revision, patch: p });
const publish = (owner: string, revision: number, p?: object) => svc.publishProfile(owner, id, { expectedRevision: revision, ...(p ? { patch: p } : {}) });
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => {
      if (e instanceof AppError) return e;
      throw e;
    },
  );
const rawRow = async () =>
  (
    await testSql()`select draft::text as draft, published::text as published, draft_revision, published_revision,
      is_published, draft_updated_at, published_at from profiles where id = ${id}`
  )[0];
const stored = async () => (await testSql()`select draft, published from profiles where id = ${id}`)[0] as { draft: Record<string, unknown>; published: Record<string, unknown> | null };
const seedDraft = (draft: object) => testSql()`update profiles set draft = ${testSql().json(draft as never)} where id = ${id}`;

async function publicHtml() {
  const live = await getLiveProfile("alice");
  const doc = live ? await getPublishedDocument(live) : null;
  return doc ? renderToStaticMarkup(createElement(ProfileView, { document: doc, verified: false, mode: "public" })) : null;
}

/** An image background still waiting for its image: what the Design panel holds right after choosing "Image". */
const waitingForImage = () => {
  const theme = getPreset("minimal").theme;
  return { ...theme, background: { ...theme.background, type: "image", overlayOpacity: 0.6 } };
};

beforeEach(async () => {
  await resetDatabase();
  session.user = null;
  await bootstrapSuperAdmin({ token: TEST_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: "correct-horse-battery" });
  for (const email of ["alice@example.com", "bob@example.com"]) expect((await signUp(email)).status).toBe(200);
  [alice, bob] = await Promise.all(["alice@example.com", "bob@example.com"].map(idOf));
  id = (await svc.createProfile(alice, { handle: "alice", label: "alice", displayName: "Alice" })).id;
});

describe("saving an unfinished draft", () => {
  it("keeps an incomplete profile exactly as typed, and reopens it with its problems", async () => {
    const typed = { header: { displayName: "", bio: "b".repeat(301), avatarUrl: "not an address" }, seo: { title: "t".repeat(71), noindex: true } };
    const before = await rawRow();
    const saved = await save(alice, 0, typed);
    expect(saved).toMatchObject({ revision: 1, needsAttention: { message: "Please fix the highlighted fields." } });
    expect(saved).not.toHaveProperty("blocks");
    await expectKeptUnfinished(id, before);

    // A reload reads it back from the database, not from anything the first request held.
    const reopened = await svc.getOwnedProfile(alice, id);
    expect(reopened.draftRevision).toBe(1);
    expect(reopened.incomplete).toMatchObject({ ...typed, issues: saved.needsAttention });
    expect(reopened.draft.header.displayName).toBe("Alice"); // the last valid draft is still there, untouched
    expect(reopened.hasUnpublishedChanges).toBe(true);
  });

  it("keeps an invalid block without it ever becoming public", async () => {
    await publish(alice, 0, patch("Alice", { blocks: [L(1)] }));
    const before = await rawRow();
    const saved = await save(alice, 1, patch("Alice", { blocks: [L(1), L(2, "", "javascript:alert(1)")] }));
    expect(saved.needsAttention?.blockErrors?.items).toEqual([
      { index: 1, id: ID(2), fields: { title: ["Add a title"], url: ["Enter a valid http(s) address, like example.com"] } },
    ]);
    const kept = await expectKeptUnfinished(id, before);
    expect(kept.blocks?.map((b) => b.config)).toEqual([L(1).config, { title: "", url: "javascript:alert(1)" }]);

    // The published snapshot and the public page know nothing about it.
    expect((await stored()).published).not.toHaveProperty("incomplete");
    expect(JSON.stringify((await stored()).published)).not.toContain("javascript:");
    const html = (await publicHtml())!;
    expect(html).toContain("Link 1");
    expect(html).not.toContain("javascript:");
    expect((await svc.listProfiles(alice))[0]).toMatchObject({ isPublished: true, hasUnpublishedChanges: true });
  });

  it("keeps an appearance that isn't finished, and reopens it", async () => {
    const before = await rawRow();
    const saved = await save(alice, 0, patch("Alice", { theme: waitingForImage() }));
    expect(saved.needsAttention?.fieldErrors).toEqual({ "theme.background.imageUrl": ["Choose a background image from your library"] });
    await expectKeptUnfinished(id, before);
    const reopened = await svc.getOwnedProfile(alice, id);
    expect(reopened.incomplete?.theme?.background).toMatchObject({ type: "image", overlayOpacity: 0.6 });
    expect(reopened.incomplete?.theme?.background).not.toHaveProperty("imageUrl");
    expect(reopened.appearance.status).toBe("editable"); // the stored theme is still the valid one
    expect(reopened.draft.theme.background.type).toBe("solid");
  });

  it("carries kept blocks and a kept theme through a later save that doesn't send them", async () => {
    await save(alice, 0, patch("Alice", { blocks: [L(1, "")], theme: waitingForImage() }));
    // A header-only save: the unfinished blocks and theme stay, they are not replaced by the last valid ones.
    const again = await save(alice, 1, patch("Alice Renamed"));
    expect(again.needsAttention?.blockErrors?.items).toHaveLength(1);
    const kept = (await svc.getOwnedProfile(alice, id)).incomplete;
    expect(kept).toMatchObject({ header: { displayName: "Alice Renamed" }, blocks: [{ id: ID(1) }], theme: { background: { type: "image" } } });
    expect(await failure(publish(alice, 2, patch("Alice Renamed")))).toMatchObject({ code: "VALIDATION" });
  });
});

describe("publishing stays strict", () => {
  it("refuses an unfinished draft on the server, with or without a patch, and changes nothing", async () => {
    await publish(alice, 0, patch("Alice", { blocks: [L(1)] }));
    await save(alice, 1, patch("", { blocks: [L(1), L(2, "")] }));
    const before = await rawRow();

    const asSaved = await failure(publish(alice, 2));
    expect(asSaved).toMatchObject({ code: "VALIDATION", message: "Please fix the highlighted fields." });
    // A patch that fixes the header but says nothing about blocks still answers for the kept ones.
    const partly = await failure(publish(alice, 2, patch("Alice")));
    expect(partly?.blockErrors?.items).toEqual([{ index: 1, id: ID(2), fields: { title: ["Add a title"] } }]);
    expect(await rawRow()).toEqual(before);

    // Through the action, as a forged request would arrive.
    session.user = { id: alice, name: "alice", email: "alice@example.com", emailVerified: true, role: "user" };
    expect(await actions.publishAction(id, { expectedRevision: 2 })).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(await rawRow()).toEqual(before);
    expect(await publicHtml()).not.toContain("Link 2");
  });

  it("fails closed on an unfinished draft it can't read", async () => {
    const draft = { ...createDefaultDocument("Alice"), incomplete: { header: 7 } };
    await seedDraft(draft);
    expect((await svc.getOwnedProfile(alice, id)).incomplete).toBeNull();
    expect(await failure(publish(alice, 0))).toMatchObject({ code: "VALIDATION", message: "This draft has problems that must be fixed before it can be published." });
    expect((await stored()).published).toBeNull();
    // A draft that validates replaces it.
    await publish(alice, 0, patch("Alice"));
    expect((await stored()).draft).not.toHaveProperty("incomplete");
  });

  it("publishes once every problem is fixed, and the unfinished copy is gone from both snapshots", async () => {
    await save(alice, 0, patch("", { blocks: [L(1, "")], theme: waitingForImage() }));
    const stillBad = await save(alice, 1, patch("Alice", { blocks: [L(1, "Shop")] })); // the theme is still waiting
    expect(stillBad.needsAttention?.fieldErrors).toHaveProperty(["theme.background.imageUrl"]);
    expect(await failure(publish(alice, 2))).toMatchObject({ code: "VALIDATION" });

    const published = await publish(alice, 2, patch("Alice", { blocks: [L(1, "Shop")], theme: getPreset("minimal").theme }));
    expect(published.revision).toBe(3);
    const after = await stored();
    expect(after.draft).not.toHaveProperty("incomplete");
    expect(after.published).not.toHaveProperty("incomplete");
    expect(after.published).toEqual(after.draft);
    expect(await publicHtml()).toContain("Shop");
    expect((await svc.getOwnedProfile(alice, id)).incomplete).toBeNull();
  });

  it("a later valid save or a discard drops the unfinished draft; valid saving and publishing work as before", async () => {
    await publish(alice, 0, patch("Alice", { blocks: [L(1)] }));
    await save(alice, 1, patch("", { blocks: [L(1, "")] }));
    const valid = await save(alice, 2, patch("Alice", { blocks: [L(1, "Fixed")] }));
    expect(valid).toMatchObject({ revision: 3, needsAttention: null, blocks: [{ id: ID(1), config: { title: "Fixed" } }] });
    expect((await stored()).draft).not.toHaveProperty("incomplete");

    await save(alice, 3, patch("", { blocks: [L(1, "")] }));
    await svc.revertDraft(alice, id, { expectedRevision: 4 });
    const reverted = await svc.getOwnedProfile(alice, id);
    expect(reverted.incomplete).toBeNull();
    expect(reverted.draft.blocks.map((b) => b.config)).toMatchObject([{ title: "Link 1" }]);
    await publish(alice, 5);
    expect(await publicHtml()).toContain("Link 1");
  });
});

describe("what an unfinished draft may not do", () => {
  it("is invisible and immutable to another account, and still revision-checked", async () => {
    await save(alice, 0, patch("", { blocks: [L(1, "")] }));
    const before = await rawRow();
    expect(await failure(svc.getOwnedProfile(bob, id))).toMatchObject({ code: "NOT_FOUND" });
    for (const write of [
      () => save(bob, 1, patch("Bob")),
      () => save(bob, 1, patch("", { blocks: [L(1, "")] })),
      () => publish(bob, 1),
      () => publish(bob, 1, patch("Bob")),
      () => svc.revertDraft(bob, id, { expectedRevision: 1 }),
    ]) {
      expect(await failure(write())).toMatchObject({ code: "NOT_FOUND" });
    }
    session.user = { id: bob, name: "bob", email: "bob@example.com", emailVerified: true, role: "user" };
    expect(await actions.saveDraftAction(id, { expectedRevision: 1, patch: patch("") })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect((await svc.listProfiles(bob)).map((p) => p.id)).not.toContain(id);
    // A stale editor can't overwrite a newer unfinished draft either.
    expect(await failure(save(alice, 0, patch("", { blocks: [] })))).toMatchObject({ code: "CONFLICT" });
    expect(await rawRow()).toEqual(before);
  });

  it("never writes into a draft holding blocks this version can't rewrite: unknown type, newer version or too many", async () => {
    const future = { id: ID(70), type: "future-widget", version: 1, visible: true, config: { x: 1 } };
    const newer = { id: ID(71), type: "link", version: 99, visible: true, config: { title: "Later", url: "https://example.com/", shape: "new" } };
    const tooMany = Array.from({ length: 101 }, (_, i) => ({ ...L(100 + i), version: 2 }));
    for (const [label, blocks] of [["unknown type", [future]], ["newer version", [newer]], ["over the limit", tooMany]] as const) {
      await seedDraft({ ...createDefaultDocument("Alice"), blocks });
      const before = await rawRow();
      expect((await svc.getOwnedProfile(alice, id)).protectedBlocks, label).toBeGreaterThan(0);
      // Invalid input that would otherwise be kept as an unfinished draft: refused, byte for byte.
      for (const p of [patch(""), patch("", { blocks: [L(1, "")] }), patch("Alice", { blocks: [L(1, "")] }), patch("Alice", { theme: waitingForImage() })]) {
        const err = await failure(save(alice, 0, p));
        expect(err?.code, label).toBe("VALIDATION");
      }
      expect(await failure(save(alice, 0, patch("Alice", { blocks: [L(1, "")] }))), label).toMatchObject({
        message: expect.stringMatching(/can't edit without losing data/),
      });
      expect(await rawRow(), label).toEqual(before);
    }
  });

  it("never stands in for a theme the editor can't carry, or for a confirmed replacement", async () => {
    const lockedTheme = { ...createDefaultDocument("Alice").theme, preset: "from-the-future" };
    await seedDraft({ ...createDefaultDocument("Alice"), theme: lockedTheme });
    const before = await rawRow();
    expect((await svc.getOwnedProfile(alice, id)).appearance.status).toBe("locked");
    expect(await failure(save(alice, 0, patch("Alice", { theme: waitingForImage() })))).toMatchObject({ code: "VALIDATION" });
    expect(await failure(save(alice, 0, patch("", { theme: getPreset("neon").theme })))).toMatchObject({ code: "VALIDATION" });
    expect(await failure(save(alice, 0, patch("", { replaceTheme: "neon" })))).toMatchObject({ code: "VALIDATION" });
    expect(await rawRow()).toEqual(before);
    // Content beside the locked theme can still be kept unfinished; the theme stays exactly as stored.
    await save(alice, 0, patch(""));
    expect((await stored()).draft.theme).toEqual(lockedTheme);
  });

  it("is refused when it can't be reopened or stored: another shape, too large, or text the database can't hold", async () => {
    const before = await rawRow();
    const refused: object[] = [
      patch("", { blocks: [{ ...L(1, ""), config: { title: "", url: "", nested: { a: 1 } } }] }),
      patch("", { blocks: [{ ...L(1, ""), version: 2 }] }),
      patch("", { blocks: [{ id: ID(1), type: "html", visible: true, config: {} }] }),
      patch("", { theme: { ...getPreset("minimal").theme, accent: "red" } }),
      patch("", { theme: { ...waitingForImage(), css: "body{}" } }),
      patch("", { theme: { ...waitingForImage(), background: { ...waitingForImage().background, imageUrl: "https://img.example.com/x.png" } } }),
      patch("x".repeat(5001)),
      { header: { displayName: "", bio: "Nul\u0000l" }, seo: { noindex: false } },
      patch("", { blocks: Array.from({ length: 60 }, (_, i) => L(i + 1, "", "y".repeat(4000))) }),
      { ...patch(""), settings: { showBranding: false } },
    ];
    for (const p of refused) expect(await failure(save(alice, 0, p)), JSON.stringify(p).slice(0, 80)).toMatchObject({ code: "VALIDATION" });
    expect(await rawRow()).toEqual(before);
  });
});
