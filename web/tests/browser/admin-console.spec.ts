import type { Browser, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * Browser workflows for the administration console: denial for ordinary
 * users, the super administrator promoting an administrator, an
 * administrator disabling and re-enabling an account (confirmation, cancel,
 * focus restoration, announcements), settings (validation, read-only security
 * settings, the invite-only confirmation and its live effect), keyboard use
 * with the skip link, phone width (pages and the confirmation dialogs' touch
 * targets, destructive contrast and focus restoration), and loading, empty
 * and error states.
 * Serial: steps build on each other. Every test also fails on CSP violations
 * or page errors (fixtures.ts).
 */
test.describe.configure({ mode: "serial" });

const OWNER = { name: "Owner Person", email: "owner@example.com", password: "correct-horse-battery" };
const ADMIN = { name: "Ada Console", email: "admin-admin@example.com", password: "admin-admin-password-1" };
const TARGET = { name: "Toby Target", email: "admin-target@example.com", password: "admin-target-password-1" };
let ip = 0;
const nextIp = () => `198.51.110.${++ip}`;

async function signIn(page: Page, baseURL: string, who: { email: string; password: string }) {
  await page.context().clearCookies();
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: who.email, password: who.password },
    headers: { origin: baseURL, "x-forwarded-for": nextIp() },
  });
  expect(res.status()).toBe(200);
}

test.beforeAll(async ({ browser, baseURL }: { browser: Browser; baseURL?: string }) => {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.111.1" } });
  const page = await context.newPage();
  await page.goto("/setup");
  if (await page.locator("#token").count()) {
    await page.locator("#token").fill(process.env.E2E_SETUP_TOKEN!);
    await page.locator("#name").fill(OWNER.name);
    await page.locator("#email").fill(OWNER.email);
    await page.locator("#password").fill(OWNER.password);
    await page.locator("#confirm").fill(OWNER.password);
    await page.getByRole("button", { name: "Create administrator" }).click();
    await expect(page.getByRole("status")).toContainText("ready");
  }
  for (const who of [ADMIN, TARGET]) {
    const res = await page.request.post("/api/auth/sign-up/email", {
      data: { name: who.name, email: who.email, password: who.password },
      headers: { origin: baseURL!, "x-forwarded-for": nextIp() },
    });
    expect(res.status()).toBe(200);
  }
  await context.close();
});

const openAccount = async (page: Page, name: string) => {
  await page.goto("/admin/users");
  await page.getByLabel("Name or email").fill(name);
  await page.getByLabel("Name or email").press("Enter");
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await page.locator("[data-testid=no-actions], section[aria-labelledby=actions-heading] button").first().waitFor();
};

test("ordinary users are denied the admin area and see no admin link", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, TARGET);
  await page.goto("/admin/users");
  await expect(page).toHaveURL(/\/dashboard\?denied=1$/);
  await expect(page.getByText("You don't have access to that page.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Administration" })).toHaveCount(0);
});

test("the super administrator promotes an account after confirming; the result is announced and focused", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, OWNER);
  await openAccount(page, ADMIN.name);
  const promote = page.getByRole("button", { name: "Make administrator" });
  await promote.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(`Make ${ADMIN.name} administrator?`);
  await dialog.getByRole("button", { name: "Change role" }).click();
  const status = page.getByTestId("action-status");
  await expect(status).toHaveText(`${ADMIN.name} is now administrator.`);
  await expect(status).toBeFocused();
  await expect(page.getByTestId("detail-role")).toHaveText("Administrator");
  await expect(page.getByRole("button", { name: "Remove administrator role" })).toBeVisible();
});

test("an administrator disables and re-enables an account; cancel changes nothing and restores focus", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, ADMIN);
  // Administrators can't act on the super administrator.
  await openAccount(page, OWNER.name);
  await expect(page.getByTestId("no-actions")).toBeVisible();

  await openAccount(page, TARGET.name);
  const disable = page.getByRole("button", { name: "Disable account" });
  await disable.click();
  await expect(page.getByRole("alertdialog")).toContainText("signed out everywhere");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(disable).toBeFocused();
  await expect(page.getByTestId("detail-status")).toHaveText("Active");

  await disable.click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Disable" }).click();
  await expect(page.getByTestId("action-status")).toHaveText(`${TARGET.name}'s account is disabled and signed out everywhere.`);
  await expect(page.getByTestId("action-status")).toBeFocused();
  await expect(page.getByTestId("detail-status")).toHaveText("Disabled");

  const enable = page.getByRole("button", { name: "Re-enable account" });
  await enable.click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Re-enable" }).click();
  await expect(page.getByTestId("action-status")).toContainText("enabled again");
  await expect(page.getByTestId("detail-status")).toHaveText("Active");

  await page.getByRole("link", { name: "Audit entries for this account" }).click();
  const rows = page.getByTestId("audit-row");
  await expect(rows.first()).toContainText("Account re-enabled");
  await expect(page.getByTestId("audit-table")).toContainText("Account disabled");
});

