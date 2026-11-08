import type { Browser, BrowserContext, Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * Browser workflows for video and music blocks. Provider hosts are
 * intercepted and answered with stub pages, so no automated suite contacts a
 * real provider; the real policy still applies to everything the page loads.
 * Covers: zero provider requests before Load; the exact iframe attributes after
 * it; the editor preview; focus; keyboard use; layout shift; 320 and 390 px
 * sizes; no cookies; no JavaScript; opening from the dashboard link; and the
 * containment cases. Serial: steps build on each other.
 */
test.describe.configure({ mode: "serial" });

const EDITOR = { name: "Eli Embed", email: "embed-editor@example.com", password: "embed-password-123" };
const HANDLE = "embedpage";
const YT_ID = "dQw4w9WgXcQ";
const SANDBOX = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox";
const PROVIDER = /(?:^|\.)(?:youtube-nocookie\.com|youtube\.com|youtu\.be|vimeo\.com|spotify\.com|soundcloud\.com|scdn\.co|ytimg\.com)$/;
let signInCount = 0;
let editorUrl = "";

const stub = (body: string) => ({ status: 200, contentType: "text/html", body: `<!doctype html><title>stub</title>${body}` });

/** Answers every provider request with a stub, and records it. */
async function stubProviders(context: BrowserContext, html: (url: URL) => string = () => "stub player") {
  const seen: string[] = [];
  await context.route(
    (url) => PROVIDER.test(url.hostname),
    async (route: Route) => {
      const url = new URL(route.request().url());
      seen.push(url.href);
      await route.fulfill(stub(html(url)));
    },
  );
  return seen;
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  // Its own client address, so this sign-up doesn't use up the per-IP limit other specs share.
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.115.1" } });
  const page = await context.newPage();
  await page.goto("/setup");
  if (await page.locator("#token").count()) {
    await page.locator("#token").fill(process.env.E2E_SETUP_TOKEN!);
    await page.locator("#name").fill("Setup Owner");
    await page.locator("#email").fill("embed-owner@example.com");
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

async function signIn(page: Page, baseURL: string | undefined) {
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: EDITOR.email, password: EDITOR.password },
    headers: { origin: baseURL!, "x-forwarded-for": `198.51.116.${++signInCount}` },
  });
  expect(res.status()).toBe(200);
}

const list = (page: Page) => page.getByTestId("block-list").filter({ visible: true });
const cards = (page: Page) => list(page).getByTestId("block-card");
const preview = (page: Page) => page.getByTestId("profile-preview").filter({ visible: true });
const status = (page: Page) => page.getByTestId("editor-status").filter({ visible: true });
const addButton = (page: Page, name: string) => page.getByRole("group", { name: "Add block" }).getByRole("button", { name, exact: true });
const field = (page: Page, suffix: string) => page.locator(`[id$="${suffix}"]`).filter({ visible: true });

/** A new visitor with no session, with provider hosts stubbed. */
async function visitor(browser: Browser, baseURL: string | undefined, options: Parameters<Browser["newContext"]>[0] = {}, html?: (url: URL) => string) {
  const context = await browser.newContext({ baseURL, ...options });
  const seen = await stubProviders(context, html);
  const page = await context.newPage();
  const violations: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  page.on("pageerror", (e) => violations.push(`pageerror: ${e.message}`));
  return { context, page, seen, violations };
}
const hydrated = (page: Page) => page.getByRole("button", { name: /^Load / }).first().waitFor();

