import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Browser, Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * The focused profile editor shell: Profile/Content/Design sections,
 * desktop/tablet/phone layouts, 720 CSS px reflow, reduced motion, linked
 * editor/preview selection, the row controls (visibility, ⋯ menu, keyboard
 * moves), save failure and recovery, leaving through a menu link with unsaved
 * changes, and an axe check of each layout. Serial: steps build on each other.
 */
test.describe.configure({ mode: "serial" });

const OWNER = { name: "Fern Foundation", email: "foundation-editor@example.com", password: "foundation-password-123" };
const HANDLE = "foundationpage";
let signInCount = 0;
let editorUrl = "";

const axeSource = readFileSync(createRequire(`${process.cwd()}/package.json`).resolve("axe-core/axe.min.js"), "utf8");

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/setup");
  if (await page.locator("#token").count()) {
    await page.locator("#token").fill(process.env.E2E_SETUP_TOKEN!);
    await page.locator("#name").fill("Setup Owner");
    await page.locator("#email").fill("foundation-owner@example.com");
    await page.locator("#password").fill("correct-horse-battery");
    await page.locator("#confirm").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Create administrator" }).click();
    await expect(page.getByRole("status")).toContainText("ready");
  }
  // Through the API with its own client address, so this spec doesn't use up the other specs' sign-up allowance.
  const res = await page.request.post("/api/auth/sign-up/email", {
    data: { name: OWNER.name, email: OWNER.email, password: OWNER.password },
    headers: { origin: process.env.E2E_BASE_URL!, "x-forwarded-for": "198.51.102.250" },
  });
  expect(res.status()).toBe(200);
  await context.close();
});

test.beforeEach(async ({ page, baseURL }) => {
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: OWNER.email, password: OWNER.password },
    headers: { origin: baseURL!, "x-forwarded-for": `198.51.102.${++signInCount}` },
  });
  expect(res.status()).toBe(200);
});

async function openEditor(page: Page) {
  await page.goto(editorUrl);
  await page.locator("[data-hydrated]").waitFor();
}

const cards = (page: Page) => page.getByTestId("block-list").filter({ visible: true }).getByTestId("block-card");
const card = (page: Page, label: string) => cards(page).filter({ has: page.getByTestId("block-label").getByText(label, { exact: true }) });
const labels = (page: Page) => page.getByTestId("block-list").filter({ visible: true }).getByTestId("block-label").allTextContents();
const preview = (page: Page) => page.getByTestId("profile-preview").filter({ visible: true });
const status = (page: Page) => page.getByTestId("editor-status").filter({ visible: true });
const topStatus = (page: Page) => page.getByTestId("profile-status").filter({ visible: true });
const addButton = (page: Page, name: string) => page.getByRole("group", { name: "Add block" }).getByRole("button", { name, exact: true });

async function addLink(page: Page, title: string, url: string) {
  await addButton(page, "Link").click();
  const c = cards(page).last();
  await c.getByLabel("Title", { exact: true }).fill(title);
  await c.getByLabel("Web address").fill(url);
}

