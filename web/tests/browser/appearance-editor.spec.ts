import type { Browser, Locator, Page } from "@playwright/test";
import { config } from "dotenv";
import postgres from "postgres";
import { assertTestDatabaseMarker, assertTestDatabaseUrl } from "../../scripts/test-db-guard.mjs";
import { blend, contrastRatio } from "../../src/features/themes/contrast";
import { expect, test } from "./fixtures";

/**
 * Browser workflows for the appearance editor: presets and every control,
 * persistence, preview/public agreement on computed styles, keyboard and
 * focus, contrast warnings and server-side publish rejection, the confirmed
 * replacement of stored themes the editor can't carry, publish/discard/
 * conflict, independence from the dashboard color mode, self-hosted fonts and
 * a phone-size check. Serial: steps build on each other. Lookups filter to
 * visible elements because Next.js keeps the previous route mounted but
 * hidden (React <Activity>).
 */
test.describe.configure({ mode: "serial" });

const EDITOR = { name: "Theo Theme", email: "theme-editor@example.com", password: "theme-password-123" };
const HANDLE = "themepage";
let signInCount = 0;
let editorUrl = "";

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/setup");
  if (await page.locator("#token").count()) {
    await page.locator("#token").fill(process.env.E2E_SETUP_TOKEN!);
    await page.locator("#name").fill("Setup Owner");
    await page.locator("#email").fill("appearance-owner@example.com");
    await page.locator("#password").fill("correct-horse-battery");
    await page.locator("#confirm").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Create administrator" }).click();
    await expect(page.getByRole("status")).toContainText("ready");
  }
  await page.goto("/register");
  await page.locator("#name").fill(EDITOR.name);
  await page.locator("#email").fill(EDITOR.email);
  await page.locator("#password").fill(EDITOR.password);
  await page.locator("#confirm").fill(EDITOR.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await context.close();
});

test.beforeEach(async ({ page, baseURL }) => {
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: EDITOR.email, password: EDITOR.password },
    headers: { origin: baseURL!, "x-forwarded-for": `198.51.102.${++signInCount}` },
  });
  expect(res.status()).toBe(200);
});

async function openEditor(page: Page, url = editorUrl) {
  await page.goto(url);
  await page.locator("[data-hydrated]").waitFor();
}

const status = (page: Page) => page.getByTestId("editor-status").filter({ visible: true });
const previewRoot = (page: Page) => page.getByTestId("profile-preview").filter({ visible: true }).locator(".pp-root");
const presetLabel = (page: Page, id: string) => page.locator("label").filter({ has: page.getByTestId(`preset-${id}`) });
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true }).filter({ visible: true });

async function appearanceTab(page: Page) {
  await page.getByRole("tab", { name: /Appearance/ }).click();
  await expect(page.getByRole("tab", { name: /Appearance/ })).toHaveAttribute("aria-selected", "true");
}

async function saveDraft(page: Page) {
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(status(page)).toContainText("Draft saved");
}

async function setColor(page: Page, label: string, value: string) {
  await field(page, label).fill(value);
}

/**
 * Computed styles of the themed primitives under a `.pp-root`. Waits for running
 * transitions (`.pp-btn` animates box-shadow for 120ms) so a theme change just
 * applied isn't sampled mid-interpolation.
 */
async function themedStyles(root: Locator) {
  await root.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))));
  return root.evaluate((el) => {
    const cs = (e: Element | null) => (e ? getComputedStyle(e) : null);
    const r = cs(el)!;
    const container = cs(el.querySelector(".pp-container"))!;
    const btn = cs(el.querySelector(".pp-btn"));
    const name = cs(el.querySelector(".pp-name"));
    const avatarRing = r.getPropertyValue("--pp-avatar-ring");
    return {
      background: `${r.backgroundColor} ${r.backgroundImage}`,
      color: r.color,
      font: r.fontFamily,
      fontSize: r.fontSize,
      maxWidth: container.maxWidth,
      textAlign: container.textAlign,
      gap: container.rowGap,
      nameFont: name?.fontFamily,
      btn: btn && {
        bg: btn.backgroundColor,
        color: btn.color,
        radius: btn.borderTopLeftRadius,
        border: `${btn.borderTopWidth} ${btn.borderTopStyle} ${btn.borderTopColor}`,
        shadow: btn.boxShadow,
      },
      accent: r.getPropertyValue("--pp-accent").trim(),
      avatarRing: avatarRing.trim(),
    };
  });
}

