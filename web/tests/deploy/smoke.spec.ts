import { writeFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import * as img from "../support/images";
import { expect, test } from "../browser/fixtures";

/**
 * Deployment smoke: the product workflow in a real browser against the
 * production Compose stack (tests/deploy/smoke.mjs starts it). One serial
 * test so the stack's shared sign-in rate limit (TRUST_PROXY=false) isn't hit.
 * Writes what later checks need (handle, avatar URL, credentials) to
 * SMOKE_STATE_FILE.
 */
const OWNER = { name: "Smoke Owner", email: "smoke-owner@example.com", password: "smoke-owner-password-1" };
const CREATOR = { name: "Smoke Creator", email: "smoke-creator@example.com", password: "smoke-creator-password-1" };
const HANDLE = "smokepage";

/** Visible matches only: with Cache Components the previous route stays mounted but hidden (React <Activity>). */
const field = (page: Page, id: string) => page.locator(`#${id}`).filter({ visible: true });
const status = (page: Page) => page.getByTestId("editor-status").filter({ visible: true });
const picker = (page: Page) => page.getByTestId("media-avatar").filter({ visible: true });
const loaded = (el: Locator) => el.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0);
const publicStatus = async (page: Page) => (await page.request.get(`/${HANDLE}`, { maxRedirects: 0 })).status();

test("setup, accounts, profile editing, avatar upload, publish and cache invalidation", async ({ page, context }) => {
  test.setTimeout(180_000);

  await test.step("first-time setup with the setup token", async () => {
    await page.goto("/setup");
    await page.locator("#token").fill(process.env.SMOKE_SETUP_TOKEN!);
    await page.locator("#name").fill(OWNER.name);
    await page.locator("#email").fill(OWNER.email);
    await page.locator("#password").fill(OWNER.password);
    await page.locator("#confirm").fill(OWNER.password);
    await page.getByRole("button", { name: "Create administrator" }).click();
    await expect(page.getByRole("status")).toContainText("ready");
  });

  await test.step("registration signs a new user in", async () => {
    await page.goto("/register");
    await page.locator("#name").fill(CREATOR.name);
    await page.locator("#email").fill(CREATOR.email);
    await page.locator("#password").fill(CREATOR.password);
    await page.locator("#confirm").fill(CREATOR.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  await test.step("sign out, then sign in again", async () => {
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
    await page.locator("#email").fill(CREATOR.email);
    await page.locator("#password").fill(CREATOR.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  let avatarUrl = "";
  await test.step("create and edit a profile; drafts stay private", async () => {
    await page.getByRole("link", { name: "Create a profile" }).click();
    await page.locator("#handle").fill(HANDLE);
    await page.locator("#label").fill("Main");
    await page.locator("#displayName").fill("Smoke Casey");
    await page.getByRole("button", { name: "Create profile" }).click();
    await expect(page).toHaveURL(/\/dashboard\/profiles\/[0-9a-f-]{36}$/);
    await page.locator("[data-hydrated]").waitFor();
    await field(page, "bio").fill("Served from the production image");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(status(page)).toHaveText("Draft saved.");
    expect(await publicStatus(page)).toBe(404);
  });

  await test.step("upload an avatar, publish, and render the public page", async () => {
    await page.getByTestId("media-file-avatar").setInputFiles({ name: "portrait.png", mimeType: "image/png", buffer: await img.png(900, 700, "#cc3366") });
    await expect(picker(page).getByTestId("media-status")).toContainText("Uploaded and selected");
    avatarUrl = (await picker(page).getByTestId("media-item").first().getAttribute("data-url"))!;
    expect(avatarUrl).toMatch(/^\/media\/[0-9a-f-]{36}\.webp$/);
    await page.getByRole("button", { name: /^Publish/ }).click();
    await expect(status(page)).toContainText("Published");

    const visitor = await context.newPage();
    expect((await visitor.goto(`/${HANDLE}`))?.status()).toBe(200);
    await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Smoke Casey");
    await expect(visitor.getByTestId("profile-bio").filter({ visible: true })).toHaveText("Served from the production image");
    const avatar = visitor.locator(".pp-avatar");
    await expect(avatar).toHaveAttribute("src", avatarUrl);
    await expect.poll(() => loaded(avatar)).toBe(true);
    await visitor.close();
  });

  await test.step("publishing changes and unpublishing invalidate the public page", async () => {
    const visitor = await context.newPage();
    await field(page, "displayName").fill("Smoke Casey v2");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(status(page)).toContainText("Draft saved.");
    await visitor.goto(`/${HANDLE}`);
    await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Smoke Casey");

    await page.getByRole("button", { name: "Publish changes" }).click();
    await expect(status(page)).toContainText("Published");
    await visitor.reload();
    await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Smoke Casey v2");

    await page.getByRole("button", { name: "Unpublish" }).click();
    await expect(status(page)).toContainText("no longer available");
    expect(await publicStatus(page)).toBe(404);
    await page.getByRole("button", { name: /^Publish/ }).click();
    await expect(status(page)).toContainText("Published");
    expect(await publicStatus(page)).toBe(200);
    await visitor.reload();
    await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Smoke Casey v2");
    await visitor.close();
  });

  writeFileSync(
    process.env.SMOKE_STATE_FILE!,
    JSON.stringify({
      handle: HANDLE,
      displayName: "Smoke Casey v2",
      avatarUrl,
      email: CREATOR.email,
      password: CREATOR.password,
      // The super administrator, for the admin-console checks.
      ownerEmail: OWNER.email,
      ownerPassword: OWNER.password,
    }),
    { mode: 0o600 },
  );
});
