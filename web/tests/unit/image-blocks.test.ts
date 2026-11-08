import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createItem, imageSources, itemConfig, itemLabel, serializeItems, toEditorItems, validateItem, type EditableItem } from "@/components/editor/block-items";
import { ProfileView, type ViewDocument } from "@/components/profile/profile-view";
import { parseBlock, type Block } from "@/features/blocks/block";
import { BLOCK_DEFINITIONS, BLOCK_INPUT_SCHEMAS, imageInputSchema } from "@/features/blocks/definitions";
import { assessStoredBlocks, IMAGE_NOT_IN_LIBRARY, resolveBlockList, type ImageMediaLookup } from "@/features/blocks/input";
import { collectMediaReferences, expectedKind, imageBlockAt } from "@/features/media/references";
import { createDefaultDocument, readDocument } from "@/features/profiles/document";

/**
 * Image blocks: the separate input and stored schemas,
 * server-stamped dimensions, the decorative/link rule, the v1 legacy policy,
 * contextual expected kinds, the shared renderer and the editor state.
 */

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROFILE = "11111111-1111-4111-8111-111111111111";
const KEY = "7c9e6679-7425-40de-944b-e07fc1f90ae7.webp";
const SRC = `/media/${KEY}`;
// Built from code points so no raw separator characters end up in this file.
const CONTROLS = [0x0d, 0x0a, 0x09, 0x00, 0x7f, 0x85, 0x1b, 0x2028, 0x2029].map((c) => String.fromCharCode(c));

const input = (over: Record<string, unknown> = {}) => ({ src: SRC, alt: "A red bicycle", decorative: false, aspect: "auto", ...over });
const stored = (over: Record<string, unknown> = {}) => ({ ...input(), width: 1200, height: 800, ...over });
const sizes: ImageMediaLookup = (src) => (src === SRC ? { width: 1200, height: 800 } : { error: IMAGE_NOT_IN_LIBRARY });
const issues = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string; code: string }[] } }) =>
  r.success ? [] : r.error!.issues.map((i) => `${i.path.join(".")}: ${i.code === "unrecognized_keys" ? "unrecognized" : i.message}`);

