import type { Browser, Dialog, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * Leaving the profile editor with unsaved changes: header links, "All
 * profiles", the profile switcher and the conflict reload ask first through
 * one in-app dialog; closing or reloading the tab keeps the browser's own
 * warning; links that don't navigate this window are left alone.
 * Serial: the first test creates the profiles the others edit.
 */
test.describe.configure({ mode: "serial" });

const OWNER = { name: "Dana Drafts", email: "drafts@example.com", password: "drafts-password-123" };
let signInCount = 0;
let mainUrl = "";
let sideUrl = "";

// Its own client address range (server runs with TRUST_PROXY=true) keeps other specs' sign-ups and sign-ins from tripping the rate limits.
test.beforeAll(async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.122.1" } });
  const page = await context.newPage();
  await page.goto("/setup");
  if (await page.locator("#token").count()) {
    await page.locator("#token").fill(process.env.E2E_SETUP_TOKEN!);
    await page.locator("#name").fill("Setup Owner");
    await page.locator("#email").fill("drafts-owner@example.com");
    await page.locator("#password").fill("correct-horse-battery");
    await page.locator("#confirm").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Create administrator" }).click();
    await expect(page.getByRole("status")).toContainText("ready");
  }
  await page.goto("/register");
  await page.locator("#name").fill(OWNER.name);
  await page.locator("#email").fill(OWNER.email);
  await page.locator("#password").fill(OWNER.password);
  await page.locator("#confirm").fill(OWNER.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await context.close();
});

test.beforeEach(async ({ page, baseURL }) => {
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: OWNER.email, password: OWNER.password },
    headers: { origin: baseURL!, "x-forwarded-for": `198.51.122.${10 + ++signInCount}` },
  });
  expect(res.status()).toBe(200);
});

/** Opens the editor and waits for hydration so typing isn't overwritten by React. */
async function openEditor(page: Page, url: string) {
  await page.goto(url);
  await page.locator("[data-hydrated]").waitFor();
}

/** Opens the editor and makes an unsaved edit to the bio. */
async function editBio(page: Page, url: string, bio: string) {
  await openEditor(page, url);
  await page.locator("#bio").fill(bio);
  await expect(page.getByTestId("unsaved-indicator").filter({ visible: true })).toBeVisible();
}

const leaveDialog = (page: Page) => page.getByRole("alertdialog", { name: "Leave without saving?" });
const headerLink = (page: Page, name: string) => page.getByRole("navigation", { name: "Main" }).getByRole("link", { name });

async function createProfile(page: Page, handle: string, label: string) {
  await page.goto("/dashboard/profiles");
  await page.locator("#handle").fill(handle);
  await page.locator("#label").fill(label);
  await page.locator("#displayName").fill(`${label} Dana`);
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page.getByTestId("editor-handle").filter({ visible: true })).toHaveText(`/${handle}`);
  return page.url();
}

test("creates the profiles to edit", async ({ page }) => {
  mainUrl = await createProfile(page, "drafts-main", "Main");
  sideUrl = await createProfile(page, "drafts-side", "Side");
});

test("without unsaved changes, links navigate without asking", async ({ page }) => {
  await openEditor(page, mainUrl);
  await headerLink(page, "Profiles").click();
  await expect(page).toHaveURL(/\/dashboard\/profiles$/);
  await expect(leaveDialog(page)).toHaveCount(0);
});

