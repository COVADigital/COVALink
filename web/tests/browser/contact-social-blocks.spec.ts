import type { Browser, Locator, Page } from "@playwright/test";
import { blend, contrastRatio } from "../../src/features/themes/contrast";
import { THEME_PRESETS } from "../../src/features/themes/presets";
import { expect, test } from "./fixtures";

/**
 * Browser workflows for contact, social and spacer blocks: the five
 * editors with inline validation and focus, keyboard ordering of social items
 * (Move up / Move down with focus kept and moves announced), persistence,
 * public and preview rendering (including real vCard downloads from both),
 * phone-width target sizes and overflow, and the rendered contrast of social
 * badges under all ten presets. Serial: steps build on each other. Lookups
 * filter to visible elements because Next.js keeps the previous route
 * mounted but hidden (React <Activity>).
 */
test.describe.configure({ mode: "serial" });

const EDITOR = { name: "Cora Contact", email: "contact-editor@example.com", password: "contact-password-123" };
const HANDLE = "contactpage";
let signInCount = 0;
let editorUrl = "";

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  // Its own client address (TRUST_PROXY is on in the E2E servers), so this sign-up doesn't
  // use up the per-IP sign-up limit (5 per 10 minutes) the other specs' registrations share.
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.111.1" } });
  const page = await context.newPage();
  await page.goto("/setup");
  if (await page.locator("#token").count()) {
    await page.locator("#token").fill(process.env.E2E_SETUP_TOKEN!);
    await page.locator("#name").fill("Setup Owner");
    await page.locator("#email").fill("contact-owner@example.com");
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
    headers: { origin: baseURL!, "x-forwarded-for": `198.51.110.${++signInCount}` },
  });
  expect(res.status()).toBe(200);
});

async function openEditor(page: Page) {
  await page.goto(editorUrl);
  await page.locator("[data-hydrated]").waitFor();
}

const list = (page: Page) => page.getByTestId("block-list").filter({ visible: true });
const cards = (page: Page) => list(page).getByTestId("block-card");
const cardOf = (page: Page, type: string) => cards(page).and(page.locator(`[data-block-type="${type}"]`));
const labels = (page: Page) => list(page).getByTestId("block-label").allTextContents();
const status = (page: Page) => page.getByTestId("editor-status").filter({ visible: true });
const announcer = (page: Page) => page.getByTestId("blocks-announcer").filter({ visible: true });
const preview = (page: Page) => page.getByTestId("profile-preview").filter({ visible: true });
const previewTypes = (page: Page) => preview(page).locator("[data-block-type]").evaluateAll((els) => els.map((e) => e.getAttribute("data-block-type")));
const addButton = (page: Page, name: string) => page.getByRole("group", { name: "Add block" }).getByRole("button", { name, exact: true });
const byIdSuffix = (scope: Page | Locator, suffix: string) => scope.locator(`[id$="${suffix}"]`).filter({ visible: true });