/**
 * Writes a profile's stored draft theme directly (standing in for data from
 * an older or newer version), through the same guards as global-setup.ts.
 */
async function seedDraftTheme(handle: string, theme: unknown) {
  const fileEnv: Record<string, string> = {};
  config({ path: ".env", quiet: true, processEnv: fileEnv });
  const { url } = assertTestDatabaseUrl(process.env.E2E_DATABASE_URL ?? fileEnv.E2E_DATABASE_URL, {
    devDatabaseUrl: fileEnv.DATABASE_URL ?? process.env.DATABASE_URL,
  });
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await assertTestDatabaseMarker(sql, new URL(url).pathname.slice(1));
    await sql`update profiles set draft = jsonb_set(draft, '{theme}', ${sql.json(theme as never)}) where handle = ${handle}`;
  } finally {
    await sql.end();
  }
}

test("chooses a preset and sets every supported control; the preview follows and the choices persist", async ({ page }) => {
  await page.goto("/dashboard/profiles");
  await page.locator("#handle").fill(HANDLE);
  await page.locator("#label").fill("Themes");
  await page.locator("#displayName").fill("Theo");
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page).toHaveURL(/\/dashboard\/profiles\/[0-9a-f-]{36}$/);
  editorUrl = page.url();
  await page.locator("[data-hydrated]").waitFor();

  // Content to style: a link button and a text block with a Markdown link.
  await page.getByRole("group", { name: "Add block" }).getByRole("button", { name: "Link", exact: true }).click();
  await page.locator('[id^="blk-"][id$="-title"]').fill("Shop");
  await page.locator('[id^="blk-"][id$="-url"]').fill("shop.example.com");
  await page.getByRole("group", { name: "Add block" }).getByRole("button", { name: "Text", exact: true }).click();
  await page.locator('[id^="blk-"][id$="-markdown"]').fill("Read [the blog](https://blog.example.com) today.");

  await appearanceTab(page);
  await expect(page.getByTestId(/^preset-/)).toHaveCount(10);
  await expect(page.getByTestId("preset-minimal")).toBeChecked();
  await presetLabel(page, "neon").click();
  await expect(page.getByTestId("preset-neon")).toBeChecked();
  await expect.poll(async () => (await themedStyles(previewRoot(page))).accent).toBe("#a3e635");

  // Every control.
  await field(page, "Gradient").check();
  await setColor(page, "Start color", "#101010");
  await setColor(page, "End color", "#202040");
  await field(page, "Angle (degrees)").fill("45");
  await setColor(page, "Text", "#f5f5f5");
  await setColor(page, "Muted text", "#c0c0c0");
  await setColor(page, "Accent", "#22d3ee");
  await field(page, "Style").selectOption("fill");
  await setColor(page, "Button color", "#22d3ee");
  await setColor(page, "Button text", "#050505");
  await field(page, "Corners").selectOption("full");
  await field(page, "Shadow").selectOption("soft");
  await field(page, "Border width").selectOption("2");
  await field(page, "Body font").selectOption("inter");
  await field(page, "Heading font").selectOption("fraunces");
  await field(page, "Text size").selectOption("lg");
  await field(page, "Width").selectOption("wide");
  await field(page, "Spacing").selectOption("relaxed");
  await field(page, "Alignment").selectOption("left");
  await field(page, "Shape").selectOption("square");
  await field(page, "Size").selectOption("lg");
  await expect(field(page, "Accent ring around the avatar")).toHaveAttribute("aria-checked", "true"); // Neon's default
  await field(page, "Accent ring around the avatar").click();
  // Image backgrounds (uploads) are exercised in media-uploads.spec.ts.
  await expect(field(page, "Image")).toBeEnabled();

  const preview = await themedStyles(previewRoot(page));
  expect(preview.background).toContain("linear-gradient(45deg, rgb(16, 16, 16), rgb(32, 32, 64))");
  expect(preview.color).toBe("rgb(245, 245, 245)");
  expect(preview.font).toContain("Inter Variable");
  expect(preview.nameFont).toContain("Fraunces Variable");
  expect(preview.fontSize).toBe("17.5px");
  expect(preview.textAlign).toBe("left");
  expect(preview.btn).toMatchObject({ bg: "rgb(34, 211, 238)", color: "rgb(5, 5, 5)", radius: "999px" });
  expect(preview.btn?.border).toContain("2px solid");
  expect(preview.avatarRing).toBe("none");
  await expect(page.getByTestId("contrast-summary")).toHaveCount(0);

  await saveDraft(page);
  await page.reload();
  await page.locator("[data-hydrated]").waitFor();
  await appearanceTab(page);
  await expect(page.getByTestId("preset-neon")).toBeChecked();
  await expect(field(page, "Gradient")).toBeChecked();
  await expect(field(page, "Start color")).toHaveValue("#101010");
  await expect(field(page, "End color")).toHaveValue("#202040");
  await expect(field(page, "Angle (degrees)")).toHaveValue("45");
  await expect(field(page, "Accent")).toHaveValue("#22d3ee");
  await expect(field(page, "Style")).toHaveValue("fill");
  await expect(field(page, "Corners")).toHaveValue("full");
  await expect(field(page, "Border width")).toHaveValue("2");
  await expect(field(page, "Heading font")).toHaveValue("fraunces");
  await expect(field(page, "Width")).toHaveValue("wide");
  await expect(field(page, "Shape")).toHaveValue("square");
  await expect(field(page, "Accent ring around the avatar")).toHaveAttribute("aria-checked", "false");
  expect(await themedStyles(previewRoot(page))).toEqual(preview);
});