/** WCAG 2.2 A/AA axe violations on the visible page (the theme-rendered preview has its own contrast tests). */
async function axeViolations(page: Page, integrated = false) {
  await page.evaluate(axeSource); // through CDP, so the page's CSP doesn't apply to the injected checker
  return page.evaluate(async (integrated) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe;
    const r = await axe.run(integrated ? document : { exclude: [["[data-testid=profile-preview]"]] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  }, integrated);
}

async function smallTargets(page: Page, min: number) {
  return page.evaluate((min) => {
    const els = [...document.querySelectorAll<HTMLElement>("button, a[href], [role=switch], [role=tab], [role=combobox]")];
    return els
      .filter((e) => e.offsetParent !== null && !e.closest("[data-testid=profile-preview]") && !e.closest(".sr-only"))
      .map((e) => {
        const r = e.getBoundingClientRect();
        if (e.getAttribute("role") !== "switch") return { e, r };
        // A switch's hit area includes its ::after extension.
        const a = getComputedStyle(e, "::after");
        const grow = (v: string) => Math.max(0, -parseFloat(v) || 0);
        return { e, r: { width: r.width + grow(a.left) + grow(a.right), height: r.height + grow(a.top) + grow(a.bottom) } };
      })
      // Inline text links are exempt (WCAG 2.5.8); controls are not.
      .filter(({ e, r }) => r.width > 0 && (Math.round(r.height) < min || Math.round(r.width) < min) && !(e.tagName === "A" && getComputedStyle(e).display === "inline"))
      .map(({ e, r }) => `${(e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }, min);
}

async function expand(c: Locator) {
  const toggle = c.getByRole("button", { name: /^Edit / });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  else await toggle.focus(); // selects without collapsing
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("desktop: focused shell, three sections and save/publish states", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dashboard/profiles");
  await page.locator("#handle").fill(HANDLE);
  await page.locator("#label").fill("Foundation");
  await page.locator("#displayName").fill("Fern");
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page).toHaveURL(/\/dashboard\/profiles\/[0-9a-f-]{36}$/);
  editorUrl = page.url();
  await page.locator("[data-hydrated]").waitFor();

  // The quiet rail marks the section the editor belongs to.
  const rail = page.getByRole("navigation", { name: "Main" });
  await expect(rail.getByRole("link", { name: "Profiles" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Workspace menu" })).toBeHidden();

  await expect(page.getByRole("tablist", { name: "Editor sections" }).getByRole("tab")).toHaveText(["Profile", "Content", "Design"]);
  await expect(page.getByRole("tab", { name: "Content" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#header-form #displayName")).toBeHidden(); // identity lives in Profile
  await expect(topStatus(page)).toHaveText("Not published");
  await expect(page.getByRole("button", { name: "Save draft" })).toBeDisabled();

  await page.getByRole("tab", { name: "Profile" }).click();
  await page.locator("#header-form #bio").fill("Pots, mostly.");
  await expect(topStatus(page)).toHaveText("Unsaved changes");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(status(page)).toHaveText("Draft saved.");
  await expect(topStatus(page)).toHaveText("Not published");

  // Invalid header input switches to Profile, focuses the field and keeps Publish from running.
  await page.getByRole("tab", { name: "Content" }).click();
  await page.getByRole("tab", { name: "Profile" }).click();
  await page.locator("#header-form #displayName").fill("");
  await page.getByRole("tab", { name: "Design" }).click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("tab", { name: /Profile/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#header-form #displayName")).toBeFocused();
  await expect(topStatus(page)).toHaveText("Needs attention");
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeEnabled(); // an unfinished draft can still be saved
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  await expect(page.getByRole("alert").filter({ hasText: "Some profile details need attention" })).toContainText("Not published.");
  await page.locator("#header-form #displayName").fill("Fern");

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(status(page)).toContainText("Published. Your public page is up to date.");
  await expect(topStatus(page)).toHaveText("Published · up to date");
  await expect(page.getByRole("button", { name: "Published" })).toBeDisabled();

  expect(await axeViolations(page)).toEqual([]);
  expect(await smallTargets(page, 40)).toEqual([]);
});

test("linked selection, row visibility and the ⋯ menu", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEditor(page);
  await addLink(page, "Shop", "https://example.com/shop");
  await addLink(page, "Classes", "https://example.com/classes");
  await addLink(page, "Market", "https://example.com/market");

  // The block being edited is marked in the preview, and only that one.
  const marked = preview(page).locator(".pp-block[data-editor-selected]");
  await expect(marked).toHaveCount(1);
  await expect(marked).toContainText("Market");
  await expand(card(page, "Shop"));
  await expect(marked).toContainText("Shop");
  await expect(card(page, "Shop")).toHaveAttribute("data-selected", "true");
  await expect(card(page, "Shop").getByText("Editing", { exact: true })).toBeVisible(); // not colour alone

  // Focus alone selects (keyboard users get the same link).
  await card(page, "Classes").getByRole("button", { name: /^Edit / }).focus();
  await expect(marked).toContainText("Classes");

  // Visibility sits in the row with written state; hidden blocks leave the preview and are counted.
  await card(page, "Market").getByRole("switch", { name: "Show “Market” on page" }).click();
  await expect(card(page, "Market").getByTestId("block-hidden-badge")).toHaveText("Hidden");
  await expect(preview(page).locator(".pp-block")).toHaveCount(2);
  await expect(page.getByRole("complementary", { name: "Preview" })).toContainText("1 hidden block not shown");

  // ⋯ menu moves are announced; focus returns to the moved row's trigger.
  const trigger = card(page, "Market").getByRole("button", { name: "More actions for “Market”" });
  await trigger.click();
  await page.getByRole("menuitem", { name: "Move to top" }).click();
  expect(await labels(page)).toEqual(["Market", "Shop", "Classes"]);
  await expect(page.getByTestId("blocks-announcer").filter({ visible: true })).toHaveText("Moved “Market” to position 1 of 3.");
  await expect(trigger).toBeFocused();

  // Keyboard drag still works through the handle.
  const dndStatus = page.locator('[id^="DndLiveRegion"]');
  await card(page, "Classes").getByTestId("block-drag-handle").focus();
  await page.keyboard.press("Space");
  await expect(dndStatus).toHaveText("“Classes” is over position 3 of 3.");
  await page.keyboard.press("ArrowUp");
  await expect(dndStatus).toHaveText("“Classes” is over position 2 of 3.");
  await page.keyboard.press("Space");
  await expect(dndStatus).toHaveText("Dropped “Classes” at position 2 of 3.");
  await expect.poll(() => labels(page)).toEqual(["Market", "Classes", "Shop"]);

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(status(page)).toContainText("Draft saved");
  await expect(topStatus(page)).toHaveText("Unpublished changes");
});

test("a failed save keeps edits, says so, and recovers with Try again", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEditor(page);
  await page.getByRole("tab", { name: "Profile" }).click();
  await page.locator("#header-form #bio").fill("Saved after a network blip");

  // Server Actions POST to the page with a Next-Action header; drop them to simulate going offline.
  const offline = (route: Parameters<Parameters<Page["route"]>[1]>[0]) =>
    route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort("internetdisconnected") : route.continue();
  await page.route("**/dashboard/profiles/**", offline);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(topStatus(page)).toHaveText("Not saved");
  await expect(page.getByRole("alert").filter({ hasText: "your draft wasn't saved" })).toBeVisible();
  await expect(page.locator("#header-form #bio")).toHaveValue("Saved after a network blip");

  await page.unroute("**/dashboard/profiles/**", offline);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(status(page)).toContainText("Draft saved");
  await page.reload();
  await page.getByRole("tab", { name: "Profile" }).click();
  await expect(page.locator("#header-form #bio")).toHaveValue("Saved after a network blip");
});

test("tablet: no rail, Edit/Preview switch, 44 px targets", async ({ page }) => {
  await page.setViewportSize({ width: 834, height: 1112 });
  await openEditor(page);
  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Workspace menu" })).toBeVisible();
  await expect(preview(page)).toHaveCount(0);

  const views = page.getByRole("group", { name: "View" });
  await views.getByRole("button", { name: "Preview" }).click();
  await expect(views.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");
  await expect(preview(page)).toBeVisible();
  await expect(page.getByRole("tabpanel")).toBeHidden();
  await views.getByRole("button", { name: "Edit" }).click();
  await expect(cards(page)).toHaveCount(3);

  expect(await noOverflow(page)).toBe(true);
  expect(await smallTargets(page, 44)).toEqual([]);
  expect(await axeViolations(page)).toEqual([]);
});

test("720 CSS px reflow approximation gets the tablet layout without loss", async ({ page }) => {
  // Browser zoom shrinks the CSS viewport; the breakpoints are in rem, so the layout follows it.
  await page.setViewportSize({ width: 720, height: 450 });
  await openEditor(page);
  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
  await expect(page.getByRole("group", { name: "View" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save draft" })).toBeVisible();
  await expect(page.getByRole("button", { name: "More profile actions" })).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
  expect(await smallTargets(page, 44)).toEqual([]);
  expect(await axeViolations(page)).toEqual([]);
});

test("reduced motion: no spinner rotation or chevron transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEditor(page);
  const chevron = card(page, "Shop").locator("svg.lucide-chevron-down");
  expect(await chevron.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
  // The saving spinner keeps still; hold the save so the spinner is on screen.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/dashboard/profiles/**", async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) await held;
    await route.continue();
  });
  await page.getByRole("tab", { name: "Profile" }).click();
  await page.locator("#header-form #bio").fill("Saved with reduced motion");
  await page.getByRole("button", { name: "Save draft" }).click();
  const spinner = page.getByTestId("profile-status").filter({ visible: true }).locator("svg");
  await expect(page.getByTestId("profile-status").filter({ visible: true })).toHaveText("Saving draft…");
  expect(await spinner.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  release();
  await expect(status(page)).toContainText("Draft saved");
  await page.unrouteAll({ behavior: "wait" });
});

test("leaving through a link in a menu asks first, then still navigates", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEditor(page);
  await page.getByRole("tab", { name: "Profile" }).click();
  await page.locator("#header-form #bio").fill("Unsaved before the menu link");
  // The link sits in a menu that closes before the person answers, so it's no longer in the page.
  await page.getByRole("button", { name: "More profile actions" }).click();
  await page.getByRole("menuitem", { name: "Analytics and QR code" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Leave without saving?" });
  await expect(dialog).toBeVisible();
  await page.getByRole("button", { name: "Leave without saving" }).click();
  await expect(page).toHaveURL(/\/dashboard\/profiles\/[0-9a-f-]{36}\/analytics$/);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("bottom action bar, labelled Preview control and short attention marker", async ({ page }) => {
    await openEditor(page);
    const bar = page.getByRole("group", { name: "Save and publish" });
    await expect(bar.getByRole("button", { name: "Preview" })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Save draft" })).toBeVisible();
    const box = await bar.boundingBox();
    expect(Math.round(box!.y + box!.height)).toBe(844); // pinned to the bottom edge

    await bar.getByRole("button", { name: "Preview" }).click();
    await expect(preview(page)).toBeVisible();
    await expect(bar.getByRole("button", { name: "Edit" })).toBeVisible();
    await bar.getByRole("button", { name: "Edit" }).click();

    // Invalid block: on phones the marker is the icon, with its words for screen readers only.
    await expand(card(page, "Shop"));
    await card(page, "Shop").getByLabel("Web address").fill("not a url");
    await bar.getByRole("button", { name: /^Publish/ }).click(); // refused before anything is sent, so nothing is stored
    const marker = card(page, "Shop").getByText("Needs attention");
    await expect(marker).toHaveClass(/sr-only/);
    await expect(topStatus(page)).toHaveText("Needs attention");

    // A focused field alone (hardware keyboard) keeps the bar; a soft keyboard shrinking the viewport hides it.
    await card(page, "Shop").getByLabel("Web address").focus();
    await expect(bar).toBeVisible();
    const keyboard = (open: boolean) =>
      page.evaluate((open) => {
        const vv = window.visualViewport!;
        if (open) Object.defineProperty(vv, "height", { configurable: true, get: () => 420 });
        else delete (vv as unknown as Record<string, unknown>).height;
        vv.dispatchEvent(new Event("resize"));
      }, open);
    await keyboard(true);
    await expect(bar).toBeHidden();
    await keyboard(false);
    await expect(bar).toBeVisible();

    expect(await noOverflow(page)).toBe(true);
    expect(await smallTargets(page, 44)).toEqual([]);
    expect(await axeViolations(page)).toEqual([]);
    await page.setViewportSize({ width: 320, height: 640 });
    expect(await noOverflow(page)).toBe(true);
    expect(await smallTargets(page, 44)).toEqual([]);
    expect(await axeViolations(page)).toEqual([]);
  });
});


test("metadata-only navigation cancels intact and confirmed discard resets on return", async ({ page }) => {
  await openEditor(page);
  await page.getByRole("tab", { name: "Profile", exact: true }).click();
  const name = page.locator("#settings-label");
  const original = await name.inputValue();
  const handle = page.locator("#settings-handle");
  const originalHandle = await handle.inputValue();
  await handle.fill("unsavedhandle");
  await name.fill("Unsaved metadata");
  await page.getByRole("link", { name: "Back to profiles" }).click();
  await expect(page.getByRole("alertdialog", { name: "Leave without saving?" })).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(name).toHaveValue("Unsaved metadata");
  await expect(handle).toHaveValue("unsavedhandle");
  await page.getByRole("link", { name: "Back to profiles" }).click();
  await page.getByRole("button", { name: "Leave without saving", exact: true }).click();
  await expect(page).toHaveURL(/dashboard\/profiles$/);
  await page.goBack();
  await page.getByRole("tab", { name: "Profile", exact: true }).click();
  await expect(name).toHaveValue(original);
  await expect(handle).toHaveValue(originalHandle);
});

test("integrated editor and preview accessibility and selected collapsed semantics", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEditor(page);
  const row = card(page, "Shop");
  const toggle = row.getByRole("button", { name: /^Edit / });
  if (await toggle.getAttribute("aria-expanded") === "true") await toggle.click();
  await toggle.focus();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(row).toHaveAttribute("aria-current", "true");
  await expect(row).toHaveAccessibleDescription(/Selected block: Shop.*Matching block highlighted/);
  const target = await row.getAttribute("aria-details");
  await expect(page.locator(`[id="${target}"]`)).toContainText("Shop");
  expect(await axeViolations(page, true)).toEqual([]);
});

test("workspace sign-out asks, restores focus on cancel, and signs out after confirmation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEditor(page);
  await page.getByRole("tab", { name: "Profile", exact: true }).click();
  await page.locator("#settings-label").fill("Before sign out");
  await page.getByRole("button", { name: "Account menu" }).click();
  const signOut = page.getByRole("menuitem", { name: "Sign out", exact: true });
  await signOut.click();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(signOut).toBeFocused();
  await expect(page.locator("#settings-label")).toHaveValue("Before sign out");
  await signOut.click();
  await page.getByRole("button", { name: "Leave without saving", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});

for (const action of ["Save draft", "Publish changes"] as const) {
  test(`draft fields stay disabled during delayed ${action}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openEditor(page);
    await page.getByRole("tab", { name: "Profile", exact: true }).click();
    await page.locator("#bio").fill(`Delayed ${action}`);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/dashboard/profiles/**", async (route) => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"]) await held;
      await route.continue();
    });
    try {
      await page.getByRole("button", { name: action, exact: true }).click();
      for (const id of ["displayName", "bio", "seoTitle", "seoDescription", "noindex"]) {
        await expect(page.locator(`#${id}`)).toBeDisabled();
      }
    } finally { release(); }
    await expect(status(page)).toContainText(action === "Save draft" ? "Draft saved" : "Published.");
    await page.unrouteAll({ behavior: "wait" });
    await expect(page.locator("#bio")).toHaveValue(`Delayed ${action}`);
  });
}

test("failed discard and unpublish have recovery; successful unpublish remains visible with draft edits", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEditor(page);
  await page.getByRole("tab", { name: "Profile", exact: true }).click();
  await page.locator("#bio").fill("Keep these unrelated draft edits");
  const offline = (route: Parameters<Parameters<Page["route"]>[1]>[0]) =>
    route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort("internetdisconnected") : route.continue();
  await page.route("**/dashboard/profiles/**", offline);
  await page.getByRole("button", { name: "More profile actions" }).click();
  await page.getByRole("menuitem", { name: "Discard draft changes" }).click();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(topStatus(page)).toHaveText("Discard failed");
  await expect(page.getByRole("alert").filter({ hasText: "Couldn't confirm whether Discard completed" })).toContainText("reload the latest version before retrying");
  await page.getByRole("button", { name: "More profile actions" }).click();
  await page.getByRole("menuitem", { name: "Unpublish", exact: true }).click();
  await expect(topStatus(page)).toHaveText("Unpublish failed");
  await expect(page.getByRole("alert").filter({ hasText: "Couldn't confirm whether Unpublish completed" })).toContainText("public page");
  await page.unroute("**/dashboard/profiles/**", offline);
  await page.getByRole("button", { name: "More profile actions" }).click();
  await page.getByRole("menuitem", { name: "Unpublish", exact: true }).click();
  await expect(status(page)).toContainText("Unpublished. Your public page is no longer available.");
  await expect(page.locator("#bio")).toHaveValue("Keep these unrelated draft edits");
  await expect(topStatus(page)).toHaveText("Unsaved changes");
});

test("invalid content keeps Publish blocked, and Save available, through a failed and a successful Unpublish", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEditor(page);
  const save = page.getByRole("button", { name: "Save draft", exact: true });
  const publish = page.getByRole("button", { name: /^Publish( changes)?$/ });
  if ((await topStatus(page).textContent()) !== "Published · up to date") {
    await publish.click();
    await expect(topStatus(page)).toHaveText("Published · up to date");
  }

  await page.getByRole("tab", { name: "Profile", exact: true }).click();
  await page.locator("#header-form #displayName").fill("");
  await publish.click();
  await expect(topStatus(page)).toHaveText("Needs attention");
  await expect(save).toBeEnabled();
  await expect(publish).toBeDisabled();

  const offline = (route: Parameters<Parameters<Page["route"]>[1]>[0]) =>
    route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort("internetdisconnected") : route.continue();
  await page.route("**/dashboard/profiles/**", offline);
  await page.getByRole("button", { name: "More profile actions" }).click();
  await page.getByRole("menuitem", { name: "Unpublish", exact: true }).click();
  await expect(topStatus(page)).toHaveText("Unpublish failed");
  await expect(save).toBeEnabled();
  await expect(publish).toBeDisabled();
  await page.unroute("**/dashboard/profiles/**", offline);

  await page.getByRole("button", { name: "More profile actions" }).click();
  await page.getByRole("menuitem", { name: "Unpublish", exact: true }).click();
  await expect(status(page)).toContainText("Unpublished. Your public page is no longer available.");
  await expect(topStatus(page)).toHaveText("Needs attention");
  await expect(page.getByRole("alert").filter({ hasText: "Some profile details need attention" })).toContainText("Not published.");
  await expect(save).toBeEnabled();
  await expect(publish).toBeDisabled();

  // Changing the content lifts the block on Publish (a new name, so there is something to save).
  await page.locator("#header-form #displayName").fill("Fern Studio");
  await expect(save).toBeEnabled();
  await expect(publish).toBeEnabled();
  await save.click();
  await expect(status(page)).toHaveText("Draft saved.");
});
