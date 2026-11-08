import type { CSSProperties } from "react";
import { GLASS_ALPHA, renderedImage } from "./contrast";
import type { FontId, ThemeConfig } from "./schema";

export const FONT_LABELS: Record<FontId, string> = {
  inter: "Inter",
  manrope: "Manrope",
  "space-grotesk": "Space Grotesk",
  "dm-serif": "DM Serif Display",
  fraunces: "Fraunces",
  "jetbrains-mono": "JetBrains Mono",
};

/**
 * Font stacks for the self-hosted Fontsource faces. The family names
 * are the ones declared by the imported Fontsource CSS
 * (components/profile/theme-fonts.ts); the fallbacks apply until the file
 * arrives (font-display: swap) or if it can't load.
 */
export const FONT_STACKS: Record<FontId, string> = {
  inter: "'Inter Variable', ui-sans-serif, system-ui, sans-serif",
  manrope: "'Manrope Variable', ui-sans-serif, system-ui, sans-serif",
  "space-grotesk": "'Space Grotesk Variable', ui-sans-serif, system-ui, sans-serif",
  "dm-serif": "'DM Serif Display', ui-serif, Georgia, serif",
  fraunces: "'Fraunces Variable', ui-serif, Georgia, serif",
  "jetbrains-mono": "'JetBrains Mono Variable', ui-monospace, monospace",
};

const RADIUS = { none: "0px", sm: "6px", md: "12px", lg: "18px", full: "999px" } as const;
const WIDTH = { narrow: "28rem", normal: "36rem", wide: "44rem" } as const;
const GAP = { compact: "0.5rem", normal: "0.75rem", relaxed: "1.125rem" } as const;
const SCALE = { sm: "15px", md: "16px", lg: "17.5px" } as const;
const AVATAR = { sm: "72px", md: "96px", lg: "120px" } as const;
const AVATAR_RADIUS = { circle: "999px", rounded: "24%", square: "6px" } as const;

/** Only `#rrggbb` reaches here (enforced by storedThemeSchema), so values are safe in CSS. */
function alpha(hex: string, a: number): string {
  const v = Math.round(a * 255).toString(16).padStart(2, "0");
  return `${hex}${v}`;
}

/**
 * Converts a validated theme into CSS custom properties consumed by the
 * public profile primitives (`.pp-*` classes in globals.css). Every value is
 * a lookup-table entry, a validated `#rrggbb` color or a bounded integer, and
 * the result is a React style object, never CSS text.
 *
 * An image background is drawn only for an exact uploaded-media
 * URL (`/media/{uuid}.webp`: lowercase hex, dashes and `.webp`, nothing that
 * can break out of `url("…")`): a uniform black overlay at the stored
 * opacity over the image (cover, centered, no repeat) over the background
 * color, which shows while the image loads. Any other stored image URL is
 * never put into CSS; that theme shows its background color.
 */
export function themeToStyle(theme: ThemeConfig): CSSProperties {
  const { background: bg, button: btn } = theme;
  const image = renderedImage(bg);
  const overlay = `rgb(0 0 0 / ${Number(bg.overlayOpacity.toFixed(4))})`;
  const background = image
    ? `linear-gradient(${overlay}, ${overlay}), url("${image}") center / cover no-repeat ${bg.color}`
    : bg.type === "gradient"
      ? `linear-gradient(${bg.gradientAngle}deg, ${bg.color}, ${bg.gradientTo})`
      : bg.color;

  let btnBg: string;
  let btnBorder: string;
  switch (btn.variant) {
    case "fill":
      btnBg = btn.color;
      btnBorder = btn.color;
      break;
    case "outline":
      btnBg = "transparent";
      btnBorder = btn.color;
      break;
    case "soft":
      btnBg = btn.color;
      btnBorder = "transparent";
      break;
    case "glass":
      btnBg = alpha(btn.color, GLASS_ALPHA);
      btnBorder = alpha(btn.color, 0.35);
      break;
  }

  const shadow =
    btn.shadow === "hard"
      ? `4px 4px 0 0 ${theme.text.color}`
      : btn.shadow === "soft"
        ? "0 1px 2px rgb(0 0 0 / 0.08), 0 6px 16px -6px rgb(0 0 0 / 0.18)"
        : "none";

  return {
    "--pp-bg": background,
    "--pp-text": theme.text.color,
    "--pp-muted": theme.text.muted,
    "--pp-accent": theme.accent,
    "--pp-btn-bg": btnBg,
    "--pp-btn-text": btn.textColor,
    "--pp-btn-border": btnBorder,
    "--pp-btn-border-width": `${btn.variant === "outline" ? Math.max(1, btn.borderWidth) : btn.borderWidth}px`,
    "--pp-btn-radius": RADIUS[btn.radius],
    "--pp-btn-shadow": shadow,
    "--pp-btn-blur": btn.variant === "glass" ? "blur(12px)" : "none",
    "--pp-font-body": FONT_STACKS[theme.font.body],
    "--pp-font-heading": FONT_STACKS[theme.font.heading],
    "--pp-font-size": SCALE[theme.font.scale],
    "--pp-width": WIDTH[theme.layout.width],
    "--pp-gap": GAP[theme.layout.spacing],
    "--pp-align": theme.layout.align,
    "--pp-items": theme.layout.align === "left" ? "flex-start" : "center",
    "--pp-avatar-size": AVATAR[theme.avatar.size],
    "--pp-avatar-radius": AVATAR_RADIUS[theme.avatar.shape],
    "--pp-avatar-ring": theme.avatar.ring ? `0 0 0 3px ${theme.accent}` : "none",
  } as CSSProperties;
}
