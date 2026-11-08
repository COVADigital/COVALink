import type { PresetId, ThemeInput } from "./schema";

/**
 * The ten selectable starting points. Each is a complete strict
 * theme input; the stored form is built by `canonicalTheme`. A stored theme
 * holds copied values, not a reference, so changing a preset here never
 * changes a page someone already saved.
 *
 * Every preset must pass the contrast policy (tests/unit/themes.test.ts).
 * Contrast corrections: Creator's button color (#ea580c → #c2410c, white label
 * 3.56:1 → 5.18:1) and Glass's first gradient stop (#0f766e → #115e59, muted
 * text 4.12:1 → 5.71:1, glass button label 3.84:1 → 4.91:1).
 */
export interface ThemePreset {
  id: PresetId;
  name: string;
  description: string;
  theme: ThemeInput;
  /** Social icon style isn't editable; the server stamps the preset's value. */
  socialStyle: "icon" | "pill";
}

type PresetTheme = Omit<ThemeInput, "preset">;

function preset(id: PresetId, name: string, description: string, socialStyle: "icon" | "pill", theme: PresetTheme): ThemePreset {
  return { id, name, description, socialStyle, theme: { preset: id, ...theme } };
}

const baseLayout = { width: "normal", spacing: "normal", align: "center" } as const;

