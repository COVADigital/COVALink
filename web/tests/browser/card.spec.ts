import type { Browser } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { expect, test } from "./fixtures";

/**
 * Browser workflows for the business card. On MAIN the owner styles, saves and
 * downloads the card. On MAIL (:3103, SMTP to the runner's sink, same
 * database) the owner verifies their email and turns on both extras; a visitor
 * who opens the page from the card's QR link (`?src=card`) sees the panel,
 * saves the contact and shares their details, confirms from the email, and the
 * owner sees them in Audience as "Business card". A normal visit shows no
 * panel. Serial: steps build on each other. Every test also fails on CSP
 * violations or page errors (fixtures.ts).
 */
test.describe.configure({ mode: "serial" });

const MAIL = process.env.E2E_MAIL_BASE_URL!;
const SINK = process.env.E2E_MAIL_URL!;
const OWNER = { name: "Ada Card", email: "card-owner@example.com", password: "card-password-123" };
const HANDLE = "cardpage";
const VISITOR = "card-visitor@example.com";
let ip = 0;
const nextIp = () => `198.51.140.${++ip}`;
let profileUrl = "";

interface SinkMessage {
  to: string[];
  raw: string;
  text: string;
}
const sinkMessages = async (): Promise<SinkMessage[]> => (await fetch(`${SINK}/messages`)).json();
const clearSink = () => fetch(`${SINK}/messages`, { method: "DELETE" });
async function linkFor(to: string, path: string) {
  await expect.poll(async () => (await sinkMessages()).filter((m) => m.to.includes(to)).length, { timeout: 10_000 }).toBe(1);
  const { text } = (await sinkMessages()).find((m) => m.to.includes(to))!;
  return { text, token: decodeURIComponent(new RegExp(`${path}#token=([^\\s"<>&]+)`).exec(text)![1]) };
}

/** A signed-out visitor on MAIL with its own client address. */
async function visitor(browser: Browser, viewport?: { width: number; height: number }) {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": nextIp() }, ...(viewport && { viewport }) });
  return { context, page: await context.newPage() };
}

test.beforeAll(async ({ browser, baseURL }: { browser: Browser; baseURL?: string }) => {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.141.1" } });
  const page = await context.newPage();
  await page.goto("/setup");
  if (await page.locator("#token").count()) {
    await page.locator("#token").fill(process.env.E2E_SETUP_TOKEN!);
    await page.locator("#name").fill("Setup Owner");
    await page.locator("#email").fill("card-admin@example.com");
    await page.locator("#password").fill("correct-horse-battery");
    await page.locator("#confirm").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Create administrator" }).click();
    await expect(page.getByRole("status")).toContainText("ready");
  }
  const res = await page.request.post("/api/auth/sign-up/email", { data: OWNER, headers: { origin: baseURL!, "x-forwarded-for": nextIp() } });
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

test("the owner styles the card, and the saved name and colour come back after a reload and in the download", async ({ page }) => {
  await page.goto("/dashboard/profiles");
  await page.locator("#handle").fill(HANDLE);
  await page.locator("#label").fill("Card");
  await page.locator("#displayName").fill("Ada");
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page).toHaveURL(/\/dashboard\/profiles\/[0-9a-f-]{36}$/);
  profileUrl = page.url();
  await page.locator("[data-hydrated]").waitFor();
  await page.getByRole("button", { name: /^Publish/ }).click();
  await expect(page.getByTestId("editor-status").filter({ visible: true })).toContainText("Published");

  await page.goto("/dashboard/audience");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Business card" }).click();
  await expect(page).toHaveURL(`${profileUrl}/card`);
  await expect(page.getByRole("heading", { level: 1, name: "Business card" })).toBeVisible();
  await expect(page.getByTestId("card-preview")).toHaveAttribute("alt", "Business card preview: Ada");

  await page.getByLabel("Display name").fill("Ada Card");
  await page.getByRole("radio", { name: "Navy" }).click();
  await expect(page.getByTestId("card-preview")).toHaveAttribute("alt", "Business card preview: Ada Card");
  await expect(page.getByText("Save to download your changes.")).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("card-download")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Display name")).toHaveValue("Ada Card");
  await expect(page.getByRole("radio", { name: "Navy" })).toBeChecked();

  const download = page.waitForEvent("download");
  await page.getByTestId("card-download").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`covalink-${HANDLE}-card.svg`);
  const svg = await readFile((await file.path())!, "utf8");
  expect(svg).toContain(">Ada Card</text>");
  expect(svg).toContain('fill="#1e3a8a"');

  // With both extras off, the public page carries nothing of the card, not even its name.
  const html = await (await page.request.get(`/${HANDLE}?src=card`)).text();
  expect(html).not.toContain("Ada Card");
});

