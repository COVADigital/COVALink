import { z } from "zod";
import { OUTPUT_BOX } from "@/features/media/constants";
import { isMediaUrl } from "@/lib/validation/media";
import { linkUrlSchema, parseLinkUrl } from "@/lib/validation/url";
import { canonicalPhone, EMAIL_MAX_LENGTH, hasControlChars, hasControlCharsExceptLf, SUBJECT_MAX_LENGTH } from "./contact-points";
import { embedUrlProblem, parseEmbed, type EmbedKind } from "./embeds";
import { getSocialPlatform, SOCIAL_PLATFORM_IDS, socialDestination } from "./social-platforms";

/**
 * Isomorphic part of the block contract: type, version, schema and defaults.
 * Renderers (src/components/profile/blocks) and editors
 * (src/components/editor/block-editors) are keyed by the same `type`, kept in
 * separate modules so public pages never bundle editor code.
 *
 * `BLOCK_DEFINITIONS` is the storage/read compatibility registry: it knows
 * every scaffolded type so stored documents parse and are preserved. Which
 * types a client may create/edit and which are rendered publicly are
 * separate, narrower lists (`EDITABLE_BLOCK_TYPES`,
 * `RENDERABLE_BLOCK_TYPES`).
 */
export interface BlockDefinition<TSchema extends z.ZodType> {
  type: string;
  version: number;
  label: string;
  description: string;
  category: "links" | "content" | "media" | "contact";
  schema: TSchema;
  defaults: () => z.input<TSchema>;
  /**
   * Stored versions below this are unreadable whatever their content, so they
   * protect their draft and are never rendered or upgraded (image v1).
   */
  minReadableVersion?: number;
  /** Upgrades a config stored with an older `version`. Identity until a v2 exists. */
  migrate?: (config: unknown, fromVersion: number) => unknown;
  /**
   * Config keys of older versions that `migrate` drops on purpose. Any other
   * stored key that doesn't survive parsing counts as data loss.
   */
  retiredFields?: readonly string[];
}

function define<const T extends string, S extends z.ZodType>(def: BlockDefinition<S> & { type: T }) {
  return def;
}

