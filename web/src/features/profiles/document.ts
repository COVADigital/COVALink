import { z } from "zod";
import { blockSchema, parseBlock, type Block, type DraftBlock } from "@/features/blocks/block";
import { MAX_BLOCKS } from "@/features/blocks/input";
import { storedThemeSchema, type ThemeConfig } from "@/features/themes/schema";
import { DEFAULT_THEME } from "@/features/themes/theme";
import { optionalImageSrcSchema } from "@/lib/validation/media";

export { MAX_BLOCKS };

const headerSchema = z.object({
  displayName: z.string().trim().min(1, "Add a display name").max(60),
  bio: z.string().trim().max(300).default(""),
  avatarUrl: optionalImageSrcSchema,
});

const settingsSchema = z.object({
  openLinksInNewTab: z.boolean().default(false),
  showBranding: z.boolean().default(true),
  seo: z.object({
    title: z.string().trim().max(70).optional().transform((v) => v || undefined),
    description: z.string().trim().max(160).optional().transform((v) => v || undefined),
    noindex: z.boolean().default(false),
  }),
});

export const profileDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    header: headerSchema,
    blocks: z.array(blockSchema).max(MAX_BLOCKS, `A profile can have at most ${MAX_BLOCKS} blocks`),
    theme: storedThemeSchema,
    settings: settingsSchema,
  })
  .superRefine((doc, ctx) => {
    const seen = new Set<string>();
    doc.blocks.forEach((b, i) => {
      if (seen.has(b.id)) ctx.addIssue({ code: "custom", path: ["blocks", i, "id"], message: "Duplicate block id" });
      seen.add(b.id);
    });
  });

export type ProfileDocument = z.output<typeof profileDocumentSchema>;

/** Editor-side document: blocks may be incomplete until saved. */
export type DraftDocument = Omit<ProfileDocument, "blocks" | "theme"> & { blocks: DraftBlock[]; theme: ThemeConfig };

export function createDefaultDocument(displayName: string): ProfileDocument {
  return {
    schemaVersion: 1,
    header: { displayName, bio: "", avatarUrl: undefined },
    blocks: [],
    theme: DEFAULT_THEME,
    settings: { openLinksInNewTab: false, showBranding: true, seo: { title: undefined, description: undefined, noindex: false } },
  };
}

/**
 * Tolerant read of a stored document: invalid blocks are dropped and an invalid
 * theme falls back to the default, so one bad field can never take a public
 * page offline. Writes always go through the strict `profileDocumentSchema`.
 */
export function readDocument(raw: unknown, fallbackName = "Untitled"): { doc: ProfileDocument; dropped: number } {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const header = headerSchema.safeParse(obj.header);
  const theme = storedThemeSchema.safeParse(obj.theme);
  const settings = settingsSchema.safeParse(obj.settings);
  // Rendering is capped at MAX_BLOCKS; `dropped` also counts the overflow so
  // callers can tell the document holds more than is shown.
  const allBlocks: unknown[] = Array.isArray(obj.blocks) ? obj.blocks : [];
  const blocks: Block[] = [];
  for (const rb of allBlocks.slice(0, MAX_BLOCKS)) {
    const r = parseBlock(rb);
    if (r.success) blocks.push(r.block);
  }
  const base = createDefaultDocument(fallbackName);
  return {
    doc: {
      schemaVersion: 1,
      header: header.success ? header.data : base.header,
      blocks,
      theme: theme.success ? theme.data : base.theme,
      settings: settings.success ? settings.data : base.settings,
    },
    dropped: allBlocks.length - blocks.length,
  };
}