describe("image input schema (client contract)", () => {
  it("accepts an uploaded image with alt text, caption, link and aspect, trimming the alt text", () => {
    const r = imageInputSchema.safeParse(input({ alt: "  A red bicycle  ", caption: " Summer ", href: "shop.example.com/bike", aspect: "wide" }));
    expect(r.success && r.data).toEqual({ src: SRC, alt: "A red bicycle", decorative: false, caption: "Summer", href: "https://shop.example.com/bike", aspect: "wide" });
    expect(BLOCK_INPUT_SCHEMAS.image).toBe(imageInputSchema);
  });

  it("refuses client-supplied dimensions, unknown keys and missing required fields", () => {
    for (const extra of [{ width: 1200 }, { height: 800 }, { width: 1, height: 1 }, { version: 2 }, { srcset: "x" }, { loading: "eager" }]) {
      expect(issues(imageInputSchema.safeParse(input(extra))), JSON.stringify(extra)).toContain(": unrecognized");
    }
    for (const missing of ["src", "alt", "decorative", "aspect"]) {
      const value = input();
      delete (value as Record<string, unknown>)[missing];
      expect(imageInputSchema.safeParse(value).success, missing).toBe(false);
    }
    expect(imageInputSchema.safeParse(input({ aspect: "panorama" })).success).toBe(false);
    expect(imageInputSchema.safeParse(input({ decorative: "true" })).success).toBe(false);
  });

  it("accepts only an exact canonical /media/{uuid}.webp source", () => {
    const refused = [
      "",
      ` ${SRC}`,
      `${SRC} `,
      `${SRC}?v=1`,
      `${SRC}#x`,
      SRC.toUpperCase(),
      `/MEDIA/${KEY}`,
      `/media/${KEY.toUpperCase()}`,
      `/media/%37${KEY.slice(1)}`,
      `/media/..%2f${KEY}`,
      `/media//${KEY}`,
      `//media/${KEY}`,
      `\\media\\${KEY}`,
      `https://links.example.com/media/${KEY}`,
      `//links.example.com/media/${KEY}`,
      "https://images.example.com/a.png",
      "data:image/webp;base64,AAAA",
      "javascript:alert(1)",
      "/media/7c9e6679-7425-10de-944b-e07fc1f90ae7.webp", // not a v4 UUID
      "/media/7c9e6679-7425-40de-944b-e07fc1f90ae7.png",
      "/media/7c9e6679742540de944be07fc1f90ae7.webp",
    ];
    for (const src of refused) expect(issues(imageInputSchema.safeParse(input({ src }))), src).toEqual(["src: Choose or upload an image"]);
  });

  it("requires alt text unless decorative; a decorative image has exactly empty alt text and no link", () => {
    expect(issues(imageInputSchema.safeParse(input({ alt: "" })))).toEqual(["alt: Describe the image, or mark it as decorative"]);
    expect(issues(imageInputSchema.safeParse(input({ alt: "   " })))).toEqual(["alt: Describe the image, or mark it as decorative"]);
    expect(imageInputSchema.safeParse(input({ alt: "", decorative: true })).success).toBe(true);
    expect(issues(imageInputSchema.safeParse(input({ decorative: true })))).toEqual(["alt: Leave the description empty for a decorative image"]);
    expect(issues(imageInputSchema.safeParse(input({ alt: " ", decorative: true })))).toEqual(["alt: Leave the description empty for a decorative image"]);
    expect(issues(imageInputSchema.safeParse(input({ alt: "", decorative: true, href: "https://example.com" })))).toEqual([
      "href: A decorative image can't be a link. Add a description instead.",
    ]);
    expect(imageInputSchema.safeParse(input({ href: "https://example.com" })).success).toBe(true);
  });

  it("refuses control characters in alt text and captions, over-long text and unsafe links", () => {
    for (const c of CONTROLS) {
      expect(imageInputSchema.safeParse(input({ alt: `A${c}B` })).success, `alt U+${c.charCodeAt(0).toString(16)}`).toBe(false);
      expect(imageInputSchema.safeParse(input({ caption: `A${c}B` })).success, `caption U+${c.charCodeAt(0).toString(16)}`).toBe(false);
    }
    expect(imageInputSchema.safeParse(input({ alt: "a".repeat(200) })).success).toBe(true);
    expect(imageInputSchema.safeParse(input({ alt: "a".repeat(201) })).success).toBe(false);
    expect(imageInputSchema.safeParse(input({ caption: "a".repeat(201) })).success).toBe(false);
    for (const href of ["javascript:alert(1)", "data:text/html,x", "ftp://example.com", "https://exa mple.com", "/relative", "\\\\evil.example"]) {
      expect(imageInputSchema.safeParse(input({ href })).success, href).toBe(false);
    }
  });

  it("measures alt text as stored: trimmed, after refusing control characters", () => {
    const longest = "a".repeat(200);
    const tooLong = "a".repeat(201);

    for (const alt of [` ${longest}`, `${longest} `, `   ${longest}   `]) {
      const r = imageInputSchema.safeParse(input({ alt }));
      expect(r.success && r.data.alt, JSON.stringify(alt)).toBe(longest);
      expect(issues(BLOCK_DEFINITIONS.image.schema.safeParse(stored({ alt }))), JSON.stringify(alt)).toEqual([]);
    }
    for (const alt of [tooLong, ` ${tooLong}`, `  ${tooLong}  `]) {
      expect(issues(imageInputSchema.safeParse(input({ alt }))), alt).toEqual(["alt: Use at most 200 characters"]);
      expect(issues(BLOCK_DEFINITIONS.image.schema.safeParse(stored({ alt }))), alt).toEqual(["alt: Use at most 200 characters"]);
    }

    // Whitespace of any length is not "exactly empty", and alone it describes nothing.
    for (const alt of [" ", "   ", " ".repeat(201)]) {
      expect(issues(imageInputSchema.safeParse(input({ alt, decorative: true }))), JSON.stringify(alt)).toEqual(["alt: Leave the description empty for a decorative image"]);
      expect(issues(imageInputSchema.safeParse(input({ alt }))), JSON.stringify(alt)).toEqual(["alt: Describe the image, or mark it as decorative"]);
    }

    for (const c of CONTROLS) {
      for (const alt of [`${c}A red bicycle`, `A red bicycle${c}`, `${c}A red bicycle${c}`, `${c}${longest}${c}`]) {
        expect(issues(imageInputSchema.safeParse(input({ alt }))), `alt U+${c.charCodeAt(0).toString(16)}`).toContain("alt: Remove line breaks, tabs and other control characters");
      }
    }
  });
});

