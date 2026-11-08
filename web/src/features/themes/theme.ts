import { isMediaUrl } from "@/lib/validation/media";
import { getPreset } from "./presets";
import { isPresetId, storedThemeSchema, THEME_VERSION, type PresetId, type ThemeConfig, type ThemeInput } from "./schema";

/**
 * Stored theme ↔ editor theme. Like blocks, the parsed view
 * is for rendering and validation; what gets written is either the exact
 * stored JSON or a theme built here from strict input.
 */

/** The stored (version 1) theme for a strict input; the server stamps everything the client can't send. */
export function canonicalTheme(input: ThemeInput): ThemeConfig {
  const { background: bg } = input;
  const base = { color: bg.color, gradientTo: bg.gradientTo, gradientAngle: bg.gradientAngle };
  return {
    version: THEME_VERSION,
    preset: input.preset,
    // An image background keeps its media URL (when chosen) and overlay; others get overlay 0 and no image.
    background:
      bg.type === "image"
        ? { type: "image", ...base, ...(bg.imageUrl !== undefined ? { imageUrl: bg.imageUrl } : {}), overlayOpacity: bg.overlayOpacity ?? 0 }
        : { type: bg.type, ...base, overlayOpacity: 0 },
    text: { ...input.text },
    accent: input.accent,
    button: { ...input.button },
    font: { ...input.font },
    layout: { ...input.layout },
    avatar: { ...input.avatar },
    social: { style: getPreset(input.preset).socialStyle },
  };
}

export const presetTheme = (id: PresetId): ThemeConfig => canonicalTheme(getPreset(id).theme);

export const DEFAULT_THEME: ThemeConfig = presetTheme("minimal");

/**
 * The editor's input for a parsed stored theme. Only meaningful for editable
 * themes (recognized preset; solid, gradient or uploaded-image background).
 */
export function toThemeInput(t: ThemeConfig): ThemeInput {
  const bg = t.background;
  const base = { color: bg.color, gradientTo: bg.gradientTo, gradientAngle: bg.gradientAngle };
  return {
    preset: t.preset as PresetId,
    background:
      bg.type === "image"
        ? { type: "image", ...base, ...(bg.imageUrl !== undefined ? { imageUrl: bg.imageUrl } : {}), overlayOpacity: bg.overlayOpacity }
        : { type: bg.type === "gradient" ? "gradient" : "solid", ...base },
    text: { ...t.text },
    accent: t.accent,
    button: { ...t.button },
    font: { ...t.font },
    layout: { ...t.layout },
    avatar: { ...t.avatar },
  };
}

export type ThemeStatus = "editable" | "locked" | "invalid";
export type LockReason = "preset" | "image" | "fields";

export interface StoredTheme {
  /**
   * - `editable` (A): the editor can reproduce every stored field.
   * - `locked` (B): valid, rendered, publishable, but the editor can't round-trip it.
   * - `invalid` (C): unreadable (including a newer version); readers fall back to the default.
   */
  status: ThemeStatus;
  reasons: LockReason[];
  /** Parsed view for rendering and checks; the default theme when invalid. */
  theme: ThemeConfig;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * True when `raw` has exactly the keys of `expected` at every level (it may
 * omit the top-level `version`: legacy v1) and each leaf's parsed value equals
 * the expected one. Exposed fields always match their parsed value, so a
 * mismatch means an unknown key, a missing key, or a stamped field (overlay
 * opacity, social style) the server wouldn't reproduce.
 */
function reproduces(raw: unknown, parsed: unknown, expected: unknown, top = false): boolean {
  if (!isObject(expected)) return parsed === expected;
  if (!isObject(raw) || !isObject(parsed)) return false;
  const rawKeys = Object.keys(raw);
  const wanted = Object.keys(expected).filter((k) => !(top && k === "version" && !Object.hasOwn(raw, "version")));
  if (rawKeys.length !== wanted.length || !wanted.every((k) => Object.hasOwn(raw, k))) return false;
  return wanted.every((k) => reproduces(raw[k], parsed[k], expected[k]));
}

export function assessStoredTheme(raw: unknown): StoredTheme {
  const r = storedThemeSchema.safeParse(raw);
  if (!r.success) return { status: "invalid", reasons: [], theme: DEFAULT_THEME };
  const theme = r.data;
  const reasons: LockReason[] = [];
  if (!isPresetId(theme.preset)) reasons.push("preset");
  // Editable images are exact uploaded-media URLs; an external image, or an
  // image URL left on a solid/gradient background, keeps the theme locked.
  const rawBackground = isObject(raw) && isObject(raw.background) ? raw.background : {};
  if (theme.background.type === "image" ? !isMediaUrl(theme.background.imageUrl) : Object.hasOwn(rawBackground, "imageUrl")) {
    reasons.push("image");
  }
  if (reasons.length === 0 && !reproduces(raw, theme, canonicalTheme(toThemeInput(theme)), true)) reasons.push("fields");
  return { status: reasons.length ? "locked" : "editable", reasons, theme };
}
