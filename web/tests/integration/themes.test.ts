import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Themes against the real database: the theme write contract, exact
 * preservation of stored themes the editor can't carry, the confirmed
 * replacement, publication isolation and contrast enforcement, concurrency,
 * cache eviction and authorization. Server Actions use a mocked session.
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
import type { ThemeInput } from "@/features/themes/schema";
import { canonicalTheme, DEFAULT_THEME, presetTheme } from "@/features/themes/theme";
import { AppError } from "@/lib/errors";
import { signUp } from "../support/auth-http";
import { clearInvalidatedTags, invalidatedTags } from "../support/cache-spy";
import { resetDatabase, testSql } from "../support/db";
import { TEST_SETUP_TOKEN } from "../support/test-env";

let alice: string;
let bob: string;

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const idOf = async (email: string) => ((await testSql()`select id from users where email = ${email}`)[0] as { id: string }).id;
const header = { header: { displayName: "Alice", bio: "" }, seo: { noindex: false } };
const as = (id: string | null) => {
  session.user = id ? { id, name: id, email: `${id}@example.com`, emailVerified: true, role: "user" } : null;
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const neon = (): ThemeInput => clone(getPreset("neon").theme);

/** The older stored default (no `version`), as every existing profile has it. */
const LEGACY = {
  preset: "minimal",
  background: { type: "solid", color: "#fafafa", gradientTo: "#f4f4f5", gradientAngle: 180, overlayOpacity: 0 },
  text: { color: "#18181b", muted: "#52525b" },
  accent: "#18181b",
  button: { variant: "outline", color: "#18181b", textColor: "#18181b", radius: "md", shadow: "none", borderWidth: 1 },
  font: { body: "inter", heading: "inter", scale: "md" },
  layout: { width: "normal", spacing: "normal", align: "center" },
  avatar: { shape: "circle", size: "md", ring: false },
  social: { style: "icon" },
};
/** Compatible (class B) themes: valid and rendered, but not round-trippable by the editor. */
const LOCKED = {
  "custom-x": { ...LEGACY, preset: "custom-x" },
  "unknown keys (blank and null)": { ...LEGACY, futureFlag: "", button: { ...LEGACY.button, glow: null } },
  image: { ...LEGACY, background: { ...LEGACY.background, type: "image", imageUrl: "https://img.example.com/bg.png", overlayOpacity: 0.4 } },
};
/** Unreadable (class C) themes. */
const INVALID = {
  "a newer version": { ...presetTheme("neon"), version: 2, futureAxis: { x: 1 } },
  "an invalid color": { ...LEGACY, accent: "red" },
};

const LINK = { id: ID(1), type: "link", version: 2, visible: true, config: { title: "Shop", url: "https://example.com/" } };

/** Exact stored state, as text, for byte-level stability checks. */
const rawRow = async (id: string) =>
  (
    await testSql()`select draft::text as draft, published::text as published, draft_revision, published_revision,
      is_published, draft_updated_at, published_at from profiles where id = ${id}`
  )[0];
const storedTheme = async (id: string) =>
  (await testSql()`select draft->'theme' as draft, published->'theme' as published, (draft->'theme')::text as draft_text,
      (published->'theme')::text as published_text from profiles where id = ${id}`)[0] as {
    draft: unknown;
    published: unknown;
    draft_text: string | null;
    published_text: string | null;
  };
const storedDraft = async (id: string) => ((await testSql()`select draft from profiles where id = ${id}`)[0] as { draft: Record<string, unknown> }).draft;

async function code(p: Promise<unknown>): Promise<string | null> {
  return p.then(
    () => null,
    (e: unknown) => (e instanceof AppError ? e.code : `non-AppError: ${String(e)}`),
  );
}
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as AppError);

async function createFor(owner: string, handle: string) {
  return (await svc.createProfile(owner, { handle, label: handle, displayName: "Alice" })).id;
}

const save = (owner: string, id: string, expectedRevision: number, extra: Record<string, unknown> = {}) =>
  svc.saveDraft(owner, id, { expectedRevision, patch: { ...header, ...extra } });

/**
 * Writes stored JSON directly (as an older or newer version might have):
 * a draft with the given theme, a block, an unrelated setting and an unknown
 * top-level field. With `published`, the profile is live at revision 1.
 */