test("keyboard: the tabs, preset radios and reset work from the keyboard with visible focus", async ({ page }) => {
  await openEditor(page);
  await page.getByRole("tab", { name: "Content" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /Appearance/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: /Appearance/ })).toBeFocused();

  const neon = page.getByTestId("preset-neon");
  await neon.focus();
  await page.keyboard.press("ArrowRight"); // native radio group: moves and selects
  const softGradient = page.getByTestId("preset-soft-gradient");
  await expect(softGradient).toBeChecked();
  await expect(softGradient).toBeFocused();
  const ring = await presetLabel(page, "soft-gradient").evaluate((el) => getComputedStyle(el).boxShadow);
  expect(ring).not.toBe("none");
  await expect.poll(async () => (await themedStyles(previewRoot(page))).accent).toBe("#7c3aed");

  // Customize, then reset to the selected preset.
  const reset = page.getByRole("button", { name: "Reset to Soft Gradient" });
  await expect(reset).toBeDisabled();
  await setColor(page, "Accent", "#5b21b6");
  await expect(reset).toBeEnabled();
  await reset.focus();
  await page.keyboard.press("Enter");
  await expect(field(page, "Accent")).toHaveValue("#7c3aed");
  await expect(reset).toBeDisabled();
  // An unfinished color blocks saving and is reported on the field.
  await field(page, "Text").fill("#12");
  await expect(page.locator("#theme-text-color-error")).toHaveText("Use a 6-digit hex color like #1a2b3c");
  await expect(field(page, "Text")).toHaveAttribute("aria-describedby", /theme-text-color-error/);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Some appearance settings need attention" })).toBeVisible();
  await expect(field(page, "Text")).toBeFocused();
});

test("warns about low contrast, saves the draft, but the server refuses to publish it", async ({ page }) => {
  await openEditor(page);
  await appearanceTab(page);
  await presetLabel(page, "minimal").click();
  await setColor(page, "Text", "#fafafa"); // same as the background
  const warning = page.locator("#theme-text-color-contrast");
  await expect(warning).toContainText("Text contrast is 1.00:1 against the background; it needs at least 4.5:1.");
  await expect(field(page, "Text")).toHaveAttribute("aria-describedby", /theme-text-color-contrast/);
  await expect(page.getByTestId("contrast-summary")).toContainText("can't be published");
  await expect(page.getByRole("tab", { name: /Appearance/ }).getByRole("img", { name: "needs attention" })).toBeVisible();

  await saveDraft(page);
  await page.getByRole("tab", { name: "Content" }).click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "doesn't have enough contrast to publish" })).toBeVisible();
  // The editor switches to the problem and focuses it; the server's message is on the field.
  await expect(page.getByRole("tab", { name: /Appearance/ })).toHaveAttribute("aria-selected", "true");
  await expect(field(page, "Text")).toBeFocused();
  await expect(page.locator("#theme-text-color-error")).toContainText("needs at least 4.5:1");
  // The same problem is shown once: the server's error replaces the identical live warning.
  await expect(page.getByText("Text contrast is 1.00:1 against the background; it needs at least 4.5:1.")).toHaveCount(1);
  await expect(field(page, "Text")).toHaveAttribute("aria-describedby", "theme-text-color-error");

  await setColor(page, "Text", "#18181b");
  await expect(warning).toHaveCount(0);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(status(page)).toContainText("Published");
});

