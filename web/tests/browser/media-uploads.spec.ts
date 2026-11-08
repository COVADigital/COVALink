import type { Browser, Locator, Page } from "@playwright/test";
import * as img from "../support/images";
import { expect, test } from "./fixtures";

/**
 * Browser workflows for uploaded media: avatar and background uploads
 * through the file picker, selection, the live preview, publishing, the
 * public page, contrast over images, deletion with confirmation and the
 * in-use explanation, upload errors, keyboard use and a phone-size run.
 * Every test also fails on CSP violations or page errors (fixtures.ts).
 * Serial: steps build on each other.
 */
test.describe.configure({ mode: "serial" });

const EDITOR = { name: "Mia Media", email: "media-editor@example.com", password: "media-password-123" };
let signInCount = 0;
let editorUrl = "";

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/setup");
  if (await page.locator("#token").count()) {
    await page.locator("#token").fill(process.env.E2E_SETUP_TOKEN!);
    await page.locator("#name").fill("Setup Owner");
    await page.locator("#email").fill("media-owner@example.com");
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
    headers: { origin: baseURL!, "x-forwarded-for": `198.51.105.${++signInCount}` },
  });
  expect(res.status()).toBe(200);
});

async function openEditor(page: Page, url = editorUrl) {
  await page.goto(url);
  await page.locator("[data-hydrated]").waitFor();
}

async function createProfile(page: Page, handle: string) {
  await page.goto("/dashboard/profiles");
  await page.locator("#handle").fill(handle);
  await page.locator("#label").fill(handle);
  await page.locator("#displayName").fill("Mia");
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page).toHaveURL(/\/dashboard\/profiles\/[0-9a-f-]{36}$/);
  await page.locator("[data-hydrated]").waitFor();
  return page.url();
}

const status = (page: Page) => page.getByTestId("editor-status").filter({ visible: true });
const picker = (page: Page, kind: "avatar" | "background") => page.getByTestId(`media-${kind}`).filter({ visible: true });
const items = (page: Page, kind: "avatar" | "background") => picker(page, kind).getByTestId("media-item");
const previewRoot = (page: Page) => page.getByTestId("profile-preview").filter({ visible: true }).locator(".pp-root");
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true }).filter({ visible: true });

async function uploadInto(page: Page, kind: "avatar" | "background", file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.getByTestId(`media-file-${kind}`).setInputFiles(file);
}

async function appearanceTab(page: Page) {
  await page.getByRole("tab", { name: /Appearance/ }).click();
  await expect(page.getByRole("tab", { name: /Appearance/ })).toHaveAttribute("aria-selected", "true");
}

async function publish(page: Page) {
  await page.getByRole("button", { name: /^Publish/ }).click();
  await expect(status(page)).toContainText("Published");
}

async function background(root: Locator) {
  await root.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))));
  return root.evaluate((el) => {
    const s = getComputedStyle(el);
    return { image: s.backgroundImage, color: s.backgroundColor, size: s.backgroundSize, position: s.backgroundPosition, repeat: s.backgroundRepeat, text: s.color };
  });
}

/** True once the <img> has loaded real pixels (not blocked or broken). */
const loaded = (el: Locator) => el.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0);

test("uploads an avatar through the file picker, selects it, publishes it and shows it on the public page", async ({ page }) => {
  editorUrl = await createProfile(page, "mediapage");
  await expect(picker(page, "avatar").getByTestId("media-empty")).toBeVisible();
  await expect(picker(page, "avatar").getByTestId("media-quota")).toHaveText("0 B of 50.0 MB used");

  await uploadInto(page, "avatar", { name: "portrait.png", mimeType: "image/png", buffer: await img.png(900, 700, "#cc3366") });
  await expect(picker(page, "avatar").getByTestId("media-status")).toContainText("Uploaded and selected");
  await expect(items(page, "avatar")).toHaveCount(1);
  const selected = items(page, "avatar").first().getByRole("button", { name: /^Use portrait\.png, 512 × 398 px/ });
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  const url = (await items(page, "avatar").first().getAttribute("data-url"))!;
  expect(url).toMatch(/^\/media\/[0-9a-f-]{36}\.webp$/);
  // The external-address field gives way to the uploaded avatar; the preview shows it.
  await expect(page.locator("#avatarUrl")).toHaveCount(0);
  const previewAvatar = previewRoot(page).locator(".pp-avatar");
  await expect(previewAvatar).toHaveAttribute("src", url);
  await expect.poll(() => loaded(previewAvatar)).toBe(true);
  await expect(page.getByTestId("unsaved-indicator")).toBeVisible();

  await publish(page);
  await page.goto("/mediapage");
  const publicAvatar = page.locator(".pp-avatar");
  await expect(publicAvatar).toHaveAttribute("src", url);
  await expect.poll(() => loaded(publicAvatar)).toBe(true);
});

test("shows upload errors from the server: an SVG disguised as a PNG is refused", async ({ page }) => {
  await openEditor(page);
  await uploadInto(page, "avatar", { name: "logo.png", mimeType: "image/png", buffer: img.svg() });
  await expect(picker(page, "avatar").getByTestId("media-error")).toHaveText("SVG images aren't supported. Use a JPEG, PNG or WebP image.");
  await expect(items(page, "avatar")).toHaveCount(1);
});

