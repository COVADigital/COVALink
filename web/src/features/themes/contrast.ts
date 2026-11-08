/**
 * WCAG 2.x contrast checks for profile themes. Pure and isomorphic:
 * the editor shows the warnings live and the server enforces them on publish.
 *
 * Blending model (matches `themeToStyle`):
 * - The page background is every gradient stop (or the solid color); a
 *   button or text can sit over any part of a gradient, so the worst stop wins.
 * - `fill`/`soft` buttons are opaque `button.color`.
 * - `outline` buttons are transparent: their text sits on the page stop.
 * - `glass` buttons are `button.color` at 16% alpha over the page stop. The
 *   backdrop blur is not modelled.
 * - Uploaded image backgrounds are drawn under a black overlay
 *   of opacity `o`, so every page pixel lies between `#000000` and the
 *   brightest possible pixel, gray `round(255 × (1 − o))`. Those are the two
 *   stops. Because an image can contain every luminance in between, a color
 *   whose luminance falls between the two surfaces it is checked against
 *   has no guaranteed contrast and is scored 1:1. External image URLs
 *   aren't rendered, so their themes use `background.color` as before.
 */

import { isMediaUrl } from "@/lib/validation/media";

export interface ContrastTheme {
  background: { type: string; color: string; gradientTo: string; imageUrl?: string; overlayOpacity?: number };
  text: { color: string; muted: string };
  accent: string;
  button: { variant: string; color: string; textColor: string };
}

/** Theme field a problem is reported against (dot path under `theme`). */
export type ContrastField = "text.color" | "text.muted" | "button.textColor" | "button.color" | "accent";

export interface ContrastIssue {
  field: ContrastField;
  ratio: number;
  required: number;
  message: string;
}

export const TEXT_CONTRAST = 4.5;
export const NON_TEXT_CONTRAST = 3;
export const GLASS_ALPHA = 0.16;

const HEX = /^#[0-9a-f]{6}$/i;

function channels(hex: string): [number, number, number] {
  if (!HEX.test(hex)) throw new Error(`contrast: not a #rrggbb color: ${hex}`);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance of an sRGB `#rrggbb` color. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `fg` at `alpha` composited over opaque `bg`. */
export function blend(fg: string, bg: string, alpha: number): string {
  const f = channels(fg);
  const b = channels(bg);
  return `#${f.map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The image URL a background renders, or null. Only an image background with
 * an exact uploaded-media URL draws an image (themeToStyle uses the same rule).
 */
export function renderedImage(bg: ContrastTheme["background"]): string | null {
  return bg.type === "image" && isMediaUrl(bg.imageUrl) ? bg.imageUrl : null;
}

/** The darkest and brightest pixel an image can have under a black overlay of `opacity`. */
export function imageExtremes(opacity: number): [string, string] {
  // round(255 × (1 − o)), computed on a 6-decimal value so float noise (1 − 0.9 = 0.0999…) can't round the brightest pixel down.
  const v = Math.round(Number((255 * (1 - opacity)).toFixed(6))).toString(16).padStart(2, "0");
  return ["#000000", `#${v}${v}${v}`];
}

export function backgroundStops(theme: ContrastTheme): string[] {
  if (renderedImage(theme.background)) return imageExtremes(theme.background.overlayOpacity ?? 0);
  return theme.background.type === "gradient" ? [theme.background.color, theme.background.gradientTo] : [theme.background.color];
}

export function buttonSurface(theme: ContrastTheme, pageStop: string): string {
  switch (theme.button.variant) {
    case "outline":
      return pageStop;
    case "glass":
      return blend(theme.button.color, pageStop, GLASS_ALPHA);
    default:
      return theme.button.color;
  }
}

const LABELS: Record<ContrastField, string> = {
  "text.color": "Text",
  "text.muted": "Muted text",
  "button.textColor": "Button text",
  "button.color": "The outline button border",
  accent: "The accent (link underlines, focus rings)",
};

const AGAINST: Record<ContrastField, string> = {
  "text.color": "the background",
  "text.muted": "the background",
  "button.textColor": "the button",
  "button.color": "the background",
  accent: "the background",
};

const fmt = (n: number) => (Math.floor(n * 100) / 100).toFixed(2);

/** All contrast problems of a theme; empty when it can be published. */
export function themeContrastIssues(theme: ContrastTheme): ContrastIssue[] {
  const stops = backgroundStops(theme);
  const image = renderedImage(theme.background) !== null;
  const worst = (fg: (stop: string) => [string, string]) => {
    const pairs = stops.map(fg);
    const ratio = Math.min(...pairs.map(([f, s]) => contrastRatio(f, s)));
    if (!image) return ratio;
    // Over an image the surface takes every value between the two extremes.
    const [lo, hi] = [relativeLuminance(pairs[0][1]), relativeLuminance(pairs[1][1])].sort((a, b) => a - b);
    const l = relativeLuminance(pairs[0][0]);
    return l >= lo && l <= hi ? 1 : ratio;
  };
  const checks: [ContrastField, number, number][] = [
    ["text.color", worst((s) => [theme.text.color, s]), TEXT_CONTRAST],
    ["text.muted", worst((s) => [theme.text.muted, s]), TEXT_CONTRAST],
    ["button.textColor", worst((s) => [theme.button.textColor, buttonSurface(theme, s)]), TEXT_CONTRAST],
    ["accent", worst((s) => [theme.accent, s]), NON_TEXT_CONTRAST],
  ];
  // An outline button's border is its only boundary; other variants have a filled surface and a text label.
  if (theme.button.variant === "outline") checks.push(["button.color", worst((s) => [theme.button.color, s]), NON_TEXT_CONTRAST]);

  const against = (field: ContrastField) =>
    image && AGAINST[field] === "the background" ? "the darkest or brightest part of the background image" : AGAINST[field];
  return checks
    .filter(([, ratio, required]) => ratio < required)
    .map(([field, ratio, required]) => ({
      field,
      ratio,
      required,
      message: `${LABELS[field]} contrast is ${fmt(ratio)}:1 against ${against(field)}; it needs at least ${required}:1.`,
    }));
}

/** Issues keyed as `theme.<field>` messages, the shape `AppError.fieldErrors` carries. */
export function contrastFieldErrors(issues: ContrastIssue[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const i of issues) (out[`theme.${i.field}`] ??= []).push(i.message);
  return out;
}
