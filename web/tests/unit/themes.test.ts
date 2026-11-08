import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  backgroundStops,
  blend,
  buttonSurface,
  contrastFieldErrors,
  contrastRatio,
  relativeLuminance,
  themeContrastIssues,
} from "@/features/themes/contrast";
import { FONT_STACKS, themeToStyle } from "@/features/themes/css";
import { getPreset, THEME_PRESETS } from "@/features/themes/presets";
import {
  ALIGNS,
  AVATAR_SHAPES,
  AVATAR_SIZES,
  BUTTON_VARIANTS,
  FONT_IDS,
  PRESET_IDS,
  RADII,
  SCALES,
  SHADOWS,
  SPACINGS,
  storedThemeSchema,
  themeInputSchema,
  WIDTHS,
  type ThemeConfig,
  type ThemeInput,
} from "@/features/themes/schema";
import { assessStoredTheme, canonicalTheme, DEFAULT_THEME, presetTheme, toThemeInput } from "@/features/themes/theme";

const SRC = path.resolve(import.meta.dirname, "../../src");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const input = (): ThemeInput => clone(getPreset("creator").theme);
const omit = <T extends object>(obj: T, key: keyof T) => {
  const copy: Partial<T> = clone(obj);
  delete copy[key];
  return copy;
};

/** The original scaffold default as it was stored in every existing profile (no `version`). */
const LEGACY_MINIMAL = {
  preset: "minimal",
  background: { type: "solid", color: "#fafafa", gradientTo: "#f4f4f5", gradientAngle: 180, overlayOpacity: 0 },
  text: { color: "#18181b", muted: "#52525b" },
  accent: "#18181b",
  button: { variant: "outline", color: "#18181b", textColor: "#18181b", radius: "md", shadow: "none", borderWidth: 1 },
  font: { body: "inter", heading: "inter", scale: "md" },
  layout: { width: "normal", spacing: "normal", align: "center" },
  avatar: { shape: "circle", size: "md", ring: false },
  social: { style: "icon" },
};

