import { describe, expect, it } from "vitest";
import { createDefaultDocument } from "@/features/profiles/document";
import { resolveHandleParam } from "@/features/profiles/handle";
import { draftPatchSchema } from "@/features/profiles/draft-input";
import { buildProfileMetadata } from "@/features/profiles/metadata";

describe("resolveHandleParam (public /{segment})", () => {
  it("serves valid canonical handles", () => {
    expect(resolveHandleParam("alice")).toEqual({ kind: "ok", handle: "alice" });
    expect(resolveHandleParam("a1_b-c")).toEqual({ kind: "ok", handle: "a1_b-c" });
  });

  it("redirects only the @-prefixed and uppercase forms to the canonical handle", () => {
    expect(resolveHandleParam("@alice")).toEqual({ kind: "redirect", handle: "alice" });
    expect(resolveHandleParam("Alice")).toEqual({ kind: "redirect", handle: "alice" });
    expect(resolveHandleParam("@ALICE")).toEqual({ kind: "redirect", handle: "alice" });
  });

  it.each([
    ["empty", ""],
    ["too short", "a"],
    ["too long but valid chars", "a".repeat(31)],
    ["extremely long", "a".repeat(5000)],
    ["double @", "@@alice"],
    ["encoded slash (decoded)", "alice/x"],
    ["dot segment", ".."],
    ["space", "ali ce"],
    ["percent sequence", "alice%00"],
    ["accented (not auto-fixed)", "zoë"],
    ["leading hyphen", "-alice"],
    ["reserved", "login"],
    ["reserved via @", "@admin"],
    ["reserved uppercase", "DASHBOARD"],
    ["file-like", "robots.txt"],
    ["emoji", "🙂"],
  ])("returns 404 for %s", (_label, segment) => {
    expect(resolveHandleParam(segment)).toEqual({ kind: "not_found" });
  });
});

describe("draftPatchSchema (narrow contract: header, SEO, blocks and theme)", () => {
  const valid = {
    header: { displayName: "Alice", bio: "Hi", avatarUrl: "https://img.example.com/a.png" },
    seo: { title: "", description: "", noindex: false },
  };

  it("accepts header and SEO fields only", () => {
    const r = draftPatchSchema.safeParse(valid);
    expect(r.success).toBe(true);
    expect(r.data?.seo.title).toBeUndefined();
  });

  it("accepts a block list (checked separately by resolveBlockList) and an omitted one", () => {
    expect(draftPatchSchema.safeParse({ ...valid, blocks: [] }).success).toBe(true);
    expect(draftPatchSchema.safeParse({ ...valid, blocks: [{ anything: true }] }).success).toBe(true);
    expect(draftPatchSchema.parse(valid).blocks).toBeUndefined();
  });

  // The theme is now part of the contract. Its strict input is checked by the
  // service (themeInputSchema, tests/unit/themes.test.ts and integration); a replacement
  // names a preset, and the two can't be combined.
  it("accepts a theme (checked separately) or a replacement preset, never both", () => {
    expect(draftPatchSchema.safeParse({ ...valid, theme: {} }).success).toBe(true);
    expect(draftPatchSchema.parse(valid).theme).toBeUndefined();
    expect(draftPatchSchema.safeParse({ ...valid, replaceTheme: "neon" }).success).toBe(true);
    expect(draftPatchSchema.safeParse({ ...valid, replaceTheme: "custom-x" }).success).toBe(false);
    expect(draftPatchSchema.safeParse({ ...valid, theme: {}, replaceTheme: "neon" }).success).toBe(false);
  });

  it.each([
    ["blocks that aren't a list", { ...valid, blocks: { 0: {} } }],
    ["settings", { ...valid, settings: { showBranding: false } }],
    ["extra header key", { ...valid, header: { ...valid.header, verified: true } }],
    ["extra seo key", { ...valid, seo: { ...valid.seo, canonical: "https://evil.example" } }],
  ])("rejects a payload carrying %s", (_label, payload) => {
    expect(draftPatchSchema.safeParse(payload).success).toBe(false);
  });

  it.each(["http://img.example.com/a.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "ftp://img.example.com/a.png"])(
    "rejects avatar URL %s",
    (avatarUrl) => {
      expect(draftPatchSchema.safeParse({ ...valid, header: { ...valid.header, avatarUrl } }).success).toBe(false);
    },
  );

  it("normalizes scheme-less and protocol-relative avatar URLs to https", () => {
    for (const avatarUrl of ["img.example.com/a.png", "//img.example.com/a.png"]) {
      const r = draftPatchSchema.parse({ ...valid, header: { ...valid.header, avatarUrl } });
      expect(r.header.avatarUrl).toBe("https://img.example.com/a.png");
    }
  });

  it("enforces lengths", () => {
    expect(draftPatchSchema.safeParse({ ...valid, header: { ...valid.header, displayName: " " } }).success).toBe(false);
    expect(draftPatchSchema.safeParse({ ...valid, header: { ...valid.header, bio: "x".repeat(301) } }).success).toBe(false);
    expect(draftPatchSchema.safeParse({ ...valid, seo: { ...valid.seo, title: "x".repeat(71) } }).success).toBe(false);
  });
});

describe("buildProfileMetadata", () => {
  const published = createDefaultDocument("Public Alice");
  published.header.bio = "Published bio";
  const base = { handle: "alice", appUrl: "https://links.example.com", siteName: "COVALink" };

  it("derives title, description, canonical and Open Graph from the published document", () => {
    const m = buildProfileMetadata({ ...base, published });
    expect(m.title).toEqual({ absolute: "Public Alice" });
    expect(m.description).toBe("Published bio");
    expect(m.alternates?.canonical).toBe("https://links.example.com/alice");
    expect(m.openGraph).toMatchObject({ title: "Public Alice", url: "https://links.example.com/alice", type: "profile" });
    expect(m.robots).toEqual({ index: true, follow: true });
  });

  it("prefers SEO overrides and honors noindex", () => {
    const doc = structuredClone(published);
    doc.settings.seo = { title: "SEO Title", description: "SEO description", noindex: true };
    const m = buildProfileMetadata({ ...base, published: doc });
    expect(m.title).toEqual({ absolute: "SEO Title" });
    expect(m.description).toBe("SEO description");
    expect(m.robots).toEqual({ index: false, follow: false });
  });

  it("truncates long bios for the description", () => {
    const doc = structuredClone(published);
    doc.header.bio = "word ".repeat(100);
    expect((buildProfileMetadata({ ...base, published: doc }).description ?? "").length).toBeLessThanOrEqual(160);
  });
});
