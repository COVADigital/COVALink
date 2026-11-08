import type { Browser, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * Browser workflows for account self-service: forgot/reset by email link
 * (fragment token removed from the address bar), the verification-required
 * sign-in with resend, verification after a click, the account page (account
 * name, password change), deletion with the typed phrase (cancel restores
 * focus; administrators see why they can't), and phone width.
 * MAIN is the normal E2E server (no SMTP); MAIL (:3103) requires verification
 * and sends through the runner's SMTP sink. Both share the E2E database, and
 * cookies are per host, so a session works on both.
 * Serial: steps build on each other. Every test also fails on CSP violations
 * or page errors (fixtures.ts).
 */
test.describe.configure({ mode: "serial" });

const MAIL = process.env.E2E_MAIL_BASE_URL!;
const SINK = process.env.E2E_MAIL_URL!;
const OWNER = { name: "Owner Person", email: "owner@example.com", password: "correct-horse-battery" };
const RESETTER = { name: "Rita Reset", email: "account-reset@example.com", password: "account-reset-password-1" };
const VERIFIER = { name: "Vera Verify", email: "account-verify@example.com", password: "account-verify-password-1" };
const ACCOUNT = { name: "Andy Account", email: "account-account@example.com", password: "account-account-password-1" };
const LEAVER = { name: "Lee Leaver", email: "account-leaver@example.com", password: "account-leaver-password-1" };
const NEW_PASSWORD = "account-a-brand-new-password";
let ip = 0;
const nextIp = () => `198.51.120.${++ip}`;

interface SinkMessage {
  to: string[];
  text: string;
}
const sinkMessages = async (): Promise<SinkMessage[]> => (await fetch(`${SINK}/messages`)).json();
const clearSink = () => fetch(`${SINK}/messages`, { method: "DELETE" });
async function latestToken(to: string, page: "/reset-password" | "/verify-email", count = 1) {
  await expect.poll(async () => (await sinkMessages()).filter((m) => m.to.includes(to)).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(count);
  const msg = (await sinkMessages()).filter((m) => m.to.includes(to)).at(-1)!;
  const m = new RegExp(`${page}#token=([^\\s"<>&]+)`).exec(msg.text);
  return decodeURIComponent(m![1]);
}

async function signIn(page: Page, baseURL: string, who: { email: string; password: string }) {
  await page.context().clearCookies();
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: who.email, password: who.password },
    headers: { origin: baseURL, "x-forwarded-for": nextIp() },
  });
  expect(res.status()).toBe(200);
}

test.beforeAll(async ({ browser, baseURL }: { browser: Browser; baseURL?: string }) => {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.121.1" } });
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
  // Created on MAIN, where verification isn't required.
  for (const who of [RESETTER, ACCOUNT, LEAVER]) {
    const res = await page.request.post("/api/auth/sign-up/email", {
      data: { name: who.name, email: who.email, password: who.password },
      headers: { origin: baseURL!, "x-forwarded-for": nextIp() },
    });
    expect(res.status()).toBe(200);
  }
  await context.close();
});

test("forgot and reset password by email link; the token leaves the address bar and works once", async ({ page, baseURL }) => {
  await page.context().clearCookies();
  // Without SMTP, the server says who can help instead.
  await page.goto("/login");
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page.getByTestId("reset-unavailable")).toContainText("Ask your administrator");

  await clearSink();
  await page.goto(`${MAIL}/forgot-password`);
  await page.getByLabel("Email").fill("not-an-email");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Email")).toBeFocused();
  await page.getByLabel("Email").fill(RESETTER.email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByTestId("reset-requested")).toBeFocused();
  const token = await latestToken(RESETTER.email, "/reset-password");

  await page.goto(`${MAIL}/reset-password#token=${encodeURIComponent(token)}`);
  await expect(page.getByLabel("New password", { exact: true })).toBeVisible();
  expect(page.url()).toBe(`${MAIL}/reset-password`);
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm new password").fill("something-else-entirely");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByLabel("Confirm new password")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Confirm new password")).toBeFocused();
  await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByTestId("reset-done")).toBeFocused();

  // The same link again (a fresh page load, as from the email): refused.
  await page.goto("about:blank");
  await page.goto(`${MAIL}/reset-password#token=${encodeURIComponent(token)}`);
  await page.getByLabel("New password", { exact: true }).fill(`${NEW_PASSWORD}-2`);
  await page.getByLabel("Confirm new password").fill(`${NEW_PASSWORD}-2`);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByTestId("reset-invalid")).toBeFocused();

  await page.goto("/login");
  await page.getByLabel("Email").fill(RESETTER.email);
  await page.getByLabel("Password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${baseURL}/dashboard`);
});