describe("theme input contract (strict)", () => {
  it("accepts every preset and lower-cases colors", () => {
    for (const p of THEME_PRESETS) expect(themeInputSchema.safeParse(p.theme).success, p.id).toBe(true);
    const t = input();
    t.accent = "#ABCDEF";
    expect(themeInputSchema.parse(t).accent).toBe("#abcdef");
  });

  // Deliberately untyped: the cases write values the input type forbids.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Loose = Record<string, any>;
  const set = (mutate: (t: Loose) => void) => {
    const t = input() as unknown as Loose;
    mutate(t);
    return t;
  };

  it.each([
    ["a named color", set((t) => (t.accent = "red"))],
    ["a 3-digit hex", set((t) => (t.accent = "#fff"))],
    ["an 8-digit hex (alpha)", set((t) => (t.accent = "#ffffffff"))],
    ["surrounding whitespace", set((t) => (t.accent = " #ffffff"))],
    ["a declaration break-out", set((t) => (t.text.color = "#ffffff;}body{display:none"))],
    ["url(javascript:)", set((t) => (t.background.color = "url(javascript:alert(1))"))],
    ["expression()", set((t) => (t.button.color = "expression(alert(1))"))],
    ["a style-tag break-out", set((t) => (t.button.textColor = "</style><script>alert(1)</script>"))],
    ["a CSS escape", set((t) => (t.text.muted = "\\23 ffffff"))],
    ["a numeric color", set((t) => (t.accent = 0xffffff))],
    ["an angle below 0", set((t) => (t.background.gradientAngle = -1))],
    ["an angle above 360", set((t) => (t.background.gradientAngle = 361))],
    ["a fractional angle", set((t) => (t.background.gradientAngle = 1.5))],
    ["an angle as text", set((t) => (t.background.gradientAngle = "90"))],
    ["border width 4", set((t) => (t.button.borderWidth = 4))],
    ["a fractional border width", set((t) => (t.button.borderWidth = 1.5))],
    ["an unknown preset", set((t) => (t.preset = "custom-x"))],
    ["an image background", set((t) => (t.background.type = "image"))],
    ["an image URL", set((t) => (t.background.imageUrl = "https://img.example.com/bg.png"))],
    ["an overlay opacity", set((t) => (t.background.overlayOpacity = 0.4))],
    ["a client version", set((t) => (t.version = 1))],
    ["a social style", set((t) => (t.social = { style: "pill" }))],
    ["custom CSS", set((t) => (t.css = "body{}"))],
    ["a font URL", set((t) => (t.font.url = "https://fonts.example.com/x.woff2"))],
    ["an unknown font", set((t) => (t.font.body = "comic-sans"))],
    ["a font family string", set((t) => (t.font.heading = "'Inter', url(x)"))],
    ["an unknown button variant", set((t) => (t.button.variant = "neon"))],
    ["a non-boolean ring", set((t) => (t.avatar.ring = "true"))],
    ["an extra nested key", set((t) => (t.button.html = "<b>"))],
    ["a missing section", set((t) => delete t.layout)],
    ["an array for an object", set((t) => (t.text = ["#000000", "#ffffff"]))],
  ])("rejects %s", (_label, payload) => {
    expect(themeInputSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects prototype-related keys, top-level and nested", () => {
    const base = JSON.stringify(input());
    for (const json of [
      base.replace(/^\{/, '{"__proto__":{"polluted":true},'),
      base.replace('"button":{', '"button":{"__proto__":{"polluted":true},'),
      base.replace(/^\{/, '{"constructor":{"prototype":{"polluted":true}},'),
      base.replace(/^\{/, '{"prototype":{},'),
    ]) {
      expect(themeInputSchema.safeParse(JSON.parse(json)).success, json.slice(0, 40)).toBe(false);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("stored theme, version and canonical form", () => {
  it("stamps version 1, no overlay and the preset's social style; never anything from the client", () => {
    const t = canonicalTheme(input());
    expect(t.version).toBe(1);
    expect(t.background.overlayOpacity).toBe(0);
    expect(t.background).not.toHaveProperty("imageUrl");
    expect(t.social.style).toBe(getPreset("creator").socialStyle);
    expect(canonicalTheme({ ...input(), preset: "editorial" }).social.style).toBe("pill");
    expect(storedThemeSchema.parse(t)).toEqual(t);
  });

  it("reads a legacy theme without `version` as v1, and refuses newer or malformed versions", () => {
    expect(storedThemeSchema.safeParse(LEGACY_MINIMAL).success).toBe(true);
    for (const version of [2, 0, "1", null]) {
      expect(storedThemeSchema.safeParse({ ...LEGACY_MINIMAL, version }).success, String(version)).toBe(false);
    }
  });

  it("the default theme is the canonical Minimal preset", () => {
    expect(DEFAULT_THEME).toEqual(presetTheme("minimal"));
    expect(DEFAULT_THEME.version).toBe(1);
  });

  it("applying or resetting a preset yields exactly that preset's theme", () => {
    for (const id of PRESET_IDS) {
      expect(toThemeInput(presetTheme(id))).toEqual(getPreset(id).theme);
      expect(canonicalTheme(getPreset(id).theme)).toEqual(presetTheme(id));
    }
  });
});

describe("assessStoredTheme: editable, locked (compatible), invalid", () => {
  const status = (raw: unknown) => assessStoredTheme(raw);

  it("editable: every preset, the legacy scaffold default, and normalized-only differences", () => {
    for (const id of PRESET_IDS) expect(status(presetTheme(id)).status, id).toBe("editable");
    expect(status(LEGACY_MINIMAL)).toMatchObject({ status: "editable", reasons: [] });
    const upper = clone(LEGACY_MINIMAL);
    upper.accent = "#18181B";
    upper.text.color = " #18181b ";
    expect(status(upper).status).toBe("editable");
    // A preset theme the owner customized is still editable.
    expect(status({ ...presetTheme("neon"), accent: "#ff00ff" }).status).toBe("editable");
  });

  it.each([
    ["an unknown top-level key", { ...LEGACY_MINIMAL, futureFlag: true }, "fields"],
    ["a blank unknown key", { ...LEGACY_MINIMAL, futureFlag: "" }, "fields"],
    ["an unknown nested key", { ...LEGACY_MINIMAL, button: { ...LEGACY_MINIMAL.button, glow: null } }, "fields"],
    ["a custom preset name", { ...LEGACY_MINIMAL, preset: "custom-x" }, "preset"],
    ["a missing preset", omit(LEGACY_MINIMAL, "preset"), "fields"],
    ["an image background", { ...LEGACY_MINIMAL, background: { ...LEGACY_MINIMAL.background, type: "image", imageUrl: "https://img.example.com/bg.png" } }, "image"],
    ["an image URL on a solid background", { ...LEGACY_MINIMAL, background: { ...LEGACY_MINIMAL.background, imageUrl: "https://img.example.com/bg.png" } }, "image"],
    ["a non-zero overlay", { ...LEGACY_MINIMAL, background: { ...LEGACY_MINIMAL.background, overlayOpacity: 0.3 } }, "fields"],
    ["a social style the preset wouldn't stamp", { ...LEGACY_MINIMAL, social: { style: "pill" } }, "fields"],
    ["a missing social section", omit(LEGACY_MINIMAL, "social"), "invalid"],
  ])("%s", (_label, raw, expected) => {
    const r = status(raw);
    if (expected === "invalid") {
      expect(r.status).toBe("invalid");
    } else {
      expect(r.status).toBe("locked");
      expect(r.reasons).toContain(expected);
      // Locked themes are still rendered from their parsed values.
      expect(r.theme.accent).toBe(LEGACY_MINIMAL.accent);
    }
  });

  it.each([
    ["a newer version", { ...presetTheme("neon"), version: 2 }],
    ["an invalid color", { ...LEGACY_MINIMAL, accent: "red" }],
    ["an image background without a usable URL", { ...LEGACY_MINIMAL, background: { ...LEGACY_MINIMAL.background, type: "image", imageUrl: "javascript:alert(1)" } }],
    ["null", null],
    ["missing", undefined],
    ["an array", []],
    ["a string", "minimal"],
  ])("invalid: %s, read as the default theme", (_label, raw) => {
    expect(status(raw)).toEqual({ status: "invalid", reasons: [], theme: DEFAULT_THEME });
  });
});

describe("themeToStyle", () => {
  const style = (patch: (t: ThemeInput) => void) => {
    const t = input();
    patch(t);
    return themeToStyle(canonicalTheme(t)) as Record<string, string>;
  };
  // Hex colors, numbers with units, the fixed rgb()/linear-gradient()/blur() forms and quoted family names; no `;`, `{`, `<`, `\` or `:`.
  const SAFE = /^[#0-9a-zA-Z.,%()' /-]*$/;

  it("maps every option of every control to a distinct, safe custom property value", () => {
    const cases: [string, readonly (string | number | boolean)[], (t: ThemeInput, v: never) => void][] = [
      ["--pp-btn-radius", RADII, (t, v) => (t.button.radius = v)],
      ["--pp-btn-shadow", SHADOWS, (t, v) => (t.button.shadow = v)],
      ["--pp-btn-border-width", [0, 1, 2, 3], (t, v) => ((t.button.variant = "fill"), (t.button.borderWidth = v))],
      ["--pp-font-body", FONT_IDS, (t, v) => (t.font.body = v)],
      ["--pp-font-heading", FONT_IDS, (t, v) => (t.font.heading = v)],
      ["--pp-font-size", SCALES, (t, v) => (t.font.scale = v)],
      ["--pp-width", WIDTHS, (t, v) => (t.layout.width = v)],
      ["--pp-gap", SPACINGS, (t, v) => (t.layout.spacing = v)],
      ["--pp-align", ALIGNS, (t, v) => (t.layout.align = v)],
      ["--pp-avatar-radius", AVATAR_SHAPES, (t, v) => (t.avatar.shape = v)],
      ["--pp-avatar-size", AVATAR_SIZES, (t, v) => (t.avatar.size = v)],
      ["--pp-avatar-ring", [true, false], (t, v) => (t.avatar.ring = v)],
      // fill and soft share the surface and differ by border, so compare both.
      ["--pp-btn-bg|--pp-btn-border", BUTTON_VARIANTS, (t, v) => (t.button.variant = v)],
    ];
    for (const [prop, values, apply] of cases) {
      const seen = values.map((v) => {
        const s = style((t) => apply(t, v as never));
        return prop.split("|").map((p) => s[p]).join(" ");
      });
      expect(new Set(seen).size, prop).toBe(values.length);
      for (const s of seen) expect(s, `${prop}: ${s}`).toMatch(SAFE);
    }
  });

  it("renders solid and gradient backgrounds, and never an image URL", () => {
    expect(style((t) => ((t.background.type = "solid"), (t.background.color = "#123456")))["--pp-bg"]).toBe("#123456");
    expect(
      style((t) => {
        t.background = { type: "gradient", color: "#111111", gradientTo: "#222222", gradientAngle: 45 };
      })["--pp-bg"],
    ).toBe("linear-gradient(45deg, #111111, #222222)");
    const image: ThemeConfig = { ...LEGACY_MINIMAL, background: { ...LEGACY_MINIMAL.background, type: "image", imageUrl: "https://img.example.com/bg.png" } } as ThemeConfig;
    const css = themeToStyle(storedThemeSchema.parse(image)) as Record<string, string>;
    expect(css["--pp-bg"]).toBe("#fafafa");
    expect(JSON.stringify(css)).not.toMatch(/url\(|img\.example/);
  });

  it("button variants: fill and soft are opaque, outline transparent, glass translucent", () => {
    const v = (variant: ThemeInput["button"]["variant"]) => style((t) => ((t.button.variant = variant), (t.button.color = "#336699")));
    expect(v("fill")["--pp-btn-bg"]).toBe("#336699");
    expect(v("soft")["--pp-btn-border"]).toBe("transparent");
    expect(v("outline")["--pp-btn-bg"]).toBe("transparent");
    expect(v("outline")["--pp-btn-border-width"]).toBe("2px"); // creator's 2px border kept
    expect(v("glass")["--pp-btn-bg"]).toBe("#33669929"); // 16% alpha, the contrast blending model
    expect(v("glass")["--pp-btn-blur"]).toBe("blur(12px)");
  });

  it("emits only validated values for every preset", () => {
    for (const id of PRESET_IDS) {
      for (const [k, val] of Object.entries(themeToStyle(presetTheme(id)) as Record<string, string>)) {
        expect(`${val}`, `${id} ${k}`).toMatch(/^[#0-9a-zA-Z.,%()' /-]*$/);
      }
    }
  });
});

describe("contrast (WCAG 2.x)", () => {
  it("matches reference values", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 6);
    expect(relativeLuminance("#000000")).toBe(0);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 6);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 6);
    expect(contrastRatio("#123456", "#123456")).toBe(1);
    // The commonly cited AA boundary greys on white.
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
    expect(contrastRatio("#949494", "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio("#959595", "#ffffff")).toBeLessThan(3);
  });

  it("blends a translucent color over an opaque one", () => {
    expect(blend("#ffffff", "#000000", 0.5)).toBe("#808080");
    expect(blend("#336699", "#ffffff", 0)).toBe("#ffffff");
    expect(blend("#336699", "#ffffff", 1)).toBe("#336699");
  });

  const theme = (over: Partial<Record<"type" | "bg" | "to" | "text" | "muted" | "accent" | "variant" | "btn" | "btnText", string>>) => ({
    background: { type: over.type ?? "solid", color: over.bg ?? "#ffffff", gradientTo: over.to ?? "#ffffff" },
    text: { color: over.text ?? "#000000", muted: over.muted ?? "#555555" },
    accent: over.accent ?? "#0000ff",
    button: { variant: over.variant ?? "fill", color: over.btn ?? "#000000", textColor: over.btnText ?? "#ffffff" },
  });

  it("passes a high-contrast theme", () => {
    expect(themeContrastIssues(theme({}))).toEqual([]);
  });

  it("checks every gradient stop and reports the worst", () => {
    expect(backgroundStops(theme({ type: "gradient", bg: "#ffffff", to: "#000000" }))).toEqual(["#ffffff", "#000000"]);
    expect(backgroundStops(theme({ type: "solid", to: "#000000" }))).toEqual(["#ffffff"]);
    const issues = themeContrastIssues(theme({ type: "gradient", to: "#000000" }));
    expect(issues.map((i) => i.field)).toEqual(expect.arrayContaining(["text.color", "text.muted"]));
    expect(issues.find((i) => i.field === "text.color")?.ratio).toBeCloseTo(1, 6);
  });

  it("uses each variant's effective button surface", () => {
    expect(buttonSurface(theme({ variant: "fill", btn: "#123456" }), "#ffffff")).toBe("#123456");
    expect(buttonSurface(theme({ variant: "outline", btn: "#123456" }), "#abcdef")).toBe("#abcdef");
    expect(buttonSurface(theme({ variant: "glass", btn: "#ffffff" }), "#000000")).toBe(blend("#ffffff", "#000000", 0.16));
    // Outline: the label sits on the page, so white text on a white page fails…
    expect(themeContrastIssues(theme({ variant: "outline", btnText: "#ffffff" })).map((i) => i.field)).toContain("button.textColor");
    // …and the border is its only boundary (3:1); a filled button has no border check.
    expect(themeContrastIssues(theme({ variant: "outline", btn: "#eeeeee", btnText: "#000000" })).map((i) => i.field)).toContain("button.color");
    expect(themeContrastIssues(theme({ variant: "fill", btn: "#eeeeee", btnText: "#000000" })).map((i) => i.field)).not.toContain("button.color");
  });

  it("holds the accent to 3:1 and text to 4.5:1", () => {
    expect(themeContrastIssues(theme({ accent: "#949494" }))).toEqual([]);
    expect(themeContrastIssues(theme({ accent: "#959595" })).map((i) => i.field)).toEqual(["accent"]);
    expect(themeContrastIssues(theme({ muted: "#767676" }))).toEqual([]);
    const [muted] = themeContrastIssues(theme({ muted: "#777777" }));
    expect(muted).toMatchObject({ field: "text.muted", required: 4.5 });
    expect(muted.message).toMatch(/^Muted text contrast is 4\.4\d:1 against the background; it needs at least 4\.5:1\.$/);
  });

  it("keys issues as theme.<field> field errors", () => {
    const errors = contrastFieldErrors(themeContrastIssues(theme({ text: "#ffffff", accent: "#ffffff" })));
    expect(Object.keys(errors).sort()).toEqual(["theme.accent", "theme.text.color"]);
  });

  it("all ten presets pass, including the corrected Creator and Glass", () => {
    expect(THEME_PRESETS.map((p) => p.id)).toEqual([...PRESET_IDS]);
    for (const id of PRESET_IDS) expect(themeContrastIssues(presetTheme(id)), id).toEqual([]);
    expect(getPreset("creator").theme.button.color).toBe("#c2410c");
    expect(getPreset("glass").theme.background.color).toBe("#115e59");
  });
});

describe("link button titles and descriptions", () => {
  const css = readFileSync(path.join(SRC, "app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  /** Declarations of every rule whose selector mentions `.pp-btn` (title, description, states). */
  const buttonRules = [...css.matchAll(/([^{}]*\.pp-btn[^{}]*)\{([^}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));

  it("never fades or recolors button text: both use the validated button text color at full opacity", () => {
    expect(buttonRules.map((r) => r.selector)).toEqual(expect.arrayContaining([".pp-btn", ".pp-btn-label", ".pp-btn-desc"]));
    for (const { selector, body: decls } of buttonRules) {
      expect(decls, selector).not.toMatch(/(^|[;\s])opacity\s*:/);
      expect(decls, selector).not.toMatch(/(^|[;\s])filter\s*:/);
      expect(decls, selector).not.toMatch(/mix-blend-mode|color-mix/);
      const color = /(^|[;\s])color\s*:\s*([^;]+)/.exec(decls)?.[2]?.trim();
      if (color) expect(color, selector).toMatch(/^var\(--pp-btn-text(, *#[0-9a-f]{6})?\)$/);
    }
    expect(buttonRules.find((r) => r.selector === ".pp-btn")?.body).toMatch(/(^|[;\s])color:\s*var\(--pp-btn-text/);
  });

  it("renders a link description inside the button with no style of its own (Creator and Glass)", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { ProfileView } = await import("@/components/profile/profile-view");
    const { createDefaultDocument } = await import("@/features/profiles/document");
    for (const id of ["creator", "glass"] as const) {
      const doc = {
        ...createDefaultDocument("Alex"),
        theme: presetTheme(id),
        blocks: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            type: "link" as const,
            version: 2,
            visible: true,
            config: { title: "Shop", url: "https://shop.example.com/", description: "New arrivals every week" },
          },
        ],
      };
      const html = renderToStaticMarkup(createElement(ProfileView, { document: doc, verified: false, mode: "public" }));
      expect(html, id).toMatch(
        /<a class="pp-btn" href="https:\/\/shop\.example\.com\/"[^>]*><span class="pp-btn-label"><span class="pp-btn-title">Shop<\/span><span class="pp-btn-desc">New arrivals every week<\/span><\/span><\/a>/,
      );
      expect(html, id).toContain(`--pp-btn-text:${presetTheme(id).button.textColor}`);
    }
  });

  it("every preset's button text, title and description alike, is at least 4.5:1 on every button surface and stop", () => {
    for (const id of PRESET_IDS) {
      const t = presetTheme(id);
      for (const stop of backgroundStops(t)) {
        const ratio = contrastRatio(t.button.textColor, buttonSurface(t, stop));
        expect(ratio, `${id} on ${stop}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // The two presets the review measured below 4.5:1 with the old 0.8 opacity.
    const creator = presetTheme("creator");
    expect(contrastRatio(creator.button.textColor, buttonSurface(creator, creator.background.color))).toBeCloseTo(5.18, 2);
    const glass = presetTheme("glass");
    expect(contrastRatio(glass.button.textColor, buttonSurface(glass, glass.background.color))).toBeCloseTo(4.91, 2);
  });
});

describe("theme fonts (self-hosted)", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|css)$/.test(f) ? [p] : [];
    });

  it("no source file imports next/font/google", () => {
    const offenders = files(SRC).filter((f) => /next\/font\/google|fonts\.googleapis|fonts\.gstatic/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("every recognized font maps to a family the imported Fontsource CSS declares", () => {
    const fontsModule = readFileSync(path.join(SRC, "components/profile/theme-fonts.ts"), "utf8");
    const imports = [...fontsModule.matchAll(/^import "([^"]+\.css)";$/gm)].map((m) => m[1]);
    expect(imports).toHaveLength(6);
    const declared = new Set(
      imports.flatMap((spec) => [...readFileSync(path.resolve("node_modules", spec), "utf8").matchAll(/font-family: '([^']+)'/g)].map((m) => m[1])),
    );
    expect(Object.keys(FONT_STACKS).sort()).toEqual([...FONT_IDS].sort());
    for (const id of FONT_IDS) {
      const family = /^'([^']+)'/.exec(FONT_STACKS[id])?.[1];
      expect(declared.has(family ?? ""), `${id} → ${family}`).toBe(true);
    }
  });
});
