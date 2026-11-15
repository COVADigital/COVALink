import type { Browser, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * Unfinished drafts in the editor: incomplete profile details, an invalid
 * block and an unfinished appearance are saved as typed and come back after a
 * reload with their problems; the saved draft counts as saved for navigation;
 * "draft saved", "needs attention", "not saved" and "not published" read
 * differently; fixing every problem allows publishing; visitors only ever see
 * published content. Serial: each step builds on the last.
 */
test.describe.configure({ mode: "serial" });

const OWNER = { name: "Una Unfinished", email: "unfinished-editor@example.com", password: "unfinished-password-123" };
const HANDLE = "unfinishedpage";
let signInCount = 0;
let editorUrl = "";

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/setup");
  if (await page.locator("#token").count()) {
    await page.locator("#token").fill(process.env.E2E_SETUP_TOKEN!);
    await page.locator("#name").fill("Setup Owner");
    await page.locator("#email").fill("unfinished-owner@example.com");
    await page.locator("#password").fill("correct-horse-battery");
    await page.locator("#confirm").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Create administrator" }).click();
    await expect(page.getByRole("status")).toContainText("ready");
  }
  // Through the API with its own client address, so this spec doesn't use up the other specs' sign-up allowance.
  const res = await page.request.post("/api/auth/sign-up/email", {
    data: { name: OWNER.name, email: OWNER.email, password: OWNER.password },
    headers: { origin: process.env.E2E_BASE_URL!, "x-forwarded-for": "198.51.104.250" },
  });
  expect(res.status()).toBe(200);
  await context.close();
});

test.beforeEach(async ({ page, baseURL }) => {
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: OWNER.email, password: OWNER.password },
    headers: { origin: baseURL!, "x-forwarded-for": `198.51.104.${++signInCount}` },
  });
  expect(res.status()).toBe(200);
});

async function openEditor(page: Page) {
  await page.goto(editorUrl);
  await page.locator("[data-hydrated]").waitFor();
}