const optionalText = (max: number, message?: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .optional()
    .transform((v) => (v ? v : undefined));

const CONTROL_MESSAGE = "Remove line breaks, tabs and other control characters";

/**
 * Single-line text without control characters. The check runs before
 * trimming, so a tab or line break is refused rather than trimmed away.
 */
const plainText = (max: number, required: string) =>
  z
    .string()
    .refine((v) => !hasControlChars(v), CONTROL_MESSAGE)
    .trim()
    .min(1, required)
    .max(max, `Use at most ${max} characters`);

const optionalPlainText = (max: number) =>
  z
    .string()
    .refine((v) => !hasControlChars(v), CONTROL_MESSAGE)
    .trim()
    .max(max, `Use at most ${max} characters`)
    .optional()
    .transform((v) => (v ? v : undefined));

const PHONE_MESSAGE = "Enter a phone number with 4 to 15 digits, like +1 555 010 0100";
/** Stored as typed (trimmed); `canonicalPhone` decides validity and builds the `tel:` URI. */
const phoneNumber = z
  .string()
  .max(64, PHONE_MESSAGE)
  .refine((v) => canonicalPhone(v) !== null, PHONE_MESSAGE)
  .transform((v) => v.trim());

const emailAddress = z.email("Enter a valid email address").max(EMAIL_MAX_LENGTH, `Use at most ${EMAIL_MAX_LENGTH} characters`);

/** Optional outbound address with the link-destination rules (http or https, strict syntax). */
const optionalLinkUrl = z
  .string()
  .trim()
  .max(2048, "URL is too long")
  .optional()
  .transform((v, ctx) => {
    if (!v) return undefined;
    const url = parseLinkUrl(v);
    if (!url) {
      ctx.addIssue({ code: "custom", message: "Enter a valid http(s) address, like example.com" });
      return z.NEVER;
    }
    return url.toString();
  });

/**
 * v1 → v2 of the social, email, phone, contact and spacer types: the config is unchanged, nothing is
 * retired. The stricter v2 rules decide whether a stored v1 block still reads;
 * one that doesn't is unreadable and protects its draft.
 */
const sameConfig = (config: unknown) => config;

/**
 * Link v1 (the original scaffold) also stored `icon`, `thumbnailUrl` and `featured`,
 * which never had an editor or a reviewed renderer. v2 is the narrow
 * editable contract; `migrate` maps v1 onto it by keeping title, url and description
 * and dropping the three presentation fields.
 */
const linkBlock = define({
  type: "link",
  version: 2,
  label: "Link",
  description: "A button that opens a web address.",
  category: "links",
  schema: z
    .object({
      title: z.string().trim().min(1, "Add a title").max(100, "Use at most 100 characters"),
      url: linkUrlSchema,
      description: optionalText(160, "Use at most 160 characters"),
    })
    .strict(),
  defaults: () => ({ title: "", url: "", description: "" }),
  retiredFields: ["icon", "thumbnailUrl", "featured"],
  migrate: (config, fromVersion) => {
    if (fromVersion !== 1 || !config || typeof config !== "object") return config;
    const { title, url, description } = config as Record<string, unknown>;
    return { title, url, description };
  },
});

const ALIGN = z.enum(["inherit", "left", "center"]);

const headingBlock = define({
  type: "heading",
  version: 1,
  label: "Heading",
  description: "A section title.",
  category: "content",
  schema: z.object({
    text: z.string().trim().min(1, "Add heading text").max(120, "Use at most 120 characters"),
    size: z.enum(["sm", "md", "lg"]).default("md"),
    align: ALIGN.default("inherit"),
  }),
  defaults: () => ({ text: "", size: "md" as const, align: "inherit" as const }),
});

const textBlock = define({
  type: "text",
  version: 1,
  label: "Text",
  description: "A paragraph with **bold**, *italic* and [links](https://…).",
  category: "content",
  schema: z.object({
    markdown: z.string().trim().min(1, "Add some text").max(2000, "Use at most 2000 characters"),
    align: ALIGN.default("inherit"),
  }),
  defaults: () => ({ markdown: "", align: "inherit" as const }),
});

const dividerBlock = define({
  type: "divider",
  version: 1,
  label: "Divider",
  description: "A line between sections.",
  category: "content",
  schema: z.object({ style: z.enum(["line", "dots", "fade"]).default("line") }),
  defaults: () => ({ style: "line" as const }),
});

const spacerBlock = define({
  type: "spacer",
  version: 1,
  label: "Spacer",
  description: "Empty vertical space.",
  category: "content",
  schema: z.object({ size: z.enum(["xs", "sm", "md", "lg", "xl"]).default("md") }),
  defaults: () => ({ size: "md" as const }),
});

export const IMAGE_ASPECTS = ["auto", "square", "wide", "portrait"] as const;
export const IMAGE_ALT_MAX = 200;

/** Exactly a canonical uploaded-media URL (`/media/{uuid}.webp`); nothing is trimmed, decoded or completed. */
const imageSrc = z.string().refine((v) => isMediaUrl(v), "Choose or upload an image");
const imageDimension = z.number().int().min(1).max(OUTPUT_BOX.background);

const imageFields = {
  // Not `.trim()` here: `imageRules` needs the raw value for a decorative image's exactly empty alt text.
  alt: z
    .string()
    .refine((v) => !hasControlChars(v), CONTROL_MESSAGE)
    .refine((v) => v.trim().length <= IMAGE_ALT_MAX, `Use at most ${IMAGE_ALT_MAX} characters`),
  decorative: z.boolean(),
  caption: optionalPlainText(200),
  href: optionalLinkUrl,
  aspect: z.enum(IMAGE_ASPECTS),
};

/**
 * Alt text is required unless the image is decorative; a decorative image has
 * exactly empty alt text and no link, so a link always has a name.
 */
function imageRules(c: { alt: string; decorative: boolean; href?: string }, ctx: z.RefinementCtx) {
  if (c.decorative) {
    if (c.alt !== "") ctx.addIssue({ code: "custom", path: ["alt"], message: "Leave the description empty for a decorative image" });
    if (c.href) ctx.addIssue({ code: "custom", path: ["href"], message: "A decorative image can't be a link. Add a description instead." });
  } else if (!c.alt.trim()) {
    ctx.addIssue({ code: "custom", path: ["alt"], message: "Describe the image, or mark it as decorative" });
  }
}

const trimAlt = <T extends { alt: string }>(c: T): T => ({ ...c, alt: c.alt.trim() });

/**
 * What a client may send for an image block: no `width`/`height`.
 * The server stamps them from the asset row, then parses the result with the
 * stored schema below.
 */
export const imageInputSchema = z.object({ src: imageSrc, ...imageFields }).strict().superRefine(imageRules).transform(trimAlt);

/**
 * v2: an uploaded image with server-stamped dimensions. Every v1
 * block is legacy and unreadable (`minReadableVersion`): v1 allowed
 * external sources and had no dimensions or decorative flag.
 */
const imageBlock = define({
  type: "image",
  version: 2,
  minReadableVersion: 2,
  label: "Image",
  description: "One of your uploaded images, with an optional caption and link.",
  category: "media",
  schema: z
    .object({ src: imageSrc, width: imageDimension, height: imageDimension, ...imageFields })
    .strict()
    .superRefine(imageRules)
    .transform(trimAlt),
  defaults: () => ({ src: "", width: 0, height: 0, alt: "", decorative: false, caption: "", href: "", aspect: "auto" as const }),
});

export const MAX_SOCIAL_ITEMS = 24;

/** One social item: a registry platform and its https destination (`socialDestination`). */
const socialItem = z
  .object({
    platform: z.enum(SOCIAL_PLATFORM_IDS, "Choose a platform"),
    url: z.string().trim().min(1, "Add the profile address").max(2048, "URL is too long"),
  })
  .strict()
  .transform((item, ctx) => {
    const destination = socialDestination(item.platform, item.url);
    if (!destination) {
      const platform = getSocialPlatform(item.platform)!;
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: platform.hosts.length
          ? `Enter an https:// ${platform.label} address, like ${platform.placeholder}`
          : "Enter an https:// address, like https://example.com",
      });
      return z.NEVER;
    }
    return { platform: item.platform, url: destination.toString() };
  });