test("preview and public page agree on computed styles for three different presets; fonts are self-hosted", async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const FONT_FILES: Record<string, RegExp> = {
    inter: /\/inter-/,
    manrope: /\/manrope-/,
    "space-grotesk": /\/space-grotesk-/,
    "dm-serif": /\/dm-serif-display-/,
    fraunces: /\/fraunces-/,
    "jetbrains-mono": /\/jetbrains-mono-/,
  };
  const cases = [
    { id: "neon", fonts: ["jetbrains-mono", "space-grotesk"], family: "JetBrains Mono Variable" },
    { id: "music", fonts: ["space-grotesk", "fraunces"], family: "Fraunces Variable" },
    { id: "editorial", fonts: ["inter", "dm-serif"], family: "DM Serif Display" },
  ];
  for (const c of cases) {
    await openEditor(page);
    await appearanceTab(page);
    await presetLabel(page, c.id).click();
    await page.getByRole("button", { name: /^Publish/ }).click();
    await expect(status(page)).toContainText("Published");
    const preview = await themedStyles(previewRoot(page));

    const visitor = await context.newPage();
    const fontRequests: string[] = [];
    visitor.on("request", (r) => {
      if (r.resourceType() === "font") fontRequests.push(r.url());
    });
    expect((await visitor.goto(`/${HANDLE}`))?.status()).toBe(200);
    await visitor.evaluate(() => document.fonts.ready);
    const pub = await themedStyles(visitor.locator(".pp-root"));
    expect(pub, c.id).toEqual(preview);

    // Markdown links: text color, persistent accent underline, also on hover.
    const link = visitor.getByRole("link", { name: "the blog" });
    const linkStyle = () =>
      link.evaluate((a) => {
        const s = getComputedStyle(a);
        return { color: s.color, line: s.textDecorationLine, decoration: s.textDecorationColor };
      });
    const rootColors = await visitor.locator(".pp-root").evaluate((el) => {
      const probe = document.createElement("span");
      probe.style.color = getComputedStyle(el).getPropertyValue("--pp-accent");
      el.appendChild(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return { text: getComputedStyle(el.querySelector(".pp-text")!).color, accent };
    });
    expect(await linkStyle()).toEqual({ color: rootColors.text, line: "underline", decoration: rootColors.accent });
    await link.hover();
    expect(await linkStyle()).toEqual({ color: rootColors.text, line: "underline", decoration: rootColors.accent });

    // Fonts: the theme's families load, every font comes from this origin, and unused theme families aren't fetched.
    expect(await visitor.evaluate((family) => document.fonts.check(`16px '${family}'`), c.family)).toBe(true);
    expect(fontRequests.length).toBeGreaterThan(0);
    for (const u of fontRequests) expect(new URL(u).origin, u).toBe(origin);
    for (const [font, pattern] of Object.entries(FONT_FILES)) {
      const fetched = fontRequests.some((u) => pattern.test(u));
      expect(fetched, `${c.id}: ${font}`).toBe(c.fonts.includes(font));
    }
    for (const u of fontRequests.filter((x) => Object.values(FONT_FILES).some((p) => p.test(x)))) expect(u, "Latin face only").toMatch(/-latin-/);
    await visitor.close();
  }
});