describe("image stored schema and the v1 policy", () => {
  it("v2 requires integer dimensions of the background box, and is strict", () => {
    const schema = BLOCK_DEFINITIONS.image.schema;
    expect(BLOCK_DEFINITIONS.image.version).toBe(2);
    expect(schema.safeParse(stored()).success).toBe(true);
    for (const bad of [{ width: undefined }, { height: undefined }, { width: 0 }, { height: 2049 }, { width: 10.5 }, { width: "1200" }, { extra: true }]) {
      expect(schema.safeParse(stored(bad)).success, JSON.stringify(bad)).toBe(false);
    }
    expect(schema.safeParse(stored({ width: 2048, height: 1 })).success).toBe(true);
  });

  it("every stored v1 image is unreadable, even one carrying v2-shaped fields, and protects its draft", () => {
    const v1 = { id: ID(1), type: "image", version: 1, visible: true, config: stored() };
    const external = { id: ID(2), type: "image", version: 1, visible: true, config: { src: "https://images.example.com/a.png", alt: "x" } };
    for (const block of [v1, external]) {
      const r = parseBlock(block);
      expect(r.success).toBe(false);
      expect(!r.success && r.error).toBe("Block version 1 can't be read by this version");
    }
    expect(assessStoredBlocks([v1, external], [])).toMatchObject({ unreadable: 2, protectedCount: 2 });
    const doc = readDocument({ ...createDefaultDocument("A"), blocks: [v1] });
    expect(doc.doc.blocks).toEqual([]);
    expect(doc.dropped).toBe(1);
    // The same config at v2 is readable, and a newer version is refused as usual.
    expect(parseBlock({ ...v1, version: 2 }).success).toBe(true);
    expect(parseBlock({ ...v1, version: 3 }).success).toBe(false);
  });

  it("a stored v2 image the editor can carry isn't lossy; an unknown key makes it unreadable", () => {
    const block = { id: ID(1), type: "image", version: 2, visible: true, config: stored({ caption: "Hi" }) };
    expect(assessStoredBlocks([block], []).protectedCount).toBe(0);
    expect(assessStoredBlocks([{ ...block, config: { ...block.config, focal: 1 } }], []).unreadable).toBe(1);
    expect(assessStoredBlocks([{ ...block, pinned: true }], []).lossy).toBe(1);
  });
});

