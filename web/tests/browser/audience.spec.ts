import type { Browser, Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { expect, test } from "./fixtures";

/**
 * Browser workflows for the Subscribe block and the Audience page. Without
 * SMTP (MAIN) the page and the block editor explain that email is needed, and
 * the public page leaves the block out. On MAIL (:3103, SMTP to the runner's
 * sink, same database) a visitor signs up, confirms from the emailed link (the
 * token leaves the address bar and works once), and the owner sees, exports
 * and deletes the contact; a second visitor removes themselves with the remove
 * link. The owner stays on MAIN, where sign-in doesn't need verification.
 * Serial: steps build on each other. Every test also fails on CSP violations
 * or page errors (fixtures.ts).
 */
test.describe.configure({ mode: "serial" });

const MAIL = process.env.E2E_MAIL_BASE_URL!;
const SINK = process.env.E2E_MAIL_URL!;
const OWNER = { name: "Ada Audience", email: "audience-owner@example.com", password: "audience-password-123" };
const HANDLE = "audiencepage";
const FAN = "fan-one@example.com";
const LEAVER = "fan-two@example.com";
let ip = 0;
const nextIp = () => `198.51.130.${++ip}`;
let profileUrl = "";

interface SinkMessage {
  to: string[];
  raw: string;
  text: string;
}
const sinkMessages = async (): Promise<SinkMessage[]> => (await fetch(`${SINK}/messages`)).json();
const clearSink = () => fetch(`${SINK}/messages`, { method: "DELETE" });
async function tokensFor(to: string) {
  await expect.poll(async () => (await sinkMessages()).filter((m) => m.to.includes(to)).length, { timeout: 10_000 }).toBe(1);
  const { text } = (await sinkMessages()).find((m) => m.to.includes(to))!;
  const pick = (page: string) => decodeURIComponent(new RegExp(`${page}#token=([^\\s"<>&]+)`).exec(text)![1]);
  return { confirm: pick("/subscribe/confirm"), remove: pick("/subscribe/remove") };
}

test.beforeAll(async ({ browser, baseURL }: { browser: Browser; baseURL?: string }) => {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.131.1" } });
  const page = await context.newPage();
  await page.goto("/setup");
  if (await page.locator("#token").count()) {
    await page.locator("#token").fill(process.env.E2E_SETUP_TOKEN!);
    await page.locator("#name").fill("Setup Owner");
    await page.locator("#email").fill("audience-admin@example.com");
    await page.locator("#password").fill("correct-horse-battery");
    await page.locator("#confirm").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Create administrator" }).click();
    await expect(page.getByRole("status")).toContainText("ready");
  }
  const res = await page.request.post("/api/auth/sign-up/email", {
    data: OWNER,
    headers: { origin: baseURL!, "x-forwarded-for": nextIp() },
  });
  expect(res.status()).toBe(200);
  await context.close();
});

test.beforeEach(async ({ page, baseURL }) => {
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: OWNER.email, password: OWNER.password },
    headers: { origin: baseURL!, "x-forwarded-for": nextIp() },
  });
  expect(res.status()).toBe(200);
});

const status = (page: Page) => page.getByTestId("editor-status").filter({ visible: true });

/** A signed-out visitor on MAIL with its own client address. */
async function visitor(browser: Browser) {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": nextIp() } });
  return { context, page: await context.newPage() };
}

async function signUp(browser: Browser, email: string) {
  const { context, page } = await visitor(browser);
  await page.goto(`${MAIL}/${HANDLE}`);
  const form = page.getByRole("form", { name: "Join the club" });
  await form.getByLabel("Email address").fill(email);
  await form.getByRole("button", { name: "Sign me up" }).click();
  await expect(form.getByRole("status")).toContainText("check your inbox");
  await expect(form.getByLabel("Email address")).toHaveCount(0);
  await expect(form.getByText("By subscribing")).toHaveCount(0);
  await context.close();
}

