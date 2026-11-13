import type { Browser, Locator, Page } from "@playwright/test";
import { config } from "dotenv";
import postgres from "postgres";
import { assertTestDatabaseMarker, assertTestDatabaseUrl } from "../../scripts/test-db-guard.mjs";
import { expect, test } from "./fixtures";

/**
 * Browser workflows for content blocks: add/edit with inline validation,
 * keyboard reordering with focus management (canonical Move up/down
 * controls), pointer and keyboard drag (dnd-kit enhancement), hide/duplicate/
 * delete, persistence across reloads, publication isolation, discard, a
 * two-tab conflict and a phone-size check. Serial: steps build on each other.
 * Lookups filter to visible elements because Next.js keeps the previous route
 * mounted but hidden (React <Activity>).
 */
test.describe.configure({ mode: "serial" });

const EDITOR = { name: "Blake Blocks", email: "blocks-editor@example.com", password: "blocks-password-123" };
const HANDLE = "blockpage";
let signInCount = 0;
let editorUrl = "";

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/setup");
  if (await page.locator("#token").count()) {
    await page.locator("#token").fill(process.env.E2E_SETUP_TOKEN!);
    await page.locator("#name").fill("Setup Owner");
    await page.locator("#email").fill("content-owner@example.com");
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
    headers: { origin: baseURL!, "x-forwarded-for": `198.51.101.${++signInCount}` },
  });
  expect(res.status()).toBe(200);
});

async function openEditor(page: Page, url = editorUrl) {
  await page.goto(url);
  await page.locator("[data-hydrated]").waitFor();
}

const list = (page: Page) => page.getByTestId("block-list").filter({ visible: true });
const cards = (page: Page) => list(page).getByTestId("block-card");
const card = (page: Page, label: string) => cards(page).filter({ has: page.getByTestId("block-label").getByText(label, { exact: true }) });
const labels = (page: Page) => list(page).getByTestId("block-label").allTextContents();
const status = (page: Page) => page.getByTestId("editor-status").filter({ visible: true });
const announcer = (page: Page) => page.getByTestId("blocks-announcer").filter({ visible: true });
const previewTypes = (page: Page) =>
  page.getByTestId("profile-preview").filter({ visible: true }).locator("[data-block-type]").evaluateAll((els) => els.map((e) => e.getAttribute("data-block-type")));
const addButton = (page: Page, name: string) => page.getByRole("group", { name: "Add block" }).getByRole("button", { name, exact: true });

async function expand(c: Locator) {
  const toggle = c.getByRole("button", { name: /^Edit / });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

async function saveDraft(page: Page) {
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(status(page)).toContainText("Draft saved");
}

test("adds blocks of all four types with inline validation, and they persist in order", async ({ page }) => {
  await page.goto("/dashboard/profiles");
  await page.locator("#handle").fill(HANDLE);
  await page.locator("#label").fill("Blocks");
  await page.locator("#displayName").fill("Blake");
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page).toHaveURL(/\/dashboard\/profiles\/[0-9a-f-]{36}$/);
  editorUrl = page.url();
  await page.locator("[data-hydrated]").waitFor();
  await expect(page.getByTestId("blocks-empty").filter({ visible: true })).toBeVisible();

  await addButton(page, "Link").click();
  const title = page.locator('[id^="blk-"][id$="-title"]');
  await expect(title).toBeFocused();
  await title.fill("Shop");
  const url = page.locator('[id^="blk-"][id$="-url"]');
  await url.fill("javascript:alert(1)");
  await url.blur();
  await expect(url).toHaveAttribute("aria-invalid", "true");
  await expect(card(page, "Shop").getByText("Enter a valid http(s) address, like example.com")).toBeVisible();
  await expect(page.getByTestId("profile-preview").filter({ visible: true })).toContainText("Incomplete link");

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Some blocks need attention" })).toBeVisible();
  await expect(url).toBeFocused();
  await url.fill("shop.example.com");
  await expect(url).not.toHaveAttribute("aria-invalid", "true");

  await addButton(page, "Heading").click();
  await page.locator('[id^="blk-"][id$="-text"]').fill("My links");
  await addButton(page, "Text").click();
  await page.locator('[id^="blk-"][id$="-markdown"]').fill("Hello **world**");
  await addButton(page, "Divider").click();

  expect(await labels(page)).toEqual(["Shop", "My links", "Hello **world**", "Divider"]);
  expect(await previewTypes(page)).toEqual(["link", "heading", "text", "divider"]);
  await expect(page.getByTestId("profile-preview").filter({ visible: true }).getByRole("link", { name: "Shop" })).toHaveAttribute(
    "target",
    "_blank",
  );

  await saveDraft(page);
  await expect(page.getByTestId("unsaved-indicator").filter({ visible: true })).toHaveCount(0);
  await page.reload();
  await page.locator("[data-hydrated]").waitFor();
  expect(await labels(page)).toEqual(["Shop", "My links", "Hello **world**", "Divider"]);
  await expand(card(page, "Shop"));
  await expect(page.locator('[id^="blk-"][id$="-url"]')).toHaveValue("https://shop.example.com/");
  expect((await page.request.get(`/${HANDLE}`, { maxRedirects: 0 })).status()).toBe(404);
});