test("adds video and music blocks with focus and inline errors; the preview contacts nobody and they persist", async ({ page, context, baseURL }) => {
  await signIn(page, baseURL);
  const seen = await stubProviders(context);
  await page.goto("/dashboard/profiles");
  await page.locator("#handle").fill(HANDLE);
  await page.locator("#label").fill("Embeds");
  await page.locator("#displayName").fill("Eli");
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page).toHaveURL(/\/dashboard\/profiles\/[0-9a-f-]{36}$/);
  editorUrl = page.url();
  await page.locator("[data-hydrated]").waitFor();

  // A new block focuses its link field, and the preview shows the existing placeholder.
  await addButton(page, "Video").click();
  await expect(field(page, "-url")).toBeFocused();
  await expect(preview(page)).toContainText("Incomplete video");

  // Saving reveals the problem and focuses the field; a refused link gets a specific message.
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Some blocks need attention" })).toBeVisible();
  await expect(field(page, "-url")).toBeFocused();
  await expect(cards(page).first().getByText(/Paste a YouTube or Vimeo link/)).toBeVisible();
  await field(page, "-url").fill(`<iframe src="https://www.youtube.com/embed/${YT_ID}"></iframe>`);
  await expect(cards(page).first().getByText(/not embed code/)).toBeVisible();
  await field(page, "-url").fill("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
  await expect(cards(page).first().getByText("That's a Spotify link. Use a Music block for it.")).toBeVisible();

  await field(page, "-url").fill(`https://youtu.be/${YT_ID}?si=abc`);
  await field(page, "-title").fill("My video");
  await expect(cards(page).first().getByTestId("block-label")).toHaveText("My video");

  // The preview renders the same box, without Load, with the note, and makes no provider contact.
  const box = preview(page).getByRole("group", { name: "My video" });
  await expect(box).toContainText("Visitors can load this player on your public page");
  await expect(box.getByRole("button")).toHaveCount(0);
  await expect(preview(page).locator("iframe")).toHaveCount(0);
  await expect(preview(page).getByRole("link", { name: "Open on YouTube: My video" })).toHaveAttribute("href", `https://www.youtube.com/watch?v=${YT_ID}`);

  await addButton(page, "Music").click();
  await expect(field(page, "-url").last()).toBeFocused();
  await field(page, "-url").last().fill("https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=x");
  await addButton(page, "Music").click();
  await field(page, "-url").last().fill("https://soundcloud.com/forss/flickermood");

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(status(page)).toContainText("saved", { ignoreCase: true });
  // The field shows the canonical URL after a save, and it survives a reload.
  await expect(field(page, "-url").first()).toHaveValue(`https://www.youtube.com/watch?v=${YT_ID}`);
  await page.reload();
  await page.locator("[data-hydrated]").waitFor();
  await expect(cards(page).getByTestId("block-label")).toHaveText(["My video", "Untitled music player", "Untitled music player"]);

  // The dashboard keeps frame-src 'none': a soft navigation can't change that.
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(status(page)).toContainText("published", { ignoreCase: true });
  expect(seen).toEqual([]);
});

test("a visitor's page contacts no provider until Load; the player then has the exact attributes and takes focus", async ({ browser, baseURL }) => {
  const { context, page, seen, violations } = await visitor(browser, baseURL, { viewport: { width: 1280, height: 900 } });
  await page.goto(`/${HANDLE}`, { waitUntil: "networkidle" });
  await hydrated(page);
  expect(seen).toEqual([]);
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(await context.cookies()).toEqual([]);

  const load = page.getByRole("button", { name: "Load video: My video" });
  await expect(load).toHaveText("Load video");
  await load.click();
  const frame = page.getByRole("group", { name: "My video" }).locator("iframe");
  await expect(frame).toHaveCount(1);
  await expect(frame).toHaveAttribute("src", `https://www.youtube-nocookie.com/embed/${YT_ID}`);
  await expect(frame).toHaveAttribute("allow", "encrypted-media; fullscreen");
  await expect(frame).toHaveAttribute("sandbox", SANDBOX);
  await expect(frame).toHaveAttribute("title", "My video");
  await expect(frame).toHaveAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  await expect(frame).toBeFocused();
  // Together, so a blocked player fails here with the CSP violation it caused.
  await expect.poll(() => ({ seen, violations })).toEqual({ seen: [`https://www.youtube-nocookie.com/embed/${YT_ID}`], violations: [] });

  // The other players are still untouched: each block loads separately.
  await expect(page.locator("iframe")).toHaveCount(1);
  await page.getByRole("button", { name: "Load music player: Spotify player" }).click();
  const spotify = page.getByRole("group", { name: "Spotify player" }).locator("iframe");
  await expect(spotify).toHaveAttribute("src", "https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC");
  await expect(spotify).toHaveAttribute("allow", "encrypted-media");
  await page.getByRole("button", { name: "Load music player: SoundCloud player" }).click();
  const soundcloud = page.getByRole("group", { name: "SoundCloud player" }).locator("iframe");
  const soundcloudSrc = await soundcloud.getAttribute("src");
  expect(soundcloudSrc).toBe("https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fforss%2Fflickermood&auto_play=false&visual=false&show_comments=false");
  expect(await soundcloud.getAttribute("allow")).toBeNull();

  // The Open link stays visible after loading, and nothing is drawn over a player.
  await expect(page.getByRole("link", { name: "Open on YouTube: My video" })).toBeVisible();
  const covering = await frame.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === el;
  });
  expect(covering).toBe(true);

  // The loaded state lasts for this page view only: nothing is remembered.
  const stored = await page.evaluate(() => [window.localStorage.length, window.sessionStorage.length, document.cookie]);
  expect(stored).toEqual([0, 0, ""]);
  await page.reload();
  await hydrated(page);
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(violations).toEqual([]);
  await context.close();
});

