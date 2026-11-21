import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { contrastRatio } from "../../src/features/themes/contrast";
import { expect, test } from "./fixtures";

/**
 * The dashboard light/dark choice: set from the account menu, kept in a cookie,
 * applied on the server's first paint, confined to the dashboard and
 * administration routes (no leak onto sign-in or public pages, no effect on the
 * profile preview), following the operating system while "System" is chosen,
 * and meeting the contrast targets in both modes. Serial: the first test
 * creates the published profile the others use.
 */
test.describe.configure({ mode: "serial" });

const OWNER = { name: "Owner Person", email: "owner@example.com", password: "correct-horse-battery" };
const MEMBER = { name: "Moss Mode", email: "color-mode@example.com", password: "color-mode-password-1" };
const HANDLE = "colormodepage";
const COOKIE = "covalink_color_mode";
const TOKENS = [
  "canvas", "surface", "inset", "ink", "ink-2", "line", "line-strong", "accent", "accent-ink",
  "danger", "danger-wash", "warn", "warn-wash", "ok", "ok-wash",
].map((t) => `--cl-${t}`);
let ip = 0;
const nextIp = () => `198.51.141.${++ip}`;
let profileUrl = "";

const axeSource = readFileSync(createRequire(`${process.cwd()}/package.json`).resolve("axe-core/axe.min.js"), "utf8");

test.beforeAll(async ({ browser, baseURL }: { browser: Browser; baseURL?: string }) => {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.141.250" } });
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
  const res = await page.request.post("/api/auth/sign-up/email", {
    data: { name: MEMBER.name, email: MEMBER.email, password: MEMBER.password },
    headers: { origin: baseURL!, "x-forwarded-for": nextIp() },
  });
  expect(res.status()).toBe(200);
  await context.close();
});

async function signIn(page: Page, baseURL: string, who: { email: string; password: string } = MEMBER) {
  await page.context().clearCookies();
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: who.email, password: who.password },
    headers: { origin: baseURL, "x-forwarded-for": nextIp() },
  });
  expect(res.status()).toBe(200);
}

const setMode = (context: BrowserContext, baseURL: string, value: "light" | "dark") =>
  context.addCookies([{ name: COOKIE, value, url: baseURL }]);
const modeCookie = async (context: BrowserContext) => (await context.cookies()).find((c) => c.name === COOKIE);

const scope = (page: Page) => page.locator(".cl-scope").first();
const waitHydrated = (page: Page) => page.locator("[data-hydrated]").waitFor();

/** Any CSS color to sRGB 8-bit, resolved by a canvas (computed values may be oklch). */
const rgba = (page: Page, css: string) =>
  page.evaluate((css) => {
    const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true })!;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255] as const;
  }, css);
const hex = ([r, g, b]: readonly number[]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const bg = (loc: Locator) => loc.evaluate((el) => getComputedStyle(el).backgroundColor);

/** The page's own colour for a locator's background: [r, g, b, a]. */
async function background(page: Page, loc: Locator) {
  return rgba(page, await bg(loc));
}
const isDark = ([r, g, b]: readonly number[]) => Math.max(r, g, b) < 60;
const isLight = ([r, g, b]: readonly number[]) => Math.min(r, g, b) > 220;

const tokens = (page: Page) =>
  scope(page).evaluate((el, names) => {
    const cs = getComputedStyle(el);
    return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
  }, TOKENS);

const htmlMode = (page: Page) => page.evaluate(() => document.documentElement.getAttribute("data-color-mode"));

const themeMenu = (page: Page, button: "Account menu" | "Workspace menu") => ({
  open: () => page.getByRole("button", { name: button }).click(),
  radio: (name: string) => page.getByRole("menuitemradio", { name, exact: true }),
});

/** Axe WCAG 2.2 A/AA violations on the visible page, optionally leaving out the profile preview. */
async function axeViolations(page: Page, excludePreview = false) {
  await page.evaluate(axeSource); // through CDP, so the page's CSP doesn't apply to the injected checker
  return page.evaluate(async (excludePreview) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[]; html: string; any: { message: string }[] }[] }[] }> } }).axe;
    const ctx = excludePreview ? { exclude: [["[data-testid=profile-preview]"]] } : document;
    const r = await axe.run(ctx, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
    return r.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(" ")} ${n.html.slice(0, 140)} (${n.any.map((a) => a.message).join("; ")})`).join(", ")}`,
    );
  }, excludePreview);
}