const cards = (page: Page) => page.getByTestId("block-list").filter({ visible: true }).getByTestId("block-card");
const card = (page: Page, label: string) => cards(page).filter({ has: page.getByTestId("block-label").getByText(label, { exact: true }) });
const status = (page: Page) => page.getByTestId("editor-status").filter({ visible: true });
const topStatus = (page: Page) => page.getByTestId("profile-status").filter({ visible: true });
const note = (page: Page) => page.getByTestId("draft-needs-attention").filter({ visible: true });
const alert = (page: Page) => page.getByRole("alert").filter({ hasText: /Not saved|Not published|wasn't saved/ });
const save = (page: Page) => page.getByRole("button", { name: "Save draft", exact: true });
const publish = (page: Page) => page.getByRole("button", { name: /^Publish( changes)?$/ });
const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
const displayName = (page: Page) => page.locator("#header-form #displayName");
const publicPage = async (page: Page) => {
  const res = await page.request.get(`/${HANDLE}`);
  return { status: res.status(), html: await res.text() };
};

async function addLink(page: Page, title: string, url: string) {
  await page.getByRole("group", { name: "Add block" }).getByRole("button", { name: "Link", exact: true }).click();
  const c = cards(page).last();
  await c.getByLabel("Title", { exact: true }).fill(title);
  await c.getByLabel("Web address").fill(url);
}

async function expand(page: Page, label: string) {
  const toggle = card(page, label).getByRole("button", { name: /^Edit / });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

test("an incomplete profile and an invalid block are saved as a draft that needs attention, and count as saved", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dashboard/profiles");
  await page.locator("#handle").fill(HANDLE);
  await page.locator("#label").fill("Unfinished");
  await page.locator("#displayName").fill("Una");
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page).toHaveURL(/\/dashboard\/profiles\/[0-9a-f-]{36}$/);
  editorUrl = page.url();
  await page.locator("[data-hydrated]").waitFor();

  await addLink(page, "Shop", "not a url");
  await tab(page, "Profile").click();
  await displayName(page).fill("");
  await page.locator("#header-form #bio").fill("Back soon to finish this.");
  await expect(topStatus(page)).toHaveText("Unsaved changes");

  await save(page).click();
  await expect(status(page)).toHaveText("Draft saved.");
  await expect(topStatus(page)).toHaveText("Saved · needs attention");
  await expect(note(page)).toContainText("saved, but it can't be published yet");
  await expect(alert(page)).toHaveCount(0); // saved: neither a failed save nor a refused publish

  // The problems are shown where they are, and Publish waits for them.
  await expect(tab(page, "Profile")).toHaveAttribute("aria-selected", "true");
  await expect(displayName(page)).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Add a display name").filter({ visible: true })).toBeVisible();
  await expect(tab(page, "Content")).toContainText("1 problem to fix");
  await expect(publish(page)).toBeDisabled();

  // Saved means saved: nothing is unsaved, and leaving doesn't ask.
  await expect(save(page)).toBeDisabled();
  await expect(page.getByTestId("unsaved-indicator").filter({ visible: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Back to profiles" }).click();
  await expect(page).toHaveURL(/\/dashboard\/profiles$/);
  await expect(page.getByRole("alertdialog", { name: "Leave without saving?" })).toHaveCount(0);

  // Never published, so there is still no public page.
  expect((await publicPage(page)).status).toBe(404);
});

test("reopening shows the invalid values with their problems; a failed save and a refused publish read differently", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEditor(page);
  await expect(topStatus(page)).toHaveText("Saved · needs attention");
  await expect(note(page)).toBeVisible();
  await expect(publish(page)).toBeDisabled();
  await expect(save(page)).toBeDisabled();

  // The block, exactly as typed, with its message.
  await expect(tab(page, "Content")).toContainText("1 problem to fix");
  await expand(page, "Shop");
  const url = card(page, "Shop").getByLabel("Web address");
  await expect(url).toHaveValue("not a url");
  await expect(url).toHaveAttribute("aria-invalid", "true");
  await expect(card(page, "Shop").getByText("Enter a valid http(s) address, like example.com")).toBeVisible();

  // The profile details, exactly as typed, with their message.
  await tab(page, "Profile").click();
  await expect(tab(page, "Profile")).toContainText("1 problem to fix");
  await expect(displayName(page)).toHaveValue("");
  await expect(displayName(page)).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Add a display name").filter({ visible: true })).toBeVisible();
  await expect(page.locator("#header-form #bio")).toHaveValue("Back soon to finish this.");

  // Publishing with the problems still there is refused before anything is sent, and says so.
  await page.locator("#header-form #bio").fill("Still not finished.");
  await expect(publish(page)).toBeEnabled();
  await publish(page).click();
  await expect(topStatus(page)).toHaveText("Needs attention");
  await expect(alert(page)).toContainText("Not published.");
  await expect(alert(page)).not.toContainText("Not saved");
  await expect(publish(page)).toBeDisabled();
  await expect(save(page)).toBeEnabled(); // the draft can still be saved as it is

  // A save that doesn't reach the server is a failed save: different words, edits kept, a way to retry.
  const offline = (route: Parameters<Parameters<Page["route"]>[1]>[0]) =>
    route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort("internetdisconnected") : route.continue();
  await page.route("**/dashboard/profiles/**", offline);
  await save(page).click();
  await expect(topStatus(page)).toHaveText("Not saved");
  await expect(alert(page)).toContainText("so your draft wasn't saved");
  await expect(alert(page)).not.toContainText("Not published");
  await expect(page.locator("#header-form #bio")).toHaveValue("Still not finished.");
  await page.unroute("**/dashboard/profiles/**", offline);

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(status(page)).toHaveText("Draft saved.");
  await expect(topStatus(page)).toHaveText("Saved · needs attention");
  await expect(alert(page)).toHaveCount(0);
  expect((await publicPage(page)).status).toBe(404);
});

/** Leaves through the guarded link, confirms, and comes back to the page Next.js kept. */
async function leaveWithoutSavingAndReturn(page: Page) {
  await page.getByRole("link", { name: "Back to profiles" }).click();
  await page.getByRole("button", { name: "Leave without saving", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/profiles$/);
  await page.goBack();
  await expect(topStatus(page)).toHaveText("Saved · needs attention");
  await expect(save(page)).toBeDisabled();
  await expect(publish(page)).toBeDisabled();
}

test("leaving without saving drops later corrections and returns to the saved unfinished values with their problems", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEditor(page);
  await tab(page, "Profile").click();
  await displayName(page).fill("Una");
  await page.locator("#header-form #bio").fill("A correction that is thrown away.");
  await tab(page, "Content").click();
  await expand(page, "Shop");
  await card(page, "Shop").getByLabel("Web address").fill("shop.example.com");
  await expect(topStatus(page)).toHaveText("Unsaved changes");

  await leaveWithoutSavingAndReturn(page);

  // What was saved, not the corrections and not an older valid draft.
  const shown = async () => {
    await tab(page, "Content").click();
    await expect(tab(page, "Content")).toContainText("1 problem to fix");
    await expand(page, "Shop");
    const url = card(page, "Shop").getByLabel("Web address");
    await expect(url).toHaveValue("not a url");
    await expect(url).toHaveAttribute("aria-invalid", "true");
    await expect(card(page, "Shop").getByText("Enter a valid http(s) address, like example.com")).toBeVisible();
    await tab(page, "Profile").click();
    await expect(displayName(page)).toHaveValue("");
    await expect(displayName(page)).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("Add a display name").filter({ visible: true })).toBeVisible();
    await expect(page.locator("#header-form #bio")).toHaveValue("Still not finished.");
  };
  await shown();

  // And the stored draft is untouched.
  await openEditor(page);
  await shown();
});

test("correcting the values clears their errors and allows publishing; visitors see the corrected page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEditor(page);
  await tab(page, "Profile").click();
  await displayName(page).fill("Una");
  await expect(displayName(page)).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Add a display name").filter({ visible: true })).toHaveCount(0);
  await expect(tab(page, "Profile")).not.toContainText("problem");

  await tab(page, "Content").click();
  await expand(page, "Shop");
  const url = card(page, "Shop").getByLabel("Web address");
  await url.fill("shop.example.com");
  await expect(url).not.toHaveAttribute("aria-invalid", "true");
  await expect(tab(page, "Content")).not.toContainText("problem");

  await expect(publish(page)).toBeEnabled();
  await publish(page).click();
  await expect(status(page)).toContainText("Published. Your public page is up to date.");
  await expect(topStatus(page)).toHaveText("Published · up to date");
  await expect(note(page)).toHaveCount(0);

  const live = await publicPage(page);
  expect(live.status).toBe(200);
  expect(live.html).toContain("Shop");
  expect(live.html).toContain('data-block-type="link"');
  expect(live.html).not.toContain("not a url");
});

test("an unfinished appearance and block are saved and reopened while visitors keep seeing the published page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEditor(page);
  await addLink(page, "Coming soon", "");
  await tab(page, "Design").click();
  await page.locator("#theme-background-type-image").check();
  await expect(page.getByTestId("media-error").filter({ visible: true })).toHaveText("Choose or upload a background image.");

  await save(page).click();
  await expect(status(page)).toHaveText("Draft saved.");
  await expect(topStatus(page)).toHaveText("Saved · needs attention");
  await expect(note(page)).toBeVisible();
  await expect(publish(page)).toBeDisabled();

  // The live page is the published one: no unfinished block, no change of look.
  const before = await publicPage(page);
  expect(before.status).toBe(200);
  expect(before.html).toContain("Shop");
  expect(before.html).not.toContain("Coming soon");
  expect(before.html).not.toContain("url(");

  await openEditor(page);
  await expect(topStatus(page)).toHaveText("Saved · needs attention");
  await expect(card(page, "Coming soon").getByText("Needs attention")).toBeAttached();
  await tab(page, "Design").click();
  await expect(page.locator("#theme-background-type-image")).toBeChecked();
  await expect(page.getByTestId("media-error").filter({ visible: true })).toContainText("background image");
  await expect(publish(page)).toBeDisabled();

  // Corrections abandoned on the way out: the saved unfinished appearance and block come back.
  await page.locator("#theme-background-type-solid").check();
  await tab(page, "Content").click();
  await expand(page, "Coming soon");
  await card(page, "Coming soon").getByLabel("Web address").fill("soon.example.com");
  await leaveWithoutSavingAndReturn(page);
  await tab(page, "Content").click();
  await expand(page, "Coming soon");
  await expect(card(page, "Coming soon").getByLabel("Web address")).toHaveValue("");
  await expect(card(page, "Coming soon").getByText("Needs attention")).toBeAttached();
  await tab(page, "Design").click();
  await expect(page.locator("#theme-background-type-image")).toBeChecked();
  await expect(page.getByTestId("media-error").filter({ visible: true })).toContainText("background image");

  // Finishing both publishes.
  await page.locator("#theme-background-type-solid").check();
  await tab(page, "Content").click();
  await expand(page, "Coming soon");
  await card(page, "Coming soon").getByLabel("Web address").fill("soon.example.com");
  await publish(page).click();
  await expect(status(page)).toContainText("Published. Your public page is up to date.");
  await expect(note(page)).toHaveCount(0);
  expect((await publicPage(page)).html).toContain("Coming soon");
});
