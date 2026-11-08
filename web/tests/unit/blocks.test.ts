import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createItem, duplicateItem, moveItem, toBlockInput, toEditorItems, toViewBlocks, validateItem } from "@/components/editor/block-items";
import { BLOCK_RENDERERS } from "@/components/profile/blocks";
import { ProfileView, type ViewDocument } from "@/components/profile/profile-view";
import { parseBlock, type Block } from "@/features/blocks/block";
import { BLOCK_DEFINITIONS, BLOCK_INPUT_SCHEMAS, EDITABLE_BLOCK_TYPES, RENDERABLE_BLOCK_TYPES } from "@/features/blocks/definitions";
import { assessStoredBlocks, MAX_BLOCKS, resolveBlockList } from "@/features/blocks/input";
import { createDefaultDocument, readDocument } from "@/features/profiles/document";
import { linkUrlSchema, parseLinkUrl } from "@/lib/validation/url";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const link = (n: number, extra: Partial<{ title: string; url: string; visible: boolean }> = {}) => ({
  id: ID(n),
  type: "link",
  visible: extra.visible ?? true,
  config: { title: extra.title ?? `Link ${n}`, url: extra.url ?? `example.com/${n}` },
});
const empty = assessStoredBlocks([], []);

describe("link destinations (parseLinkUrl)", () => {
  it.each([
    ["https://example.com/a?b=1#c", "https://example.com/a?b=1#c"],
    ["http://example.com", "http://example.com/"],
    ["example.com", "https://example.com/"],
    ["sub.example.co.uk/path", "https://sub.example.co.uk/path"],
    ["HTTPS://Example.COM", "https://example.com/"],
    ["  https://example.com  ", "https://example.com/"],
    ["http://192.0.2.10:8080/x", "http://192.0.2.10:8080/x"],
    ["https://[2001:db8::1]/x", "https://[2001:db8::1]/x"],
    ["https://example.com//double/path", "https://example.com//double/path"],
  ])("accepts %s", (input, expected) => {
    expect(parseLinkUrl(input)?.toString()).toBe(expected);
  });

  it.each([
    ["single-label host", "foo"],
    ["single-label host with scheme", "https://foo"],
    ["protocol-relative", "//evil.com"],
    ["root-relative", "/dashboard"],
    ["backslashes", "\\\\evil.com"],
    ["mixed slashes", "/\\evil.com"],
    ["scheme with backslashes", "https:\\\\evil.com"],
    ["scheme without slashes", "https:evil.com"],
    ["scheme with one slash", "https:/evil.com"],
    ["scheme with three slashes", "https:///example.com"],
    ["scheme with four slashes", "https:////example.com"],
    ["http with four slashes", "http:////example.com"],
    ["uppercase scheme with three slashes", "HTTPS:///example.com"],
    ["backslash in path", "https://example.com/a\\b"],
    ["credentials", "https://user:pass@example.com"],
    ["username only", "https://user@example.com"],
    ["whitespace inside", "https://exa mple.com"],
    ["tab", "https://example.com/\tx"],
    ["newline", "https://example.com/\nx"],
    ["NUL", "https://example.com/\u0000"],
    ["control character", "https://example.com/\u0007"],
    ["DEL", "https://example.com/\u007f"],
    ["javascript:", "javascript:alert(1)"],
    ["javascript with slashes", "javascript://example.com/%0Aalert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["vbscript:", "vbscript:msgbox(1)"],
    ["file:", "file:///etc/passwd"],
    ["ftp:", "ftp://example.com/x"],
    ["mailto:", "mailto:a@example.com"],
    ["overlength", `https://example.com/${"a".repeat(2049)}`],
    ["empty", ""],
  ])("rejects %s", (_label, input) => {
    expect(parseLinkUrl(input)).toBeNull();
    expect(linkUrlSchema.safeParse(input).success).toBe(false);
  });
});

describe("block registry", () => {
  it("keeps every scaffolded type readable; all twelve are editable and renderable", () => {
    expect(Object.keys(BLOCK_DEFINITIONS)).toHaveLength(12);
    const reviewed = ["link", "heading", "text", "divider", "social", "email", "phone", "contact", "spacer", "image", "video", "music"];
    expect([...EDITABLE_BLOCK_TYPES]).toEqual(reviewed);
    expect([...RENDERABLE_BLOCK_TYPES]).toEqual(reviewed);
    expect(Object.keys(BLOCK_RENDERERS).sort()).toEqual([...RENDERABLE_BLOCK_TYPES].sort());
    expect(Object.keys(BLOCK_INPUT_SCHEMAS).sort()).toEqual([...EDITABLE_BLOCK_TYPES].sort());
  });

  it("starts new link, heading and text blocks empty so nothing placeholder-like can be published by accident", () => {
    for (const type of ["link", "heading", "text"] as const) {
      expect(BLOCK_INPUT_SCHEMAS[type].safeParse(BLOCK_DEFINITIONS[type].defaults()).success).toBe(false);
    }
    expect(BLOCK_INPUT_SCHEMAS.divider.safeParse(BLOCK_DEFINITIONS.divider.defaults()).success).toBe(true);
  });

  it("input schemas reject unknown config keys", () => {
    expect(BLOCK_INPUT_SCHEMAS.heading.safeParse({ text: "Hi", size: "md", align: "inherit", html: "<b>" }).success).toBe(false);
    expect(BLOCK_INPUT_SCHEMAS.link.safeParse({ title: "x", url: "example.com", icon: "star" }).success).toBe(false);
    expect(BLOCK_INPUT_SCHEMAS.divider.safeParse({ style: "line", color: "red" }).success).toBe(false);
  });
});

describe("link v1 → v2 migration", () => {
  const v1 = {
    id: ID(1),
    type: "link",
    version: 1,
    visible: true,
    config: { title: "Old", url: "https://example.com/", description: "Kept", icon: "star", thumbnailUrl: "https://img.example.com/t.png", featured: true },
  };

  it("keeps title, url and description and drops the presentation-only fields", () => {
    const r = parseBlock(v1);
    expect(r).toEqual({
      success: true,
      block: { id: ID(1), type: "link", version: 2, visible: true, config: { title: "Old", url: "https://example.com/", description: "Kept" } },
    });
  });

  it("migrates inside stored documents instead of dropping the block", () => {
    const { doc, dropped } = readDocument({ ...createDefaultDocument("X"), blocks: [v1] });
    expect(dropped).toBe(0);
    expect(doc.blocks[0]).toMatchObject({ version: 2, config: { title: "Old" } });
  });

  it("drops an unusable v1 link (as any invalid stored block) and rejects newer versions", () => {
    expect(parseBlock({ ...v1, config: { ...v1.config, url: "javascript:alert(1)" } }).success).toBe(false);
    expect(parseBlock({ ...v1, version: 3 }).success).toBe(false);
  });
});

describe("resolveBlockList (client block-list contract)", () => {
  it("stamps the supported version and normalizes values, in the submitted order", () => {
    const r = resolveBlockList(
      [link(2, { url: "example.com" }), { id: ID(1), type: "heading", visible: false, config: { text: " Hi ", size: "lg", align: "center" } }],
      empty,
    );
    expect(r).toMatchObject({
      ok: true,
      blocks: [
        { id: ID(2), type: "link", version: 2, visible: true, config: { title: "Link 2", url: "https://example.com/" } },
        { id: ID(1), type: "heading", version: 1, visible: false, config: { text: "Hi", size: "lg", align: "center" } },
      ],
    });
  });

  it.each([
    ["client-supplied version", { ...link(1), version: 2 }],
    ["extra envelope key", { ...link(1), published: true }],
    ["missing visible", { id: ID(1), type: "link", config: link(1).config }],
    ["string instead of object", "link"],
    ["null", null],
    ["extra config key", { ...link(1), config: { ...link(1).config, icon: "star" } }],
    ["config not an object", { ...link(1), config: "https://example.com" }],
    ["unsafe url", link(1, { url: "javascript:alert(1)" })],
    ["protocol-relative url", link(1, { url: "//evil.com" })],
    ["invalid video link", { id: ID(1), type: "video", visible: true, config: { url: "https://youtu.be/x" } }],
    ["unknown type", { id: ID(1), type: "script", visible: true, config: {} }],
    ["retired preserve reference", { id: ID(1), preserve: true }],
    ["preserve with extra key", { id: ID(1), preserve: true, config: {} }],
    ["preserve false", { id: ID(1), preserve: false }],
  ])("rejects %s", (_label, entry) => {
    const r = resolveBlockList([entry], empty);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.items[0]?.index).toBe(0);
  });

  it("reports malformed and duplicate ids by position only", () => {
    const r = resolveBlockList([{ ...link(1), id: "not-a-uuid" }, link(2), link(2)], empty);
    expect(r).toEqual({
      ok: false,
      errors: {
        list: [],
        items: [
          { index: 0, message: "This block has an invalid id." },
          { index: 2, message: "Two blocks share the same id." },
        ],
      },
    });
  });

  it("reports field problems by block id and field, with our own messages", () => {
    const r = resolveBlockList([link(1, { title: "", url: "foo" })], empty);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.items).toEqual([
      { index: 0, id: ID(1), fields: { title: ["Add a title"], url: ["Enter a valid http(s) address, like example.com"] } },
    ]);
    expect(JSON.stringify(r.errors)).not.toMatch(/"code"|"path"|"expected"/);
  });

  it(`enforces at most ${MAX_BLOCKS} blocks as a list-level error`, () => {
    const many = Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => link(i + 1));
    expect(resolveBlockList(many, empty)).toEqual({
      ok: false,
      errors: { list: [`A profile can have at most ${MAX_BLOCKS} blocks.`], items: [] },
    });
    expect(resolveBlockList(many.slice(0, MAX_BLOCKS), empty).ok).toBe(true);
    expect(resolveBlockList({ 0: link(1) }, empty)).toMatchObject({ ok: false, errors: { list: ["Blocks must be a list."] } });
  });

  it("prevents an existing id (draft or published) from changing type", () => {
    const stored = assessStoredBlocks([], [{ id: ID(1), type: "heading", version: 1, visible: true, config: { text: "Old" } }]);
    const r = resolveBlockList([link(1)], stored);
    expect(r).toMatchObject({ ok: false, errors: { items: [{ index: 0, id: ID(1), message: "A block can't change its type." }] } });
  });

  it("refuses a retired preserve reference as malformed, whether or not the block exists", () => {
    const stored = assessStoredBlocks([{ ...link(1), version: 2 }], []);
    expect(stored.protectedCount).toBe(0);
    for (const id of [ID(1), ID(8)]) {
      expect(resolveBlockList([{ id, preserve: true }], stored)).toEqual({ ok: false, errors: { list: [], items: [{ index: 0, message: "This block is malformed." }] } });
    }
  });

  it("protects drafts with unreadable blocks, editable blocks the editor can't round-trip, and more than the block limit", () => {
    const unreadable = assessStoredBlocks([{ id: ID(1), type: "future-widget", version: 1, visible: true, config: {} }, { id: ID(2), type: "link", version: 9 }], []);
    expect(unreadable).toMatchObject({ unreadable: 2, lossy: 0, overflow: 0, protectedCount: 2 });
    expect(unreadable.knownTypes.get(ID(1))).toBe("future-widget");

    const heading = (extra: object = {}, config: object = {}) => ({ id: ID(3), type: "heading", version: 1, visible: true, config: { text: "Hi", ...config }, ...extra });
    expect(assessStoredBlocks([heading({}, { color: "red" })], []).lossy).toBe(1); // unknown config key would be stripped
    expect(assessStoredBlocks([heading({ pinned: true })], []).lossy).toBe(1); // extra envelope key
    expect(assessStoredBlocks([heading()], []).protectedCount).toBe(0); // size/align omitted: defaults add, nothing is lost
    expect(assessStoredBlocks([{ ...link(4), version: 2, config: { title: " Shop ", url: "https://example.com" } }], []).protectedCount).toBe(0); // normalized, not lost
    // The intentional v1 → v2 link migration isn't a loss.
    expect(assessStoredBlocks([{ ...link(5), version: 1, config: { title: "Old", url: "https://e.example.com/", icon: "star", featured: true } }], []).protectedCount).toBe(0);
    // ...but an unknown key on a v1 link is.
    expect(assessStoredBlocks([{ ...link(6), version: 1, config: { title: "Old", url: "https://e.example.com/", extra: 1 } }], []).lossy).toBe(1);

    const many = Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => ({ ...link(i + 1), version: 2 }));
    expect(assessStoredBlocks(many, [])).toMatchObject({ unreadable: 0, lossy: 0, overflow: 1, protectedCount: 1 });
    expect(assessStoredBlocks(many.slice(0, MAX_BLOCKS), []).protectedCount).toBe(0);
  });

  it("treats every unknown config key as a loss, whatever its value (M3-001A)", () => {
    const stored = (type: string, version: number, config: object) => ({ id: ID(7), type, version, visible: true, config });
    const lossy = (block: object) => assessStoredBlocks([block], []);
    for (const value of ["", "   ", null, false, 0, [], {}]) {
      expect(lossy(stored("heading", 1, { text: "Heading", futureField: value })), `heading ${JSON.stringify(value)}`).toMatchObject({ unreadable: 0, lossy: 1, protectedCount: 1 });
      expect(lossy(stored("text", 1, { markdown: "Hi", futureField: value })), `text ${JSON.stringify(value)}`).toMatchObject({ lossy: 1, protectedCount: 1 });
      expect(lossy(stored("divider", 1, { futureField: value })), `divider ${JSON.stringify(value)}`).toMatchObject({ lossy: 1, protectedCount: 1 });
      expect(lossy(stored("link", 1, { title: "Old", url: "https://e.example.com/", futureField: value })), `link v1 ${JSON.stringify(value)}`).toMatchObject({ lossy: 1, protectedCount: 1 });
    }
    // A strict v2 link refuses unknown keys outright, retired names included.
    expect(lossy(stored("link", 2, { title: "Shop", url: "https://example.com", futureField: "" }))).toMatchObject({ unreadable: 1, protectedCount: 1 });
    expect(lossy(stored("link", 2, { title: "Shop", url: "https://example.com", icon: "star" }))).toMatchObject({ unreadable: 1, protectedCount: 1 });

    // A recognized optional field that normalizes to undefined is carried, not lost.
    for (const description of ["", "   "]) {
      expect(lossy(stored("link", 2, { title: "Shop", url: "https://example.com", description })).protectedCount).toBe(0);
      expect(lossy(stored("link", 1, { title: "Old", url: "https://e.example.com/", description })).protectedCount).toBe(0);
    }
    // Retired v1 fields stay exempt, blank, null or set.
    for (const value of ["", null, false, "star"]) {
      expect(lossy(stored("link", 1, { title: "Old", url: "https://e.example.com/", icon: value, thumbnailUrl: value, featured: value })).protectedCount).toBe(0);
    }
  });

  it("counts stored overflow as dropped while reading at most the block limit", () => {
    const many = Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => ({ ...link(i + 1), version: 2 }));
    const { doc, dropped } = readDocument({ ...createDefaultDocument("X"), blocks: many });
    expect(doc.blocks).toHaveLength(MAX_BLOCKS);
    expect(dropped).toBe(1);
  });
});