test("a published profile exists for the color mode checks", async ({ page, baseURL }) => {
  await signIn(page, baseURL!);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dashboard/profiles");
  await page.locator("#handle").fill(HANDLE);
  await page.locator("#label").fill("Color mode");
  await page.locator("#displayName").fill("Moss");
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page).toHaveURL(/\/dashboard\/profiles\/[0-9a-f-]{36}$/);
  profileUrl = page.url();
  await waitHydrated(page);
  await page.getByRole("group", { name: "Add block" }).getByRole("button", { name: "Link", exact: true }).click();
  const card = page.getByTestId("block-list").filter({ visible: true }).getByTestId("block-card").last();
  await card.getByLabel("Title", { exact: true }).fill("Shop");
  await card.getByLabel("Web address").fill("https://example.com/shop");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("profile-status").filter({ visible: true })).toHaveText("Published · up to date");
});

test("desktop: Dark from the account menu persists across reload, and System removes the cookie", async ({ page, baseURL, context }) => {
  await signIn(page, baseURL!);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/dashboard");
  await expect(scope(page)).toHaveAttribute("data-color-mode", "system");
  const lightCanvas = await background(page, scope(page));
  expect(isLight(lightCanvas)).toBe(true);

  const menu = themeMenu(page, "Account menu");
  await menu.open();
  await expect(page.getByRole("group", { name: "Dashboard theme" })).toBeVisible();
  await expect(menu.radio("System")).toHaveAttribute("aria-checked", "true");
  await menu.radio("Dark").click();
  await expect(scope(page)).toHaveAttribute("data-color-mode", "dark");
  await expect(menu.radio("Dark")).toHaveAttribute("aria-checked", "true"); // the menu stays open
  await expect(menu.radio("System")).toHaveAttribute("aria-checked", "false");
  expect(isDark(await background(page, scope(page)))).toBe(true);
  expect(await htmlMode(page)).toBe("dark");

  const cookie = await modeCookie(context);
  expect(cookie).toMatchObject({ value: "dark", httpOnly: true, sameSite: "Lax", path: "/" });
  expect(cookie!.expires - Date.now() / 1000).toBeGreaterThan(60 * 60 * 24 * 360);
  expect(cookie!.expires - Date.now() / 1000).toBeLessThanOrEqual(60 * 60 * 24 * 366);

  await page.keyboard.press("Escape");
  await page.reload();
  await expect(scope(page)).toHaveAttribute("data-color-mode", "dark");
  expect(isDark(await background(page, scope(page)))).toBe(true);
  await menu.open();
  await expect(menu.radio("Dark")).toHaveAttribute("aria-checked", "true");

  await menu.radio("Light").click();
  await expect(scope(page)).toHaveAttribute("data-color-mode", "light");
  await expect(menu.radio("Light")).toHaveAttribute("aria-checked", "true");
  expect((await modeCookie(context))?.value).toBe("light");

  await menu.radio("System").click();
  await expect(scope(page)).toHaveAttribute("data-color-mode", "system");
  await expect(menu.radio("System")).toHaveAttribute("aria-checked", "true");
  expect(await modeCookie(context)).toBeUndefined();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(scope(page)).toHaveAttribute("data-color-mode", "system");
  expect(await modeCookie(context)).toBeUndefined();
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("Dark from the workspace menu persists across reload, with 44 px choices", async ({ page, baseURL, context }) => {
    await signIn(page, baseURL!);
    await page.goto("/dashboard");
    const menu = themeMenu(page, "Workspace menu");
    await menu.open();
    for (const name of ["System", "Light", "Dark"]) {
      // Layout height: the menu's open animation scales its bounding box.
      const height = await menu.radio(name).evaluate((el) => (el as HTMLElement).offsetHeight);
      expect(height, `${name} choice height`).toBeGreaterThanOrEqual(44);
    }
    await menu.radio("Dark").click();
    await expect(scope(page)).toHaveAttribute("data-color-mode", "dark");
    await expect(menu.radio("Dark")).toHaveAttribute("aria-checked", "true");
    expect((await modeCookie(context))?.value).toBe("dark");

    await page.keyboard.press("Escape");
    await page.reload();
    await expect(scope(page)).toHaveAttribute("data-color-mode", "dark");
    await menu.open();
    await expect(menu.radio("Dark")).toHaveAttribute("aria-checked", "true");

    await menu.radio("System").click();
    await expect(scope(page)).toHaveAttribute("data-color-mode", "system");
    expect(await modeCookie(context)).toBeUndefined();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test("the theme changes without a full page load and keeps unsaved editor changes", async ({ page, baseURL }) => {
  await signIn(page, baseURL!);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(profileUrl);
  await waitHydrated(page);
  await page.getByRole("tab", { name: "Profile", exact: true }).click();
  await page.locator("#header-form #bio").fill("Typed but not saved");
  await expect(page.getByTestId("profile-status").filter({ visible: true })).toHaveText("Unsaved changes");
  await page.evaluate(() => ((window as unknown as { __kept: number }).__kept = 7));

  const menu = themeMenu(page, "Account menu");
  await menu.open();
  await menu.radio("Dark").click();
  await expect(scope(page)).toHaveAttribute("data-color-mode", "dark");
  await menu.radio("Light").click();
  await expect(scope(page)).toHaveAttribute("data-color-mode", "light");
  await menu.radio("Dark").click();
  await expect(scope(page)).toHaveAttribute("data-color-mode", "dark");
  await page.keyboard.press("Escape");

  expect(await page.evaluate(() => (window as unknown as { __kept?: number }).__kept), "the document was not reloaded").toBe(7);
  await expect(page.locator("#header-form #bio")).toHaveValue("Typed but not saved");
  await expect(page.getByTestId("profile-status").filter({ visible: true })).toHaveText("Unsaved changes");
  // No navigation prompt either: the edit is still there, but leaving is the person's choice.
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("the dark theme is on the server's first paint, before any script runs", async ({ page, baseURL, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" }); // the explicit choice beats the operating system
  await page.route("**/_next/static/**/*.js", (route) => route.abort());
  // The owner reaches /admin; the member owns the profile.
  for (const [path, who] of [["/dashboard", MEMBER], ["/admin", OWNER], [profileUrl, MEMBER]] as const) {
    await signIn(page, baseURL!, who);
    await setMode(context, baseURL!, "dark");
    await page.goto(path, { waitUntil: "domcontentloaded" });
    const el = scope(page);
    await expect(el, path).toHaveAttribute("data-color-mode", "dark");
    expect(isDark(await background(page, el)), `${path} canvas`).toBe(true);
    // <html> only gets the attribute from the client component; with no scripts it has none.
    expect(await htmlMode(page), `${path} <html>`).toBeNull();
    expect(await page.evaluate(() => document.querySelector("[data-hydrated]") !== null)).toBe(false);
  }
  await page.unroute("**/_next/static/**/*.js");
});

test("every element on a dashboard page is inside the color scope, on load and after client navigation", async ({ page, baseURL, context }) => {
  await signIn(page, baseURL!);
  await setMode(context, baseURL!, "dark");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const seen = new Set<Element>();
    (window as unknown as { __added: Set<Element> }).__added = seen;
    const note = (n: Node) => {
      if (n.nodeType !== 1) return;
      const e = n as Element;
      seen.add(e);
      e.querySelectorAll("*").forEach((c) => seen.add(c));
    };
    new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach(note))).observe(document, { childList: true, subtree: true });
  });
  /** Visible elements under <body> (added at any point, or present now) that sit outside every `.cl-scope`. */
  const escaped = () =>
    page.evaluate(() => {
      const added = (window as unknown as { __added: Set<Element> }).__added;
      const everything = new Set<Element>([...added, ...document.body.querySelectorAll("*")]);
      const inert = new Set(["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "NOSCRIPT", "TITLE", "HEAD"]);
      return [...everything]
        .filter((e) => e.isConnected && document.body.contains(e) && e !== document.body && !e.closest(".cl-scope"))
        .filter((e) => !inert.has(e.tagName) && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden")
        // Next.js' route announcer is an accessibility live region it appends to <body>, not page content.
        .filter((e) => !e.closest("next-route-announcer") && e.tagName !== "NEXT-ROUTE-ANNOUNCER")
        .map((e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}${e.className && typeof e.className === "string" ? `.${e.className.split(" ").join(".")}` : ""}`);
    });

  await page.goto("/dashboard");
  await expect(scope(page)).toHaveAttribute("data-color-mode", "dark");
  expect(await escaped(), "after a full load").toEqual([]);

  // The sidebar stays on every destination; Account settings swaps in its own, which is last.
  for (const [link, sidebar] of [["Profiles", "Main"], ["Analytics", "Main"], ["Account", "Account settings"]]) {
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: link, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(link === "Profiles" ? "/dashboard/profiles$" : link === "Analytics" ? "/analytics$" : "/dashboard/account$"));
    const nav = page.getByRole("navigation", { name: sidebar });
    await expect(nav).toBeVisible();
    // Exactly one place is marked current: the Profiles item itself, the analytics profile under Analytics, or the first account section.
    await expect(nav.locator("[aria-current]")).toHaveCount(1);
    if (link === "Profiles") await expect(nav.getByRole("link", { name: "Profiles", exact: true })).toHaveAttribute("aria-current", "page");
    if (link === "Analytics") {
      await expect(nav.getByRole("link", { name: "Analytics", exact: true })).not.toHaveAttribute("aria-current");
      await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    }
    if (link === "Account") await expect(nav.getByRole("link", { name: "Personal" })).toHaveAttribute("aria-current", "location");
    await expect(scope(page)).toHaveAttribute("data-color-mode", "dark");
    expect(await page.evaluate(() => performance.getEntriesByType("navigation").length), "still one document").toBe(1);
    expect(await escaped(), `after navigating to ${link}`).toEqual([]);
  }
  // A menu opened on the way is a portal into <body>, covered by the mode on <html>.
  await themeMenu(page, "Account menu").open();
  expect(await htmlMode(page)).toBe("dark");
  expect(isDark(await background(page, page.getByRole("menu")))).toBe(true);
});

test("System follows the operating system, with the same colors as an explicit choice", async ({ page, baseURL, context }) => {
  await signIn(page, baseURL!);
  await page.setViewportSize({ width: 1440, height: 900 });
  const read = async (scheme: "light" | "dark") => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/dashboard");
    await expect.poll(() => htmlMode(page), "<html> mirrors the mode once hydrated").not.toBeNull();
    return { t: await tokens(page), canvas: await background(page, scope(page)), mode: await scope(page).getAttribute("data-color-mode"), html: await htmlMode(page) };
  };

  const systemDark = await read("dark");
  expect(systemDark.mode).toBe("system");
  expect(systemDark.html).toBe("system");
  expect(isDark(systemDark.canvas)).toBe(true);
  const systemLight = await read("light");
  expect(isLight(systemLight.canvas)).toBe(true);

  await setMode(context, baseURL!, "dark");
  const explicitDark = await read("light"); // OS says light; the choice wins
  expect(explicitDark.mode).toBe("dark");
  expect(isDark(explicitDark.canvas)).toBe(true);
  await setMode(context, baseURL!, "light");
  const explicitLight = await read("dark"); // OS says dark; the choice wins
  expect(explicitLight.mode).toBe("light");
  expect(isLight(explicitLight.canvas)).toBe(true);

  expect(systemDark.t, "System + dark equals Dark").toEqual(explicitDark.t);
  expect(systemLight.t, "System + light equals Light").toEqual(explicitLight.t);
  for (const name of ["--cl-canvas", "--cl-surface", "--cl-ink", "--cl-accent", "--cl-accent-ink"]) {
    expect(systemDark.t[name], name).not.toBe(systemLight.t[name]);
  }
  for (const [name, value] of Object.entries({ ...systemDark.t, ...systemLight.t })) expect(value, name).not.toBe("");
});

test("menus, dialogs and the profile switcher popup follow the dark theme", async ({ page, baseURL, context }) => {
  await signIn(page, baseURL!);
  await setMode(context, baseURL!, "dark");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });

  await page.goto("/dashboard/account");
  await themeMenu(page, "Account menu").open();
  const menu = page.getByRole("menu");
  expect(isDark(await background(page, menu)), "account menu").toBe(true);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Delete account…" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  expect(isDark(await background(page, dialog)), "alert dialog").toBe(true);
  const overlay = await background(page, page.locator("[data-slot=alert-dialog-overlay]"));
  expect(isDark(overlay) && overlay[3] >= 0.5, `overlay ${overlay.join(",")}`).toBe(true);
  expect(await dialog.evaluate((el) => getComputedStyle(el).color)).not.toBe("");
  const text = await rgba(page, await dialog.evaluate((el) => getComputedStyle(el).color));
  expect(isLight(text), "alert dialog text").toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.goto("/dashboard"); // the editor shows its own switcher only with two or more profiles
  await page.getByRole("combobox", { name: "Active profile" }).click();
  const popup = page.getByRole("listbox");
  await expect(popup).toBeVisible();
  expect(isDark(await background(page, popup)), "profile switcher popup").toBe(true);
});

test("signing out leaves no dark theme on the sign-in page", async ({ page, baseURL, context, browser }) => {
  // The light baseline: an anonymous visitor under a light operating system.
  const anon = await browser.newContext({ colorScheme: "light", extraHTTPHeaders: { "x-forwarded-for": nextIp() } });
  const anonPage = await anon.newPage();
  await anonPage.goto("/login");
  const card = (p: Page) => p.locator("main div.rounded-xl").first();
  const baseline = { card: await bg(card(anonPage)), page: await bg(anonPage.locator("body")), scheme: await anonPage.evaluate(() => getComputedStyle(document.documentElement).colorScheme) };
  await anon.close();

  await signIn(page, baseURL!);
  await setMode(context, baseURL!, "dark");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/dashboard");
  await expect(scope(page)).toHaveAttribute("data-color-mode", "dark");
  await themeMenu(page, "Account menu").open();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(card(page)).toBeVisible();

  expect(await htmlMode(page), "<html> keeps no color mode").toBeNull();
  // The dashboard route may stay mounted but hidden after a client-side redirect (React <Activity>); nothing of it is rendered.
  expect(await page.evaluate(() => [...document.querySelectorAll("[data-color-mode]")].filter((e) => e.getClientRects().length > 0).length)).toBe(0);
  expect(await bg(card(page))).toBe(baseline.card);
  expect(await bg(page.locator("body"))).toBe(baseline.page);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(baseline.scheme);
  // The choice is remembered for the next sign-in, and still doesn't touch the sign-in page under a dark operating system.
  expect((await modeCookie(context))?.value).toBe("dark");
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await bg(card(page))).toBe(baseline.card);
});

/** Computed look of the editor preview: the page, its button, and the dashboard's selection markers drawn over it. */
const previewLook = (page: Page) =>
  page.getByTestId("profile-preview").filter({ visible: true }).locator(".pp-root").evaluate((root) => {
    const r = getComputedStyle(root);
    const btn = root.querySelector(".pp-btn");
    const selected = root.querySelector(".pp-block[data-editor-selected]");
    const chip = selected ? getComputedStyle(selected, "::before") : null;
    return {
      background: `${r.backgroundColor} ${r.backgroundImage}`,
      color: r.color,
      colorScheme: r.colorScheme,
      font: r.fontFamily,
      btn: btn ? { bg: getComputedStyle(btn).backgroundColor, color: getComputedStyle(btn).color } : null,
      outline: selected ? getComputedStyle(selected).outlineColor : null,
      chip: chip ? { bg: chip.backgroundColor, color: chip.color } : null,
      accent: r.getPropertyValue("--cl-accent").trim(),
      accentInk: r.getPropertyValue("--cl-accent-ink").trim(),
    };
  });

test("the editor preview looks the same in every dashboard mode, with the light selection colors", async ({ page, baseURL, context }) => {
  await signIn(page, baseURL!);
  await page.setViewportSize({ width: 1440, height: 900 });
  const looks: Record<string, Awaited<ReturnType<typeof previewLook>>> = {};
  for (const [name, mode, scheme] of [
    ["light", "light", "light"],
    ["dark", "dark", "light"],
    ["dark with a dark system", "dark", "dark"],
    ["system with a dark system", null, "dark"],
    ["system with a light system", null, "light"],
  ] as const) {
    await context.clearCookies({ name: COOKIE });
    if (mode) await setMode(context, baseURL!, mode);
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(profileUrl);
    await waitHydrated(page);
    // Focus alone selects the block, which marks it in the preview.
    await page.getByTestId("block-list").filter({ visible: true }).getByTestId("block-card").first().getByRole("button", { name: /^Edit / }).focus();
    await expect(page.locator(".pp-block[data-editor-selected]").filter({ visible: true })).toHaveCount(1);
    looks[name] = await previewLook(page);
  }
  const light = looks.light;
  expect(light.colorScheme).toBe("light");
  expect(light.chip, "a selected block shows the Editing chip").not.toBeNull();
  for (const [name, look] of Object.entries(looks)) expect(look, name).toEqual(light);
  // The selection colors stay the light teal and light ink: dark teal on a light page would lose contrast.
  expect(await rgba(page, light.accent)).toEqual(await rgba(page, "oklch(0.47 0.09 200)"));
  expect(await rgba(page, light.accentInk)).toEqual(await rgba(page, "oklch(0.99 0 0)"));
  expect(contrastRatio(hex(await rgba(page, light.chip!.color)), hex(await rgba(page, light.chip!.bg)))).toBeGreaterThanOrEqual(4.5);
});

test("the public profile page is identical with and without the dashboard dark choice, and sets no cookie", async ({ baseURL, browser }) => {
  const look = (p: Page) =>
    p.evaluate(() => {
      const root = document.querySelector(".pp-root")!;
      const r = getComputedStyle(root);
      const btn = root.querySelector(".pp-btn");
      return {
        html: document.documentElement.getAttribute("data-color-mode"),
        scopes: document.querySelectorAll("[data-color-mode], .cl-scope").length,
        htmlScheme: getComputedStyle(document.documentElement).colorScheme,
        body: getComputedStyle(document.body).backgroundColor,
        root: `${r.backgroundColor} ${r.backgroundImage}`,
        color: r.color,
        colorScheme: r.colorScheme,
        font: r.fontFamily,
        btn: btn ? { bg: getComputedStyle(btn).backgroundColor, color: getComputedStyle(btn).color } : null,
      };
    });
  const visit = async (extra: { dark: boolean; scheme: "light" | "dark" }) => {
    const ctx = await browser.newContext({ colorScheme: extra.scheme, extraHTTPHeaders: { "x-forwarded-for": nextIp() } });
    if (extra.dark) await setMode(ctx, baseURL!, "dark");
    const p = await ctx.newPage();
    const res = await p.goto(`/${HANDLE}`);
    expect(res!.status()).toBe(200);
    expect(await res!.headerValue("set-cookie"), "the public page sets no cookie").toBeNull();
    await expect(p.locator(".pp-root")).toBeVisible();
    const result = await look(p);
    await ctx.close();
    return result;
  };
  const plain = await visit({ dark: false, scheme: "light" });
  expect(plain.html).toBeNull();
  expect(plain.scopes).toBe(0);
  expect(await visit({ dark: true, scheme: "light" })).toEqual(plain);
  expect(await visit({ dark: true, scheme: "dark" })).toEqual(await visit({ dark: false, scheme: "dark" }));
});

for (const mode of ["light", "dark"] as const) {
  test(`${mode} theme: text, borders and the teal accent meet their contrast targets`, async ({ page, baseURL, context }) => {
    await signIn(page, baseURL!);
    await setMode(context, baseURL!, mode);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: mode === "dark" ? "light" : "dark" }); // the choice, not the system, decides
    await page.goto("/dashboard");
    await expect(scope(page)).toHaveAttribute("data-color-mode", mode);
    const t = await tokens(page);
    const c: Record<string, string> = {};
    for (const [name, value] of Object.entries(t)) c[name.replace("--cl-", "")] = hex(await rgba(page, value));
    const ratio = (a: string, b: string) => contrastRatio(c[a], c[b]);
    const report: string[] = [];
    const atLeast = (label: string, actual: number, min: number) => {
      report.push(`${label} ${actual.toFixed(2)}`);
      expect(actual, `${mode}: ${label}`).toBeGreaterThanOrEqual(min);
    };
    for (const plane of ["canvas", "surface", "inset"]) {
      atLeast(`ink-2 on ${plane}`, ratio("ink-2", plane), 6.5);
      atLeast(`line-strong on ${plane}`, ratio("line-strong", plane), 3);
      atLeast(`accent on ${plane}`, ratio("accent", plane), 4.5);
      atLeast(`ink on ${plane}`, ratio("ink", plane), 7);
    }
    atLeast("accent-ink on accent", ratio("accent-ink", "accent"), 4.5);
    console.log(`[color mode contrast] ${mode}: ${report.join(", ")}`);
  });
}

/** A CSS color expression resolved inside `scope` (so its variables apply), as sRGB 8-bit. */
async function probeBackground(page: Page, scope: Locator, css: string) {
  const computed = await scope.evaluate((el, css) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = css;
    el.appendChild(probe);
    const v = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return v;
  }, css);
  return rgba(page, computed);
}

test("the primary button keeps readable text while hovered, in both modes", async ({ page, baseURL, context }) => {
  await signIn(page, baseURL!);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const mode of ["light", "dark"] as const) {
    await setMode(context, baseURL!, mode);
    await page.goto(profileUrl);
    await waitHydrated(page);
    await page.getByRole("tab", { name: "Profile", exact: true }).click();
    await page.locator("#header-form #bio").fill(`Hover check ${mode}`); // an edit enables Publish, the dashboard's primary button
    const button = page.getByRole("button", { name: /^Publish( changes)?$/ });
    await expect(button).toBeEnabled();
    await button.hover();
    await button.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined));
    const [bgc, fg] = await button.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]);
    // The hover fill may be translucent over the surface: composite it over the page's surface.
    const surface = hex(await rgba(page, await scope(page).evaluate((el) => getComputedStyle(el).getPropertyValue("--cl-surface"))));
    const [r, g, b, a] = await rgba(page, bgc);
    const over = ([r, g, b]: readonly number[], base: string) => [r, g, b].map((v, i) => Math.round(v * a + parseInt(base.slice(1 + i * 2, 3 + i * 2), 16) * (1 - a)));
    const fill = hex(over([r, g, b], surface));
    expect(contrastRatio(hex(await rgba(page, fg)), fill), `${mode}: hovered primary button`).toBeGreaterThanOrEqual(4.5);
    // Inside the dashboard the hover fill is opaque: the primary color mixed toward the ink, not the translucent /80 fill.
    expect(a, `${mode}: dashboard hover fill is opaque`).toBe(1);
    const expected = await probeBackground(page, scope(page), "color-mix(in oklch, var(--primary), var(--foreground) 18%)");
    const translucent = await probeBackground(page, scope(page), "color-mix(in oklab, var(--primary) 80%, transparent)");
    expect([r, g, b], `${mode}: hover fill is the color-mix value`).toEqual(expected.slice(0, 3));
    expect(translucent[3]).toBeLessThan(1);
    await page.locator("#header-form #bio").fill("");
  }
});

test("the editor in Dark has no WCAG A/AA violations, contrast included, outside the preview", async ({ page, baseURL, context }) => {
  await signIn(page, baseURL!);
  await setMode(context, baseURL!, "dark");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(profileUrl);
  await waitHydrated(page);
  await expect(scope(page)).toHaveAttribute("data-color-mode", "dark");
  for (const tab of ["Content", "Profile", "Design"]) {
    await page.getByRole("tab", { name: new RegExp(tab) }).click();
    expect(await axeViolations(page, true), `editor ${tab}`).toEqual([]);
  }
});

for (const path of ["/dashboard", "/dashboard/account"]) {
  test(`${path} in Dark has no WCAG A/AA violations, contrast included`, async ({ page, baseURL, context }) => {
    await signIn(page, baseURL!);
    await setMode(context, baseURL!, "dark");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(path);
    await expect(scope(page)).toHaveAttribute("data-color-mode", "dark");
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.locator("[aria-busy=true]")).toHaveCount(0); // the page, not its loading skeleton
    expect(await axeViolations(page), path).toEqual([]);
  });
}

test("the sign-in page's primary button still hovers to the translucent fill", async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: "light", extraHTTPHeaders: { "x-forwarded-for": nextIp() } });
  const page = await ctx.newPage();
  await page.goto("/login");
  const button = page.getByRole("button", { name: "Sign in" });
  await button.hover();
  await button.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined));
  const hovered = await rgba(page, await bg(button));
  expect(hovered[3], "the /80 fill is translucent").toBeGreaterThan(0.7);
  expect(hovered[3]).toBeLessThan(0.9);
  expect(await page.evaluate(() => document.querySelectorAll(".cl-scope").length)).toBe(0);
  await ctx.close();
});

/** Rendered text contrast of an element: its colour over its own and its ancestors' backgrounds, each resolved to sRGB by a canvas. */
const renderedContrast = (loc: Locator) =>
  loc.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined))); // transitions finished
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
    const lum = (c: number[]) => c.map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    const h = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
    return { bg: h(bg), fg: h(fg), ratio: (hi + 0.05) / (lo + 0.05) };
  });

for (const mode of ["dark", "system-dark", "light"] as const) {
  test(`destructive buttons stay readable at rest and hovered in ${mode}`, async ({ page, baseURL, context }) => {
    await signIn(page, baseURL!);
    if (mode === "system-dark") await page.emulateMedia({ colorScheme: "dark" });
    else {
      await setMode(context, baseURL!, mode);
      await page.emulateMedia({ colorScheme: mode === "dark" ? "light" : "dark" }); // the choice decides, not the system
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const seen: string[] = [];
    const check = async (label: string, target: Locator, rest: () => Promise<void>) => {
      await rest();
      const atRest = await renderedContrast(target);
      await target.hover();
      const hovered = await renderedContrast(target);
      seen.push(`${label}: rest ${atRest.ratio.toFixed(2)} (${atRest.fg} on ${atRest.bg}), hover ${hovered.ratio.toFixed(2)} (${hovered.fg} on ${hovered.bg})`);
      expect.soft(atRest.ratio, `${mode}: ${label} at rest`).toBeGreaterThanOrEqual(4.5);
      expect.soft(hovered.ratio, `${mode}: ${label} hovered`).toBeGreaterThanOrEqual(4.5);
    };
    await page.goto(profileUrl);
    await waitHydrated(page);
    await page.getByRole("tab", { name: "Profile", exact: true }).click();
    const trigger = page.getByRole("region", { name: "Delete profile" }).getByRole("button", { name: "Delete profile", exact: true });
    await trigger.scrollIntoViewIfNeeded();
    await check("Delete profile", trigger, () => page.mouse.move(2, 2));
    await trigger.click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByLabel(/^Type .* to confirm$/).fill(HANDLE); // enables the button; nothing is confirmed
    const confirm = dialog.getByRole("button", { name: "Delete permanently" });
    await expect(confirm).toBeEnabled();
    await check("Delete permanently", confirm, () => page.mouse.move(2, 2));
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("tab", { name: "Content", exact: true }).click();
    const row = page.getByTestId("block-list").filter({ visible: true }).getByTestId("block-card").first();
    await row.getByRole("button", { name: /^More actions for/ }).click();
    const del = page.getByRole("menuitem", { name: "Delete", exact: true });
    await check("Block Delete", del, () => page.getByRole("menuitem", { name: "Duplicate", exact: true }).hover());
    await page.keyboard.press("Escape"); // the block is not deleted
    console.log(`[destructive contrast] ${mode}: ${seen.join("; ")}`);
  });
}
