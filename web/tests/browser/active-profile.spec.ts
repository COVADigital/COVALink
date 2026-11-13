import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * The active profile follows the profile a page is about: the editor and a
 * profile's analytics show it in the header at once and remember it through
 * the ownership-checked select action. Another user's profile is a 404 and
 * leaves the choice alone. Serial: the first step creates the profiles.
 */
test.describe.configure({ mode: "serial" });

const OWNER = { name: "Ari Active", email: "active-owner@example.com", password: "active-password-123" };
const STRANGER = { name: "Sam Stranger", email: "active-stranger@example.com", password: "stranger-password-123" };
const COOKIE = "covalink_active_profile";
let signIns = 0;
let homeId = "";
let shopId = "";
let strangerId = "";

/** Its own client address range keeps other specs' sign-ins from tripping the rate limits. */
const address = () => `198.51.124.${10 + ++signIns}`;

async function register(browser: Browser, who: typeof OWNER, handles: string[]): Promise<string[]> {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": address() } });
  const page = await context.newPage();
  await page.goto("/setup");
  if (await page.locator("#token").count()) {
    await page.locator("#token").fill(process.env.E2E_SETUP_TOKEN!);
    await page.locator("#name").fill("Setup Owner");
    await page.locator("#email").fill("active-setup@example.com");
    await page.locator("#password").fill("correct-horse-battery");
    await page.locator("#confirm").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Create administrator" }).click();
    await expect(page.getByRole("status")).toContainText("ready");
  }
  await page.goto("/register");
  await page.locator("#name").fill(who.name);
  await page.locator("#email").fill(who.email);
  await page.locator("#password").fill(who.password);
  await page.locator("#confirm").fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  const ids: string[] = [];
  for (const handle of handles) {
    await page.goto("/dashboard/profiles");
    await page.locator("#handle").fill(handle);
    await page.locator("#label").fill(handle.split("-")[1][0].toUpperCase() + handle.split("-")[1].slice(1));
    await page.locator("#displayName").fill(who.name);
    await page.getByRole("button", { name: "Create profile" }).click();
    await expect(page.getByTestId("editor-handle").filter({ visible: true })).toHaveText(`/${handle}`);
    ids.push(page.url().split("/").pop()!);
  }
  await context.close();
  return ids;
}

test.beforeAll(async ({ browser }) => {
  [homeId, shopId] = await register(browser, OWNER, ["active-home", "active-shop"]);
  [strangerId] = await register(browser, STRANGER, ["active-stranger"]);
});

test.beforeEach(async ({ page, baseURL }) => {
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: OWNER.email, password: OWNER.password },
    headers: { origin: baseURL!, "x-forwarded-for": address() },
  });
  expect(res.status()).toBe(200);
});

const remembered = async (context: BrowserContext) => (await context.cookies()).find((c) => c.name === COOKIE)?.value ?? null;
const switcher = (page: Page) => page.getByRole("combobox", { name: "Active profile" });
const analyticsLink = (page: Page) => page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Analytics" });

/** Counts Server Action calls (the sync and the switcher both use one). */
function countActions(page: Page) {
  const calls = { n: 0 };
  page.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"]) calls.n++;
  });
  return calls;
}

/** Remembering the choice is the only Server Action an unchanged page sends, so this waits for it to finish. */
async function settled(page: Page) {
  await page.waitForLoadState("networkidle");
}

async function expectRemembered(page: Page, id: string, label: string) {
  await expect.poll(() => remembered(page.context())).toBe(id);
  await page.goto("/dashboard");
  await expect(page.getByRole("region", { name: "Active profile" })).toContainText(label);
  await page.goto("/dashboard/analytics");
  await expect(page).toHaveURL(new RegExp(`/dashboard/profiles/${id}/analytics$`));
}