/** v2: 1–24 strict items with the https destination rule; v1 allowed 0 items, `http:` and unknown keys. */
const socialBlock = define({
  type: "social",
  version: 2,
  label: "Social links",
  description: "A row of icons linking to your accounts.",
  category: "links",
  schema: z
    .object({
      items: z.array(socialItem).min(1, "Add at least one social link").max(MAX_SOCIAL_ITEMS, `Use at most ${MAX_SOCIAL_ITEMS} social links`),
      style: z.enum(["inherit", "icon", "pill"]).default("inherit"),
    })
    .strict(),
  defaults: () => ({ items: [{ platform: SOCIAL_PLATFORM_IDS[0], url: "" }], style: "inherit" as const }),
  migrate: sameConfig,
});

/** A provider link, stored in its canonical form (`parseEmbed`). */
const embedUrl = (kind: EmbedKind) =>
  z.string().transform((value, ctx) => {
    const embed = parseEmbed(value, kind);
    if (!embed) {
      ctx.addIssue({ code: "custom", message: embedUrlProblem(value, kind) });
      return z.NEVER;
    }
    return embed.canonicalUrl;
  });

/**
 * v2: strict, with an allowlisted canonical URL. A stored v1 block
 * that meets these rules reads as v2 and is canonicalized on its next save; one
 * that doesn't (`http:`, a loose path, an unknown key) is unreadable.
 */
const videoBlock = define({
  type: "video",
  version: 2,
  label: "Video",
  description: "A YouTube or Vimeo video that loads when a visitor asks for it.",
  category: "media",
  schema: z.object({ url: embedUrl("video"), title: optionalPlainText(100) }).strict(),
  defaults: () => ({ url: "", title: "" }),
  migrate: sameConfig,
});

/** v2: as `video`; v1 had no title. */
const musicBlock = define({
  type: "music",
  version: 2,
  label: "Music",
  description: "A Spotify or SoundCloud player that loads when a visitor asks for it.",
  category: "media",
  schema: z.object({ url: embedUrl("music"), title: optionalPlainText(100) }).strict(),
  defaults: () => ({ url: "", title: "" }),
  migrate: sameConfig,
});

/** v2: strict; labels and the subject refuse control characters. */
const emailBlock = define({
  type: "email",
  version: 2,
  label: "Email",
  description: "A button that opens the visitor's email app.",
  category: "contact",
  schema: z
    .object({
      label: plainText(100, "Add a label"),
      email: emailAddress,
      subject: optionalPlainText(SUBJECT_MAX_LENGTH),
    })
    .strict(),
  defaults: () => ({ label: "Email me", email: "", subject: "" }),
  migrate: sameConfig,
});

/** v2: strict; 4–15 digits once formatting is removed. */
const phoneBlock = define({
  type: "phone",
  version: 2,
  label: "Phone",
  description: "A button that starts a call.",
  category: "contact",
  schema: z
    .object({
      label: plainText(100, "Add a label"),
      phone: phoneNumber,
    })
    .strict(),
  defaults: () => ({ label: "Call me", phone: "" }),
  migrate: sameConfig,
});