test("reorders with Move up / Move down from the keyboard, keeping focus and announcing the move", async ({ page }) => {
  await openEditor(page);
  const upHeading = page.getByRole("button", { name: "Move “My links” up" });
  await upHeading.focus();
  await page.keyboard.press("Enter");
  expect(await labels(page)).toEqual(["My links", "Shop", "Hello **world**", "Divider"]);
  // At the top, Move up is disabled, so focus moves to the block's Move down.
  await expect(upHeading).toBeDisabled();
  await expect(page.getByRole("button", { name: "Move “My links” down" })).toBeFocused();
  await expect(announcer(page)).toHaveText("Moved “My links” to position 1 of 4.");

  const upDivider = page.getByRole("button", { name: "Move “Divider” up" });
  await upDivider.focus();
  await page.keyboard.press("Enter");
  await expect(upDivider).toBeFocused();
  await page.keyboard.press("Space");
  expect(await labels(page)).toEqual(["My links", "Divider", "Shop", "Hello **world**"]);
  await expect(upDivider).toBeFocused();
  expect(await previewTypes(page)).toEqual(["heading", "divider", "link", "text"]);
  await expect(page.getByTestId("unsaved-indicator").filter({ visible: true })).toBeVisible();

  await saveDraft(page);
  await page.reload();
  await page.locator("[data-hydrated]").waitFor();
  expect(await labels(page)).toEqual(["My links", "Divider", "Shop", "Hello **world**"]);
});

test("reorders by pointer drag (progressive enhancement)", async ({ page }) => {
  await openEditor(page);
  // Mouse coordinates are viewport-relative: bring the whole list on screen first.
  await page.getByRole("group", { name: "Add block" }).scrollIntoViewIfNeeded();
  await list(page).scrollIntoViewIfNeeded();
  const handle = card(page, "Shop").getByTestId("block-drag-handle");
  const target = cards(page).first();
  const from = (await handle.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 10, { steps: 4 });
  await page.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => labels(page)).toEqual(["Shop", "My links", "Divider", "Hello **world**"]);
  await saveDraft(page);
  await page.reload();
  await page.locator("[data-hydrated]").waitFor();
  expect(await labels(page)).toEqual(["Shop", "My links", "Divider", "Hello **world**"]);
});

test("reorders by keyboard drag on the handle (Space, arrow, Space)", async ({ page }) => {
  await openEditor(page);
  // dnd-kit announces each step in its own live region; waiting for it also
  // gives dnd-kit time to measure the drop targets after pick-up.
  const dndStatus = page.locator('[id^="DndLiveRegion"]');
  await card(page, "Hello **world**").getByTestId("block-drag-handle").focus();
  await page.keyboard.press("Space");
  // "Picked up …" is immediately followed by the start position's "over" announcement.
  await expect(dndStatus).toHaveText("“Hello **world**” is over position 4 of 4.");
  await page.keyboard.press("ArrowUp");
  await expect(dndStatus).toHaveText("“Hello **world**” is over position 3 of 4.");
  await page.keyboard.press("Space");
  await expect(dndStatus).toHaveText("Dropped “Hello **world**” at position 3 of 4.");
  await expect.poll(() => labels(page)).toEqual(["Shop", "My links", "Hello **world**", "Divider"]);
  await saveDraft(page);
});

