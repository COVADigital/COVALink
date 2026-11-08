import { readFile } from "node:fs/promises";
import type { Browser, BrowserContext, Page, Response } from "@playwright/test";
import { config } from "dotenv";
import jsQR from "jsqr";
import postgres from "postgres";
import sharp from "sharp";
import { assertTestDatabaseMarker, assertTestDatabaseUrl } from "../../scripts/test-db-guard.mjs";
import { expect, test } from "./fixtures";

/**
 * Analytics browser workflows: a published link and a Markdown link, a visitor's
 * real beacon (after hydration) and click-through via /go, the QR source,
 * owner exclusion, the owner's analytics dashboard (ranges, accessible
 * tables and chart, empty and loading states, phone width) and the QR SVG
 * download decoded by an independent decoder. Visitors use Playwright's
 * Desktop Edge user agent (not a headless one) and distinct X-Forwarded-For
 * addresses (the E2E server trusts the proxy headers), so their views get
 * visitor hashes. Serial: steps build on each other.
 */
test.describe.configure({ mode: "serial" });

const EDITOR = { name: "Ava Analytics", email: "analytics-editor@example.com", password: "analytics-password-123" };
const HANDLE = "m7page";
let signInCount = 0;
let profileId = "";
let destination = "";

/** Guarded access to the E2E database (same checks as global-setup.ts). */
async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const fileEnv: Record<string, string> = {};
  config({ path: ".env", quiet: true, processEnv: fileEnv });
  const { url } = assertTestDatabaseUrl(process.env.E2E_DATABASE_URL ?? fileEnv.E2E_DATABASE_URL, { devDatabaseUrl: fileEnv.DATABASE_URL ?? process.env.DATABASE_URL });
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await assertTestDatabaseMarker(sql, new URL(url).pathname.slice(1));
    return await fn(sql);
  } finally {
    await sql.end();
  }
}
const counts = () =>
  withDb(async (sql) => {
    const rows = await sql`select type, source, (visitor_hash is not null) as hashed from analytics_events where profile_id = ${profileId}`;
    return {
      views: rows.filter((r) => r.type === "view").length,
      clicks: rows.filter((r) => r.type === "click").length,
      qr: rows.filter((r) => r.source === "qr").length,
      hashed: rows.filter((r) => r.hashed).length,
    };
  });

/** Every Set-Cookie header the context receives (call the result to collect them). */
function cookieWatch(context: BrowserContext) {
  const pending: Promise<string[]>[] = [];
  context.on("response", (r: Response) => {
    pending.push(r.headerValues("set-cookie").then((values) => values.map((v) => `${new URL(r.url()).pathname}: ${v.split("=")[0]}`)));
  });
  return async () => (await Promise.all(pending)).flat();
}
const beaconSent = (page: Page) => page.waitForResponse((r) => r.url().endsWith("/api/v") && r.request().method() === "POST");

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  // Its own client address: sign-up is rate limited per client (5 per 10 minutes), and earlier specs register too.
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.109.1" } });
  const page = await context.newPage();
  await page.goto("/setup");
  if (await page.locator("#token").count()) {
    await page.locator("#token").fill(process.env.E2E_SETUP_TOKEN!);
    await page.locator("#name").fill("Setup Owner");
    await page.locator("#email").fill("analytics-owner@example.com");
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
    headers: { origin: baseURL!, "x-forwarded-for": `198.51.107.${++signInCount}` },
  });
  expect(res.status()).toBe(200);
});

test("the owner publishes a link block and a Markdown link", async ({ page, baseURL }) => {
  // The destination is this server under another origin (a reachable, valid http URL).
  destination = `${baseURL!.replace("localhost", "127.0.0.1")}/api/health`;
  await page.goto("/dashboard/profiles");
  await page.locator("#handle").fill(HANDLE);
  await page.locator("#label").fill("Analytics page");
  await page.locator("#displayName").fill("Ava");
  await page.getByRole("button", { name: "Create profile" }).click();
  await page.waitForURL(/\/dashboard\/profiles\/[0-9a-f-]{36}$/);
  profileId = page.url().split("/").pop()!;
  await withDb(
    (sql) => sql`update profiles set draft = jsonb_set(draft, '{blocks}', ${sql.json([
      { id: "00000000-0000-4000-8000-0000000000a1", type: "link", version: 2, visible: true, config: { title: "Health check", url: destination } },
      { id: "00000000-0000-4000-8000-0000000000a2", type: "text", version: 1, visible: true, config: { markdown: "Read [the docs](https://docs.example.com).", align: "inherit" } },
    ] as never)}) where id = ${profileId}`,
  );
  await page.reload();
  await page.locator("[data-hydrated]").waitFor();
  // The preview keeps the direct destination.
  await expect(page.getByTestId("profile-preview").filter({ visible: true }).getByRole("link", { name: "Health check" })).toHaveAttribute("href", destination);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("editor-status").filter({ visible: true })).toContainText("Published");
});

test("a visitor's view (beacon) and click (/go) are recorded; nothing sets a cookie", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.108.10" } });
  const cookies = cookieWatch(context);
  const visitor = await context.newPage();
  const sent = beaconSent(visitor);
  expect((await visitor.goto(`/${HANDLE}`))?.status()).toBe(200);
  expect((await sent).status()).toBe(204);
  const link = visitor.getByRole("link", { name: "Health check" });
  await expect(link).toHaveAttribute("href", `/go/${profileId}/00000000-0000-4000-8000-0000000000a1`);
  await expect(visitor.getByRole("link", { name: "the docs" })).toHaveAttribute("href", "https://docs.example.com/");
  await link.click();
  await visitor.waitForURL(destination);
  await expect.poll(counts).toMatchObject({ views: 1, clicks: 1, hashed: 2 });
  expect(await cookies()).toEqual([]);
  expect(await context.cookies()).toEqual([]);
  await context.close();
});

