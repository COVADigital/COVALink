import { beforeEach, describe, expect, it, vi } from "vitest";

// `use cache` helpers only work inside Next.js; here the cached function runs uncached.
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
}));

import { setUserBanned } from "@/features/admin/users";
import { resolveActiveProfile } from "@/features/profiles/active";
import { setPublicCacheInvalidator } from "@/features/profiles/cache";
import { createDefaultDocument } from "@/features/profiles/document";
import { buildProfileMetadata } from "@/features/profiles/metadata";
import { getLiveProfile, getPublishedDocument } from "@/features/profiles/public";
import * as svc from "@/features/profiles/service";
import { setSetting } from "@/features/settings/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { AppError } from "@/lib/errors";
import { cookieFrom, deleteAccount, signIn, signUp } from "../support/auth-http";
import { clearInvalidatedTags, invalidatedTags, recordInvalidation } from "../support/cache-spy";
import { resetDatabase, testSql } from "../support/db";
import { TEST_SETUP_TOKEN } from "../support/test-env";

let superId: string;
let alice: string;
let bob: string;

const idOf = async (email: string) => ((await testSql()`select id from users where email = ${email}`)[0] as { id: string }).id;
const row = async (id: string) =>
  (
    await testSql()`select handle, is_published, draft_revision, published_revision, draft, published from profiles where id = ${id}`
  )[0] as {
    handle: string;
    is_published: boolean;
    draft_revision: number;
    published_revision: number | null;
    draft: { header: { displayName: string }; blocks: unknown[]; theme: { preset: string }; settings: { showBranding: boolean } };
    published: { header: { displayName: string } } | null;
  };

const patch = (displayName: string, extra: Partial<{ bio: string; noindex: boolean; title: string }> = {}) => ({
  header: { displayName, bio: extra.bio ?? "", avatarUrl: undefined },
  seo: { title: extra.title, description: undefined, noindex: extra.noindex ?? false },
});

async function code(p: Promise<unknown>): Promise<string | null> {
  return p.then(
    () => null,
    (e: unknown) => (e instanceof AppError ? e.code : `non-AppError: ${String(e)}`),
  );
}

async function createFor(owner: string, handle: string) {
  return svc.createProfile(owner, { handle, label: handle, displayName: `${handle} name` });
}

async function publicView(handle: string) {
  const live = await getLiveProfile(handle);
  return live ? { live, doc: await getPublishedDocument(live) } : null;
}

beforeEach(async () => {
  await resetDatabase();
  clearInvalidatedTags();
  ({ userId: superId } = await bootstrapSuperAdmin({
    token: TEST_SETUP_TOKEN,
    name: "Owner",
    email: "owner@example.com",
    password: "correct-horse-battery",
  }));
  for (const email of ["alice@example.com", "bob@example.com"]) expect((await signUp(email)).status).toBe(200);
  [alice, bob] = await Promise.all(["alice@example.com", "bob@example.com"].map(idOf));
});

describe("creating profiles", () => {
  it("normalizes the handle and starts unpublished with an empty draft", async () => {
    const { id, handle } = await svc.createProfile(alice, { handle: "@Alice_Main", label: "Main", displayName: "Alice" });
    expect(handle).toBe("alice_main");
    const r = await row(id);
    expect(r).toMatchObject({ is_published: false, draft_revision: 0, published_revision: null, published: null });
    expect(r.draft.header.displayName).toBe("Alice");
  });

  it("rejects reserved, invalid and duplicate handles, and extra fields", async () => {
    expect(await code(createFor(alice, "dashboard"))).toBe("VALIDATION");
    expect(await code(createFor(alice, "x"))).toBe("VALIDATION");
    await createFor(alice, "taken");
    expect(await code(createFor(bob, "Taken"))).toBe("CONFLICT");
    expect(await code(svc.createProfile(alice, { handle: "extra", label: "x", displayName: "x", ownerId: bob }))).toBe("VALIDATION");
  });

  it("enforces the per-user limit, even under concurrent creates", async () => {
    await setSetting("profiles.maxPerUser", 3, superId);
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => createFor(alice, `burst${i}`)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === "rejected")) expect((r.reason as AppError).code).toBe("LIMIT");
    expect(await svc.listProfiles(alice)).toHaveLength(3);
    expect(await svc.listProfiles(bob)).toHaveLength(0);
  });
});

