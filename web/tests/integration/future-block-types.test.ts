import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The future-type invariant against real transactions. Every
 * shipped type is editable, so this fixture narrows the editable list to make a
 * registered type, `music`, noneditable: the state a staged future type would
 * be in. Removing the `nonEditable` count makes these tests fail, because such
 * a block would then be deleted silently by a list that leaves it out.
 */
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
}));
vi.mock("@/features/blocks/definitions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/blocks/definitions")>();
  return {
    ...real,
    EDITABLE_BLOCK_TYPES: real.EDITABLE_BLOCK_TYPES.filter((t) => t !== "music"),
    isEditableBlockType: (value: string) => value !== "music" && real.isEditableBlockType(value),
  };
});

import { toBlockInput, toEditorItems } from "@/components/editor/block-items";
import { createDefaultDocument } from "@/features/profiles/document";
import * as svc from "@/features/profiles/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { AppError } from "@/lib/errors";
import { signUp } from "../support/auth-http";
import { resetDatabase, testSql } from "../support/db";
import { TEST_SETUP_TOKEN } from "../support/test-env";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const header = { header: { displayName: "Ana", bio: "" }, seo: { noindex: false } };
const LINK = { id: ID(1), type: "link", version: 2, visible: true, config: { title: "Shop", url: "https://shop.example.com/" } };
const STAGED = { id: ID(2), type: "music", version: 2, visible: true, config: { url: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC" } };
const PROTECTED = /can't edit without losing data/;

let alice = "";
let profileId = "";

const rawRow = async () =>
  (
    await testSql()`select draft::text as draft, published::text as published, draft_revision, published_revision,
      is_published, draft_updated_at, published_at from profiles where id = ${profileId}`
  )[0];
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => {
      if (e instanceof AppError) return e;
      throw e;
    },
  );

const save = (expectedRevision: number, blocks?: unknown[]) => svc.saveDraft(alice, profileId, { expectedRevision, patch: { ...header, ...(blocks ? { blocks } : {}) } });
const publish = (expectedRevision: number, blocks?: unknown[]) => svc.publishProfile(alice, profileId, { expectedRevision, ...(blocks ? { patch: { ...header, blocks } } : {}) });

const EDITED_LINK = { id: ID(1), type: "link", visible: true, config: { title: "Edited", url: "https://shop.example.com/" } };
/** What a client could send: omitting the block, a stale preserve entry, or trying to edit it. */
const CLIENT_LISTS: [string, unknown[]][] = [
  ["a list that omits it", [EDITED_LINK]],
  ["an empty list", []],
  ["a stale preserve entry", [{ id: ID(2), preserve: true }, EDITED_LINK]],
  ["an edit of the block", [{ id: ID(2), type: "music", visible: true, config: { url: STAGED.config.url, title: "Edited" } }, EDITED_LINK]],
];

beforeEach(async () => {
  await resetDatabase();
  await bootstrapSuperAdmin({ token: TEST_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: "correct-horse-battery" });
  expect((await signUp("alice@example.com")).status).toBe(200);
  alice = ((await testSql()`select id from users where email = 'alice@example.com'`)[0] as { id: string }).id;
  profileId = (await svc.createProfile(alice, { handle: "ana", label: "ana", displayName: "Ana" })).id;
  const base = createDefaultDocument("Ana");
  await testSql()`update profiles set draft = ${testSql().json({ ...base, blocks: [STAGED, LINK] })},
    published = ${testSql().json({ ...base, blocks: [LINK] })},
    draft_revision = 1, published_revision = 1, is_published = true, published_at = now() where id = ${profileId}`;
});

describe("a draft holding a registered, noneditable block", () => {
  it("is reported as protected, and the editor never receives the block", async () => {
    const owned = await svc.getOwnedProfile(alice, profileId);
    expect(owned.protectedBlocks).toBe(1);
    expect(toBlockInput(toEditorItems(owned.draft.blocks)).map((b) => b.id)).toEqual([ID(1)]);
  });

  it("refuses a header-only save and a stored-draft publish, changing nothing", async () => {
    const before = await rawRow();
    for (const write of [() => save(1), () => publish(1)]) expect((await failure(write()))?.message).toMatch(PROTECTED);
    expect(await rawRow()).toEqual(before);
  });

  it.each(CLIENT_LISTS)("refuses %s with the protected message, on save and save-and-publish, changing nothing", async (_label, blocks) => {
    const before = await rawRow();
    for (const write of [() => save(1, blocks), () => publish(1, blocks)]) {
      const err = await failure(write());
      expect(err?.code).toBe("VALIDATION");
      expect(err?.message).toMatch(PROTECTED);
      expect(err?.blockErrors).toBeUndefined();
    }
    expect(await rawRow()).toEqual(before);
    const draft = JSON.parse((before as { draft: string }).draft) as { blocks: unknown[] };
    expect(draft.blocks[0]).toEqual(STAGED);
  });

  it("still discards, restoring the published version", async () => {
    await svc.revertDraft(alice, profileId, { expectedRevision: 1 });
    const after = await rawRow();
    expect((JSON.parse((after as { draft: string }).draft) as { blocks: { id: string }[] }).blocks.map((b) => b.id)).toEqual([ID(1)]);
    expect((await svc.getOwnedProfile(alice, profileId)).protectedBlocks).toBe(0);
  });
});