test("the beacon is sent after the document and never blocks display, even when it hangs", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.108.12" } });
  let requested = false;
  await context.route("**/api/v", () => {
    requested = true; // never answered
  });
  const visitor = await context.newPage();
  const t0 = Date.now();
  expect((await visitor.goto(`/${HANDLE}`))?.status()).toBe(200); // waits for the load event
  await expect(visitor.getByRole("heading", { level: 1, name: "Ava" })).toBeVisible();
  const loadMs = Date.now() - t0;
  const timing = await visitor.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null;
    const beacon = performance.getEntriesByType("resource").find((e) => e.name.endsWith("/api/v"))?.startTime ?? null;
    return { responseEnd: nav.responseEnd, fcp, beacon };
  });
  // The hung request isn't finished, so it may not have a resource entry yet; the request itself was made.
  await expect.poll(() => requested).toBe(true);
  expect(loadMs).toBeLessThan(10_000);
  if (timing.beacon !== null) expect(timing.beacon).toBeGreaterThan(timing.responseEnd);
  await context.close();
});

test("a QR-code visit is reported with the qr source and the address bar is cleaned", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.108.11" } });
  const visitor = await context.newPage();
  const sent = beaconSent(visitor);
  await visitor.goto(`/${HANDLE}?src=qr`);
  expect(JSON.parse((await sent).request().postData() ?? "{}")).toMatchObject({ p: profileId, s: "qr" });
  await expect.poll(() => new URL(visitor.url()).search).toBe("");
  await expect.poll(counts).toMatchObject({ views: 2, qr: 1 });
  await context.close();
});

test("the signed-in owner's own views and clicks are not counted", async ({ page }) => {
  const before = await counts();
  const sent = beaconSent(page);
  await page.goto(`/${HANDLE}`);
  expect((await sent).status()).toBe(204);
  await page.getByRole("link", { name: "Health check" }).click();
  await page.waitForURL(destination);
  expect(await counts()).toEqual(before);
});

test("the owner's dashboard shows the metrics, an accessible chart and tables, ranges and an empty state", async ({ page }) => {
  const url = `/dashboard/profiles/${profileId}/analytics`;
  // The streamed page starts with its loading skeleton.
  expect(await (await page.request.get(url)).text()).toContain('data-testid="analytics-loading"');
  await page.goto("/dashboard");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Analytics" }).click();
  await page.waitForURL(new RegExp(`${url}$`));
  await expect(page.getByTestId("stat-views")).toHaveText("2");
  await expect(page.getByTestId("stat-clicks")).toHaveText("1");
  await expect(page.getByTestId("stat-ctr")).toHaveText("50.0%");
  await expect(page.getByTestId("stat-visitors")).toHaveText("2");
  await expect(page.getByTestId("stat-visitors")).toHaveAttribute("data-availability", "approximate");
  await expect(page.getByRole("img", { name: "Daily views and clicks" })).toBeVisible();
  const daily = page.getByRole("table", { name: /per UTC day/ });
  await expect(daily).toBeVisible();
  const today = new Date().toISOString().slice(0, 10);
  await expect(daily.getByRole("row", { name: new RegExp(`^${today} 2 1 2$`) })).toBeVisible();
  await expect(page.getByRole("table", { name: "Top links" }).getByRole("row", { name: /Health check 1/ })).toBeVisible();
  await expect(page.getByRole("table", { name: "Sources" }).getByRole("row", { name: /QR code 1/ })).toBeVisible();
  await expect(page.getByRole("table", { name: "Devices" }).getByRole("row", { name: /Desktop 2/ })).toBeVisible();

  // Presets: keyboard-reachable links with the current one marked.
  const seven = page.getByRole("link", { name: "Last 7 days" });
  await seven.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("link", { name: "Last 7 days" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("range-summary")).toContainText("(7 days)");

  // Custom range: invalid input explains itself; a past day with nothing shows the empty state.
  await page.getByLabel("From (UTC)").fill(today);
  await page.getByLabel("To (UTC)").fill("2026-01-01");
  await page.getByRole("button", { name: "Show" }).click();
  // (Next's route announcer is a second, empty role=alert.)
  await expect(page.getByTestId("range-error")).toHaveAttribute("role", "alert");
  await expect(page.getByTestId("range-error")).toContainText("start date must be on or before the end date");
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await page.goto(`${url}?from=${yesterday}&to=${yesterday}`);
  await expect(page.getByTestId("analytics-empty")).toBeVisible();
  await expect(page.getByTestId("stat-ctr")).toHaveText("—");
  await expect(page.getByTestId("links-empty")).toBeVisible();
});

test("the QR code downloads as an SVG that decodes to the profile URL with ?src=qr", async ({ page, baseURL }) => {
  await page.goto(`/dashboard/profiles/${profileId}/analytics`);
  await expect(page.getByTestId("qr-target")).toHaveText(`${baseURL}/${HANDLE}?src=qr`);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("qr-download").click()]);
  expect(download.suggestedFilename()).toBe(`covalink-${HANDLE}-qr.svg`);
  const svg = await readFile((await download.path())!);
  const { data, info } = await sharp(svg).resize(480, 480, { kernel: "nearest" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height)?.data).toBe(`${baseURL}/${HANDLE}?src=qr`);
});

test("phone width: the dashboard and the public page fit without horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of [`/dashboard/profiles/${profileId}/analytics?range=90`, `/${HANDLE}`]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  await expect(page.getByRole("link", { name: "Health check" })).toBeVisible();
});
