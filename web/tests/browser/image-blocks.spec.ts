import type { Browser, Locator, Page } from "@playwright/test";
import * as img from "../support/images";
import { expect, test } from "./fixtures";

/**
 * Browser workflows for uploaded image blocks: upload and selection
 * through the picker, inline validation of the alt/decorative/link rules with
 * focus, persistence across reloads, the direct preview link, the published
 * figure, reserved image space while the file is delayed (no layout shift),
 * the in-use deletion refusal for block images, no visitor cookies, and the
 * phone layout. Serial: steps build on each other. Lookups filter to visible
 * elements because Next.js keeps the previous route mounted but hidden.
 */
test.describe.configure({ mode: "serial" });

const EDITOR = { name: "Iris Image", email: "image-editor@example.com", password: "image-password-123" };
const HANDLE = "imagepage";
const DESTINATION = "https://lighthouse.example.com/tour";
let signInCount = 0;
let editorUrl = "";

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  // Its own client address (TRUST_PROXY is on in the E2E servers), so this sign-up doesn't use
  // up the per-IP sign-up limit the other specs' registrations share.
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.113.1" } });
  const page = await context.newPage();
  await page.goto("/setup");
  if (await page.locator("#token").count()) {
    await page.locator("#token").fill(process.env.E2E_SETUP_TOKEN!);
    await page.locator("#name").fill("Setup Owner");
    await page.locator("#email").fill("image-owner@example.com");
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
    headers: { origin: baseURL!, "x-forwarded-for": `198.51.114.${++signInCount}` },
  });
  expect(res.status()).toBe(200);
});

async function openEditor(page: Page) {
  await page.goto(editorUrl);
  await page.locator("[data-hydrated]").waitFor();
}

const list = (page: Page) => page.getByTestId("block-list").filter({ visible: true });
const card = (page: Page) => list(page).getByTestId("block-card").and(page.locator('[data-block-type="image"]'));
const status = (page: Page) => page.getByTestId("editor-status").filter({ visible: true });
const preview = (page: Page) => page.getByTestId("profile-preview").filter({ visible: true });
const picker = (page: Page) => page.getByTestId("media-image").filter({ visible: true });
const pickerItems = (page: Page) => picker(page).getByTestId("media-item");
const addButton = (page: Page, name: string) => page.getByRole("group", { name: "Add block" }).getByRole("button", { name, exact: true });
const byIdSuffix = (scope: Page | Locator, suffix: string) => scope.locator(`[id$="${suffix}"]`).filter({ visible: true });