test("draft appearance stays private, discard restores the published one, and a stale tab gets a conflict", async ({ page, context }) => {
  await openEditor(page);
  await appearanceTab(page);
  await setColor(page, "Accent", "#7f1d1d");
  await saveDraft(page);

  const visitor = await context.newPage();
  await visitor.goto(`/${HANDLE}`);
  expect((await themedStyles(visitor.locator(".pp-root"))).accent).toBe("#9a3412"); // editorial, as published
  await visitor.close();

  await page.getByRole("button", { name: "Discard draft changes" }).click();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(status(page)).toContainText("Draft changes discarded");
  await expect(field(page, "Accent")).toHaveValue("#9a3412");

  const other = await context.newPage();
  await openEditor(other);
  await appearanceTab(other);
  await setColor(other, "Accent", "#7c2d12");
  await saveDraft(other);

  await setColor(page, "Accent", "#78350f");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "changed somewhere else" })).toBeVisible();
  await page.getByRole("button", { name: "Reload latest version" }).click();
  await page.getByRole("button", { name: "Leave without saving" }).click();
  await page.locator("[data-hydrated]").waitFor();
  await appearanceTab(page);
  await expect(field(page, "Accent")).toHaveValue("#7c2d12");
  await other.close();
});

test("the dashboard's color mode doesn't change the profile preview", async ({ page }) => {
  await openEditor(page);
  const light = await themedStyles(previewRoot(page));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  expect(await themedStyles(previewRoot(page))).toEqual(light);
});

test("stored themes the editor can't carry are read-only until replaced after confirmation", async ({ page }) => {
  const handle = "themelegacy";
  await page.goto("/dashboard/profiles");
  await page.locator("#handle").fill(handle);
  await page.locator("#label").fill("Legacy theme");
  await page.locator("#displayName").fill("Legacy Theo");
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page).toHaveURL(/\/dashboard\/profiles\/[0-9a-f-]{36}$/);
  const url = page.url();

  const legacy = {
    preset: "custom-x",
    background: { type: "solid", color: "#fef3c7", gradientTo: "#fde68a", gradientAngle: 180, overlayOpacity: 0 },
    text: { color: "#1c1917", muted: "#57534e" },
    accent: "#b45309",
    button: { variant: "fill", color: "#92400e", textColor: "#ffffff", radius: "md", shadow: "none", borderWidth: 0 },
    font: { body: "manrope", heading: "manrope", scale: "md" },
    layout: { width: "normal", spacing: "normal", align: "center" },
    avatar: { shape: "circle", size: "md", ring: false },
    social: { style: "icon" },
  };
  await seedDraftTheme(handle, legacy);
  await openEditor(page, url);
  await appearanceTab(page);
  const locked = page.getByTestId("appearance-locked").filter({ visible: true });
  await expect(locked).toContainText("uses a preset this version of COVALink doesn't offer");
  await expect(page.getByTestId(/^preset-/)).toHaveCount(0);
  expect((await themedStyles(previewRoot(page))).background).toContain("rgb(254, 243, 199)"); // still rendered

  // Replacement waits for other changes, then asks for confirmation.
  const replace = page.getByRole("button", { name: "Replace saved appearance" });
  await page.getByRole("tab", { name: "Content" }).click();
  await page.locator("#bio").fill("Unsaved bio");
  await appearanceTab(page);
  await expect(replace).toBeDisabled();
  await page.getByRole("tab", { name: "Content" }).click();
  await saveDraft(page);
  await appearanceTab(page);
  await replace.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("replaced completely");
  await dialog.getByLabel("Start from").selectOption("glass");
  await dialog.getByRole("button", { name: "Keep it" }).click();
  await expect(locked).toBeVisible();
  await replace.click();
  await page.getByRole("alertdialog").getByLabel("Start from").selectOption("glass");
  await page.getByRole("button", { name: "Replace appearance" }).click();
  await expect(status(page)).toContainText("Appearance replaced");
  await expect(page.getByTestId("preset-glass")).toBeChecked();
  await page.reload();
  await page.locator("[data-hydrated]").waitFor();
  await appearanceTab(page);
  await expect(page.getByTestId("preset-glass")).toBeChecked();

  // An unreadable (newer) theme: the draft can be saved, publishing is blocked until replaced.
  await seedDraftTheme(handle, { ...legacy, preset: "glass", version: 2 });
  await openEditor(page, url);
  await expect(page.getByTestId("publish-blocked").filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  await page.locator("#bio").fill("Still editable");
  await saveDraft(page);
  await appearanceTab(page);
  await expect(page.getByTestId("appearance-locked").filter({ visible: true })).toContainText("can't be read");
});