describe("ownership (IDOR)", () => {
  it("never lets another user read or change a profile", async () => {
    const { id } = await createFor(alice, "alice");
    await svc.publishProfile(alice, id, { expectedRevision: 0 });
    const before = await row(id);

    expect(await code(svc.getOwnedProfile(bob, id))).toBe("NOT_FOUND");
    expect(await code(svc.saveDraft(bob, id, { expectedRevision: 0, patch: patch("Pwned") }))).toBe("NOT_FOUND");
    expect(await code(svc.publishProfile(bob, id, { expectedRevision: 0, patch: patch("Pwned") }))).toBe("NOT_FOUND");
    expect(await code(svc.unpublishProfile(bob, id))).toBe("NOT_FOUND");
    expect(await code(svc.revertDraft(bob, id, { expectedRevision: 0 }))).toBe("NOT_FOUND");
    expect(await code(svc.updateProfileMeta(bob, id, { handle: "stolen", label: "x" }))).toBe("NOT_FOUND");
    expect(await code(svc.deleteProfile(bob, id))).toBe("NOT_FOUND");
    expect(await svc.listProfiles(bob)).toEqual([]);

    expect(await row(id)).toEqual(before);
  });

  it("treats malformed ids as not found", async () => {
    for (const bad of ["", "not-a-uuid", "'; drop table profiles; --", "00000000-0000-0000-0000-000000000000"]) {
      expect(await code(svc.getOwnedProfile(alice, bad))).toBe("NOT_FOUND");
      expect(await code(svc.deleteProfile(alice, bad))).toBe("NOT_FOUND");
    }
  });

  it("ignores a tampered active-profile cookie pointing at someone else's profile", async () => {
    const mine = await createFor(alice, "alice");
    const theirs = await createFor(bob, "bob");
    const { active, all } = await resolveActiveProfile(alice, theirs.id);
    expect(active?.id).toBe(mine.id);
    expect(all.map((p) => p.id)).toEqual([mine.id]);
    expect((await resolveActiveProfile(alice, "garbage")).active?.id).toBe(mine.id);
  });

  it("shows the owned profile a page is about and asks to remember it", async () => {
    const first = await createFor(alice, "alice");
    const second = await createFor(alice, "alice-two");
    const viewed = await resolveActiveProfile(alice, first.id, second.id);
    expect(viewed.active?.id).toBe(second.id);
    expect(viewed.sync).toBe(true);
    // Already the remembered one, or no page profile: nothing to sync.
    expect(await resolveActiveProfile(alice, second.id, second.id)).toMatchObject({ active: { id: second.id }, sync: false });
    expect(await resolveActiveProfile(alice, first.id)).toMatchObject({ active: { id: first.id }, sync: false });
    // No cookie yet: the viewed profile still wins and is remembered.
    expect(await resolveActiveProfile(alice, undefined, second.id)).toMatchObject({ active: { id: second.id }, sync: true });
  });

  it("never shows or remembers someone else's profile passed as the page's profile", async () => {
    const mine = await createFor(alice, "alice");
    const mineToo = await createFor(alice, "alice-two");
    const theirs = await createFor(bob, "bob");
    for (const viewedId of [theirs.id, "garbage", "00000000-0000-0000-0000-000000000000"]) {
      const r = await resolveActiveProfile(alice, mineToo.id, viewedId);
      expect(r.active?.id).toBe(mineToo.id);
      expect(r.sync).toBe(false);
      expect(r.all.map((p) => p.id).sort()).toEqual([mine.id, mineToo.id].sort());
    }
  });
});