async function useLink(browser: Browser, action: "confirm" | "remove", token: string) {
  const { context, page } = await visitor(browser);
  await page.goto(`${MAIL}/subscribe/${action}#token=${encodeURIComponent(token)}`);
  const button = page.getByRole("button", { name: action === "confirm" ? "Confirm subscription" : "Remove my email" });
  await expect(button).toBeVisible();
  expect(page.url()).toBe(`${MAIL}/subscribe/${action}`);
  await button.click();
  await expect(page.getByTestId("subscribe-done")).toBeFocused();
  return { context, page };
}

test("without email: the Audience page and the block editor say so, and the public page leaves the block out", async ({ page }) => {
  await page.goto("/dashboard/profiles");
  await page.locator("#handle").fill(HANDLE);
  await page.locator("#label").fill("Audience");
  await page.locator("#displayName").fill("Ada");
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page).toHaveURL(/\/dashboard\/profiles\/[0-9a-f-]{36}$/);
  profileUrl = page.url();

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Audience" }).click();
  await expect(page).toHaveURL(`${profileUrl}/audience`);
  await expect(page.getByRole("heading", { level: 1, name: "Audience" })).toBeVisible();
  await expect(page.getByRole("note").filter({ hasText: "Email isn't set up on this server" })).toBeVisible();
  await expect(page.getByTestId("audience-empty")).toBeVisible();
  await page.getByRole("link", { name: "Add a Subscribe block" }).click();
  await expect(page).toHaveURL(profileUrl);
  await page.locator("[data-hydrated]").waitFor();

  await page.getByRole("group", { name: "Add block" }).getByRole("button", { name: "Subscribe", exact: true }).click();
  const card = page.getByTestId("block-card").and(page.locator('[data-block-type="subscribe"]')).filter({ visible: true });
  await expect(card.getByRole("note").filter({ hasText: "Email isn't set up on this server" })).toBeVisible();
  await card.getByLabel("Title").fill("Join the club");
  await card.getByLabel("Button label").fill("Sign me up");
  // The preview shows the block, inert.
  const preview = page.getByTestId("profile-preview").filter({ visible: true });
  await expect(preview.getByRole("button", { name: "Sign me up" })).toBeDisabled();
  await page.getByRole("button", { name: /^Publish/ }).click();
  await expect(status(page)).toContainText("Published");

  await page.goto(`/${HANDLE}`);
  await expect(page.getByText("Ada", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("form", { name: "Join the club" })).toHaveCount(0);

  await page.goto(`${profileUrl}/audience`);
  await expect(page.getByTestId("audience-none")).toHaveText("No sign-ups yet.");
});

