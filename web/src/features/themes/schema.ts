import { z } from "zod";
import { isMediaUrl, optionalImageSrcSchema } from "@/lib/validation/media";

/**
 * Theme contracts.
 *
 * - `storedThemeSchema` is the tolerant read view of `draft.theme` /
 *   `published.theme`: it accepts legacy themes without `version` and strips
 *   unknown keys, so it is a rendering view, never what gets written back.
 * - `themeInputSchema` is the strict client contract: only the fields the
 *   appearance editor controls, every object `.strict()`, no version, CSS,
 *   font or free-text field, and no URL except an image background's exact
 *   `/media/{uuid}.webp`. The server builds the stored theme from it
 *   (`canonicalTheme`) and stamps the version.
 */

export const THEME_VERSION = 1;

const HEX = /^#[0-9a-fA-F]{6}$/;
const HEX_MESSAGE = "Use a 6-digit hex color like #1a2b3c";

/** Stored colors: tolerant of surrounding whitespace and case. */
export const hexColor = z
  .string()
  .trim()
  .regex(HEX, HEX_MESSAGE)
  .transform((v) => v.toLowerCase());

/** Client colors: exactly `#rrggbb`, nothing around it. */
const inputHex = z
  .string()
  .regex(HEX, HEX_MESSAGE)
  .transform((v) => v.toLowerCase());

export const FONT_IDS = ["inter", "manrope", "space-grotesk", "dm-serif", "fraunces", "jetbrains-mono"] as const;
export type FontId = (typeof FONT_IDS)[number];

export const PRESET_IDS = [
  "minimal",
  "midnight",
  "editorial",
  "creator",
  "portfolio",
  "neon",
  "soft-gradient",
  "business",
  "music",
  "glass",
] as const;
export type PresetId = (typeof PRESET_IDS)[number];
export const isPresetId = (v: unknown): v is PresetId => (PRESET_IDS as readonly unknown[]).includes(v);

export const BUTTON_VARIANTS = ["fill", "outline", "soft", "glass"] as const;
export const RADII = ["none", "sm", "md", "lg", "full"] as const;
export const SHADOWS = ["none", "soft", "hard"] as const;
export const SCALES = ["sm", "md", "lg"] as const;
export const WIDTHS = ["narrow", "normal", "wide"] as const;
export const SPACINGS = ["compact", "normal", "relaxed"] as const;
export const ALIGNS = ["center", "left"] as const;
export const AVATAR_SHAPES = ["circle", "rounded", "square"] as const;
export const AVATAR_SIZES = ["sm", "md", "lg"] as const;

const angle = z.number().int("Use a whole number of degrees").min(0, "Use 0 to 360 degrees").max(360, "Use 0 to 360 degrees");
const borderWidth = z.number().int().min(0, "Use 0 to 3 pixels").max(3, "Use 0 to 3 pixels");

export const storedThemeSchema = z
  .object({
    version: z.literal(THEME_VERSION).optional(),
    preset: z.string().max(40).default("minimal"),
    background: z.object({
      type: z.enum(["solid", "gradient", "image"]),
      color: hexColor,
      gradientTo: hexColor,
      gradientAngle: angle,
      // Rendered and editable only as an exact uploaded-media URL; an
      // https image (older data) stays readable but locked and isn't rendered.
      imageUrl: z.string().max(2048).optional(),
      overlayOpacity: z.number().min(0).max(0.9),
    }),
    text: z.object({ color: hexColor, muted: hexColor }),
    accent: hexColor,
    button: z.object({
      variant: z.enum(BUTTON_VARIANTS),
      color: hexColor,
      textColor: hexColor,
      radius: z.enum(RADII),
      shadow: z.enum(SHADOWS),
      borderWidth,
    }),
    font: z.object({ body: z.enum(FONT_IDS), heading: z.enum(FONT_IDS), scale: z.enum(SCALES) }),
    layout: z.object({ width: z.enum(WIDTHS), spacing: z.enum(SPACINGS), align: z.enum(ALIGNS) }),
    avatar: z.object({ shape: z.enum(AVATAR_SHAPES), size: z.enum(AVATAR_SIZES), ring: z.boolean() }),
    social: z.object({ style: z.enum(["icon", "pill"]) }),
  })
  .superRefine((t, ctx) => {
    // Same rule as other image sources: uploaded media or https.
    if (t.background.type === "image") {
      const r = optionalImageSrcSchema.safeParse(t.background.imageUrl);
      if (!r.success || !r.data) {
        ctx.addIssue({ code: "custom", path: ["background", "imageUrl"], message: "Choose a background image" });
      }
    }
  });

export type ThemeConfig = z.output<typeof storedThemeSchema>;

export const MAX_OVERLAY = 0.9;

/**
 * Client background. An image background needs an exact
 * canonical uploaded-media URL (ownership and kind are checked by the
 * service) and a black overlay opacity; solid and gradient backgrounds must
 * not carry either.
 */
const inputBackground = z
  .strictObject({
    type: z.enum(["solid", "gradient", "image"], "Choose a solid, gradient or image background"),
    color: inputHex,
    gradientTo: inputHex,
    gradientAngle: angle,
    imageUrl: z.string().max(100).optional(),
    overlayOpacity: z.number().min(0, "Use 0% to 90%").max(MAX_OVERLAY, "Use 0% to 90%").optional(),
  })
  .superRefine((bg, ctx) => {
    if (bg.type === "image") {
      if (bg.imageUrl === undefined || !isMediaUrl(bg.imageUrl)) {
        ctx.addIssue({ code: "custom", path: ["imageUrl"], message: "Choose a background image from your library" });
      }
      if (bg.overlayOpacity === undefined) ctx.addIssue({ code: "custom", path: ["overlayOpacity"], message: "Choose how dark the overlay is" });
    } else {
      if (bg.imageUrl !== undefined) ctx.addIssue({ code: "custom", path: ["imageUrl"], message: "Only image backgrounds have an image" });
      if (bg.overlayOpacity !== undefined) ctx.addIssue({ code: "custom", path: ["overlayOpacity"], message: "Only image backgrounds have an overlay" });
    }
  });

export const themeInputSchema = z.strictObject({
  preset: z.enum(PRESET_IDS, "Choose one of the presets"),
  background: inputBackground,
  text: z.strictObject({ color: inputHex, muted: inputHex }),
  accent: inputHex,
  button: z.strictObject({
    variant: z.enum(BUTTON_VARIANTS),
    color: inputHex,
    textColor: inputHex,
    radius: z.enum(RADII),
    shadow: z.enum(SHADOWS),
    borderWidth,
  }),
  font: z.strictObject({ body: z.enum(FONT_IDS), heading: z.enum(FONT_IDS), scale: z.enum(SCALES) }),
  layout: z.strictObject({ width: z.enum(WIDTHS), spacing: z.enum(SPACINGS), align: z.enum(ALIGNS) }),
  avatar: z.strictObject({ shape: z.enum(AVATAR_SHAPES), size: z.enum(AVATAR_SIZES), ring: z.boolean() }),
});

export type ThemeInput = z.output<typeof themeInputSchema>;