describe("resolveBlockList stamps dimensions on the server", () => {
  const empty = assessStoredBlocks([], []);
  const entry = (config: Record<string, unknown>) => ({ id: ID(5), type: "image", visible: true, config });

  it("stamps width and height from the lookup and writes the canonical stored config", () => {
    const r = resolveBlockList([entry(input({ caption: "Bike" }))], empty, sizes);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.write[0]).toEqual({
      id: ID(5),
      type: "image",
      version: 2,
      visible: true,
      config: { src: SRC, width: 1200, height: 800, alt: "A red bicycle", decorative: false, caption: "Bike", href: undefined, aspect: "auto" },
    });
    expect(Object.keys((r.write[0] as Block).config)).toEqual(["src", "width", "height", "alt", "decorative", "caption", "aspect"]);
  });

  it("refuses an image the lookup doesn't allow, and every image when there is no lookup", () => {
    const other = "/media/0f8fad5b-d9cb-469f-a165-70867728950e.webp";
    expect(resolveBlockList([entry(input({ src: other }))], empty, sizes)).toMatchObject({
      ok: false,
      errors: { items: [{ index: 0, id: ID(5), fields: { src: [IMAGE_NOT_IN_LIBRARY] } }] },
    });
    expect(resolveBlockList([entry(input())], empty)).toMatchObject({ ok: false, errors: { items: [{ fields: { src: [IMAGE_NOT_IN_LIBRARY] } }] } });
    expect(resolveBlockList([entry(input())], empty, () => ({ error: "kind" }))).toMatchObject({ ok: false, errors: { items: [{ fields: { src: ["kind"] } }] } });
  });

  it("refuses injected dimensions and versions before asking for sizes", () => {
    let asked = 0;
    const counting: ImageMediaLookup = (src) => (asked++, sizes(src));
    for (const config of [input({ width: 1 }), input({ height: 1 }), input({ width: 1200, height: 800 })]) {
      expect(resolveBlockList([entry(config)], empty, counting)).toMatchObject({
        ok: false,
        errors: { items: [{ message: "This block has fields that aren't supported." }] },
      });
    }
    expect(resolveBlockList([{ ...entry(input()), version: 2 }], empty, counting)).toMatchObject({
      ok: false,
      errors: { items: [{ message: "This block is malformed." }] },
    });
    expect(asked).toBe(0);
  });

  it("a size outside the stored rules is refused rather than written", () => {
    expect(resolveBlockList([entry(input())], empty, () => ({ width: 4096, height: 10 }))).toMatchObject({ ok: false });
  });
});

describe("contextual media kinds", () => {
  const doc = {
    header: { avatarUrl: SRC },
    theme: { background: { imageUrl: SRC } },
    blocks: [
      { id: ID(1), type: "image", version: 2, config: stored() },
      { id: ID(2), type: "link", version: 2, config: { src: SRC } },
      { id: ID(3), type: "future-gallery", version: 1, config: { src: SRC, items: [{ src: SRC }] } },
      { id: ID(4), type: "image", version: 1, config: { src: SRC } },
    ],
    futureBlock: { src: SRC },
  };

  it("requires the background kind only for the src of an actual image block", () => {
    const kinds = Object.fromEntries(collectMediaReferences(doc).map((r) => [r.path.join("."), expectedKind(r.path, doc)]));
    expect(kinds).toEqual({
      "header.avatarUrl": "avatar",
      "theme.background.imageUrl": "background",
      "blocks.0.config.src": "background",
      "blocks.1.config.src": null,
      "blocks.2.config.src": null,
      "blocks.2.config.items.0.src": null,
      "blocks.3.config.src": "background",
      "futureBlock.src": null,
    });
    expect(expectedKind(["blocks", 0, "config", "src"])).toBeNull(); // without the document nothing is classified
    expect(imageBlockAt(["blocks", "0", "config", "src"], doc)).toBeNull();
    expect(imageBlockAt(["blocks", 0, "config", "alt"], doc)).toBeNull();
    expect(imageBlockAt(["blocks", 0, "config", "src"], doc)).toMatchObject({ width: 1200, height: 800 });
  });
});

