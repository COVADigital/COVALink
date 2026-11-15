import { z } from "zod";
import { draftBlockSchema, MAX_BLOCKS, type BlockInput } from "@/features/blocks/input";
import { draftThemeSchema, PRESET_IDS, type ThemeInput } from "@/features/themes/schema";
import { optionalImageSrcSchema } from "@/lib/validation/media";

/**
 * The only profile-content fields a client may change: the header, SEO
 * settings, the block list and the theme. `.strict()` rejects any
 * other key, so unrelated settings can't be written through this contract;
 * the server merges the patch into the stored draft. `blocks` is
 * checked by `resolveBlockList` against the stored blocks. `theme` is
 * checked by the strict `themeInputSchema` and replaces the whole theme;
 * `replaceTheme` is the confirmed replacement of a stored theme the editor
 * can't carry with a preset. Omitted, the stored blocks and theme are
 * kept exactly as they are. Shared by the editor form and server.
 */
export const headerFieldsSchema = z
  .object({
    displayName: z.string().trim().min(1, "Add a display name").max(60, "Use at most 60 characters"),
    bio: z.string().trim().max(300, "Use at most 300 characters"),
    avatarUrl: optionalImageSrcSchema,
  })
  .strict();

export const seoFieldsSchema = z
  .object({
    title: z
      .string()
      .trim()
      .max(70, "Use at most 70 characters")
      .optional()
      .transform((v) => v || undefined),
    description: z
      .string()
      .trim()
      .max(160, "Use at most 160 characters")
      .optional()
      .transform((v) => v || undefined),
    noindex: z.boolean(),
  })
  .strict();

export const draftPatchSchema = z
  .object({
    header: headerFieldsSchema,
    seo: seoFieldsSchema,
    blocks: z.array(z.unknown()).optional(),
    // Validated by the service so its problems can be reported per field (`theme.<path>`).
    theme: z.unknown().optional(),
    replaceTheme: z.enum(PRESET_IDS).optional(),
  })
  .strict()
  .refine((p) => p.theme === undefined || p.replaceTheme === undefined, "Send a theme or a replacement preset, not both");

const TEXT_MAX = 5000;
const draftHeader = z.strictObject({
  displayName: z.string().max(TEXT_MAX),
  bio: z.string().max(TEXT_MAX),
  avatarUrl: z.string().max(TEXT_MAX).optional(),
});
const draftSeo = z.strictObject({
  title: z.string().max(TEXT_MAX).optional(),
  description: z.string().max(TEXT_MAX).optional(),
  noindex: z.boolean(),
});

/**
 * What "Save draft" accepts: the same keys as `draftPatchSchema`, with the
 * text only bounded in size. A patch that also passes `draftPatchSchema` and
 * the service's checks is saved as a valid draft; otherwise it is kept as
 * an unfinished draft. Publishing always requires `draftPatchSchema`.
 */
export const savablePatchSchema = z
  .strictObject({
    header: draftHeader,
    seo: draftSeo,
    blocks: z.array(z.unknown()).optional(),
    theme: z.unknown().optional(),
    replaceTheme: z.enum(PRESET_IDS).optional(),
  })
  .refine((p) => p.theme === undefined || p.replaceTheme === undefined, "Send a theme or a replacement preset, not both");

export type SavablePatch = z.output<typeof savablePatchSchema>;

const messages = z.record(z.string(), z.array(z.string()));

/**
 * An unfinished draft, stored under `incomplete` in the draft document beside
 * the last valid draft: what the editor sent, and why it can't be published
 * yet. It is never copied into the published snapshot.
 */
export const incompleteDraftSchema = z.object({
  header: draftHeader,
  seo: draftSeo,
  blocks: z.array(draftBlockSchema).max(MAX_BLOCKS).optional(),
  theme: draftThemeSchema.optional(),
  issues: z.object({
    message: z.string(),
    fieldErrors: messages.optional(),
    blockErrors: z
      .object({
        list: z.array(z.string()),
        items: z.array(z.object({ index: z.number(), id: z.string().optional(), message: z.string().optional(), fields: messages.optional() })),
      })
      .optional(),
  }),
});

export type IncompleteDraft = z.output<typeof incompleteDraftSchema>;

export type DraftPatch = z.output<typeof draftPatchSchema>;
export type DraftPatchInput = Omit<z.input<typeof draftPatchSchema>, "blocks" | "theme"> & { blocks?: BlockInput[]; theme?: ThemeInput };

export const revisionSchema = z.number().int().min(0);