describe("shared renderer (ProfileView)", () => {
  // Stored-shape fixtures; optional config fields may be absent, as in real JSON.
  const block = (b: { id: string; type: string; config: object; version?: number; visible?: boolean }): Block =>
    ({ version: 1, visible: true, ...b }) as unknown as Block;
  const render = (blocks: ViewDocument["blocks"], opts: { mode?: "public" | "preview"; newTab?: boolean } = {}) => {
    const base = createDefaultDocument("Alice");
    const document: ViewDocument = { ...base, blocks, settings: { ...base.settings, openLinksInNewTab: opts.newTab ?? false } };
    return renderToStaticMarkup(createElement(ProfileView, { document, verified: false, mode: opts.mode ?? "public" }));
  };
  const sample: Block[] = [
    block({ id: ID(1), type: "heading", config: { text: "First heading", size: "lg", align: "inherit" } }),
    block({ id: ID(2), type: "link", version: 2, config: { title: "Shop", url: "https://shop.example.com/", description: "New stuff" } }),
    block({ id: ID(3), type: "link", version: 2, visible: false, config: { title: "HIDDEN LINK", url: "https://hidden.example.com/" } }),
    block({ id: ID(4), type: "text", config: { markdown: "Hello **bold** <script>alert(1)</script> [bad](javascript:alert(1)) [rel](//evil.com) [ok](example.org)", align: "inherit" } }),
    block({ id: ID(5), type: "divider", config: { style: "dots" } }),
    block({ id: ID(6), type: "future-widget", config: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } }),
    block({ id: ID(7), type: "heading", config: { text: "Small one", size: "sm", align: "center" } }),
  ];

  it("renders visible content blocks in order and nothing else", () => {
    const html = render(sample);
    const order = [...html.matchAll(/data-block-id="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual([ID(1), ID(2), ID(4), ID(5), ID(7)]);
    expect(html).not.toContain("HIDDEN LINK");
    expect(html).not.toMatch(/<iframe|youtube/i);
  });

  it("uses direct destinations with the agreed rel, and h2 for every heading", () => {
    const html = render(sample);
    expect(html).toContain('<a class="pp-btn" href="https://shop.example.com/" rel="noopener nofollow ugc">');
    expect(html).not.toContain("/go/");
    expect(html).not.toContain("target=");
    expect(html.match(/<h2 class="pp-heading"/g)).toHaveLength(2);
    expect(html).not.toMatch(/<h3/);
  });

  it("honors openLinksInNewTab with noreferrer, and always opens preview links in a new tab", () => {
    for (const html of [render(sample, { newTab: true }), render(sample, { mode: "preview" })]) {
      expect(html).toContain('href="https://shop.example.com/" target="_blank" rel="noopener noreferrer nofollow ugc"');
    }
  });

  it("escapes Markdown text and links only safe destinations", () => {
    const html = render(sample);
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/<script|href="javascript|href="\/\/|evil\.com"/);
    expect(html).toContain("[bad](javascript:alert(1))");
    expect(html).toContain('<a href="https://example.org/" rel="noopener nofollow ugc">ok</a>');
  });

  it("shows incomplete editor blocks as placeholders in the preview only", () => {
    const blocks: ViewDocument["blocks"] = [{ id: ID(1), type: "link", visible: true, incomplete: true }];
    expect(render(blocks, { mode: "preview" })).toContain("Incomplete link");
    expect(render(blocks)).not.toContain("Incomplete");
  });
});

describe("editor block items", () => {
  const blocks = [
    { id: ID(1), type: "link", version: 2, visible: true, config: { title: "A", url: "https://a.example.com/" } },
    { id: ID(2), type: "video", version: 1, visible: true, config: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } },
    { id: ID(3), type: "divider", version: 1, visible: false, config: { style: "fade" } },
  ] as unknown as Block[];

  it("round-trips stored blocks as form values", () => {
    expect(toBlockInput(toEditorItems(blocks))).toEqual([
      { id: ID(1), type: "link", visible: true, config: { title: "A", url: "https://a.example.com/", description: "" } },
      { id: ID(2), type: "video", visible: true, config: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "" } },
      { id: ID(3), type: "divider", visible: false, config: { style: "fade" } },
    ]);
    expect(resolveBlockList(toBlockInput(toEditorItems(blocks)), assessStoredBlocks(blocks, [])).ok).toBe(true);
  });

  it("moves, duplicates and creates with fresh ids", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b"], 0, 5)).toEqual(["a", "b"]);
    const [first] = toEditorItems(blocks);
    const copy = duplicateItem(first);
    expect(copy.id).not.toBe(first.id);
    expect(copy.values).toEqual(first.values);
    expect(createItem("link").id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("validates with the server rules and passes every block to the preview", () => {
    const item = createItem("link");
    expect(validateItem(item)).toMatchObject({ ok: false, fields: { title: ["Add a title"] } });
    expect(validateItem({ ...item, values: { title: "Hi", url: "example.com", description: "" } })).toMatchObject({ ok: true });
    expect(toViewBlocks(toEditorItems(blocks)).map((b) => b.id)).toEqual([ID(1), ID(2), ID(3)]);
  });
});
