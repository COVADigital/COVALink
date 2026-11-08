import type { Browser, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * Profile editor browser workflows: create → edit with live preview → save draft →
 * publish → public page → draft isolation → conflict across tabs → rename →
 * unpublish → profile switcher → delete, plus a phone-size check.
 * Serial: later steps build on earlier ones.
 *
 * Test-id lookups are filtered to visible elements: with Cache Components,
 * Next.js keeps the previous route mounted but hidden (React <Activity>).
 */
test.describe.configure({ mode: "serial" });

const CREATOR = { name: "Casey Creator", email: "creator@example.com", password: "creator-password-123" };
let signInCount = 0;

let editorUrl = "";
let handle = "creatorpage";

async function ensureSetup(page: Page) {
  await page.goto("/setup");
  if (await page.locator("#token").count()) {
    await page.locator("#token").fill(process.env.E2E_SETUP_TOKEN!);
    await page.locator("#name").fill("Setup Owner");
    await page.locator("#email").fill("editor-owner@example.com");
    await page.locator("#password").fill("correct-horse-battery");
    await page.locator("#confirm").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Create administrator" }).click();
    await expect(page.getByRole("status")).toContainText("ready");
  }
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await ensureSetup(page);
  await page.goto("/register");
  await page.locator("#name").fill(CREATOR.name);
  await page.locator("#email").fill(CREATOR.email);
  await page.locator("#password").fill(CREATOR.password);
  await page.locator("#confirm").fill(CREATOR.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await context.close();
});

/**
 * Signs each test's browser context in through the real auth endpoint (the
 * session cookie lands in the context). A distinct X-Forwarded-For keeps the
 * per-client sign-in rate limit from tripping across tests (server runs with
 * TRUST_PROXY=true in this suite).
 */
test.beforeEach(async ({ page, baseURL }) => {
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: CREATOR.email, password: CREATOR.password },
    headers: { origin: baseURL!, "x-forwarded-for": `198.51.100.${++signInCount}` },
  });
  expect(res.status()).toBe(200);
});

/** Opens the editor and waits for hydration so typing isn't overwritten by React. */
async function openEditor(page: Page, url = editorUrl) {
  await page.goto(url);
  await page.locator("[data-hydrated]").waitFor();
}

async function publicStatus(page: Page, h: string) {
  return (await page.request.get(`/${h}`, { maxRedirects: 0 })).status();
}

test("creates a profile from the dashboard with a normalized handle", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByText("You don't have a profile yet")).toBeVisible();
  await page.getByRole("link", { name: "Create a profile" }).click();
  await expect(page).toHaveURL(/\/dashboard\/profiles$/);

  await page.locator("#handle").fill("@Creator.Page");
  await expect(page.locator("#handle-hint")).toHaveText("Your page will be at /creatorpage");
  await page.locator("#label").fill("Main");
  await page.locator("#displayName").fill("Casey");
  await page.getByRole("button", { name: "Create profile" }).click();

  await expect(page).toHaveURL(/\/dashboard\/profiles\/[0-9a-f-]{36}$/);
  editorUrl = page.url();
  await expect(page.getByTestId("editor-handle").filter({ visible: true })).toHaveText("/creatorpage");
  await expect(page.getByTestId("profile-status").filter({ visible: true })).toContainText("Not published");
  expect(await publicStatus(page, handle)).toBe(404);
});

test("edits update the shared preview live; saving a draft keeps the page unpublished", async ({ page }) => {
  await openEditor(page);
  const preview = page.getByTestId("profile-preview").filter({ visible: true });
  await page.locator("#displayName").fill("Casey Draft");
  await page.locator("#bio").fill("Line one\nLine two");
  await expect(preview.getByTestId("profile-name")).toHaveText("Casey Draft");
  await expect(preview.getByTestId("profile-bio")).toHaveText("Line one\nLine two");
  await expect(page.getByTestId("unsaved-indicator").filter({ visible: true })).toBeVisible();

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByTestId("editor-status").filter({ visible: true })).toHaveText("Draft saved.");
  await expect(page.getByTestId("unsaved-indicator").filter({ visible: true })).toHaveCount(0);
  expect(await publicStatus(page, handle)).toBe(404);

  await page.reload();
  await expect(page.locator("#displayName")).toHaveValue("Casey Draft");
});

test("invalid input is reported inline and nothing is saved", async ({ page }) => {
  await openEditor(page);
  await page.locator("#displayName").fill("");
  await page.locator("#avatarUrl").fill("javascript:alert(1)");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.locator("#displayName")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#avatarUrl-error")).toHaveText("Use an https:// image address");
  await page.reload();
  await expect(page.locator("#displayName")).toHaveValue("Casey Draft");
});

test("publishing makes the page public with the published content", async ({ page, context }) => {
  await openEditor(page);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("editor-status").filter({ visible: true })).toContainText("Published");
  await expect(page.getByRole("button", { name: "Published" })).toBeDisabled();

  const visitor = await context.newPage();
  const res = await visitor.goto(`/${handle}`);
  expect(res?.status()).toBe(200);
  await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Casey Draft");
  await expect(visitor.getByTestId("profile-bio").filter({ visible: true })).toHaveText("Line one\nLine two");
  await expect(visitor).toHaveTitle("Casey Draft");
  await visitor.close();
});