describe("shared renderer", () => {
  const block = (config: Record<string, unknown>, visible = true): Block => ({ id: ID(7), type: "image", version: 2, visible, config }) as Block;
  const doc = (blocks: Block[], newTab = false): ViewDocument => {
    const base = createDefaultDocument("Ivy");
    return { ...base, settings: { ...base.settings, openLinksInNewTab: newTab }, blocks };
  };
  const render = (blocks: Block[], mode: "public" | "preview", newTab = false) =>
    renderToStaticMarkup(createElement(ProfileView, { document: doc(blocks, newTab), verified: false, mode, clickTrackingProfileId: mode === "public" ? PROFILE : undefined }));

  it("renders a figure with a sized, lazy image and no caption or link when there are none", () => {
    const html = render([block(stored())], "public");
    expect(html).toContain(
      `<figure class="pp-figure" data-aspect="auto"><img class="pp-image" src="${SRC}" alt="A red bicycle" width="1200" height="800" loading="lazy" decoding="async"/></figure>`,
    );
    expect(html).not.toContain("figcaption");
    expect(html).not.toContain("<a ");
  });

  it("links publicly through /go and directly in the preview; the caption is a figcaption", () => {
    const config = stored({ caption: "Ride along", href: "https://shop.example.com/bike", aspect: "square" });
    const pub = render([block(config)], "public");
    expect(pub).toContain(`<a class="pp-image-link" href="/go/${PROFILE}/${ID(7)}" rel="noopener nofollow ugc"><img class="pp-image" src="${SRC}" alt="A red bicycle"`);
    expect(pub).toContain(`<figcaption class="pp-caption">Ride along</figcaption>`);
    expect(pub).toContain(`data-aspect="square"`);
    expect(render([block(config)], "public", true)).toContain(`href="/go/${PROFILE}/${ID(7)}" target="_blank" rel="noopener noreferrer nofollow ugc"`);
    const preview = render([block(config)], "preview");
    expect(preview).toContain(`href="https://shop.example.com/bike" target="_blank" rel="noopener noreferrer nofollow ugc"`);
    expect(preview).not.toContain("/go/");
  });

  it("a decorative image has empty alt text and is never a link; hidden images aren't rendered", () => {
    const html = render([block(stored({ alt: "", decorative: true }))], "public");
    expect(html).toContain(`alt="" width="1200"`);
    // Even a tampered decorative config with a link isn't linked.
    expect(render([block(stored({ alt: "", decorative: true, href: "https://x.example.com" }))], "public")).not.toContain("<a ");
    expect(render([block(stored(), false)], "public")).not.toContain("pp-image");
    expect(render([block(stored({ src: "https://images.example.com/a.png" }))], "public")).not.toContain("<img");
  });
});

describe("editor state", () => {
  const picked = (over: Record<string, string> = {}): EditableItem => {
    const item = createItem("image");
    return { ...item, values: { ...item.values, src: SRC, width: "1200", height: "800", alt: "A red bicycle", ...over } };
  };

  it("starts incomplete, submits a boolean and never the dimensions", () => {
    const fresh = createItem("image");
    expect(validateItem(fresh)).toMatchObject({ ok: false, fields: { src: ["Choose or upload an image"] } });
    const item = picked({ caption: "Hi", decorative: "false" });
    expect(itemConfig(item)).toEqual({ src: SRC, alt: "A red bicycle", decorative: false, caption: "Hi", href: "", aspect: "auto" });
    expect(serializeItems([item])).not.toMatch(/width|height/);
    // The size the picker reported only changes the preview, not what is saved.
    const same = picked();
    expect(serializeItems([{ ...same, values: { ...same.values, width: "10", height: "10" } }])).toBe(serializeItems([same]));
  });

  it("previews with the picker's size and labels the block by its description", () => {
    const v = validateItem(picked());
    expect(v.ok && v.block.config).toMatchObject({ width: 1200, height: 800 });
    expect(validateItem(picked({ width: "0" }))).toMatchObject({ ok: false, fields: { src: ["Choose or upload an image"] } });
    expect(itemLabel(picked())).toBe("A red bicycle");
    expect(itemLabel(picked({ alt: "", decorative: "true" }))).toBe("Decorative image");
    expect(itemLabel(picked({ alt: "", caption: "Sunset" }))).toBe("Sunset");
  });

  it("round-trips a stored block and reports the images chosen in the editor", () => {
    const block = { id: ID(8), type: "image", version: 2, visible: true, config: { ...stored(), caption: undefined, href: undefined } } as Block;
    const [item] = toEditorItems([block]);
    expect(item).toMatchObject({ values: { src: SRC, width: "1200", height: "800", decorative: "false", caption: "", href: "" } });
    expect(imageSources([item, createItem("image"), createItem("link")])).toEqual([SRC]);
  });
});
