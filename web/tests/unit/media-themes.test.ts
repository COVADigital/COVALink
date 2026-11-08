import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backgroundStops, contrastRatio, imageExtremes, renderedImage, themeContrastIssues } from "@/features/themes/contrast";
import { themeToStyle } from "@/features/themes/css";
import { getPreset } from "@/features/themes/presets";
import { storedThemeSchema, themeInputSchema, type ThemeConfig, type ThemeInput } from "@/features/themes/schema";
import { assessStoredTheme, canonicalTheme, toThemeInput } from "@/features/themes/theme";

/**
 * Image backgrounds: the strict input, stored-theme
 * compatibility, the shared renderer and the conservative two-extreme
 * contrast model.
 */

const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e.webp";
const URL_ = `/media/${KEY}`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Midnight (light text on dark) with an image background. */
function imageInput(overlayOpacity = 0.6, patch: (t: ThemeInput) => void = () => {}): ThemeInput {
  const t = clone(getPreset("midnight").theme);
  t.background = { ...t.background, type: "image", imageUrl: URL_, overlayOpacity };
  patch(t);
  return t;
}

describe("image background input (strict)", () => {
  it("accepts an exact uploaded-media URL with an overlay of 0 to 0.9", () => {
    for (const o of [0, 0.35, 0.6, 0.9]) expect(themeInputSchema.safeParse(imageInput(o)).success, String(o)).toBe(true);
  });

  it.each([
    ["no image", (t: ThemeInput) => delete t.background.imageUrl, "background.imageUrl"],
    ["an https image", (t: ThemeInput) => (t.background.imageUrl = "https://img.example.com/bg.webp"), "background.imageUrl"],
    ["a protocol-relative image", (t: ThemeInput) => (t.background.imageUrl = `//evil.example${URL_}`), "background.imageUrl"],
    ["a padded media URL", (t: ThemeInput) => (t.background.imageUrl = ` ${URL_}`), "background.imageUrl"],
    ["a legacy media path", (t: ThemeInput) => (t.background.imageUrl = "/media/u/bg.png"), "background.imageUrl"],
    ["a CSS breakout", (t: ThemeInput) => (t.background.imageUrl = `${URL_}"), url(https://evil.example/x`), "background.imageUrl"],
    ["no overlay", (t: ThemeInput) => delete t.background.overlayOpacity, "background.overlayOpacity"],
    ["an overlay above 0.9", (t: ThemeInput) => (t.background.overlayOpacity = 0.95), "background.overlayOpacity"],
    ["a negative overlay", (t: ThemeInput) => (t.background.overlayOpacity = -0.1), "background.overlayOpacity"],
    ["a string overlay", (t: ThemeInput) => ((t.background as Record<string, unknown>).overlayOpacity = "0.5"), "background.overlayOpacity"],
  ])("rejects %s", (_, patch, field) => {
    const r = themeInputSchema.safeParse(imageInput(0.6, patch));
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join("."))).toContain(field);
  });

  it("rejects image fields on solid and gradient backgrounds", () => {
    for (const type of ["solid", "gradient"] as const) {
      const withImage = imageInput(0.6, (t) => (t.background.type = type));
      expect(themeInputSchema.safeParse(withImage).success, type).toBe(false);
    }
  });
});

describe("stored image themes", () => {
  it("an uploaded-image theme is editable and round-trips exactly", () => {
    const stored = canonicalTheme(themeInputSchema.parse(imageInput(0.45)));
    const m = getPreset("midnight").theme.background;
    expect(stored.background).toEqual({ type: "image", color: m.color, gradientTo: m.gradientTo, gradientAngle: m.gradientAngle, imageUrl: URL_, overlayOpacity: 0.45 });
    const state = assessStoredTheme(clone(stored));
    expect(state.status).toBe("editable");
    expect(canonicalTheme(toThemeInput(state.theme))).toEqual(stored);
  });

  it("an external image theme stays locked and isn't rendered (existing behavior)", () => {
    const stored = { ...canonicalTheme(themeInputSchema.parse(imageInput())), background: { ...canonicalTheme(themeInputSchema.parse(imageInput())).background, imageUrl: "https://img.example.com/bg.png" } };
    expect(storedThemeSchema.safeParse(stored).success).toBe(true);
    expect(assessStoredTheme(stored)).toMatchObject({ status: "locked", reasons: ["image"] });
    const css = JSON.stringify(themeToStyle(storedThemeSchema.parse(stored)));
    expect(css).not.toContain("img.example.com");
    expect(css).not.toContain("url(");
  });

  it("a solid theme keeps overlay 0 and no image field after switching away from an image", () => {
    const solid = imageInput(0.6, (t) => {
      t.background = { type: "solid", color: t.background.color, gradientTo: t.background.gradientTo, gradientAngle: t.background.gradientAngle };
    });
    const stored = canonicalTheme(themeInputSchema.parse(solid));
    const m = getPreset("midnight").theme.background;
    expect(stored.background).toEqual({ type: "solid", color: m.color, gradientTo: m.gradientTo, gradientAngle: m.gradientAngle, overlayOpacity: 0 });
  });
});