/** v2: strict; the phone rule of `phone` blocks; only the note may contain line breaks. */
const contactBlock = define({
  type: "contact",
  version: 2,
  label: "Contact card",
  description: "Lets visitors download your contact details (vCard).",
  category: "contact",
  schema: z
    .object({
      label: plainText(100, "Add a label").default("Save contact"),
      firstName: optionalPlainText(60),
      lastName: optionalPlainText(60),
      organization: optionalPlainText(100),
      jobTitle: optionalPlainText(100),
      email: z.union([z.literal(""), emailAddress]).optional().transform((v) => v || undefined),
      phone: z.union([z.literal(""), phoneNumber]).optional().transform((v) => v || undefined),
      website: optionalLinkUrl,
      note: z
        .string()
        .refine((v) => !hasControlCharsExceptLf(v), "Remove tabs and other control characters")
        .trim()
        .max(300, "Use at most 300 characters")
        .optional()
        .transform((v) => (v ? v : undefined)),
    })
    .strict()
    .refine((c) => c.firstName || c.lastName || c.organization, {
      message: "Add a name or organization",
      path: ["firstName"],
    }),
  defaults: () => ({
    label: "Save contact",
    firstName: "",
    lastName: "",
    organization: "",
    jobTitle: "",
    email: "",
    phone: "",
    website: "",
    note: "",
  }),
  migrate: sameConfig,
});

export const BLOCK_DEFINITIONS = {
  link: linkBlock,
  heading: headingBlock,
  text: textBlock,
  divider: dividerBlock,
  spacer: spacerBlock,
  image: imageBlock,
  social: socialBlock,
  video: videoBlock,
  music: musicBlock,
  email: emailBlock,
  phone: phoneBlock,
  contact: contactBlock,
} as const;

export type BlockType = keyof typeof BLOCK_DEFINITIONS;
export const BLOCK_TYPES = Object.keys(BLOCK_DEFINITIONS) as BlockType[];

export type BlockConfig<T extends BlockType> = z.output<(typeof BLOCK_DEFINITIONS)[T]["schema"]>;
export type BlockConfigInput<T extends BlockType> = z.input<(typeof BLOCK_DEFINITIONS)[T]["schema"]>;

export function isBlockType(value: string): value is BlockType {
  return Object.hasOwn(BLOCK_DEFINITIONS, value);
}

/**
 * Types a client may create or change. A deliberate review
 * gate for future types: a stored block of a registered type left out of this
 * list protects its whole draft.
 */
export const EDITABLE_BLOCK_TYPES = [
  "link",
  "heading",
  "text",
  "divider",
  "social",
  "email",
  "phone",
  "contact",
  "spacer",
  "image",
  "video",
  "music",
] as const satisfies readonly BlockType[];
export type EditableBlockType = (typeof EDITABLE_BLOCK_TYPES)[number];

/** Types whose renderers have been reviewed and may appear on public pages and in the preview. */
export const RENDERABLE_BLOCK_TYPES = [
  "link",
  "heading",
  "text",
  "divider",
  "social",
  "email",
  "phone",
  "contact",
  "spacer",
  "image",
  "video",
  "music",
] as const satisfies readonly BlockType[];
export type RenderableBlockType = (typeof RENDERABLE_BLOCK_TYPES)[number];

export function isEditableBlockType(value: string): value is EditableBlockType {
  return (EDITABLE_BLOCK_TYPES as readonly string[]).includes(value);
}

export function isRenderableBlockType(value: string): value is RenderableBlockType {
  return (RENDERABLE_BLOCK_TYPES as readonly string[]).includes(value);
}

/**
 * Client input schemas for editable types: the storage schema with unknown
 * keys rejected. (Stored v1 heading/text/divider/spacer configs keep their
 * lenient storage schema so older documents still parse; link v2 and the v2
 * social, email, phone, contact, spacer, video and music types are strict in
 * storage too. Image input omits the stamped dimensions.)
 */
export const BLOCK_INPUT_SCHEMAS = {
  link: linkBlock.schema,
  heading: headingBlock.schema.strict(),
  text: textBlock.schema.strict(),
  divider: dividerBlock.schema.strict(),
  social: socialBlock.schema,
  email: emailBlock.schema,
  phone: phoneBlock.schema,
  contact: contactBlock.schema,
  spacer: spacerBlock.schema.strict(),
  image: imageInputSchema,
  video: videoBlock.schema,
  music: musicBlock.schema,
} satisfies Record<EditableBlockType, z.ZodType>;