test("settings: validation, read-only security settings for administrators, and a saved change", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, ADMIN);
  await page.goto("/admin/settings");
  const inviteOnly = page.getByTestId("setting-registration.inviteOnly");
  await expect(inviteOnly.getByRole("switch")).toBeDisabled();
  await expect(inviteOnly.getByRole("button", { name: "Save" })).toHaveCount(0);

  const site = page.getByTestId("setting-site.name");
  const input = site.getByRole("textbox");
  await input.fill("   ");
  await site.getByRole("button", { name: "Save" }).click();
  await expect(site.getByText("This can't be empty.")).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-invalid", "true");

  const limit = page.getByTestId("setting-profiles.maxPerUser");
  await limit.getByRole("textbox").fill("101");
  await limit.getByRole("button", { name: "Save" }).click();
  await expect(limit.getByText("Enter a number from 1 to 100.")).toBeVisible();

  await input.fill("Admin Console Links");
  await site.getByRole("button", { name: "Save" }).click();
  await expect(site.getByRole("status")).toHaveText("Site name saved.");
  await expect(site.getByRole("status")).toBeFocused();
  await expect(site.getByRole("button", { name: "Save" })).toBeDisabled(); // nothing left to save
  await page.reload();
  await expect(page.getByTestId("setting-site.name").getByRole("textbox")).toHaveValue("Admin Console Links");
});

test("invite-only: the super administrator must confirm, and registration closes at once", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, OWNER);
  await page.goto("/admin/settings");
  const inviteOnly = page.getByTestId("setting-registration.inviteOnly");
  await expect(inviteOnly).toContainText("closes registration completely");
  await inviteOnly.getByRole("switch").click();
  const save = inviteOnly.getByRole("button", { name: "Save" });
  await save.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Close registration completely?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(save).toBeFocused();
  await save.click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Turn on invite-only" }).click();
  await expect(inviteOnly.getByRole("status")).toHaveText("Invite-only registration saved.");

  const blocked = await page.request.post("/api/auth/sign-up/email", {
    data: { name: "Late", email: "admin-late@example.com", password: "late-password-123" },
    headers: { origin: baseURL!, "x-forwarded-for": nextIp() },
  });
  expect(blocked.status()).not.toBe(200);

  // Turning it off needs no confirmation.
  await inviteOnly.getByRole("switch").click();
  await inviteOnly.getByRole("button", { name: "Save" }).click();
  await expect(inviteOnly.getByRole("status")).toHaveText("Invite-only registration saved.");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("keyboard: the skip link leads to the main content, and the section navigation marks the current page", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, ADMIN);
  await page.goto("/admin/audit");
  // The skip link is part of the streamed content (the Suspense fallback has none),
  // which React may reveal just after the load event; wait for it before tabbing.
  await expect(page.getByLabel("Event")).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Event")).toBeFocused();
  const nav = page.getByRole("navigation", { name: "Administration" });
  await expect(nav.getByRole("link", { name: "Audit log" })).toHaveAttribute("aria-current", "page");
  await nav.getByRole("link", { name: "Users" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/users$/);
});

test("loading, empty and error states", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, ADMIN);
  expect(await (await page.request.get("/admin/users")).text()).toContain('data-testid="admin-loading"');
  await page.goto("/admin/users?q=zz-no-such-account");
  await expect(page.getByTestId("users-empty")).toContainText("No accounts match.");
  await page.goto("/admin/audit?from=2020-01-01&to=2020-01-02");
  await expect(page.getByTestId("audit-empty")).toBeVisible();
  await page.goto("/admin/audit?from=2026-03-02&to=2026-03-01");
  await expect(page.getByTestId("admin-error")).toContainText("The start date must be on or before the end date");
  await expect(page.getByTestId("admin-error")).toHaveAttribute("role", "alert");
});

test("phone width: no page overflow, and 44 px primary targets", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, OWNER);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/users");
  const target = await page.getByRole("link", { name: TARGET.name, exact: true }).getAttribute("href");
  for (const path of ["/admin", "/admin/users", target!, "/admin/settings", "/admin/audit"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), path).toBeLessThanOrEqual(0);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll("nav[aria-label=Administration] a, main button, main select, main input:not([type=hidden]):not([aria-hidden=true])")]
        .filter((el) => (el as HTMLElement).offsetParent !== null && el.getAttribute("role") !== "switch")
        .map((el) => [el.textContent?.trim() || el.getAttribute("name") || el.tagName, Math.round(el.getBoundingClientRect().height)] as const)
        .filter(([, h]) => h < 44),
    );
    expect(small, path).toEqual([]);
  }
  // The switch's own hit area (its ::after) is at least 44 px tall.
  await page.goto("/admin/settings");
  const hit = await page.getByTestId("setting-registration.enabled").getByRole("switch").evaluate((el) => {
    const r = el.getBoundingClientRect();
    const after = getComputedStyle(el, "::after");
    return r.height - parseFloat(after.top) - parseFloat(after.bottom);
  });
  expect(hit).toBeGreaterThanOrEqual(44);
});