test("Load works from the keyboard with Enter and Space", async ({ browser, baseURL }) => {
  for (const key of ["Enter", "Space"]) {
    const { context, page, violations } = await visitor(browser, baseURL);
    await page.goto(`/${HANDLE}`);
    await hydrated(page);
    await page.getByRole("button", { name: "Load video: My video" }).focus();
    await page.keyboard.press(key);
    await expect(page.locator("iframe")).toBeFocused();
    expect(violations).toEqual([]);
    await context.close();
  }
});

test("the player replaces the placeholder with no layout shift", async ({ browser, baseURL }) => {
  const { context, page, violations } = await visitor(browser, baseURL, { viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => {
    const w = window as unknown as { __shifts: number };
    w.__shifts = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { value: number }[]) w.__shifts += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto(`/${HANDLE}`);
  await hydrated(page);
  await page.waitForLoadState("networkidle");

  const names = ["My video", "Spotify player", "SoundCloud player"];
  const boxes = () => Promise.all(names.map((name) => page.getByRole("group", { name }).boundingBox()));
  const before = await boxes();
  const after = page.locator(".pp-footer, .pp-embed-open").last();
  const bottomBefore = await after.boundingBox();
  await page.getByRole("button", { name: "Load video: My video" }).click();
  await page.getByRole("button", { name: "Load music player: Spotify player" }).click();
  await page.getByRole("button", { name: "Load music player: SoundCloud player" }).click();
  await expect(page.locator("iframe")).toHaveCount(3);
  expect(await boxes()).toEqual(before);
  expect(await after.boundingBox()).toEqual(bottomBefore);
  // Pointer presses count as recent input, so read every entry, not only the unexpected ones.
  expect(await page.evaluate(() => (window as unknown as { __shifts: number }).__shifts)).toBeLessThan(0.001);
  expect(violations).toEqual([]);
  await context.close();
});

for (const width of [320, 390]) {
  test(`at ${width} px the page doesn't overflow, the video frame is at least 200 x 200 px, and targets are 44 px`, async ({ browser, baseURL }) => {
    const { context, page, violations } = await visitor(browser, baseURL, { viewport: { width, height: 800 }, hasTouch: true });
    await page.goto(`/${HANDLE}`);
    await hydrated(page);
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await noOverflow()).toBe(true);
    for (const load of await page.getByRole("button", { name: /^Load / }).all()) {
      expect((await load.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    for (const open of await page.getByRole("link", { name: /^Open on / }).all()) {
      expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    // Every piece of placeholder text fits its box.
    for (const name of ["My video", "Spotify player", "SoundCloud player"]) {
      const fits = await page.getByRole("group", { name }).evaluate((el) => el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth);
      expect(fits, name).toBe(true);
    }
    await page.getByRole("button", { name: "Load video: My video" }).click();
    const frame = await page.getByRole("group", { name: "My video" }).locator("iframe").boundingBox();
    expect(frame!.width).toBeGreaterThanOrEqual(200);
    expect(frame!.height).toBeGreaterThanOrEqual(200);
    // Music players get exactly the height they were measured to fit.
    await page.getByRole("button", { name: "Load music player: Spotify player" }).click();
    await page.getByRole("button", { name: "Load music player: SoundCloud player" }).click();
    expect((await page.getByRole("group", { name: "Spotify player" }).locator("iframe").boundingBox())!.height).toBe(152);
    expect((await page.getByRole("group", { name: "SoundCloud player" }).locator("iframe").boundingBox())!.height).toBe(166);
    expect(await noOverflow()).toBe(true);
    expect(violations).toEqual([]);
    await context.close();
  });
}

test("without JavaScript the box and the Open link work and no inert control is shown", async ({ browser, baseURL }) => {
  const { context, page, seen } = await visitor(browser, baseURL, { javaScriptEnabled: false });
  await page.goto(`/${HANDLE}`);
  await expect(page.getByRole("group", { name: "My video" })).toBeVisible();
  await expect(page.locator(".pp-embed-box button")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open on YouTube: My video" })).toHaveAttribute("href", `https://www.youtube.com/watch?v=${YT_ID}`);
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(seen).toEqual([]);
  expect(await context.cookies()).toEqual([]);
  await context.close();
});

test("opened from the dashboard link, the page has the embed policy and the player loads", async ({ page, context, baseURL }) => {
  await signIn(page, baseURL);
  await stubProviders(context);
  await page.goto(editorUrl);
  await page.locator("[data-hydrated]").waitFor();
  const [publicPage] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("link", { name: /view public page|view page|open public page/i }).first().click(),
  ]);
  const problems: string[] = [];
  publicPage.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text());
  });
  await hydrated(publicPage);
  await publicPage.getByRole("button", { name: "Load video: My video" }).click();
  await expect(publicPage.locator("iframe")).toHaveCount(1);
  await expect(publicPage.frameLocator("iframe").locator("body")).toContainText("stub player");
  expect(problems).toEqual([]);
});

/** The containment cases against the real policy: the stub player's script or link tries to leave. */
test.describe("containment", () => {
  const ESCAPE = "https://www.youtube-nocookie.com/elsewhere/";
  const scenario = async (browser: Browser, baseURL: string | undefined, body: string) => {
    const made = await visitor(browser, baseURL, {}, (url) => (url.pathname.startsWith("/embed/") ? body : "other page"));
    await made.page.goto(`/${HANDLE}`);
    await hydrated(made.page);
    const cspErrors: string[] = [];
    made.page.on("console", (m) => {
      if (/frame-src/.test(m.text())) cspErrors.push(m.text());
    });
    await made.page.evaluate(() => {
      (window as unknown as { __v: string[] }).__v = [];
      document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __v: string[] }).__v.push(e.effectiveDirective));
    });
    await made.page.getByRole("button", { name: "Load video: My video" }).click();
    return { ...made, cspErrors, violated: () => made.page.evaluate(() => (window as unknown as { __v: string[] }).__v) };
  };

  test("leaving the allowed path is blocked with a frame-src violation, before any request", async ({ browser, baseURL }) => {
    const { context, page, seen, violated } = await scenario(browser, baseURL, `<script>setTimeout(() => { location.href = ${JSON.stringify(ESCAPE)}; }, 100);</script>`);
    await expect.poll(violated).toContain("frame-src");
    expect(seen.filter((u) => u === ESCAPE)).toEqual([]);
    expect(page.url()).toContain(`/${HANDLE}`);
    await context.close();
  });

  test("navigating the top page fails, and the page stays", async ({ browser, baseURL }) => {
    const { context, page, seen, violations } = await scenario(browser, baseURL, `<script>setTimeout(() => { try { top.location.href = ${JSON.stringify(ESCAPE)}; } catch {} }, 100);</script>`);
    await expect.poll(() => seen.length).toBe(1);
    await page.waitForTimeout(800);
    expect(new URL(page.url()).pathname).toBe(`/${HANDLE}`);
    expect(seen.filter((u) => u === ESCAPE)).toEqual([]);
    expect(violations.filter((v) => v.startsWith("pageerror"))).toEqual([]);
    await context.close();
  });

  test("a link opening a new tab works: that page is outside the frame's limits, and unsandboxed", async ({ browser, baseURL }) => {
    const { context, page } = await scenario(browser, baseURL, `<a id="out" href=${JSON.stringify(ESCAPE)} target="_blank">Out</a>`);
    const frame = page.frameLocator("iframe");
    const [tab] = await Promise.all([context.waitForEvent("page"), frame.locator("#out").click()]);
    await tab.waitForLoadState();
    expect(tab.url()).toBe(ESCAPE);
    let dialog = false;
    tab.on("dialog", (d) => {
      dialog = true;
      void d.dismiss();
    });
    await tab.evaluate(() => window.alert("x"));
    expect(dialog).toBe(true);
    await context.close();
  });
});
