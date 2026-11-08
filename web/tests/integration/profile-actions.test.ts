import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server Actions are reachable over HTTP by anyone, so their own session check
 * and the tags they evict matter. The session and cookie jar are mocked; the
 * database, services and invalidation path are real.
 */
const session = vi.hoisted(() => ({ user: null as null | { id: string; name: string; email: string; emailVerified: boolean; role: "user" } }));
const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => session.user }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

import * as actions from "@/features/profiles/actions";
import { ACTIVE_PROFILE_COOKIE } from "@/features/profiles/active";
import { setPublicCacheInvalidator } from "@/features/profiles/cache";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { signUp } from "../support/auth-http";
import { clearInvalidatedTags, invalidatedTags, recordInvalidation } from "../support/cache-spy";
import { resetDatabase, testSql } from "../support/db";
import { TEST_SETUP_TOKEN } from "../support/test-env";

let alice: string;
let bob: string;
const as = (id: string | null) => {
  session.user = id ? { id, name: id, email: `${id}@example.com`, emailVerified: true, role: "user" } : null;
};
const idOf = async (email: string) => ((await testSql()`select id from users where email = ${email}`)[0] as { id: string }).id;
const header = (displayName: string) => ({ header: { displayName, bio: "" }, seo: { noindex: false } });

beforeEach(async () => {
  await resetDatabase();
  clearInvalidatedTags();
  jar.clear();
  await bootstrapSuperAdmin({ token: TEST_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: "correct-horse-battery" });
  for (const email of ["alice@example.com", "bob@example.com"]) expect((await signUp(email)).status).toBe(200);
  [alice, bob] = await Promise.all(["alice@example.com", "bob@example.com"].map(idOf));
});

describe("profile server actions", () => {
  it("refuse every call without a session and change nothing", async () => {
    as(null);
    const results = await Promise.all([
      actions.createProfileAction({ handle: "anon", label: "x", displayName: "x" }),
      actions.publishAction("00000000-0000-4000-8000-000000000000", { expectedRevision: 0 }),
      actions.deleteProfileAction("00000000-0000-4000-8000-000000000000"),
    ]);
    for (const r of results) expect(r).toEqual({ ok: false, error: "Your session has expired. Please sign in again." });
    const [{ n }] = await testSql()`select count(*)::int as n from profiles`;
    expect(n).toBe(0);
  });

  it("create sets the active profile; select refuses someone else's profile", async () => {
    as(alice);
    const created = await actions.createProfileAction({ handle: "alice", label: "Main", displayName: "Alice" });
    expect(created.ok).toBe(true);
    const aliceProfile = created.ok ? created.data.id : "";
    expect(jar.get(ACTIVE_PROFILE_COOKIE)).toBe(aliceProfile);

    as(bob);
    jar.clear();
    const r = await actions.selectProfileAction(aliceProfile);
    expect(r).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(jar.has(ACTIVE_PROFILE_COOKIE)).toBe(false);
  });

  it("return NOT_FOUND for another user's profile on every mutation", async () => {
    as(alice);
    const created = await actions.createProfileAction({ handle: "alice", label: "Main", displayName: "Alice" });
    const id = created.ok ? created.data.id : "";
    as(bob);
    for (const r of [
      await actions.saveDraftAction(id, { expectedRevision: 0, patch: header("Pwned") }),
      await actions.publishAction(id, { expectedRevision: 0, patch: header("Pwned") }),
      await actions.unpublishAction(id),
      await actions.revertDraftAction(id, { expectedRevision: 0 }),
      await actions.updateProfileMetaAction(id, { handle: "stolen", label: "x" }),
      await actions.deleteProfileAction(id),
    ]) {
      expect(r).toMatchObject({ ok: false, code: "NOT_FOUND" });
    }
    expect(invalidatedTags()).toEqual([]);
  });

  it("evict the right public cache tags on publish, rename, unpublish and delete", async () => {
    as(alice);
    const created = await actions.createProfileAction({ handle: "alice", label: "Main", displayName: "Alice" });
    const id = created.ok ? created.data.id : "";

    expect((await actions.publishAction(id, { expectedRevision: 0, patch: header("Alice") })).ok).toBe(true);
    expect(invalidatedTags()).toEqual([`profile:${id}`, "profile-handle:alice"]);

    clearInvalidatedTags();
    expect((await actions.updateProfileMetaAction(id, { handle: "alice-new", label: "Main" })).ok).toBe(true);
    expect(invalidatedTags()).toEqual([`profile:${id}`, "profile-handle:alice", "profile-handle:alice-new"]);

    clearInvalidatedTags();
    expect((await actions.unpublishAction(id)).ok).toBe(true);
    expect(invalidatedTags()).toEqual([`profile:${id}`, "profile-handle:alice-new"]);

    clearInvalidatedTags();
    jar.set(ACTIVE_PROFILE_COOKIE, id);
    expect((await actions.deleteProfileAction(id)).ok).toBe(true);
    expect(invalidatedTags()).toEqual([`profile:${id}`, "profile-handle:alice-new"]);
    expect(jar.has(ACTIVE_PROFILE_COOKIE)).toBe(false);
  });

  it("surface CONFLICT for stale revisions so the editor can offer a reload", async () => {
    as(alice);
    const created = await actions.createProfileAction({ handle: "alice", label: "Main", displayName: "Alice" });
    const id = created.ok ? created.data.id : "";
    expect((await actions.saveDraftAction(id, { expectedRevision: 0, patch: header("Tab A") })).ok).toBe(true);
    expect(await actions.saveDraftAction(id, { expectedRevision: 0, patch: header("Tab B") })).toMatchObject({ ok: false, code: "CONFLICT" });
  });

  it("reports committed mutations as successful when best-effort cache eviction fails", async () => {
    as(alice);
    const created = await actions.createProfileAction({ handle: "alice", label: "Main", displayName: "Alice" });
    const id = created.ok ? created.data.id : "";
    setPublicCacheInvalidator(() => {
      throw new Error("injected cache failure");
    });
    try {
      expect((await actions.publishAction(id, { expectedRevision: 0, patch: header("Alice") })).ok).toBe(true);
      expect((await actions.updateProfileMetaAction(id, { handle: "alice-new", label: "Main" })).ok).toBe(true);
      expect((await actions.unpublishAction(id)).ok).toBe(true);
      expect((await actions.deleteProfileAction(id)).ok).toBe(true);
      const [{ n }] = await testSql()`select count(*)::int as n from profiles where id = ${id}`;
      expect(n).toBe(0);
    } finally {
      setPublicCacheInvalidator(recordInvalidation);
    }
  });
});