async function expand(c: Locator) {
  const toggle = c.getByRole("button", { name: /^Edit / });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

async function saveDraft(page: Page) {
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(status(page)).toContainText("Draft saved");
}

async function publish(page: Page) {
  await page.getByRole("button", { name: /^Publish/ }).click();
  await expect(status(page)).toContainText("Published");
}

function parseRgb(value: string): { hex: string; alpha: number } {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/.exec(value);
  if (!m) throw new Error(`unparsed color: ${value}`);
  const hex = `#${[m[1], m[2], m[3]].map((c) => Math.round(Number(c)).toString(16).padStart(2, "0")).join("")}`;
  return { hex, alpha: m[4] === undefined ? 1 : Number(m[4]) };
}

test("adds all five block types with inline validation and focus, and they persist", async ({ page }) => {
  await page.goto("/dashboard/profiles");
  await page.locator("#handle").fill(HANDLE);
  await page.locator("#label").fill("Contacts");
  await page.locator("#displayName").fill("Cora");
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page).toHaveURL(/\/dashboard\/profiles\/[0-9a-f-]{36}$/);
  editorUrl = page.url();
  await page.locator("[data-hydrated]").waitFor();

  // Social links: the first platform is focused; an http address is refused inline and on save.
  await addButton(page, "Social links").click();
  const platform0 = byIdSuffix(page, "-items.0.platform");
  await expect(platform0).toBeFocused();
  await platform0.selectOption("github");
  const url0 = byIdSuffix(page, "-items.0.url");
  await url0.fill("http://github.com/cora");
  await url0.blur();
  await expect(url0).toHaveAttribute("aria-invalid", "true");
  const urlError = page.getByText("Enter an https:// GitHub address, like https://github.com/you").filter({ visible: true });
  await expect(urlError).toBeVisible();
  expect(await url0.getAttribute("aria-describedby")).toContain(`${await url0.getAttribute("id")}-error`);
  await expect(preview(page)).toContainText("Incomplete social links");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Some blocks need attention" })).toBeVisible();
  await expect(url0).toBeFocused();
  await url0.fill("github.com/cora");
  await expect(url0).not.toHaveAttribute("aria-invalid", "true");

  const social = cardOf(page, "social");
  await social.getByRole("button", { name: "Add social link" }).click();
  const platform1 = byIdSuffix(page, "-items.1.platform");
  await expect(platform1).toBeFocused();
  await expect(announcer(page)).toHaveText("Added social link 2 of 2.");
  await platform1.selectOption("website");
  await byIdSuffix(page, "-items.1.url").fill("cora.example");
  await social.getByRole("combobox", { name: "Style" }).selectOption("pill");

  // Email, phone (an extension is refused), contact card and spacer.
  await addButton(page, "Email").click();
  const emailLabel = byIdSuffix(cardOf(page, "email"), "-label");
  await expect(emailLabel).toBeFocused();
  await emailLabel.fill("Email Cora");
  await byIdSuffix(cardOf(page, "email"), "-email").fill("cora@example.com");
  await byIdSuffix(cardOf(page, "email"), "-subject").fill("Hello & welcome");

  await addButton(page, "Phone").click();
  await expect(byIdSuffix(cardOf(page, "phone"), "-label")).toBeFocused();
  const phone = byIdSuffix(cardOf(page, "phone"), "-phone");
  await phone.fill("555 0100 x12");
  await phone.blur();
  await expect(phone).toHaveAttribute("aria-invalid", "true");
  await expect(cardOf(page, "phone").getByText("Enter a phone number with 4 to 15 digits")).toBeVisible();
  await phone.fill("+1 (555) 010-0100");
  await expect(phone).not.toHaveAttribute("aria-invalid", "true");

  await addButton(page, "Contact card").click();
  const first = byIdSuffix(cardOf(page, "contact"), "-firstName");
  await expect(first).toBeFocused();
  await first.fill("Cora");
  await byIdSuffix(cardOf(page, "contact"), "-lastName").fill("Ng");
  await byIdSuffix(cardOf(page, "contact"), "-organization").fill("Acme; Labs");
  await byIdSuffix(cardOf(page, "contact"), "-note").fill("Line one\nLine two");

  await addButton(page, "Spacer").click();
  const size = byIdSuffix(cardOf(page, "spacer"), "-size");
  await expect(size).toBeFocused();
  await size.selectOption("lg");

  expect(await labels(page)).toEqual(["GitHub, Website", "Email Cora", "Call me", "Cora Ng", "Spacer (large)"]);
  expect(await previewTypes(page)).toEqual(["social", "email", "phone", "contact", "spacer"]);
  await saveDraft(page);
  await page.reload();
  await page.locator("[data-hydrated]").waitFor();
  expect(await labels(page)).toEqual(["GitHub, Website", "Email Cora", "Call me", "Cora Ng", "Spacer (large)"]);
  await expand(cardOf(page, "social"));
  await expect(byIdSuffix(page, "-items.0.url")).toHaveValue("https://github.com/cora");
  await expect(byIdSuffix(page, "-items.1.url")).toHaveValue("https://cora.example/");
});