test("a header link asks first: Keep editing keeps every edit, Leave without saving navigates", async ({ page }) => {
  await editBio(page, mainUrl, "Unsaved header-link edit");
  await page.locator("#displayName").fill("Renamed but unsaved");
  await page.getByRole("group", { name: "Add block" }).getByRole("button", { name: "Heading" }).click();
  await page.getByLabel("Heading text").fill("Unsaved heading");

  await headerLink(page, "Account").click();
  await expect(leaveDialog(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(leaveDialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(mainUrl);
  await expect(page.locator("#bio")).toHaveValue("Unsaved header-link edit");
  await expect(page.locator("#displayName")).toHaveValue("Renamed but unsaved");
  await expect(page.getByLabel("Heading text")).toHaveValue("Unsaved heading");
  await expect(headerLink(page, "Account")).toBeFocused();

  await headerLink(page, "Account").click();
  await page.getByRole("button", { name: "Leave without saving" }).click();
  await expect(page).toHaveURL(/\/dashboard\/account$/);
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();

  // Coming back in the same session (Next.js may reuse the hidden page) shows the saved draft, not the discarded edits.
  await headerLink(page, "Profiles").click();
  await page.getByTestId("profile-row").filter({ visible: true }).filter({ hasText: "/drafts-main" }).getByRole("link", { name: "Edit" }).click();
  await expect(page).toHaveURL(mainUrl);
  await expect(page.locator("#bio")).toHaveValue("");
  await expect(page.locator("#displayName").filter({ visible: true })).toHaveValue("Main Dana");
  await expect(page.getByLabel("Heading text")).toHaveCount(0);
  await expect(page.getByTestId("unsaved-indicator").filter({ visible: true })).toHaveCount(0);
});

test("“All profiles” asks first, and the dialog works from the keyboard", async ({ page }) => {
  await editBio(page, mainUrl, "Unsaved all-profiles edit");
  const back = page.getByRole("link", { name: "← All profiles" });

  await back.focus();
  await page.keyboard.press("Enter");
  await expect(leaveDialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(leaveDialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(mainUrl);
  await expect(page.locator("#bio")).toHaveValue("Unsaved all-profiles edit");

  await back.focus();
  await page.keyboard.press("Enter");
  await expect(leaveDialog(page)).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Leave without saving" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/dashboard\/profiles$/);
});

test("switching profiles asks first; cancelling keeps the current profile and its edits", async ({ page }) => {
  // Edit the profile the switcher shows as active, then switch to the other one.
  const switcher = page.getByRole("combobox", { name: "Active profile" });
  await openEditor(page, mainUrl);
  const mainActive = (await switcher.textContent())?.includes("Main");
  const [fromUrl, fromLabel, toUrl, toLabel] = mainActive ? [mainUrl, "Main", sideUrl, "Side"] : [sideUrl, "Side", mainUrl, "Main"];
  await editBio(page, fromUrl, "Unsaved switcher edit");
  await expect(switcher).toContainText(fromLabel);

  await switcher.click();
  await page.getByRole("option", { name: new RegExp(toLabel) }).click();
  await expect(leaveDialog(page)).toBeVisible();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(fromUrl);
  await expect(switcher).toContainText(fromLabel);
  await expect(switcher).toBeFocused();
  await expect(page.locator("#bio")).toHaveValue("Unsaved switcher edit");

  await switcher.click();
  await page.getByRole("option", { name: new RegExp(toLabel) }).click();
  await page.getByRole("button", { name: "Leave without saving" }).click();
  await expect(page).toHaveURL(toUrl);
  await expect(page.getByTestId("editor-handle").filter({ visible: true })).toHaveText(`/drafts-${toLabel.toLowerCase()}`);
});

test("an edit after saving clears the saved message; after saving again, links don't ask", async ({ page }) => {
  const status = page.getByTestId("editor-status").filter({ visible: true });
  const unsaved = page.getByTestId("unsaved-indicator").filter({ visible: true });
  await editBio(page, mainUrl, "First saved bio");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(status).toHaveText("Draft saved.");
  await expect(unsaved).toHaveCount(0);

  await page.locator("#bio").fill("Edited after saving");
  await expect(page.getByText("Draft saved.", { exact: true })).toBeHidden();
  await expect(unsaved).toBeVisible();
  await headerLink(page, "Profiles").click();
  await expect(leaveDialog(page)).toBeVisible();
  await page.getByRole("button", { name: "Keep editing" }).click();

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(status).toHaveText("Draft saved.");
  await headerLink(page, "Profiles").click();
  await expect(page).toHaveURL(/\/dashboard\/profiles$/);
  await expect(leaveDialog(page)).toHaveCount(0);
});

test("new-tab, modified and middle clicks and other sites aren't intercepted", async ({ page, context }) => {
  await editBio(page, mainUrl, "Unsaved while opening tabs");
  const opensTab = async (click: () => Promise<void>) => {
    const [tab] = await Promise.all([context.waitForEvent("page"), click()]);
    await tab.close();
    await expect(leaveDialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(mainUrl);
  };
  await opensTab(() => headerLink(page, "Profiles").click({ modifiers: ["ControlOrMeta"] }));
  await opensTab(() => headerLink(page, "Profiles").click({ button: "middle" }));
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "/dashboard";
    a.target = "_blank";
    a.textContent = "Dashboard in a new tab";
    document.querySelector("main")!.prepend(a);
  });
  await opensTab(() => page.getByRole("link", { name: "Dashboard in a new tab" }).click());
  await expect(page.locator("#bio")).toHaveValue("Unsaved while opening tabs");

  // Another site gets the browser's own warning, not the in-app dialog. Nothing leaves the test machine.
  await page.route("https://elsewhere.invalid/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Elsewhere</title>" }));
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "https://elsewhere.invalid/page";
    a.textContent = "Another site";
    document.querySelector("main")!.prepend(a);
  });
  const prompts: string[] = [];
  page.on("dialog", (d) => {
    prompts.push(d.type());
    void d.accept();
  });
  await page.getByRole("link", { name: "Another site" }).click();
  await expect(page).toHaveURL("https://elsewhere.invalid/page");
  expect(prompts).toEqual(["beforeunload"]);
});

test("reloading or closing the tab keeps the browser's warning", async ({ page }) => {
  await editBio(page, mainUrl, "Unsaved before reload");
  const nextDialog = () => page.waitForEvent("dialog");

  let shown: Promise<Dialog> = nextDialog();
  await page.evaluate(() => setTimeout(() => location.reload()));
  let dialog = await shown;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  await expect(page.locator("#bio")).toHaveValue("Unsaved before reload");
  await expect(leaveDialog(page)).toHaveCount(0);

  shown = nextDialog();
  await page.close({ runBeforeUnload: true });
  dialog = await shown;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.accept();
});

test("a conflict reload asks first: cancelling keeps the local text, leaving loads the latest version", async ({ page, context }) => {
  await openEditor(page, mainUrl);
  const other = await context.newPage();
  await openEditor(other, mainUrl);
  await other.locator("#bio").fill("Saved in the other tab");
  await other.getByRole("button", { name: "Save draft" }).click();
  await expect(other.getByTestId("editor-status").filter({ visible: true })).toHaveText("Draft saved.");
  await other.close();

  await page.locator("#bio").fill("Typed in the stale tab");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "changed somewhere else" })).toBeVisible();

  await page.getByRole("button", { name: "Reload latest version" }).click();
  await expect(leaveDialog(page)).toBeVisible();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.locator("#bio")).toHaveValue("Typed in the stale tab");

  await page.getByRole("button", { name: "Reload latest version" }).click();
  await page.getByRole("button", { name: "Leave without saving" }).click();
  await page.locator("[data-hydrated]").waitFor();
  await expect(page.locator("#bio")).toHaveValue("Saved in the other tab");
});