async function expand(c: Locator) {
  const toggle = c.getByRole("button", { name: /^Edit / });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

async function upload(page: Page, name: string, w: number, h: number, color: string) {
  await card(page).getByTestId("media-file-image").setInputFiles({ name, mimeType: "image/png", buffer: await img.png(w, h, color) });
  await expect(picker(page).getByTestId("media-status")).toHaveText("Uploaded and selected. Save or publish to use it on your page.");
}

test("adds an image block with upload, inline validation and focus; it persists and previews with a direct link", async ({ page }) => {
  await page.goto("/dashboard/profiles");
  await page.locator("#handle").fill(HANDLE);
  await page.locator("#label").fill("Images");
  await page.locator("#displayName").fill("Iris");
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page).toHaveURL(/\/dashboard\/profiles\/[0-9a-f-]{36}$/);
  editorUrl = page.url();
  await page.locator("[data-hydrated]").waitFor();

  // A new image block focuses its upload control; the wording is "image", never "background image".
  await addButton(page, "Image").click();
  const uploadButton = byIdSuffix(page, "-src");
  await expect(uploadButton).toBeFocused();
  await expect(uploadButton).toHaveText("Upload image");
  await expect(picker(page)).not.toContainText(/background/i);
  await expect(picker(page).getByTestId("media-empty")).toHaveText("No images uploaded yet.");
  await expect(preview(page)).toContainText("Incomplete image");

  // Saving with nothing chosen reveals the problem and focuses the upload control.
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Some blocks need attention" })).toBeVisible();
  await expect(picker(page).getByTestId("media-error")).toHaveText("Choose or upload an image");
  await expect(uploadButton).toBeFocused();

  await upload(page, "lighthouse.png", 1600, 900, "#224466");
  await expect(pickerItems(page)).toHaveCount(1);
  await expect(pickerItems(page).first().getByRole("button", { name: /^Use lighthouse\.png, 1600 × 900 px$/ })).toHaveAttribute("aria-pressed", "true");

  // Alt text is required unless the image is decorative.
  const alt = byIdSuffix(card(page), "-alt");
  await expect(alt).toHaveAttribute("aria-invalid", "true");
  await expect(card(page).getByText("Describe the image, or mark it as decorative")).toBeVisible();
  await alt.fill("A lighthouse at dusk");
  await expect(alt).not.toHaveAttribute("aria-invalid", "true");
  const previewImage = preview(page).locator("img.pp-image");
  await expect(previewImage).toHaveAttribute("width", "1600");
  await expect(previewImage).toHaveAttribute("height", "900");
  await expect(previewImage).toHaveAttribute("alt", "A lighthouse at dusk");

  // Decorative: the description must be empty and a link isn't allowed; nothing is cleared silently.
  const decorative = card(page).getByRole("switch", { name: "Decorative image" });
  await decorative.click();
  await expect(decorative).toHaveAttribute("aria-checked", "true");
  await expect(card(page).getByText("Leave the description empty for a decorative image")).toBeVisible();
  await expect(alt).toHaveValue("A lighthouse at dusk");
  await alt.fill("");
  const href = byIdSuffix(card(page), "-href");
  await href.fill("lighthouse.example.com/tour");
  await href.blur();
  await expect(card(page).getByText("A decorative image can't be a link. Add a description instead.")).toBeVisible();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(href).toBeFocused();
  await expect(preview(page)).toContainText("Incomplete image");

  await decorative.press("Space");
  await expect(decorative).toHaveAttribute("aria-checked", "false");
  await alt.fill("A lighthouse at dusk");
  await byIdSuffix(card(page), "-caption").fill("Point Reyes");
  await card(page).getByRole("combobox", { name: "Shape" }).selectOption("wide");
  await expect(page.getByTestId("unsaved-indicator")).toBeVisible();

  // The preview links directly to the destination in a new tab; nothing is counted there.
  const previewLink = preview(page).locator("a.pp-image-link");
  await expect(previewLink).toHaveAttribute("href", DESTINATION);
  await expect(previewLink).toHaveAttribute("target", "_blank");
  await expect(preview(page).locator("figcaption")).toHaveText("Point Reyes");

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(status(page)).toContainText("Draft saved");
  await expect(page.getByTestId("unsaved-indicator")).toHaveCount(0);

  // Everything persists across a reload.
  await openEditor(page);
  await expand(card(page));
  await expect(byIdSuffix(card(page), "-alt")).toHaveValue("A lighthouse at dusk");
  await expect(byIdSuffix(card(page), "-caption")).toHaveValue("Point Reyes");
  await expect(byIdSuffix(card(page), "-href")).toHaveValue(DESTINATION);
  await expect(card(page).getByRole("combobox", { name: "Shape" })).toHaveValue("wide");
  await expect(card(page).getByRole("switch", { name: "Decorative image" })).toHaveAttribute("aria-checked", "false");
  await expect(pickerItems(page).first().getByRole("button", { name: /^Use lighthouse\.png/ })).toHaveAttribute("aria-pressed", "true");
  await expect(card(page).getByTestId("block-label")).toHaveText("A lighthouse at dusk");

  // Draft only: the public page doesn't exist yet. Then publish.
  expect((await page.request.get(`/${HANDLE}`)).status()).toBe(404);
  await page.getByRole("button", { name: /^Publish/ }).click();
  await expect(status(page)).toContainText("Published");
});

test("an image chosen in a block can't be deleted from the library, saved or not", async ({ page }) => {
  await openEditor(page);
  await expand(card(page));
  const dialog = page.getByRole("alertdialog");
  await pickerItems(page).first().getByTestId("media-delete").click();
  await expect(dialog.getByRole("heading")).toHaveText("This image can't be deleted yet");
  await expect(dialog.getByTestId("media-in-use")).toContainText(`/${HANDLE} (saved draft and published page)`);
  await dialog.getByRole("button", { name: "Close" }).click();

  // A second image selected in a duplicated block but not saved is protected too.
  await card(page).first().getByRole("button", { name: "Duplicate “A lighthouse at dusk”" }).click();
  await expect(card(page)).toHaveCount(2);
  const copy = card(page).nth(1);
  await expand(copy);
  await copy.getByTestId("media-file-image").setInputFiles({ name: "second.png", mimeType: "image/png", buffer: await img.png(800, 800, "#663322") });
  await expect(copy.getByTestId("media-status")).toHaveText("Uploaded and selected. Save or publish to use it on your page.");
  await copy.getByTestId("media-item").first().getByTestId("media-delete").click();
  await expect(dialog.getByTestId("media-in-use")).toContainText("this editor (selected, not saved yet)");
  await dialog.getByRole("button", { name: "Close" }).click();

  // Delete the copy without saving: back to the saved state.
  await copy.getByRole("button", { name: "Delete “A lighthouse at dusk”" }).click();
  await expect(card(page)).toHaveCount(1);
  await expect(page.getByTestId("unsaved-indicator")).toHaveCount(0);
});

/**
 * Opens the public page as a new visitor with uploaded media held back, and
 * checks the image box (and the caption below it) before and after the image
 * arrives, plus the layout-shift entries in between.
 */