/** `rgb(r, g, b)` / `rgba(r, g, b, a)` → `#rrggbb` plus alpha. */
function parseRgb(css: string): { hex: string; alpha: number } {
  const m = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(css);
  if (!m) throw new Error(`not an rgb color: ${css}`);
  const hex = `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
  return { hex, alpha: m[4] === undefined ? 1 : Number(m[4]) };
}

test("link descriptions render at the validated button text color, at least 4.5:1 on every surface", async ({ page, context }) => {
  await openEditor(page);
  const shop = page
    .getByTestId("block-card")
    .filter({ visible: true })
    .filter({ has: page.getByTestId("block-label").getByText("Shop", { exact: true }) });
  await shop.getByRole("button", { name: /^Edit / }).click();
  await shop.locator('[id$="-description"]').fill("New arrivals every week");

  for (const preset of ["creator", "glass"]) {
    await appearanceTab(page);
    await presetLabel(page, preset).click();
    await page.getByRole("button", { name: /^Publish/ }).click();
    await expect(status(page)).toContainText("Published");

    const visitor = await context.newPage();
    await visitor.goto(`/${HANDLE}`);
    const desc = visitor.locator(".pp-btn-desc");
    await expect(desc).toHaveText("New arrivals every week");
    const measured = await desc.evaluate((el) => {
      const root = el.closest(".pp-root")!;
      const btn = el.closest(".pp-btn")!;
      // Opacity of the description and every ancestor up to the themed root.
      const opacities: string[] = [];
      for (let e: Element | null = el; e && e !== root.parentElement; e = e.parentElement) opacities.push(getComputedStyle(e).opacity);
      const r = getComputedStyle(root);
      const stops = r.backgroundImage === "none" ? [r.backgroundColor] : (r.backgroundImage.match(/rgba?\([^)]+\)/g) ?? []);
      return {
        opacities,
        desc: getComputedStyle(el).color,
        title: getComputedStyle(btn.querySelector(".pp-btn-title")!).color,
        token: r.getPropertyValue("--pp-btn-text").trim(),
        surface: getComputedStyle(btn).backgroundColor,
        stops,
      };
    });
    expect(measured.opacities.every((o) => o === "1"), `${preset}: ${measured.opacities}`).toBe(true);
    expect(measured.desc, preset).toBe(measured.title);
    expect(parseRgb(measured.desc).hex, preset).toBe(measured.token);

    // Effective contrast against the rendered button surface, composited over each page stop.
    const surface = parseRgb(measured.surface);
    expect(measured.stops.length, preset).toBeGreaterThan(0);
    for (const stop of measured.stops.map((s) => parseRgb(s).hex)) {
      const effective = surface.alpha < 1 ? blend(surface.hex, stop, surface.alpha) : surface.hex;
      const ratio = contrastRatio(parseRgb(measured.desc).hex, effective);
      expect(ratio, `${preset} description on ${effective} (page ${stop})`).toBeGreaterThanOrEqual(4.5);
    }
    await visitor.close();
  }
});

test.describe("phone viewport", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the appearance editor and public page fit without horizontal scrolling", async ({ page }) => {
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    await openEditor(page);
    await appearanceTab(page);
    await field(page, "Gradient").check();
    expect(await noOverflow()).toBe(true);
    const preset = presetLabel(page, "music");
    await preset.scrollIntoViewIfNeeded();
    await expect(preset).toBeInViewport({ ratio: 1 });
    await preset.tap();
    await expect(page.getByTestId("preset-music")).toBeChecked();
    const angle = field(page, "Angle (degrees)");
    await angle.scrollIntoViewIfNeeded();
    await expect(angle).toBeInViewport({ ratio: 1 });
    expect(await noOverflow()).toBe(true);
    await page.goto(`/${HANDLE}`);
    await expect(page.getByRole("link", { name: "Shop" })).toBeVisible();
    expect(await noOverflow()).toBe(true);
  });
});