test("background image: required before saving, contrast checked over the image, preview and public page agree", async ({ page }) => {
  await openEditor(page);
  await appearanceTab(page);
  await field(page, "Image").check();
  await expect(picker(page, "background").getByTestId("media-error")).toHaveText("Choose or upload a background image.");
  // Saving with no image chosen is refused client-side and focuses the upload control.
  await page.getByRole("button", { name: /^Publish/ }).click();
  await expect(page.locator("#theme-background-imageUrl")).toBeFocused();

  await uploadInto(page, "background", { name: "beach.jpg", mimeType: "image/jpeg", buffer: await img.jpeg(2400, 1600, "#d9c27a") });
  await expect(items(page, "background")).toHaveCount(1);
  await expect(items(page, "background").first().getByRole("button", { name: /^Use / })).toHaveAttribute("aria-pressed", "true");
  const url = (await items(page, "background").first().getAttribute("data-url"))!;

  // The Minimal preset's dark text can't be guaranteed over an image.
  await expect(page.getByTestId("contrast-summary")).toBeVisible();
  await expect(page.locator("#theme-text-color-contrast")).toContainText("background image");

  await field(page, "Text").fill("#ffffff");
  await field(page, "Muted text").fill("#e4e4e7");
  await field(page, "Accent").fill("#ffffff");
  await field(page, "Style").selectOption("fill");
  await field(page, "Button color").fill("#ffffff");
  await field(page, "Button text").fill("#111111");
  await field(page, "Overlay darkness").fill("70");
  await expect(page.getByTestId("overlay-value")).toHaveText("70%");
  await expect(page.getByTestId("contrast-summary")).toHaveCount(0);

  const preview = await background(previewRoot(page));
  expect(preview.image).toContain("linear-gradient(rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0.7))");
  expect(preview.image).toContain(`${url}")`);
  expect(preview).toMatchObject({ size: "auto, cover", repeat: "repeat, no-repeat", text: "rgb(255, 255, 255)" });

  const bgResponse = page.waitForResponse((r) => r.url().endsWith(url));
  await publish(page);
  await page.goto("/mediapage");
  expect((await bgResponse).status()).toBe(200);
  const live = await background(page.locator(".pp-root"));
  expect(live).toEqual(preview);
});

test("server-side contrast enforcement over an image matches the editor's warning", async ({ page }) => {
  await openEditor(page);
  await appearanceTab(page);
  await field(page, "Overlay darkness").fill("20");
  await expect(page.getByTestId("contrast-summary")).toBeVisible();
  // The editor would block nothing client-side for contrast; the server refuses the publish with the same fields.
  await page.getByRole("button", { name: /^Publish/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: "enough contrast" })).toBeVisible();
  await expect(page.locator("#theme-text-color-contrast")).toBeVisible();
  await field(page, "Overlay darkness").fill("70");
  await expect(page.getByTestId("contrast-summary")).toHaveCount(0);
  // Back to the saved, published 70%: nothing left to save, and the page stays as published.
  await expect(page.getByTestId("unsaved-indicator")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save draft" })).toBeDisabled();
});

test("deletion: in-use images explain why they can't be deleted; unused ones are deleted after confirmation", async ({ page }) => {
  await openEditor(page);
  const first = items(page, "avatar").first();
  const firstUrl = (await first.getAttribute("data-url"))!;

  // Used by the saved draft and the published page.
  await first.getByTestId("media-delete").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("heading")).toHaveText("This image can't be deleted yet");
  await expect(dialog.getByTestId("media-in-use")).toContainText("/mediapage (saved draft and published page)");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(first.getByTestId("media-delete")).toBeFocused();

  // A new upload is selected here but not saved yet: also protected.
  await uploadInto(page, "avatar", { name: "second.webp", mimeType: "image/webp", buffer: await img.webp(300, 300, "#22aa66") });
  await expect(items(page, "avatar")).toHaveCount(2);
  const second = items(page, "avatar").first();
  await second.getByTestId("media-delete").click();
  await expect(dialog.getByTestId("media-in-use")).toContainText("this editor (selected, not saved yet)");
  await dialog.getByRole("button", { name: "Close" }).click();

  // Choose the first again: the second is unused, so it can be deleted (keyboard: Enter opens, the action confirms).
  await picker(page, "avatar").locator(`[data-url="${firstUrl}"]`).getByRole("button", { name: /^Use / }).click();
  await second.getByTestId("media-delete").focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("heading")).toHaveText("Delete this image?");
  await dialog.getByRole("button", { name: "Delete image" }).click();
  await expect(picker(page, "avatar").getByTestId("media-status")).toHaveText("Image deleted.");
  await expect(items(page, "avatar")).toHaveCount(1);
  await expect(page.getByTestId("unsaved-indicator")).toHaveCount(0);
});

test.describe("phone viewport", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("upload, select, publish, view, and the delete refusal all work at 390 px without horizontal scrolling", async ({ page }) => {
    const url = await createProfile(page, "mediaphone");
    await uploadInto(page, "avatar", { name: "phone.jpg", mimeType: "image/jpeg", buffer: await img.jpeg(600, 800, "#336699") });
    await expect(items(page, "avatar")).toHaveCount(2); // the first avatar from the earlier tests, plus this one
    const chosen = items(page, "avatar").first();
    await expect(chosen.getByRole("button", { name: /^Use phone\.jpg/ })).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await publish(page);

    await page.goto("/mediaphone");
    const avatar = page.locator(".pp-avatar");
    await expect.poll(() => loaded(avatar)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await openEditor(page, url);
    await items(page, "avatar").first().getByTestId("media-delete").tap();
    await expect(page.getByRole("alertdialog").getByTestId("media-in-use")).toContainText("/mediaphone");
    await page.getByRole("alertdialog").getByRole("button", { name: "Close" }).tap();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