describe("narrow draft contract (header/SEO, plus validated blocks)", () => {
  it("rejects payloads that try to write invalid blocks, theme or other settings", async () => {
    const { id } = await createFor(alice, "alice");
    const crafted = [
      { expectedRevision: 0, patch: { ...patch("A"), blocks: [{ id: "x", type: "link", visible: true, config: {} }] } },
      { expectedRevision: 0, patch: { ...patch("A"), theme: { preset: "neon" } } },
      { expectedRevision: 0, patch: { ...patch("A"), settings: { showBranding: false } } },
      { expectedRevision: 0, document: createDefaultDocument("Full doc") },
      { expectedRevision: 0, patch: patch("A"), published: true },
    ];
    for (const input of crafted) expect(await code(svc.saveDraft(alice, id, input))).toBe("VALIDATION");
    expect(await code(svc.publishProfile(alice, id, crafted[1]))).toBe("VALIDATION");
    expect((await row(id)).draft_revision).toBe(0);
  });

  it("preserves stored blocks exactly (even a v1 link), theme and unrelated settings when the header changes", async () => {
    const { id } = await createFor(alice, "alice");
    const seeded = createDefaultDocument("Seeded");
    const block = {
      id: "11111111-1111-4111-8111-111111111111",
      type: "link",
      version: 1,
      visible: true,
      config: { title: "Site", url: "https://example.com/", icon: "none", featured: false },
    };
    const doc = { ...seeded, blocks: [block], theme: { ...seeded.theme, preset: "custom-x" }, settings: { ...seeded.settings, showBranding: false } };
    await testSql()`update profiles set draft = ${testSql().json(doc)} where id = ${id}`;

    await svc.saveDraft(alice, id, { expectedRevision: 0, patch: patch("New name", { bio: "New bio" }) });
    const r = await row(id);
    expect(r.draft.header.displayName).toBe("New name");
    expect(r.draft.blocks).toEqual([block]);
    expect(r.draft.theme.preset).toBe("custom-x");
    expect(r.draft.settings.showBranding).toBe(false);
  });
});

describe("revisions, save and atomic publish", () => {
  it("rejects stale saves and stale publishes without changing anything", async () => {
    const { id } = await createFor(alice, "alice");
    await svc.saveDraft(alice, id, { expectedRevision: 0, patch: patch("First") });
    const before = await row(id);
    expect(await code(svc.saveDraft(alice, id, { expectedRevision: 0, patch: patch("Stale") }))).toBe("CONFLICT");
    expect(await code(svc.publishProfile(alice, id, { expectedRevision: 0 }))).toBe("CONFLICT");
    expect(await code(svc.revertDraft(alice, id, { expectedRevision: 0 }))).toBe("CONFLICT");
    expect(await row(id)).toEqual(before);
  });

  it("save-and-publish is atomic: a failed publish leaves draft and published untouched", async () => {
    const { id } = await createFor(alice, "alice");
    await svc.publishProfile(alice, id, { expectedRevision: 0, patch: patch("Live v1") });
    const before = await row(id);
    expect(await code(svc.publishProfile(alice, id, { expectedRevision: 1, patch: patch("") }))).toBe("VALIDATION");
    expect(await row(id)).toEqual(before);
  });

  it("a concurrent save can never cause a different draft to be published", async () => {
    for (let round = 0; round < 10; round++) {
      await resetDatabaseKeepingUsers();
      const { id } = await createFor(alice, `race${round}`);
      const [saved, published] = await Promise.allSettled([
        svc.saveDraft(alice, id, { expectedRevision: 0, patch: patch("Saved concurrently") }),
        svc.publishProfile(alice, id, { expectedRevision: 0, patch: patch("Published version") }),
      ]);
      // Exactly one wins the revision; the loser gets CONFLICT.
      expect([saved.status, published.status].filter((s) => s === "fulfilled")).toHaveLength(1);
      const r = await row(id);
      if (published.status === "fulfilled") {
        expect(r.published?.header.displayName).toBe("Published version");
        expect(r.draft.header.displayName).toBe("Published version");
      } else {
        expect(((published as PromiseRejectedResult).reason as AppError).code).toBe("CONFLICT");
        expect(r.published).toBeNull();
        expect(r.draft.header.displayName).toBe("Saved concurrently");
      }
    }
  });

  it("tracks unpublished changes and discards them on revert", async () => {
    const { id } = await createFor(alice, "alice");
    await svc.publishProfile(alice, id, { expectedRevision: 0, patch: patch("Published") });
    expect((await svc.listProfiles(alice))[0]).toMatchObject({ isPublished: true, hasUnpublishedChanges: false });
    await svc.saveDraft(alice, id, { expectedRevision: 1, patch: patch("Draft only") });
    expect((await svc.listProfiles(alice))[0].hasUnpublishedChanges).toBe(true);
    const { revision } = await svc.revertDraft(alice, id, { expectedRevision: 2 });
    expect(revision).toBe(3);
    const r = await row(id);
    expect(r.draft.header.displayName).toBe("Published");
    expect((await svc.listProfiles(alice))[0].hasUnpublishedChanges).toBe(false);
  });
});