test("orders social items from the keyboard with Move up / Move down, keeping focus and announcing each move", async ({ page }) => {
  await openEditor(page);
  const social = cardOf(page, "social");
  await expand(social);
  const up = social.getByRole("button", { name: "Move link 2 (Website) up" });
  await up.focus();
  await page.keyboard.press("Enter");
  // At the top, Move up is disabled, so focus moves to the same item's Move down.
  await expect(social.getByRole("button", { name: "Move link 1 (Website) down" })).toBeFocused();
  await expect(social.getByRole("button", { name: "Move link 1 (Website) up" })).toBeDisabled();
  await expect(announcer(page)).toHaveText("Moved social link Website to position 1 of 2.");
  await expect(byIdSuffix(page, "-items.0.url")).toHaveValue("https://cora.example/");

  await page.keyboard.press("Enter");
  await expect(social.getByRole("button", { name: "Move link 2 (Website) up" })).toBeFocused();
  await expect(announcer(page)).toHaveText("Moved social link Website to position 2 of 2.");
  await page.keyboard.press("Space");
  await expect(social.getByRole("button", { name: "Move link 1 (Website) down" })).toBeFocused();
  expect(await labels(page)).toContain("Website, GitHub");

  // Add a third item, then remove it: focus moves to the previous item's Remove and the removal is announced.
  await social.getByRole("button", { name: "Add social link" }).click();
  await byIdSuffix(page, "-items.2.platform").selectOption("mastodon");
  await social.getByRole("button", { name: "Remove link 3 (Mastodon)" }).click();
  await expect(social.getByRole("button", { name: "Remove link 2 (GitHub)" })).toBeFocused();
  await expect(announcer(page)).toHaveText("Removed social link 3 (Mastodon). Save to keep this change.");

  await saveDraft(page);
  await page.reload();
  await page.locator("[data-hydrated]").waitFor();
  expect(await labels(page)).toContain("Website, GitHub");
});