test("with email, an unverified owner is told to verify, does so from the Account page, and only then can visitors sign up", async ({ page, browser }) => {
  // Before: no form on the public page.
  const before = await visitor(browser);
  await before.page.goto(`${MAIL}/${HANDLE}`);
  await expect(before.page.getByText("Ada", { exact: true }).first()).toBeVisible();
  await expect(before.page.getByRole("form", { name: "Join the club" })).toHaveCount(0);
  await before.context.close();

  // The session from MAIN works on MAIL (cookies are per host).
  await clearSink();
  await page.goto(`${MAIL}${new URL(profileUrl).pathname}/audience`);
  const note = page.getByRole("note").filter({ hasText: "Verify your email address to collect sign-ups" });
  await expect(note).toBeVisible();
  await note.getByRole("link", { name: "Verify on the Account page" }).click();
  await expect(page.getByText("Not verified.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Send verification link" }).click();
  await expect(page.getByText("We've sent a verification link.")).toBeVisible();

  await expect.poll(async () => (await sinkMessages()).filter((m) => m.to.includes(OWNER.email)).length, { timeout: 10_000 }).toBe(1);
  const text = (await sinkMessages()).find((m) => m.to.includes(OWNER.email))!.text;
  const token = decodeURIComponent(/\/verify-email#token=([^\s"<>&]+)/.exec(text)![1]);
  await page.goto(`${MAIL}/verify-email#token=${encodeURIComponent(token)}`);
  await page.getByRole("button", { name: "Verify my email" }).click();
  await expect(page.getByTestId("verify-verified")).toBeFocused();

  await page.goto(`${MAIL}${new URL(profileUrl).pathname}/audience`);
  await expect(page.getByRole("note").filter({ hasText: "Verify your email address" })).toHaveCount(0);
  const after = await visitor(browser);
  await after.page.goto(`${MAIL}/${HANDLE}`);
  await expect(after.page.getByRole("form", { name: "Join the club" })).toBeVisible();
  await after.context.close();
});

test("a visitor signs up and confirms from the email; the owner sees, exports and deletes the contact", async ({ page, browser }) => {
  await clearSink();
  await signUp(browser, FAN);
  const tokens = await tokensFor(FAN);
  expect((await sinkMessages())[0].raw).toMatch(/^Subject: Confirm your subscription\r?$/m);

  // Before confirming, the owner sees nothing to export.
  await page.goto(`${profileUrl}/audience`);
  await expect(page.getByText("0 confirmed contacts")).toBeVisible();
  await expect(page.getByRole("link", { name: "Export CSV" })).toHaveCount(0);

  const { context, page: linkPage } = await useLink(browser, "confirm", tokens.confirm);
  // The same link again (a fresh load, as from the email): already used.
  await linkPage.goto("about:blank");
  await linkPage.goto(`${MAIL}/subscribe/confirm#token=${encodeURIComponent(tokens.confirm)}`);
  await linkPage.getByRole("button", { name: "Confirm subscription" }).click();
  await expect(linkPage.getByTestId("subscribe-gone")).toBeFocused();
  // Without a token there's nothing to confirm.
  await linkPage.goto(`${MAIL}/subscribe/confirm`);
  await expect(linkPage.getByTestId("subscribe-gone")).toBeVisible();
  await context.close();

  await page.reload();
  await expect(page.getByText("1 confirmed contact", { exact: false })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: FAN });
  await expect(row.getByText("Confirmed")).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`${HANDLE}-contacts.csv`);
  const lines = (await readFile((await file.path())!, "utf8")).trimEnd().split("\r\n");
  expect(lines[0]).toBe("email,name,phone,note,source,confirmed_at,consent_text");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toMatch(new RegExp(`^${FAN.replace(/\./g, "\\.")},,,,block,\\d{4}-\\d{2}-\\d{2}T`));

  // Delete: cancel returns focus to the row's button; confirming removes the row and says so.
  const del = row.getByRole("button", { name: `Delete ${FAN}` });
  await del.click();
  await expect(page.getByRole("alertdialog", { name: `Delete ${FAN}?` })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(del).toBeFocused();
  await del.click();
  await page.getByRole("button", { name: "Delete contact" }).click();
  await expect(page.getByText(`Deleted ${FAN}.`)).toBeAttached();
  await expect(page.getByRole("row").filter({ hasText: FAN })).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("audience-none")).toBeVisible();
});

test("a confirmed subscriber removes themselves with the email's remove link", async ({ page, browser }) => {
  await clearSink();
  await signUp(browser, LEAVER);
  const tokens = await tokensFor(LEAVER);
  (await useLink(browser, "confirm", tokens.confirm)).context.close();

  await page.goto(`${profileUrl}/audience`);
  await expect(page.getByRole("row").filter({ hasText: LEAVER })).toBeVisible();

  const { context, page: linkPage } = await useLink(browser, "remove", tokens.remove);
  await linkPage.goto("about:blank");
  await linkPage.goto(`${MAIL}/subscribe/remove#token=${encodeURIComponent(tokens.remove)}`);
  await linkPage.getByRole("button", { name: "Remove my email" }).click();
  await expect(linkPage.getByTestId("subscribe-gone")).toBeFocused();
  await context.close();

  await page.reload();
  await expect(page.getByRole("row").filter({ hasText: LEAVER })).toHaveCount(0);
  await expect(page.getByTestId("audience-none")).toBeVisible();
});

test("phone width: the public form fits and its controls are large enough to tap", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 740 }, extraHTTPHeaders: { "x-forwarded-for": nextIp() } });
  const page = await context.newPage();
  await page.goto(`${MAIL}/${HANDLE}`);
  const form = page.getByRole("form", { name: "Join the club" });
  await expect(form).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  for (const control of [form.getByLabel("Email address"), form.getByRole("button", { name: "Sign me up" })]) {
    const box = (await control.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await context.close();
});