/** Layout heights (unaffected by the open animation's scale) of every visible button in the open dialog. */
const dialogButtonHeights = (page: Page) =>
  page
    .getByRole("alertdialog")
    .evaluate((d) => [...d.querySelectorAll("button")].filter((b) => b.getClientRects().length > 0).map((b) => [b.textContent!.trim(), b.offsetHeight] as const));

/**
 * Rendered text contrast of `name` in the open dialog: its color against its
 * own and its ancestors' backgrounds composited (the footer is translucent),
 * each color resolved to sRGB by a canvas.
 */
const dialogButtonContrast = (page: Page, name: string) =>
  page
    .getByRole("alertdialog")
    .getByRole("button", { name })
    .evaluate((el) => {
      const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true })!;
      const rgba = (color: string) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        return [r, g, b, a / 255] as const;
      };
      const layers: (readonly [number, number, number, number])[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = rgba(getComputedStyle(n).backgroundColor);
        if (c[3] > 0) layers.unshift(c);
        if (c[3] === 1) break;
      }
      const over = (top: readonly [number, number, number, number], base: number[]) => base.map((v, i) => top[i] * top[3] + v * (1 - top[3]));
      const bg = layers.reduce<number[]>((base, layer) => over(layer, base), [255, 255, 255]);
      const fg = over(rgba(getComputedStyle(el).color), bg);
      const lum = (c: number[]) =>
        c.map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      return (hi + 0.05) / (lo + 0.05);
    });

test("phone width: confirmation dialogs have 44 px buttons, readable destructive actions, and cancel restores focus", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, OWNER);
  await page.setViewportSize({ width: 390, height: 844 });
  await openAccount(page, TARGET.name);
  const dialog = page.getByRole("alertdialog");
  // Buttons transition their colors: measure only once every transition in the dialog has finished.
  const settle = () => dialog.evaluate((d) => Promise.all(d.getAnimations({ subtree: true }).map((a) => a.finished)).then(() => undefined));
  const contrastBothThemes = async (name: string) => {
    await page.mouse.move(0, 0); // no hover tint
    await settle();
    const light = await dialogButtonContrast(page, name);
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await settle();
    const dark = await dialogButtonContrast(page, name);
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await settle();
    console.log(`[admin contrast] ${name}: light ${light.toFixed(2)}:1, dark ${dark.toFixed(2)}:1`); // recorded in the run log
    return { light, dark };
  };

  for (const [opener, action] of [
    ["Disable account", "Disable"],
    ["Make administrator", "Change role"],
  ] as const) {
    const button = page.getByRole("button", { name: opener });
    await button.click();
    await expect(dialog).toBeVisible();
    const heights = await dialogButtonHeights(page);
    expect(heights.map(([n]) => n).sort(), opener).toEqual(["Cancel", action].sort());
    for (const [n, h] of heights) expect(h, `${opener}: ${n}`).toBeGreaterThanOrEqual(44);
    if (action === "Disable") {
      const { light, dark } = await contrastBothThemes(action);
      expect(light, "Disable (light)").toBeGreaterThanOrEqual(4.5);
      expect(dark, "Disable (dark)").toBeGreaterThanOrEqual(4.5);
    }
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused();
  }
  await expect(page.getByTestId("detail-status")).toHaveText("Active");
  await expect(page.getByTestId("detail-role")).toHaveText("User");

  await page.goto("/admin/settings");
  const inviteOnly = page.getByTestId("setting-registration.inviteOnly");
  await inviteOnly.getByRole("switch").click();
  const save = inviteOnly.getByRole("button", { name: "Save" });
  await save.click();
  await expect(dialog).toContainText("Close registration completely?");
  const heights = await dialogButtonHeights(page);
  expect(heights.map(([n]) => n).sort()).toEqual(["Cancel", "Turn on invite-only"]);
  for (const [n, h] of heights) expect(h, n).toBeGreaterThanOrEqual(44);
  const { light, dark } = await contrastBothThemes("Turn on invite-only");
  expect(light, "Turn on invite-only (light)").toBeGreaterThanOrEqual(4.5);
  expect(dark, "Turn on invite-only (dark)").toBeGreaterThanOrEqual(4.5);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(save).toBeFocused();
  // Nothing was saved.
  await page.reload();
  await expect(page.getByTestId("setting-registration.inviteOnly").getByRole("switch")).toHaveAttribute("aria-checked", "false");
});