describe("shared renderer (preview and public page)", () => {
  it("draws the black overlay over the centered, covering, non-repeating image over the fallback color", () => {
    const style = themeToStyle(canonicalTheme(themeInputSchema.parse(imageInput(0.6)))) as Record<string, string>;
    expect(style["--pp-bg"]).toBe(`linear-gradient(rgb(0 0 0 / 0.6), rgb(0 0 0 / 0.6)), url("${URL_}") center / cover no-repeat ${getPreset("midnight").theme.background.color}`);
  });

  it("only ever puts the exact media key pattern inside url()", () => {
    const hostile = clone(canonicalTheme(themeInputSchema.parse(imageInput()))) as ThemeConfig;
    for (const bad of [`${URL_}"), url(https://evil.example/x`, "https://evil.example/x.webp", "/media/x.webp", "javascript:alert(1)"]) {
      hostile.background.imageUrl = bad;
      expect(renderedImage(hostile.background)).toBeNull();
      expect(JSON.stringify(themeToStyle(hostile))).not.toContain("url(");
    }
  });
});

describe("conservative image contrast", () => {
  it("checks against #000000 and the brightest pixel after the overlay", () => {
    expect(imageExtremes(0)).toEqual(["#000000", "#ffffff"]);
    expect(imageExtremes(0.6)).toEqual(["#000000", "#666666"]);
    expect(imageExtremes(0.9)).toEqual(["#000000", "#1a1a1a"]);
    const theme = canonicalTheme(themeInputSchema.parse(imageInput(0.6)));
    expect(backgroundStops(theme)).toEqual(["#000000", "#666666"]);
  });

  it("passes light text over a dark enough overlay", () => {
    const theme = canonicalTheme(
      themeInputSchema.parse(
        imageInput(0.7, (t) => {
          t.text = { color: "#ffffff", muted: "#e4e4e7" };
          t.accent = "#ffffff";
          t.button = { ...t.button, variant: "fill", color: "#ffffff", textColor: "#111111" };
        }),
      ),
    );
    expect(themeContrastIssues(theme)).toEqual([]);
  });

  it("fails dark text over any image, even with the darkest overlay", () => {
    const theme = canonicalTheme(themeInputSchema.parse(imageInput(0.9, (t) => (t.text = { color: "#18181b", muted: "#52525b" }))));
    expect(themeContrastIssues(theme).map((i) => i.field)).toEqual(expect.arrayContaining(["text.color", "text.muted"]));
  });

  it("fails a mid-tone color even when both extremes alone would pass (a pixel of that luminance can exist)", () => {
    // With no overlay the extremes are black and white; #767676 has ≥ 4.5:1 against both.
    expect(contrastRatio("#767676", "#000000")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    const theme = canonicalTheme(themeInputSchema.parse(imageInput(0, (t) => (t.text = { color: "#767676", muted: "#767676" }))));
    const issues = themeContrastIssues(theme).filter((i) => i.field === "text.color");
    expect(issues).toHaveLength(1);
    expect(issues[0].ratio).toBe(1);
    expect(issues[0].message).toContain("background image");
  });

  it("checks outline borders, glass surfaces and outline button text against both extremes", () => {
    const outline = canonicalTheme(
      themeInputSchema.parse(imageInput(0.6, (t) => (t.button = { ...t.button, variant: "outline", color: "#555555", textColor: "#ffffff" }))),
    );
    expect(themeContrastIssues(outline).map((i) => i.field)).toContain("button.color");
    const glass = canonicalTheme(
      themeInputSchema.parse(imageInput(0.6, (t) => (t.button = { ...t.button, variant: "glass", color: "#ffffff", textColor: "#ffffff" }))),
    );
    // Glass over the brightest pixel: 16% white over #666666 → still under 4.5:1 for white text.
    expect(themeContrastIssues(glass).map((i) => i.field)).toContain("button.textColor");
  });

  it("is one isomorphic module: the editor and the publish check import the same function", () => {
    const src = (p: string) => readFileSync(path.resolve(import.meta.dirname, "../../src", p), "utf8");
    expect(src("components/editor/appearance-editor.tsx")).toContain('import { themeContrastIssues, type ContrastIssue } from "@/features/themes/contrast"');
    expect(src("features/profiles/service.ts")).toContain('import { contrastFieldErrors, themeContrastIssues } from "@/features/themes/contrast"');
  });

  it("leaves solid and gradient themes on the worst-stop rule", () => {
    for (const id of ["minimal", "midnight", "creator", "glass"] as const) {
      const t = canonicalTheme(getPreset(id).theme);
      expect(renderedImage(t.background)).toBeNull();
      expect(themeContrastIssues(t), id).toEqual([]);
    }
  });
});