async function checkReservedSpace(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  const visitor = await context.newPage();
  await visitor.addInitScript(() => {
    const w = window as unknown as { __shifts: number };
    w.__shifts = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) w.__shifts += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  // Only uploaded media (`/media/…`), not Next.js font files under `/_next/static/media/`.
  await visitor.route((url) => url.pathname.startsWith("/media/"), async (route) => {
    await held;
    await route.continue();
  });

  // The held image would block the load event.
  await visitor.goto(`/${HANDLE}`, { waitUntil: "domcontentloaded" });
  const image = visitor.locator("img.pp-image");
  const after = visitor.locator(".pp-figure figcaption");
  await expect(after).toBeVisible();
  // Fonts settle first, so only what the image itself does is measured.
  await expect.poll(() => visitor.evaluate(() => document.fonts.status)).toBe("loaded");
  expect(await image.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0)).toBe(false);
  const before = { img: (await image.boundingBox())!, caption: await after.boundingBox() };
  // 16:9 of the rendered width, reserved before any byte of the image arrives. Geometry only: the
  // markup (width/height attributes) is asserted by the unit, E2E and editor tests.
  expect(before.img.height).toBeGreaterThan(100);
  expect(Math.abs(before.img.height - (before.img.width * 9) / 16)).toBeLessThan(1);

  await visitor.evaluate(() => ((window as unknown as { __shifts: number }).__shifts = 0));
  release();
  await expect.poll(() => image.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth === 1600)).toBe(true);
  expect(await image.boundingBox()).toEqual(before.img);
  expect(await after.boundingBox()).toEqual(before.caption);
  expect(await visitor.evaluate(() => (window as unknown as { __shifts: number }).__shifts)).toBe(0);
  return { context, visitor };
}

test("the public page reserves the image's space before it loads and shifts nothing, cropped or not; visitors get no cookies", async ({ page, browser, baseURL }) => {
  // Wide (16:9): the CSS aspect ratio reserves the box.
  const { context, visitor } = await checkReservedSpace(browser, baseURL);
  const go = (await visitor.locator("a.pp-image-link").getAttribute("href"))!;
  expect(go).toMatch(/^\/go\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
  const res = await visitor.request.get(go, { maxRedirects: 0 });
  expect([res.status(), res.headers()["location"]]).toEqual([302, DESTINATION]);
  expect(await context.cookies()).toEqual([]);
  await context.close();

  // Original shape: only the width/height attributes reserve the box (the upload is 1600 × 900).
  await openEditor(page);
  await expand(card(page));
  await card(page).getByRole("combobox", { name: "Shape" }).selectOption("auto");
  await page.getByRole("button", { name: /^Publish/ }).click();
  await expect(status(page)).toContainText("Published");
  const auto = await checkReservedSpace(browser, baseURL);
  await expect(auto.visitor.locator(".pp-figure")).toHaveAttribute("data-aspect", "auto");
  expect(await auto.context.cookies()).toEqual([]);
  await auto.context.close();
});

test.describe("phone viewport", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the image editor and public page fit at 390 px, and every interactive target is at least 44 × 44 px", async ({ page }) => {
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    await openEditor(page);
    await expand(card(page));
    await expect(pickerItems(page)).toHaveCount(2);
    expect(await noOverflow()).toBe(true);

    const small = await page.evaluate(() => {
      const scope = [...document.querySelectorAll('[data-testid="block-list"]')].filter((e) => (e as HTMLElement).offsetParent !== null);
      const out: string[] = [];
      for (const root of scope) {
        for (const el of root.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href]")) {
          if (el.offsetParent === null) continue;
          if (el.getAttribute("role") === "switch") {
            // The switch's hit area is its ::after box (extended below `sm`).
            const after = getComputedStyle(el, "::after");
            const h = el.offsetHeight - parseFloat(after.top) - parseFloat(after.bottom);
            const w = el.offsetWidth - parseFloat(after.left) - parseFloat(after.right);
            if (h < 44 || w < 44) out.push(`switch ${w}×${h}`);
            continue;
          }
          const isIcon = el.tagName === "BUTTON" && !el.textContent?.trim();
          if (el.offsetHeight < 44 || (isIcon && el.offsetWidth < 44)) {
            out.push(`${el.tagName.toLowerCase()} "${el.getAttribute("aria-label") ?? el.id ?? el.textContent}" ${el.offsetWidth}×${el.offsetHeight}`);
          }
        }
      }
      return out;
    });
    expect(small).toEqual([]);

    await page.goto(`/${HANDLE}`);
    await expect(page.locator("img.pp-image")).toBeVisible();
    expect(await noOverflow()).toBe(true);
    const box = await page.locator("a.pp-image-link").boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });
});