async function seed(id: string, theme: unknown, published?: unknown) {
  const base = createDefaultDocument("Alice");
  const draft = { ...base, theme, blocks: [LINK], settings: { ...base.settings, showBranding: false, futureSetting: "keep" }, futureTop: { a: 1 } };
  if (published !== undefined) {
    await testSql()`update profiles set draft = ${testSql().json(draft)}, published = ${testSql().json({ ...base, theme: published })},
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
  clearInvalidatedTags();
  session.user = null;
  await bootstrapSuperAdmin({ token: TEST_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: "correct-horse-battery" });
  for (const email of ["alice@example.com", "bob@example.com"]) expect((await signUp(email)).status).toBe(200);
  [alice, bob] = await Promise.all(["alice@example.com", "bob@example.com"].map(idOf));
});

describe("theme write contract", () => {
  it("replaces the whole theme with the server-stamped canonical form, keeping header, blocks, settings and unrelated fields", async () => {
    const id = await createFor(alice, "alice");
    await seed(id, LEGACY);
    const theme = { ...neon(), accent: "#FF66CC" };
    const r = await save(alice, id, 0, { theme });
    expect(r.appearance).toEqual({ status: "editable", reasons: [] });

    const draft = await storedDraft(id);
    expect(draft.theme).toEqual(canonicalTheme({ ...neon(), accent: "#ff66cc" }));
    expect((draft.theme as { version: number }).version).toBe(1);
    expect(draft.blocks).toEqual([LINK]);
    expect(draft.settings).toMatchObject({ showBranding: false, futureSetting: "keep" });
    expect(draft.futureTop).toEqual({ a: 1 });
    expect((await storedTheme(id)).published).toBeNull();
  });

  it("a content save never rewrites a legacy theme (no version is added)", async () => {
    const id = await createFor(alice, "alice");
    await seed(id, LEGACY);
    const before = (await storedTheme(id)).draft_text;
    await save(alice, id, 0);
    await save(alice, id, 1, { blocks: [{ id: ID(1), type: "link", visible: false, config: { title: "Shop", url: "example.com" } }] });
    expect((await storedTheme(id)).draft_text).toBe(before);
    expect((await storedDraft(id)).theme).not.toHaveProperty("version");
  });

  it("returns per-field errors for invalid theme input, never Zod internals, and writes nothing", async () => {
    const id = await createFor(alice, "alice");
    const before = await rawRow(id);
    const bad = { ...neon(), accent: "red", version: 1, button: { ...neon().button, borderWidth: 9, css: "x" } };
    const err = await failure(save(alice, id, 0, { theme: bad }));
    expect(err).toBeInstanceOf(AppError);
    expect(err?.message).toBe("Some appearance settings need attention.");
    expect(err?.fieldErrors).toEqual({
      theme: ["This setting isn't supported."],
      "theme.accent": ["Use a 6-digit hex color like #1a2b3c"],
      "theme.button": ["This setting isn't supported."],
      "theme.button.borderWidth": ["Use 0 to 3 pixels"],
    });
    expect(JSON.stringify(err?.fieldErrors)).not.toMatch(/version|css|ZodError|issues/);
    expect(await rawRow(id)).toEqual(before);
  });

  it("rejects prototype-related keys, an image background, a client version and a theme combined with a replacement", async () => {
    const id = await createFor(alice, "alice");
    const before = await rawRow(id);
    const json = JSON.stringify(neon());
    for (const theme of [
      JSON.parse(json.replace(/^\{/, '{"__proto__":{"polluted":true},')),
      JSON.parse(json.replace('"text":{', '"text":{"constructor":{"prototype":{}},')),
      { ...neon(), background: { ...neon().background, type: "image", imageUrl: "https://img.example.com/x.png" } },
      { ...neon(), version: 1 },
    ]) {
      expect(await code(save(alice, id, 0, { theme }))).toBe("VALIDATION");
    }
    expect(await code(save(alice, id, 0, { theme: neon(), replaceTheme: "neon" }))).toBe("VALIDATION");
    expect(await rawRow(id)).toEqual(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("stored themes the editor can't carry", () => {
  it.each(Object.entries(LOCKED))("compatible (%s): content saves and publishes keep it exactly; the editor can't change it", async (_label, raw) => {
    const id = await createFor(alice, "alice");
    await seed(id, raw);
    expect((await svc.getOwnedProfile(alice, id)).appearance.status).toBe("locked");
    const exact = (await storedTheme(id)).draft_text;

    await save(alice, id, 0); // header-only
    await save(alice, id, 1, { blocks: [{ id: ID(1), type: "link", visible: true, config: { title: "Shop", url: "https://example.com/" } }] }); // block save
    expect((await storedTheme(id)).draft_text).toBe(exact);

    // A submitted theme is refused; nothing changes.
    const before = await rawRow(id);
    const err = await failure(save(alice, id, 2, { theme: neon() }));
    expect(err?.message).toMatch(/can't be edited here/);
    expect(await rawRow(id)).toEqual(before);

    // Publishing (stored draft, then with a patch) publishes it exactly as stored.
    await svc.publishProfile(alice, id, { expectedRevision: 2 });
    expect((await storedTheme(id)).published_text).toBe(exact);
    await svc.publishProfile(alice, id, { expectedRevision: 2, patch: header });
    const t = await storedTheme(id);
    expect([t.draft_text, t.published_text]).toEqual([exact, exact]);
  });

  it("the image background is preserved but never rendered: the page shows its background color", async () => {
    const id = await createFor(alice, "alice");
    await seed(id, LOCKED.image);
    await svc.publishProfile(alice, id, { expectedRevision: 0 });
    const html = (await publicHtml("alice")) ?? "";
    expect(html).toContain("--pp-bg:#fafafa");
    expect(html).not.toMatch(/url\(|img\.example\.com/);
  });

  it.each(Object.entries(INVALID))("unreadable (%s): draft saves keep it exactly; publishing is blocked in both forms", async (_label, raw) => {
    const id = await createFor(alice, "alice");
    await seed(id, raw);
    const owned = await svc.getOwnedProfile(alice, id);
    expect(owned.appearance).toEqual({ status: "invalid", reasons: [] });
    expect(owned.draft.theme).toEqual(DEFAULT_THEME);
    const exact = (await storedTheme(id)).draft_text;

    const saved = await save(alice, id, 0, { header: { displayName: "Alice Renamed", bio: "" } });
    expect(saved.appearance.status).toBe("invalid");
    expect((await storedTheme(id)).draft_text).toBe(exact);
    expect((await storedDraft(id)).header).toMatchObject({ displayName: "Alice Renamed" });

    const before = await rawRow(id);
    for (const attempt of [
      svc.publishProfile(alice, id, { expectedRevision: 1 }),
      svc.publishProfile(alice, id, { expectedRevision: 1, patch: header }),
      save(alice, id, 1, { theme: neon() }),
    ]) {
      const err = await failure(attempt);
      expect(err?.code).toBe("VALIDATION");
    }
    expect((await failure(svc.publishProfile(alice, id, { expectedRevision: 1 })))?.message).toMatch(/can't be read/);
    expect(await rawRow(id)).toEqual(before);
  });

  it("an unreadable published theme falls back to the default theme without failing the page", async () => {
    const id = await createFor(alice, "alice");
    await seed(id, LEGACY, INVALID["a newer version"]);
    const html = await publicHtml("alice");
    expect(html).toContain("--pp-bg:#fafafa");
    expect(html).toContain("Made with COVALink");
  });

  it("confirmed replacement writes a preset over a locked or unreadable theme, preserving everything else", async () => {
    for (const raw of [LOCKED["custom-x"], INVALID["a newer version"]]) {
      await testSql()`delete from profiles`;
      const id = await createFor(alice, "alice");
      await seed(id, raw);
      // Stale and foreign replacements are refused first.
      expect(await code(save(alice, id, 5, { replaceTheme: "glass" }))).toBe("CONFLICT");
      expect(await code(save(bob, id, 0, { replaceTheme: "glass" }))).toBe("NOT_FOUND");

      const r = await save(alice, id, 0, { replaceTheme: "glass" });
      expect(r).toMatchObject({ revision: 1, appearance: { status: "editable" } });
      const draft = await storedDraft(id);
      expect(draft.theme).toEqual(presetTheme("glass"));
      expect(draft.blocks).toEqual([LINK]);
      expect(draft.settings).toMatchObject({ showBranding: false, futureSetting: "keep" });
      expect(draft.futureTop).toEqual({ a: 1 });
      // Now editable and publishable.
      await save(alice, id, 1, { theme: { ...getPreset("glass").theme, accent: "#99f6e4" } });
      await svc.publishProfile(alice, id, { expectedRevision: 2 });
      expect((await storedTheme(id)).published).toEqual(canonicalTheme({ ...getPreset("glass").theme, accent: "#99f6e4" }));
    }
  });
});

describe("contrast enforcement (server)", () => {
  const unreadable = (): ThemeInput => ({ ...neon(), text: { color: "#111111", muted: "#a3a3a3" } }); // near-black text on #050505

  it("saving an inaccessible draft works; publishing it is refused with field errors and changes nothing", async () => {
    const id = await createFor(alice, "alice");
    await save(alice, id, 0, { theme: unreadable() });
    const before = await rawRow(id);

    const stored = await failure(svc.publishProfile(alice, id, { expectedRevision: 1 }));
    expect(stored?.message).toBe("This appearance doesn't have enough contrast to publish. Fix the highlighted colors, then try again.");
    expect(Object.keys(stored?.fieldErrors ?? {})).toEqual(["theme.text.color"]);
    expect(stored?.fieldErrors?.["theme.text.color"]?.[0]).toMatch(/^Text contrast is 1\.\d\d:1 against the background; it needs at least 4\.5:1\.$/);

    // Save-and-publish with an inaccessible theme also writes nothing (the draft isn't saved either).
    expect(await code(svc.publishProfile(alice, id, { expectedRevision: 1, patch: { ...header, theme: { ...unreadable(), accent: "#000000" } } }))).toBe("VALIDATION");
    expect(await rawRow(id)).toEqual(before);

    const ok = await svc.publishProfile(alice, id, { expectedRevision: 1, patch: { ...header, theme: neon() } });
    expect(ok.revision).toBe(2);
    expect((await storedTheme(id)).published).toEqual(presetTheme("neon"));
  });

  it("a locked theme that fails contrast can't be published either", async () => {
    const id = await createFor(alice, "alice");
    await seed(id, { ...LOCKED["custom-x"], text: { color: "#fafafa", muted: "#52525b" } });
    const err = await failure(svc.publishProfile(alice, id, { expectedRevision: 0 }));
    expect(err?.fieldErrors).toHaveProperty(["theme.text.color"]);
  });

  it("a page already published with colors that fail a later check stays online", async () => {
    const id = await createFor(alice, "alice");
    await seed(id, LEGACY, { ...LEGACY, text: { color: "#fafafa", muted: "#fafafa" } });
    expect(await publicHtml("alice")).toContain("--pp-text:#fafafa");
  });
});

describe("publication and discard", () => {
  it("public pages use only the published theme; publish copies the draft theme; discard restores it", async () => {
    const id = await createFor(alice, "alice");
    const a = neon();
    const b = { ...neon(), accent: "#22d3ee" };
    await save(alice, id, 0, { theme: a });
    await svc.publishProfile(alice, id, { expectedRevision: 1 });
    await save(alice, id, 1, { theme: b });

    const t = await storedTheme(id);
    expect(t.published).toEqual(canonicalTheme(a));
    expect(t.draft).toEqual(canonicalTheme(b));
    const html = (await publicHtml("alice")) ?? "";
    expect(html).toContain("--pp-accent:#a3e635");
    expect(html).not.toContain("#22d3ee");

    await svc.revertDraft(alice, id, { expectedRevision: 2 });
    const reverted = await storedTheme(id);
    expect(reverted.draft_text).toBe(reverted.published_text);
    expect((await svc.getOwnedProfile(alice, id)).appearance.status).toBe("editable");
  });

  it("discard restores a published theme the editor can't carry exactly as stored", async () => {
    const id = await createFor(alice, "alice");
    await seed(id, LEGACY, LOCKED["unknown keys (blank and null)"]);
    await save(alice, id, 1, { theme: neon() });
    await svc.revertDraft(alice, id, { expectedRevision: 2 });
    const t = await storedTheme(id);
    expect(t.draft_text).toBe(t.published_text);
    expect(t.draft).toEqual(LOCKED["unknown keys (blank and null)"]);
  });
});

describe("concurrency", () => {
  it("rejects a stale theme save", async () => {
    const id = await createFor(alice, "alice");
    await save(alice, id, 0, { theme: neon() });
    const before = await rawRow(id);
    expect(await code(save(alice, id, 0, { theme: { ...neon(), accent: "#ffffff" } }))).toBe("CONFLICT");
    expect(await rawRow(id)).toEqual(before);
  });

  /**
   * Publishing the stored draft keeps its revision, so "publish, then save" both succeed; "save,
   * then publish" makes the publish stale. Either way only a theme that was saved at the
   * expected revision can be published, never the concurrent newer one.
   */
  it("a concurrent theme save and publish from the same revision never publish the unsaved theme", async () => {
    for (let round = 0; round < 8; round++) {
      await testSql()`delete from profiles`;
      const id = await createFor(alice, "alice");
      await save(alice, id, 0, { theme: neon() });
      const next = { ...neon(), accent: "#f472b6" };
      const [saved, published] = await Promise.all([
        code(save(alice, id, 1, { theme: next })),
        code(svc.publishProfile(alice, id, { expectedRevision: 1 })),
      ]);
      expect(saved, `round ${round}`).toBeNull();
      expect([null, "CONFLICT"], `round ${round}`).toContain(published);
      const t = await storedTheme(id);
      expect(t.draft).toEqual(canonicalTheme(next));
      expect(t.published).toEqual(published === null ? presetTheme("neon") : null);
    }
  });
});

describe("cache and authorization", () => {
  it("publishing a theme change evicts the profile's public tags; a draft theme save evicts nothing", async () => {
    const id = await createFor(alice, "alice");
    as(alice);
    const saved = await actions.saveDraftAction(id, { expectedRevision: 0, patch: { ...header, theme: neon() } });
    expect(saved).toMatchObject({ ok: true, data: { revision: 1, appearance: { status: "editable" }, theme: { accent: "#a3e635" } } });
    expect(invalidatedTags()).toEqual([]);
    const published = await actions.publishAction(id, { expectedRevision: 1 });
    expect(published).toMatchObject({ ok: true, data: { theme: { preset: "neon" } } });
    expect(invalidatedTags()).toEqual([`profile:${id}`, "profile-handle:alice"]);
  });

  it("another user can't save, publish or replace someone else's theme", async () => {
    const id = await createFor(alice, "alice");
    await save(alice, id, 0, { theme: neon() });
    const before = await rawRow(id);
    expect(await code(save(bob, id, 1, { theme: { ...neon(), accent: "#ffffff" } }))).toBe("NOT_FOUND");
    expect(await code(save(bob, id, 1, { replaceTheme: "music" }))).toBe("NOT_FOUND");
    expect(await code(svc.publishProfile(bob, id, { expectedRevision: 1, patch: { ...header, theme: neon() } }))).toBe("NOT_FOUND");
    expect(await rawRow(id)).toEqual(before);
  });

  it("theme actions need a session, scope to the owner and return safe field errors", async () => {
    const id = await createFor(alice, "alice");
    const input = { expectedRevision: 0, patch: { ...header, theme: neon() } };
    as(null);
    expect(await actions.saveDraftAction(id, input)).toEqual({ ok: false, error: "Your session has expired. Please sign in again." });
    expect(await actions.publishAction(id, input)).toEqual({ ok: false, error: "Your session has expired. Please sign in again." });
    as(bob);
    expect(await actions.saveDraftAction(id, input)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await actions.saveDraftAction(id, { expectedRevision: 0, patch: { ...header, replaceTheme: "music" } })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    as(alice);
    expect(await actions.saveDraftAction(id, { expectedRevision: 0, patch: { ...header, theme: { ...neon(), accent: "#12" } } })).toEqual({
      ok: false,
      error: "Some appearance settings need attention.",
      code: "VALIDATION",
      fieldErrors: { "theme.accent": ["Use a 6-digit hex color like #1a2b3c"] },
      blockErrors: undefined,
    });
    expect((await rawRow(id)).draft_revision).toBe(0);
  });
});