test("draft edits stay private until published again", async ({ page, context }) => {
  await openEditor(page);
  await page.locator("#displayName").fill("Secret Next Version");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByTestId("editor-status").filter({ visible: true })).toContainText("Draft saved");
  await expect(page.getByTestId("profile-status").filter({ visible: true })).toContainText("Unpublished changes");

  const visitor = await context.newPage();
  await visitor.goto(`/${handle}`);
  await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Casey Draft");
  expect(await visitor.content()).not.toContain("Secret Next Version");

  await page.getByRole("button", { name: "Publish changes" }).click();
  await expect(page.getByTestId("editor-status").filter({ visible: true })).toContainText("Published");
  await visitor.reload();
  await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Secret Next Version");
  await visitor.close();
});

test("a stale tab can't overwrite newer changes and is offered a reload", async ({ page, context }) => {
  await openEditor(page);
  const other = await context.newPage();
  await openEditor(other);

  await other.locator("#bio").fill("Saved in the other tab");
  await other.getByRole("button", { name: "Save draft" }).click();
  await expect(other.getByTestId("editor-status").filter({ visible: true })).toContainText("Draft saved");

  await page.locator("#bio").fill("Saved in the stale tab");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.locator("form [role=alert], [role=alert]").filter({ hasText: "changed somewhere else" })).toBeVisible();
  await page.getByRole("button", { name: "Reload latest version" }).click();
  await expect(page.locator("#bio")).toHaveValue("Saved in the other tab");
  await other.close();
});

test("renaming the handle moves the public page after confirmation", async ({ page }) => {
  await openEditor(page);
  await page.locator("#settings-handle").fill("creator-renamed");
  await page.getByRole("button", { name: "Save address & name" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("/creatorpage will stop working");
  await page.getByRole("button", { name: "Change address" }).click();
  await expect(page.getByText("Saved. Your page address is /creator-renamed.")).toBeVisible();
  expect(await publicStatus(page, "creatorpage")).toBe(404);
  expect(await publicStatus(page, "creator-renamed")).toBe(200);
  handle = "creator-renamed";
});

test("unpublish takes the page offline and publish brings it back", async ({ page }) => {
  await openEditor(page);
  await page.getByRole("button", { name: "Unpublish" }).click();
  await expect(page.getByTestId("editor-status").filter({ visible: true })).toContainText("no longer available");
  expect(await publicStatus(page, handle)).toBe(404);
  await page.getByRole("button", { name: /^Publish/ }).click();
  await expect(page.getByTestId("editor-status").filter({ visible: true })).toContainText("Published");
  expect(await publicStatus(page, handle)).toBe(200);
});

test("the header switcher changes the active profile", async ({ page }) => {
  await page.goto("/dashboard/profiles");
  await page.locator("#handle").fill("creator-second");
  await page.locator("#label").fill("Second");
  await page.locator("#displayName").fill("Second Casey");
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page.getByTestId("editor-handle").filter({ visible: true })).toHaveText("/creator-second");

  await page.getByRole("combobox", { name: "Active profile" }).click(); // role query skips the hidden previous route kept by <Activity>
  await page.getByRole("option", { name: /Main/ }).click();
  await expect(page).toHaveURL(editorUrl);
  await expect(page.getByTestId("editor-handle").filter({ visible: true })).toHaveText(`/${handle}`);

  await page.goto("/dashboard");
  await expect(page.getByRole("region", { name: "Active profile" })).toContainText("Main");
});

test("deleting requires typing the handle and removes the public page", async ({ page }) => {
  await openEditor(page);
  await page.getByRole("button", { name: "Delete profile" }).click();
  const confirm = page.getByRole("button", { name: "Delete permanently" });
  await expect(confirm).toBeDisabled();
  await page.locator("#confirm-handle").fill(handle);
  await confirm.click();
  await expect(page).toHaveURL(/\/dashboard\/profiles$/);
  await expect(page.getByTestId("profile-row").filter({ visible: true })).toHaveCount(1);
  expect(await publicStatus(page, handle)).toBe(404);
});

test.describe("phone viewport", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("editor and public page fit without horizontal scrolling", async ({ page }) => {
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    await page.goto("/dashboard/profiles");
    await page.getByRole("link", { name: "Edit" }).first().click();
    await page.locator("[data-hydrated]").waitFor();
    expect(await noOverflow()).toBe(true);
    await page.getByTestId("profile-preview").filter({ visible: true }).scrollIntoViewIfNeeded();
    await expect(page.getByTestId("profile-preview").filter({ visible: true })).toBeInViewport();

    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByTestId("editor-status").filter({ visible: true })).toContainText("Published");
    await page.goto("/creator-second");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Second Casey");
    expect(await noOverflow()).toBe(true);
  });
});