test("publishes: the public page and the preview render the same blocks; both contact cards download", async ({ page, context }) => {
  await openEditor(page);
  await publish(page);
  const previewHtml = await preview(page).locator(".pp-blocks").innerHTML();

  const visitor = await context.newPage();
  await visitor.goto(`/${HANDLE}`);
  const blocks = visitor.locator(".pp-blocks");
  await expect(blocks.getByRole("link", { name: "Website" })).toHaveAttribute("href", /^\/go\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/0$/);
  await expect(blocks.getByRole("link", { name: "GitHub profile" })).toHaveAttribute("href", /\/1$/);
  await expect(blocks.getByRole("link", { name: "Email Cora" })).toHaveAttribute("href", "mailto:cora@example.com?subject=Hello%20%26%20welcome");
  await expect(blocks.getByRole("link", { name: "Call me" })).toHaveAttribute("href", "tel:+15550100100");
  await expect(blocks.locator(".pp-social-label")).toHaveText(["Website", "GitHub"]);
  await expect(blocks.locator('.pp-spacer[data-size="lg"]')).toHaveAttribute("aria-hidden", "true");

  // Same markup as the preview apart from destinations and the new-tab attribute.
  const publicHtml = await blocks.innerHTML();
  const normalize = (html: string) => html.replace(/ href="[^"]*"/g, "").replace(/ target="_blank"/g, "").replace(/ rel="[^"]*"/g, "");
  expect(normalize(publicHtml)).toBe(normalize(previewHtml));

  // The public card comes from /api/vcard; the preview builds the draft's card in the browser.
  const [download] = await Promise.all([visitor.waitForEvent("download"), blocks.getByRole("link", { name: "Save contact" }).click()]);
  expect(download.suggestedFilename()).toBe("Cora-Ng.vcf");
  expect(download.url()).toMatch(/\/api\/vcard\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
  const card = await (await download.createReadStream()).toArray();
  const text = Buffer.concat(card as Buffer[]).toString("utf8");
  expect(text).toMatch(/^BEGIN:VCARD\r\nVERSION:4\.0\r\nFN:Cora Ng\r\n/);
  expect(text).toContain("ORG:Acme\\; Labs\r\n");
  expect(text).toContain("NOTE:Line one\\nLine two\r\n");
  await visitor.close();

  const [draftDownload] = await Promise.all([page.waitForEvent("download"), preview(page).getByRole("link", { name: "Save contact" }).click()]);
  expect(draftDownload.suggestedFilename()).toBe("Cora-Ng.vcf");
  const draftText = Buffer.concat((await (await draftDownload.createReadStream()).toArray()) as Buffer[]).toString("utf8");
  expect(draftText).toBe(text);
});

test("social badges reach 4.5:1 under all ten presets, rendered in the preview and on the public page", async ({ page, context }) => {
  await openEditor(page);
  const measure = (root: Locator) =>
    root.evaluate(async (el) => {
      await Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined)));
      const r = getComputedStyle(el);
      const stops = r.backgroundImage === "none" ? [r.backgroundColor] : (r.backgroundImage.match(/rgba?\([^)]+\)/g) ?? []);
      return [...el.querySelectorAll(".pp-social-link")].map((a) => {
        const link = getComputedStyle(a);
        const parts = [...a.querySelectorAll(".pp-social-mark, .pp-social-label")].map((s) => getComputedStyle(s));
        const opacities: string[] = [];
        for (let e: Element | null = a; e && e !== el.parentElement; e = e.parentElement) opacities.push(getComputedStyle(e).opacity);
        return { surface: link.backgroundColor, text: parts.map((p) => p.color), opacities, stops, height: (a as HTMLElement).offsetHeight, width: (a as HTMLElement).offsetWidth };
      });
    });
  const check = (label: string, rows: Awaited<ReturnType<typeof measure>>) => {
    expect(rows.length, label).toBe(2);
    for (const row of rows) {
      expect(row.opacities.every((o) => o === "1"), `${label}: ${row.opacities}`).toBe(true);
      expect(row.height, label).toBeGreaterThanOrEqual(44);
      expect(row.width, label).toBeGreaterThanOrEqual(44);
      const surface = parseRgb(row.surface);
      for (const color of row.text) {
        for (const stop of row.stops.map((s) => parseRgb(s).hex)) {
          const effective = surface.alpha < 1 ? blend(surface.hex, stop, surface.alpha) : surface.hex;
          const ratio = contrastRatio(parseRgb(color).hex, effective);
          expect(ratio, `${label}: ${color} on ${effective} (page ${stop})`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  };

  await page.getByRole("tab", { name: /Appearance/ }).click();
  expect(THEME_PRESETS).toHaveLength(10);
  for (const { id } of THEME_PRESETS) {
    await page.locator("label").filter({ has: page.getByTestId(`preset-${id}`) }).click();
    await expect(page.getByTestId(`preset-${id}`)).toBeChecked();
    check(`preview ${id}`, await measure(preview(page).locator(".pp-root")));
  }
  // The last preset, published and measured on the public page.
  await publish(page);
  const visitor = await context.newPage();
  await visitor.goto(`/${HANDLE}`);
  check(`public ${THEME_PRESETS.at(-1)!.id}`, await measure(visitor.locator(".pp-root")));
  await visitor.close();
});

test.describe("phone viewport", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the block editor and public page fit at 390 px, and every interactive target is at least 44 × 44 px", async ({ page }) => {
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    await openEditor(page);
    for (const type of ["social", "email", "phone", "contact", "spacer"]) await expand(cardOf(page, type));
    expect(await noOverflow()).toBe(true);

    const small = await page.evaluate(() => {
      const scope = [...document.querySelectorAll('[data-testid="block-list"], [role="group"][aria-labelledby="add-block-label"]')].filter(
        (e) => (e as HTMLElement).offsetParent !== null,
      );
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
    await expect(page.locator(".pp-social-link").first()).toBeVisible();
    expect(await noOverflow()).toBe(true);
    const targets = await page.locator(".pp-blocks a[href]").evaluateAll((els) => els.map((e) => [(e as HTMLElement).offsetWidth, (e as HTMLElement).offsetHeight]));
    expect(targets.length).toBe(5);
    for (const [w, h] of targets) {
      expect(w).toBeGreaterThanOrEqual(44);
      expect(h).toBeGreaterThanOrEqual(44);
    }
    // The spacer is never a focus stop: Tab from the contact card leaves the blocks.
    await page.locator(".pp-blocks a[href]").last().focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest(".pp-spacer"))).toBeNull();
  });
});