test("hides, duplicates and deletes blocks with sensible focus", async ({ page }) => {
  await openEditor(page);
  const preview = page.getByTestId("profile-preview").filter({ visible: true });

  const shop = card(page, "Shop");
  await expand(shop);
  await shop.getByLabel("Show on page").click();
  await expect(shop.getByTestId("block-hidden-badge")).toBeVisible();
  await expect(preview.getByRole("link", { name: "Shop" })).toHaveCount(0);
  expect(await previewTypes(page)).toEqual(["heading", "text", "divider"]);

  const heading = card(page, "My links");
  await expand(heading);
  await heading.getByRole("button", { name: "Duplicate “My links”" }).click();
  expect(await labels(page)).toEqual(["Shop", "My links", "My links", "Hello **world**", "Divider"]);
  const copy = cards(page).nth(2);
  await expect(copy.getByRole("button", { name: /^Edit / })).toBeFocused();
  await expect(announcer(page)).toHaveText("Duplicated “My links”. The copy is at position 3.");

  await expand(copy);
  await copy.getByRole("button", { name: "Delete “My links”" }).click();
  expect(await labels(page)).toEqual(["Shop", "My links", "Hello **world**", "Divider"]);
  // Focus goes to the block that took its place.
  await expect(card(page, "Hello **world**").getByRole("button", { name: /^Edit / })).toBeFocused();

  await saveDraft(page);
  await page.reload();
  await page.locator("[data-hydrated]").waitFor();
  expect(await labels(page)).toEqual(["Shop", "My links", "Hello **world**", "Divider"]);
  await expect(card(page, "Shop").getByTestId("block-hidden-badge")).toBeVisible();
});

test("publishing shows the editor's blocks publicly; drafts stay private; discard restores", async ({ page, context }) => {
  await openEditor(page);
  const shop = card(page, "Shop");
  await expand(shop);
  await shop.getByLabel("Show on page").click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(status(page)).toContainText("Published");
  const editorOrder = await previewTypes(page);
  expect(editorOrder).toEqual(["link", "heading", "text", "divider"]);

  const visitor = await context.newPage();
  expect((await visitor.goto(`/${HANDLE}`))?.status()).toBe(200);
  const publicOrder = await visitor.locator("main [data-block-type]").evaluateAll((els) => els.map((e) => e.getAttribute("data-block-type")));
  expect(publicOrder).toEqual(editorOrder);
  const link = visitor.getByRole("link", { name: "Shop" });
  // Published link blocks go through the tracked /go redirect.
  await expect(link).toHaveAttribute("href", /^\/go\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
  await expect(link).toHaveAttribute("rel", "noopener nofollow ugc");
  await expect(visitor.getByRole("heading", { level: 2, name: "My links" })).toBeVisible();
  await expect(visitor.locator("main strong")).toHaveText("world");

  const heading = card(page, "My links");
  await expand(heading);
  await page.locator('[id^="blk-"][id$="-text"]').fill("Secret heading");
  await saveDraft(page);
  await visitor.reload();
  await expect(visitor.getByRole("heading", { level: 2, name: "My links" })).toBeVisible();
  expect(await visitor.content()).not.toContain("Secret heading");

  await page.getByRole("button", { name: "Discard draft changes" }).click();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(status(page)).toContainText("Draft changes discarded");
  expect(await labels(page)).toEqual(["Shop", "My links", "Hello **world**", "Divider"]);
  await visitor.close();
});

test("a stale tab can't overwrite a newer block order and is offered a reload", async ({ page, context }) => {
  await openEditor(page);
  const other = await context.newPage();
  await openEditor(other);

  await other.getByRole("button", { name: "Move “Divider” up" }).click();
  await saveDraft(other);
  const saved = await labels(other);

  await page.getByRole("button", { name: "Move “Shop” down" }).click();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "changed somewhere else" })).toBeVisible();
  await page.getByRole("button", { name: "Reload latest version" }).click();
  await page.getByRole("button", { name: "Leave without saving" }).click();
  await page.locator("[data-hydrated]").waitFor();
  await expect.poll(() => labels(page)).toEqual(saved);
  await other.close();
});

/**
 * Writes a profile's stored draft directly (standing in for data from an older
 * version or another tool), through the same guards as global-setup.ts.
 */