describe("public reads use only the published snapshot", () => {
  it("never exposes draft values in content or metadata", async () => {
    const { id } = await createFor(alice, "alice");
    await svc.publishProfile(alice, id, { expectedRevision: 0, patch: patch("Public Name", { bio: "Public bio", title: "Public title" }) });
    await svc.saveDraft(alice, id, { expectedRevision: 1, patch: patch("SECRET DRAFT", { bio: "SECRET BIO", title: "SECRET TITLE" }) });
    const view = await publicView("alice");
    expect(view?.doc?.header.displayName).toBe("Public Name");
    const meta = buildProfileMetadata({ published: view!.doc!, handle: "alice", appUrl: "http://localhost:3000", siteName: "COVALink" });
    expect(JSON.stringify(meta)).not.toContain("SECRET");
    expect(JSON.stringify(view)).not.toContain("SECRET");
  });

  it("is null for unknown, never-published, reserved and malformed handles", async () => {
    await createFor(alice, "alice");
    for (const h of ["alice", "nobody", "login", "A".repeat(40), "@alice", "ALICE", ""]) expect(await getLiveProfile(h)).toBeNull();
  });
});

describe("public visibility and cache invalidation across lifecycle events", () => {
  async function published(owner: string, handle: string) {
    const { id } = await createFor(owner, handle);
    await svc.publishProfile(owner, id, { expectedRevision: 0 });
    return id;
  }

  it("unpublish and delete take effect immediately", async () => {
    const id = await published(alice, "alice");
    expect(await publicView("alice")).not.toBeNull();
    await svc.unpublishProfile(alice, id);
    expect(await publicView("alice")).toBeNull();
    await svc.publishProfile(alice, id, { expectedRevision: 0 });
    expect(await publicView("alice")).not.toBeNull();
    await svc.deleteProfile(alice, id);
    expect(await publicView("alice")).toBeNull();
  });

  it("rename moves the page: old handle 404s, new handle serves, old handle reusable", async () => {
    const id = await published(alice, "alice");
    const r = await svc.updateProfileMeta(alice, id, { handle: "alice-new", label: "Main" });
    expect(r).toEqual({ id, previousHandle: "alice", handle: "alice-new" });
    expect(await publicView("alice")).toBeNull();
    expect((await publicView("alice-new"))?.live.id).toBe(id);
    await published(bob, "alice");
    expect((await publicView("alice"))?.live.ownerId).toBe(bob);
  });

  it("ban hides every profile of the owner at once and evicts owner, profile and handle tags; unban restores", async () => {
    const a1 = await published(alice, "alice");
    const a2 = await published(alice, "alice-two");
    await published(bob, "bob");
    clearInvalidatedTags();

    await setUserBanned(superId, alice, true);
    expect(await publicView("alice")).toBeNull();
    expect(await publicView("alice-two")).toBeNull();
    expect(await publicView("bob")).not.toBeNull();
    expect(invalidatedTags()).toEqual(
      expect.arrayContaining([`profile-owner:${alice}`, `profile:${a1}`, `profile:${a2}`, "profile-handle:alice", "profile-handle:alice-two"]),
    );
    expect(invalidatedTags().some((t) => t.includes(bob) || t === "profile-handle:bob")).toBe(false);

    clearInvalidatedTags();
    await setUserBanned(superId, alice, false);
    expect(await publicView("alice")).not.toBeNull();
    expect(invalidatedTags()).toContain(`profile-owner:${alice}`);
  });

  it("account deletion removes every public page of the owner and evicts their tags", async () => {
    const a1 = await published(alice, "alice");
    clearInvalidatedTags();
    const cookie = cookieFrom(await signIn("alice@example.com"));
    await deleteAccount(cookie);
    expect(await publicView("alice")).toBeNull();
    expect(invalidatedTags()).toEqual(expect.arrayContaining([`profile-owner:${alice}`, `profile:${a1}`, "profile-handle:alice"]));
  });

  it("does not misreport account deletion when best-effort owner eviction fails", async () => {
    await published(alice, "alice");
    const cookie = cookieFrom(await signIn("alice@example.com"));
    setPublicCacheInvalidator(() => {
      throw new Error("injected cache failure");
    });
    try {
      await deleteAccount(cookie);
      const [{ n }] = await testSql()`select count(*)::int as n from users where id = ${alice}`;
      expect(n).toBe(0);
    } finally {
      setPublicCacheInvalidator(recordInvalidation);
    }
  });
});

/** Clears profiles only, keeping the users created in beforeEach. */
async function resetDatabaseKeepingUsers() {
  await testSql()`delete from profiles`;
}