test("with email, the verified owner turns on sharing back and Save contact (which asks for contact details first)", async ({ page }) => {
  // Verify the owner's email on MAIL; the session from MAIN works there (cookies are per host).
  await clearSink();
  await page.goto(`${MAIL}/dashboard/account`);
  await page.getByRole("button", { name: "Send verification link" }).click();
  await expect(page.getByText("We've sent a verification link.")).toBeVisible();
  const { token } = await linkFor(OWNER.email, "/verify-email");
  await page.goto(`${MAIL}/verify-email#token=${encodeURIComponent(token)}`);
  await page.getByRole("button", { name: "Verify my email" }).click();
  await expect(page.getByTestId("verify-verified")).toBeFocused();

  await page.goto(`${MAIL}${new URL(profileUrl).pathname}/card`);
  const share = page.getByRole("switch", { name: "Let visitors share their details back" });
  await share.click();
  await expect(share).toBeChecked();
  // Sign-ups can run on MAIL, so no setup note is shown.
  await expect(page.getByTestId("card-row-share").getByRole("note")).toHaveCount(0);

  const save = page.getByRole("switch", { name: "Let visitors save your contact" });
  // The owner is told the details become public, not card-only.
  await expect(page.getByTestId("card-row-contact")).toContainText("anyone who visits your page can download these details");
  await save.click();
  await expect(save).not.toBeChecked();
  const form = page.getByRole("form", { name: "Contact details" });
  await form.getByLabel("Email").fill("not-an-email");
  await form.getByRole("button", { name: "Save and turn on" }).click();
  await expect(form.getByText("Enter a valid email address")).toBeVisible();
  await expect(save).not.toBeChecked();
  await form.getByLabel("First name").fill("Ada");
  await form.getByLabel("Last name").fill("Card");
  await form.getByLabel("Email").fill("ada@example.com");
  await form.getByLabel("Phone").fill("+1 555 010 0100");
  await form.getByRole("button", { name: "Save and turn on" }).click();
  await expect(save).toBeChecked();
  await expect(page.getByRole("button", { name: "Edit contact details" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("switch", { name: "Let visitors share their details back" })).toBeChecked();
  await expect(page.getByRole("switch", { name: "Let visitors save your contact" })).toBeChecked();

  // Editing the details while Save contact is off keeps it off.
  const saveSwitch = page.getByRole("switch", { name: "Let visitors save your contact" });
  await saveSwitch.click();
  await expect(saveSwitch).not.toBeChecked();
  await page.getByRole("button", { name: "Edit contact details" }).click();
  const edit = page.getByRole("form", { name: "Contact details" });
  await expect(edit.getByRole("button", { name: "Save and turn on" })).toHaveCount(0);
  await edit.getByLabel("Job title").fill("Engineer");
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit contact details" })).toBeVisible();
  await page.reload();
  await expect(saveSwitch).not.toBeChecked();
  await saveSwitch.click();
  await expect(saveSwitch).toBeChecked();
});

test("a visitor who scans the card saves the contact and shares their details; the owner sees them in Audience", async ({ page, browser }) => {
  // A normal visit: no panel.
  const plain = await visitor(browser);
  await plain.page.goto(`${MAIL}/${HANDLE}`);
  await expect(plain.page.getByRole("heading", { level: 1, name: "Ada" })).toBeVisible();
  await expect(plain.page.getByTestId("card-welcome")).toHaveCount(0);
  await plain.context.close();

  await clearSink();
  const { context, page: scan } = await visitor(browser);
  await scan.goto(`${MAIL}/${HANDLE}?src=card`);
  const panel = scan.getByRole("region", { name: "From Ada Card's business card" });
  await expect(panel).toBeVisible();
  await expect.poll(() => scan.url()).toBe(`${MAIL}/${HANDLE}`); // The source leaves the address bar.

  const download = scan.waitForEvent("download");
  await panel.getByRole("link", { name: "Save Ada Card's contact" }).click();
  const vcf = await download;
  expect(vcf.suggestedFilename()).toMatch(/\.vcf$/);
  const card = await readFile((await vcf.path())!, "utf8");
  expect(card).toContain("FN:Ada Card");
  expect(card).toContain("EMAIL:ada@example.com");
  expect(card).toContain("TEL;VALUE=uri:tel:+15550100100");

  const form = panel.getByRole("form", { name: "Share your details with Ada Card" });
  await form.getByLabel("Your name").fill("Vera Visitor");
  await form.getByLabel("Email address").fill(VISITOR);
  await form.getByLabel("Phone number (optional)").fill("+1 555 010 0200");
  await form.getByLabel("Note (optional)").fill("Met at the fair");
  await form.getByRole("button", { name: "Send" }).click();
  await expect(form.getByRole("status")).toContainText("check your inbox");
  await context.close();

  const { text, token } = await linkFor(VISITOR, "/auth/subscribe/confirm");
  expect(text).toContain("business card");
  const confirm = await visitor(browser);
  // If the details can't be loaded, confirming isn't offered; trying again loads them.
  await confirm.page.route("**/api/subscribe/confirm", (route) => route.abort(), { times: 1 });
  await confirm.page.goto(`${MAIL}/auth/subscribe/confirm#token=${encodeURIComponent(token)}`);
  await expect(confirm.page.getByRole("button", { name: "Confirm subscription" })).toHaveCount(0);
  await confirm.page.getByRole("button", { name: "Try again" }).click();
  // What confirming shares is shown first.
  const preview = confirm.page.getByTestId("subscribe-preview");
  await expect(preview).toContainText(`/${HANDLE}`);
  await expect(preview).toContainText("Vera Visitor");
  await expect(preview).toContainText("+15550100200");
  await expect(preview).toContainText("Met at the fair");
  await confirm.page.getByRole("button", { name: "Confirm subscription" }).click();
  await expect(confirm.page.getByTestId("subscribe-done")).toBeFocused();
  await confirm.context.close();

  await page.goto(`${profileUrl}/audience`);
  const row = page.getByRole("row").filter({ hasText: VISITOR });
  await expect(row).toContainText("Vera Visitor");
  await expect(row).toContainText("+15550100200");
  await expect(row).toContainText("Met at the fair");
  await expect(row).toContainText("Business card");
  await expect(row.getByText("Confirmed")).toBeVisible();
});

test("phone width: the card page and the scan panel fit, and the panel's controls are large enough to tap", async ({ page, browser }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto(`${profileUrl}/card`);
  await expect(page.getByTestId("card-preview")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  const { context, page: scan } = await visitor(browser, { width: 375, height: 740 });
  await scan.goto(`${MAIL}/${HANDLE}?src=card`);
  const panel = scan.getByTestId("card-welcome");
  await expect(panel).toBeVisible();
  expect(await scan.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  for (const control of [
    panel.getByRole("link", { name: "Save Ada Card's contact" }),
    panel.getByLabel("Your name"),
    panel.getByRole("button", { name: "Send" }),
    panel.getByRole("button", { name: "Close" }),
  ]) {
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);
  await context.close();
});