async function seedDraftBlocks(handle: string, blocks: unknown[]) {
  // Workers inherit DATABASE_URL = the E2E database from global-setup, so read
  // the developer's real DATABASE_URL from .env for the "distinct from dev" check.
  const fileEnv: Record<string, string> = {};
  config({ path: ".env", quiet: true, processEnv: fileEnv });
  const { url } = assertTestDatabaseUrl(process.env.E2E_DATABASE_URL ?? fileEnv.E2E_DATABASE_URL, {
    devDatabaseUrl: fileEnv.DATABASE_URL ?? process.env.DATABASE_URL,
  });
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await assertTestDatabaseMarker(sql, new URL(url).pathname.slice(1));
    await sql`update profiles set draft = jsonb_set(draft, '{blocks}', ${sql.json(blocks as never)}) where handle = ${handle}`;
  } finally {
    await sql.end();
  }
}

test("keeps stored blocks it can't edit, and locks drafts it can't rewrite losslessly (unreadable or over 100 blocks)", async ({ page }) => {
  const legacy = "blocklegacy";
  await page.goto("/dashboard/profiles");
  await page.locator("#handle").fill(legacy);
  await page.locator("#label").fill("Legacy");
  await page.locator("#displayName").fill("Legacy Blake");
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page).toHaveURL(/\/dashboard\/profiles\/[0-9a-f-]{36}$/);
  const legacyUrl = page.url();

  const video = { id: "00000000-0000-4000-8000-000000000090", type: "video", version: 1, visible: true, config: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } };
  const v1Link = {
    id: "00000000-0000-4000-8000-000000000080",
    type: "link",
    version: 1,
    visible: true,
    config: { title: "Legacy link", url: "https://legacy.example.com/", icon: "star", featured: true },
  };
  await seedDraftBlocks(legacy, [video, v1Link]);
  await openEditor(page, legacyUrl);

  // A valid v1 video reads as an ordinary editable block, and its preview contacts no provider.
  expect(await labels(page)).toEqual(["Untitled video", "Legacy link"]);
  expect(await previewTypes(page)).toEqual(["video", "link"]);
  await expect(page.getByTestId("profile-preview").filter({ visible: true }).locator("iframe")).toHaveCount(0);

  await page.getByRole("button", { name: "Move “Untitled video” down" }).click();
  await saveDraft(page);
  await page.reload();
  await page.locator("[data-hydrated]").waitFor();
  expect(await labels(page)).toEqual(["Legacy link", "Untitled video"]);

  await expand(card(page, "Untitled video"));
  await card(page, "Untitled video").getByRole("button", { name: "Delete “Untitled video”" }).click();
  expect(await labels(page)).toEqual(["Legacy link"]);
  await saveDraft(page);

  await seedDraftBlocks(legacy, [{ id: "00000000-0000-4000-8000-000000000070", type: "future-widget", version: 1, visible: true, config: {} }]);
  await openEditor(page, legacyUrl);
  const notice = page.getByTestId("protected-blocks").filter({ visible: true });
  await expect(notice).toContainText("a block that this version of COVALink can't edit without losing data");
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  await page.locator("#bio").fill("Trying to save anyway");
  await expect(page.getByRole("button", { name: "Save draft" })).toBeDisabled();
  await expect(page.getByRole("group", { name: "Add block" }).getByRole("button", { name: "Link", exact: true })).toBeDisabled();

  // 101 individually valid blocks: the editor shows 100, so a full-list save would drop one. It's locked instead.
  const many = Array.from({ length: 101 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(1000 + i).padStart(12, "0")}`,
    type: "link",
    version: 2,
    visible: true,
    config: { title: `Overflow ${i + 1}`, url: `https://example.com/${i + 1}` },
  }));
  await seedDraftBlocks(legacy, many);
  await openEditor(page, legacyUrl);
  await expect(notice).toContainText("a block that this version");
  await expect(cards(page)).toHaveCount(100);
  await page.locator("#bio").fill("Trying to save anyway");
  await expect(page.getByRole("button", { name: "Save draft" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
});

test.describe("phone viewport", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the block editor and public page fit without horizontal scrolling", async ({ page }) => {
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    await openEditor(page);
    await expand(card(page, "Shop"));
    await expand(card(page, "My links"));
    expect(await noOverflow()).toBe(true);
    const moveDown = page.getByRole("button", { name: "Move “Shop” down" });
    await moveDown.scrollIntoViewIfNeeded();
    await expect(moveDown).toBeInViewport({ ratio: 1 });
    await page.goto(`/${HANDLE}`);
    await expect(page.getByRole("link", { name: "Shop" })).toBeVisible();
    expect(await noOverflow()).toBe(true);
  });
});
