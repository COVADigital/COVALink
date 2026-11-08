import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * Setup and sign-in browser workflows against the production build. Runs serially: setup must
 * happen before sign-in. Every test fails if the page logs a CSP violation or
 * an uncaught error (see fixtures.ts).
 */
test.describe.configure({ mode: "serial" });

const OWNER = { name: "Owner Person", email: "owner@example.com", password: "correct-horse-battery" };
const MEMBER = { name: "Member Person", email: "member@example.com", password: "another-good-password" };

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function hasVisibleFocusRing(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    const s = getComputedStyle(el);
    const ring = s.boxShadow !== "none" && s.boxShadow !== "";
    const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
    return el.matches(":focus-visible") && (ring || outline);
  });
}

test("setup rejects a wrong token with an announced error and creates nothing", async ({ page }) => {
  await page.goto("/setup");
  await page.locator("#token").fill("x".repeat(40));
  await page.locator("#name").fill(OWNER.name);
  await page.locator("#email").fill(OWNER.email);
  await page.locator("#password").fill(OWNER.password);
  await page.locator("#confirm").fill(OWNER.password);
  await page.getByRole("button", { name: "Create administrator" }).click();
  await expect(page.locator("form [role=alert]")).toHaveText("The setup token is not valid.");
  await expect(page.locator("#token")).toHaveAttribute("aria-invalid", "true");
  await page.reload();
  await expect(page.getByRole("button", { name: "Create administrator" })).toBeVisible();
});

test("setup form creates the administrator via the server action", async ({ page }) => {
  await page.goto("/setup");
  await page.locator("#token").fill(process.env.E2E_SETUP_TOKEN!);
  await page.locator("#name").fill(OWNER.name);
  await page.locator("#email").fill(OWNER.email);
  await page.locator("#password").fill(OWNER.password);
  await page.locator("#confirm").fill(OWNER.password);
  await page.getByRole("button", { name: "Create administrator" }).click();
  await expect(page.getByRole("status")).toContainText("administrator account is ready");

  await page.goto("/setup");
  await expect(page.getByRole("status")).toContainText("already set up");
  await expect(page.locator("#token")).toHaveCount(0);
});

test("keyboard navigation reaches the login fields with a visible focus indicator", async ({ page }) => {
  await page.goto("/login");
  for (let i = 0; i < 6 && !(await page.locator("#email").evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Tab");
  }
  await expect(page.locator("#email")).toBeFocused();
  expect(await hasVisibleFocusRing(page, "#email")).toBe(true);

  await page.keyboard.press("Tab");
  await expect(page.locator("#password")).toBeFocused();
  await page.keyboard.press("Tab");
  const submit = page.getByRole("button", { name: "Sign in" });
  await expect(submit).toBeFocused();
  expect(await submit.evaluate((el) => el.matches(":focus-visible") && getComputedStyle(el).boxShadow !== "none")).toBe(true);
});

test("invalid login shows an announced error and stays signed out", async ({ page }) => {
  await signIn(page, OWNER.email, "definitely-wrong-password");
  await expect(page.locator("form [role=alert]")).toHaveText("Incorrect email or password.");
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);
});

test("valid login shows the dashboard identity, survives reload, and logs out", async ({ page }) => {
  await signIn(page, OWNER.email, OWNER.password);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId("user-email")).toContainText(OWNER.email);
  await expect(page.getByTestId("user-name")).toHaveText(OWNER.name);
  await expect(page.getByTestId("user-role")).toHaveAttribute("data-role", "super_admin");
  await expect(page.getByRole("link", { name: "Administration" })).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("user-email")).toContainText(OWNER.email);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
});

test("registration validates inline, then signs the new user in as an ordinary user", async ({ page }) => {
  await page.goto("/register");
  await page.locator("#name").fill(MEMBER.name);
  await page.locator("#email").fill(MEMBER.email);
  await page.locator("#password").fill(MEMBER.password);
  await page.locator("#confirm").fill("not-the-same-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator("#confirm")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#confirm-error")).toHaveText("Passwords don't match");

  await page.locator("#confirm").fill(MEMBER.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId("user-email")).toContainText(MEMBER.email);
  await expect(page.getByTestId("user-role")).toHaveAttribute("data-role", "user");
  await expect(page.getByRole("link", { name: "Administration" })).toHaveCount(0);

  await page.goto("/admin");
  await expect(page).toHaveURL(/\/dashboard\?denied=1$/);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("don't have access");
});

test.describe("mobile viewport", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("login and dashboard fit a phone screen without horizontal scrolling", async ({ page }) => {
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    await page.goto("/login");
    expect(await noOverflow()).toBe(true);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeInViewport();

    await signIn(page, MEMBER.email, MEMBER.password);
    await expect(page).toHaveURL(/\/dashboard$/);
    expect(await noOverflow()).toBe(true);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeInViewport();
    await expect(page.getByTestId("user-email")).toBeVisible();
  });
});