test("opening a profile that isn't active from the list shows and remembers it", async ({ page }) => {
  // Choose "Shop" with the switcher first.
  await page.goto("/dashboard/profiles");
  await switcher(page).click();
  await page.getByRole("option", { name: /Shop/ }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/profiles/${shopId}$`));
  await expect.poll(() => remembered(page.context())).toBe(shopId);
  await page.goto("/dashboard/profiles");
  const actions = countActions(page);
  await page.getByTestId("profile-row").filter({ visible: true, hasText: "/active-home" }).getByRole("link", { name: "Edit" }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/profiles/${homeId}$`));
  await expect(switcher(page)).toContainText("Home");
  await expect(analyticsLink(page)).toHaveAttribute("href", `/dashboard/profiles/${homeId}/analytics`);
  await page.locator("[data-hydrated]").waitFor();
  await settled(page);
  expect(actions.n).toBe(1); // synced once, no loop
  await expect(switcher(page)).toContainText("Home");

  await analyticsLink(page).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/profiles/${homeId}/analytics$`));
  await expect(page.getByText("/active-home", { exact: false }).filter({ visible: true }).first()).toBeVisible();
  await expectRemembered(page, homeId, "Home");
});

test("opening an owned profile's editor or analytics directly does the same", async ({ page }) => {
  await page.goto(`/dashboard/profiles/${shopId}/analytics`);
  await expect(switcher(page)).toContainText("Shop");
  await expect(analyticsLink(page)).toHaveAttribute("href", `/dashboard/profiles/${shopId}/analytics`);
  await expectRemembered(page, shopId, "Shop");

  const actions = countActions(page);
  await page.goto(`/dashboard/profiles/${homeId}`);
  await expect(switcher(page)).toContainText("Home");
  await page.locator("[data-hydrated]").waitFor();
  await expectRemembered(page, homeId, "Home");
  expect(actions.n).toBe(1);

  // Already remembered: no sync at all.
  const again = countActions(page);
  await page.goto(`/dashboard/profiles/${homeId}`);
  await page.locator("[data-hydrated]").waitFor();
  await settled(page);
  expect(again.n).toBe(0);
});

test("another user's profile is a 404 and doesn't change the active profile", async ({ page }) => {
  await page.goto(`/dashboard/profiles/${homeId}`);
  await expect.poll(() => remembered(page.context())).toBe(homeId);
  for (const path of [`/dashboard/profiles/${strangerId}`, `/dashboard/profiles/${strangerId}/analytics`]) {
    // The page streams, so the 404 is the not-found boundary in the body, not the status line.
    const res = await page.goto(path);
    expect(await res?.text()).toContain("NEXT_HTTP_ERROR_FALLBACK;404");
    await expect(page.getByText("This page could not be found.")).toBeVisible();
    await expect(page.getByText("Stranger")).toHaveCount(0);
    await settled(page);
    expect(await remembered(page.context())).toBe(homeId);
  }
  await page.goto("/dashboard");
  await expect(page.getByRole("region", { name: "Active profile" })).toContainText("Home");
  await expect(page.getByRole("region", { name: "Active profile" })).not.toContainText("Stranger");
});

test("a sync still in flight doesn't overwrite a newer switcher choice", async ({ page }) => {
  await page.goto(`/dashboard/profiles/${homeId}`);
  await expect.poll(() => remembered(page.context())).toBe(homeId);

  // Hold the Shop page's sync back until after the person has chosen Home in the switcher.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let heldOnce = false;
  await page.route(`**/dashboard/profiles/${shopId}`, async (route) => {
    if (!heldOnce && route.request().method() === "POST" && route.request().headers()["next-action"]) {
      heldOnce = true;
      await held;
    }
    await route.continue();
  });
  await page.goto(`/dashboard/profiles/${shopId}`);
  await page.locator("[data-hydrated]").waitFor();
  await expect.poll(() => heldOnce).toBe(true);

  await switcher(page).click();
  await page.getByRole("option", { name: /Home/ }).click();
  release();
  await expect(page).toHaveURL(new RegExp(`/dashboard/profiles/${homeId}$`));
  await settled(page);
  expect(await remembered(page.context())).toBe(homeId);
  await expect(switcher(page)).toContainText("Home");
  await page.unroute(`**/dashboard/profiles/${shopId}`);

  // Opening it again through a link is a new choice.
  await page.getByRole("link", { name: "← All profiles" }).click();
  await page.getByTestId("profile-row").filter({ visible: true, hasText: "/active-shop" }).getByRole("link", { name: "Edit" }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/profiles/${shopId}$`));
  await expect.poll(() => remembered(page.context())).toBe(shopId);
});

test.describe("phone viewport", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the header shows the opened profile and fits", async ({ page }) => {
    await page.goto(`/dashboard/profiles/${shopId}`);
    await expect(switcher(page)).toContainText("Shop");
    await expect(analyticsLink(page)).toHaveAttribute("href", `/dashboard/profiles/${shopId}/analytics`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expectRemembered(page, shopId, "Shop");
  });
});