test("verification required: sign-in offers a resend, and the link verifies after a click", async ({ page }) => {
  await page.context().clearCookies();
  await clearSink();
  const res = await page.request.post(`${MAIL}/api/auth/sign-up/email`, {
    data: { name: VERIFIER.name, email: VERIFIER.email, password: VERIFIER.password },
    headers: { origin: MAIL, "x-forwarded-for": nextIp() },
  });
  expect(res.status()).toBe(200);
  await latestToken(VERIFIER.email, "/verify-email");

  await page.goto(`${MAIL}/login`);
  await page.getByLabel("Email").fill(VERIFIER.email);
  await page.getByLabel("Password").fill(VERIFIER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Verify your email to sign in" })).toBeFocused();
  await page.getByRole("button", { name: "Send a new verification link" }).click();
  await expect(page.getByRole("status")).toContainText("we've sent a new link");
  await expect(page.getByRole("status")).toBeFocused();
  const token = await latestToken(VERIFIER.email, "/verify-email", 2);

  await page.goto(`${MAIL}/verify-email`);
  await expect(page.getByTestId("verify-invalid")).toBeVisible();

  await page.goto("about:blank");
  await page.goto(`${MAIL}/verify-email#token=${encodeURIComponent(token)}`);
  const verify = page.getByRole("button", { name: "Verify my email" });
  await expect(verify).toBeVisible();
  expect(page.url()).toBe(`${MAIL}/verify-email`);
  await verify.click();
  await expect(page.getByTestId("verify-verified")).toBeFocused();
  await page.getByRole("link", { name: "Go to your dashboard" }).click();
  await expect(page.getByTestId("user-email")).toContainText(VERIFIER.email);
});

test("account page: the account name and password change with validation, announcements and persistence", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, ACCOUNT);
  await page.goto("/dashboard");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Account" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();

  const name = page.getByRole("textbox", { name: "Account name" });
  await expect(name).toHaveValue(ACCOUNT.name);
  await name.fill("   ");
  await page.getByRole("button", { name: "Save account name" }).click();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toBeFocused();
  await name.fill("  Andy Renamed  ");
  await page.getByRole("button", { name: "Save account name" }).click();
  await expect(page.getByText("Account name saved.")).toBeFocused();
  await page.reload();
  await expect(name).toHaveValue("Andy Renamed");

  await expect(page.getByLabel("Sign out my other devices")).toBeChecked();
  await page.getByLabel("Current password").fill("not-my-password-at-all");
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByLabel("Current password")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Current password")).toBeFocused();
  await page.getByLabel("Current password").fill(ACCOUNT.password);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Password changed. Your other devices have been signed out.")).toBeFocused();
  // This browser keeps a working session.
  await page.reload();
  await expect(name).toHaveValue("Andy Renamed");
});

test("account deletion needs the typed phrase; cancel restores focus; administrators see why they can't", async ({ page, baseURL }) => {
  await signIn(page, baseURL!, OWNER);
  await page.goto("/dashboard/account");
  await expect(page.getByText("The super administrator account can't be deleted.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete account" })).toBeDisabled();

  await signIn(page, baseURL!, LEAVER);
  await page.goto("/dashboard/account");
  const opener = page.getByRole("button", { name: "Delete account…" });
  await opener.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Delete your account?");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();

  await opener.click();
  await dialog.getByLabel("Password").fill(LEAVER.password);
  await dialog.getByLabel('Type "delete my account"').fill("delete");
  await dialog.getByRole("button", { name: "Delete my account" }).click();
  await expect(dialog.getByLabel('Type "delete my account"')).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByLabel('Type "delete my account"')).toBeFocused();
  await dialog.getByLabel('Type "delete my account"').fill("delete my account");
  await dialog.getByLabel("Password").fill("not-the-password");
  await dialog.getByRole("button", { name: "Delete my account" }).click();
  await expect(dialog.getByLabel("Password")).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByLabel("Password")).toBeFocused();
  await dialog.getByLabel("Password").fill(LEAVER.password);
  await dialog.getByRole("button", { name: "Delete my account" }).click();
  await expect(page).toHaveURL(`${baseURL}/login?account=deleted`);
  await expect(page.getByRole("status")).toHaveText("Your account has been deleted.");

  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: LEAVER.email, password: LEAVER.password },
    headers: { origin: baseURL!, "x-forwarded-for": nextIp() },
  });
  expect(res.status()).toBe(401);
});

test("phone width: account and token pages fit and have 44 px targets", async ({ page, baseURL }) => {
  // The account test above changed this password.
  await signIn(page, baseURL!, { ...ACCOUNT, password: NEW_PASSWORD });
  await page.setViewportSize({ width: 390, height: 844 });
  const pages = [
    `${baseURL}/login`,
    `${baseURL}/forgot-password`,
    `${MAIL}/forgot-password`,
    `${MAIL}/reset-password#token=phone-width-check`,
    `${MAIL}/verify-email#token=phone-width-check`,
    `${baseURL}/dashboard/account`,
  ];
  for (const url of pages) {
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    await page.locator("main button, main a").first().waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), url).toBeLessThanOrEqual(0);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll("main button, main select, main input:not([type=hidden]):not([type=checkbox]), main label:has(input[type=checkbox])")]
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => [el.textContent?.trim() || el.getAttribute("name") || el.tagName, Math.round(el.getBoundingClientRect().height)] as const)
        .filter(([, h]) => h < 44),
    );
    expect(small, url).toEqual([]);
  }
  // The deletion dialog at phone width.
  await page.goto("/dashboard/account");
  await page.getByRole("button", { name: "Delete account…" }).click();
  const heights = await page.getByRole("alertdialog").evaluate((d) =>
    // Layout height: the opening animation scales the dialog, which would distort bounding boxes.
    [...d.querySelectorAll("button, input")].filter((el) => (el as HTMLElement).offsetParent !== null).map((el) => (el as HTMLElement).offsetHeight),
  );
  for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