export const THEME_PRESETS: readonly ThemePreset[] = [
  preset("minimal", "Minimal", "Quiet monochrome with crisp outlines.", "icon", {
    background: { type: "solid", color: "#fafafa", gradientTo: "#f4f4f5", gradientAngle: 180 },
    text: { color: "#18181b", muted: "#52525b" },
    accent: "#18181b",
    button: { variant: "outline", color: "#18181b", textColor: "#18181b", radius: "md", shadow: "none", borderWidth: 1 },
    font: { body: "inter", heading: "inter", scale: "md" },
    layout: baseLayout,
    avatar: { shape: "circle", size: "md", ring: false },
  }),
  preset("midnight", "Midnight", "Deep navy, luminous buttons, high contrast.", "icon", {
    background: { type: "gradient", color: "#0b1020", gradientTo: "#1a1f3c", gradientAngle: 160 },
    text: { color: "#f1f5f9", muted: "#a5b4cf" },
    accent: "#7dd3fc",
    button: { variant: "soft", color: "#1e2a4a", textColor: "#e2e8f0", radius: "lg", shadow: "soft", borderWidth: 0 },
    font: { body: "manrope", heading: "manrope", scale: "md" },
    layout: baseLayout,
    avatar: { shape: "circle", size: "lg", ring: true },
  }),
  preset("editorial", "Editorial", "Serif headlines on warm paper, left aligned.", "pill", {
    background: { type: "solid", color: "#f6f1e7", gradientTo: "#efe6d4", gradientAngle: 180 },
    text: { color: "#2b2118", muted: "#6b5a49" },
    accent: "#9a3412",
    button: { variant: "outline", color: "#2b2118", textColor: "#2b2118", radius: "none", shadow: "none", borderWidth: 1 },
    font: { body: "inter", heading: "dm-serif", scale: "lg" },
    layout: { width: "normal", spacing: "relaxed", align: "left" },
    avatar: { shape: "square", size: "md", ring: false },
  }),
  preset("creator", "Creator", "Bold color pops and chunky pill buttons.", "icon", {
    background: { type: "solid", color: "#fff7ed", gradientTo: "#ffedd5", gradientAngle: 180 },
    text: { color: "#1c1917", muted: "#57534e" },
    accent: "#ea580c",
    button: { variant: "fill", color: "#c2410c", textColor: "#ffffff", radius: "full", shadow: "hard", borderWidth: 2 },
    font: { body: "space-grotesk", heading: "space-grotesk", scale: "md" },
    layout: baseLayout,
    avatar: { shape: "circle", size: "lg", ring: true },
  }),
  preset("portfolio", "Portfolio", "Wide, airy and understated for showcasing work.", "pill", {
    background: { type: "solid", color: "#ffffff", gradientTo: "#f8fafc", gradientAngle: 180 },
    text: { color: "#0f172a", muted: "#64748b" },
    accent: "#2563eb",
    button: { variant: "soft", color: "#f1f5f9", textColor: "#0f172a", radius: "sm", shadow: "none", borderWidth: 0 },
    font: { body: "manrope", heading: "fraunces", scale: "md" },
    layout: { width: "wide", spacing: "relaxed", align: "left" },
    avatar: { shape: "rounded", size: "md", ring: false },
  }),
  preset("neon", "Neon", "Black canvas with electric outlined buttons.", "icon", {
    background: { type: "solid", color: "#050505", gradientTo: "#111111", gradientAngle: 180 },
    text: { color: "#f5f5f5", muted: "#a3a3a3" },
    accent: "#a3e635",
    button: { variant: "outline", color: "#a3e635", textColor: "#a3e635", radius: "md", shadow: "none", borderWidth: 2 },
    font: { body: "jetbrains-mono", heading: "space-grotesk", scale: "md" },
    layout: baseLayout,
    avatar: { shape: "rounded", size: "md", ring: true },
  }),
  preset("soft-gradient", "Soft Gradient", "Pastel sunrise gradient with frosted buttons.", "icon", {
    background: { type: "gradient", color: "#fbcfe8", gradientTo: "#c7d2fe", gradientAngle: 135 },
    text: { color: "#1e1b4b", muted: "#4c1d95" },
    accent: "#7c3aed",
    button: { variant: "glass", color: "#ffffff", textColor: "#1e1b4b", radius: "lg", shadow: "soft", borderWidth: 1 },
    font: { body: "manrope", heading: "manrope", scale: "md" },
    layout: baseLayout,
    avatar: { shape: "circle", size: "lg", ring: true },
  }),
  preset("business", "Business", "Trustworthy slate and blue, compact layout.", "pill", {
    background: { type: "solid", color: "#f1f5f9", gradientTo: "#e2e8f0", gradientAngle: 180 },
    text: { color: "#0f172a", muted: "#475569" },
    accent: "#1d4ed8",
    button: { variant: "fill", color: "#1d4ed8", textColor: "#ffffff", radius: "sm", shadow: "soft", borderWidth: 0 },
    font: { body: "inter", heading: "inter", scale: "sm" },
    layout: { width: "normal", spacing: "compact", align: "center" },
    avatar: { shape: "rounded", size: "sm", ring: false },
  }),
  preset("music", "Music", "Moody plum gradient for artists and podcasts.", "icon", {
    background: { type: "gradient", color: "#2e1065", gradientTo: "#831843", gradientAngle: 200 },
    text: { color: "#fdf4ff", muted: "#f0abfc" },
    accent: "#f472b6",
    button: { variant: "fill", color: "#fdf4ff", textColor: "#2e1065", radius: "full", shadow: "none", borderWidth: 0 },
    font: { body: "space-grotesk", heading: "fraunces", scale: "lg" },
    layout: baseLayout,
    avatar: { shape: "circle", size: "lg", ring: false },
  }),
  preset("glass", "Glass", "Frosted cards floating over a cool backdrop.", "icon", {
    background: { type: "gradient", color: "#115e59", gradientTo: "#1e3a8a", gradientAngle: 145 },
    text: { color: "#f0fdfa", muted: "#bae6fd" },
    accent: "#5eead4",
    button: { variant: "glass", color: "#ffffff", textColor: "#f0fdfa", radius: "lg", shadow: "soft", borderWidth: 1 },
    font: { body: "inter", heading: "manrope", scale: "md" },
    layout: baseLayout,
    avatar: { shape: "circle", size: "md", ring: true },
  }),
];

export function getPreset(id: PresetId): ThemePreset {
  const p = THEME_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown theme preset: ${id}`);
  return p;
}
