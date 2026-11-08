import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Browser, Frame, Page } from "@playwright/test";
import { config } from "dotenv";
import postgres from "postgres";
import { assertTestDatabaseMarker, assertTestDatabaseUrl } from "../../scripts/test-db-guard.mjs";
import { expect, test } from "./fixtures";

/**
 * The confirmation run for video and music blocks against real providers,
 * through the built app. Manual and skipped by default: it contacts YouTube, Vimeo,
 * Spotify and SoundCloud, so it runs only with EMBED_CONFIRM_OUT set to a results
 * file outside the repository. It confirms the attributes actually shipped; it decides nothing. Records
 * cookie names only, URLs without query strings, and a short excerpt of a player's text only when it didn't play.
 *
 *   EMBED_CONFIRM_OUT=/tmp/embed-confirmation.jsonl npm run test:browser -- tests/browser/embed-real-providers.spec.ts
 */
const OUT = process.env.EMBED_CONFIRM_OUT;
test.skip(!OUT, "Contacts real providers; set EMBED_CONFIRM_OUT to run it");
test.describe.configure({ mode: "serial" });

const EDITOR = { name: "Confirm", email: "embed-confirm@example.com", password: "confirm-password-123" };
const HANDLE = "m12confirm";
const SPOTIFY = (kind: string, id: string) => `https://open.spotify.com/${kind}/${id}`;
const SAMPLES: { name: string; type: "video" | "music"; url: string; provider: keyof typeof PLAY; only?: "gpu" | "nogpu" }[] = [
  { name: "youtube", type: "video", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", provider: "youtube" },
  { name: "vimeo-22439234", type: "video", url: "https://vimeo.com/22439234", provider: "vimeo" },
  { name: "vimeo-76979871", type: "video", url: "https://vimeo.com/76979871", provider: "vimeo", only: "gpu" },
  { name: "vimeo-1084537", type: "video", url: "https://vimeo.com/1084537", provider: "vimeo", only: "gpu" },
  { name: "spotify-track", type: "music", url: SPOTIFY("track", "4uLU6hMCjMI75M1A2tKUQC"), provider: "spotify" },
  { name: "spotify-album", type: "music", url: SPOTIFY("album", "4aawyAB9vmqN3uQ7FjRGTy"), provider: "spotify", only: "gpu" },
  { name: "spotify-playlist", type: "music", url: SPOTIFY("playlist", "37i9dQZF1DXcBWIGoYBM5M"), provider: "spotify", only: "gpu" },
  { name: "spotify-artist", type: "music", url: SPOTIFY("artist", "0OdUWJ0sBjDrqHygGUXeCF"), provider: "spotify", only: "gpu" },
  { name: "spotify-episode", type: "music", url: SPOTIFY("episode", "2en2xJFq6PzeSFWqWitPqI"), provider: "spotify", only: "nogpu" },
  { name: "spotify-show", type: "music", url: SPOTIFY("show", "4rOoJ6Egrf8K2IrywzwOMk"), provider: "spotify", only: "nogpu" },
  { name: "soundcloud-track", type: "music", url: "https://soundcloud.com/forss/flickermood", provider: "soundcloud" },
  { name: "soundcloud-set", type: "music", url: "https://soundcloud.com/forss/sets/soulhack", provider: "soundcloud", only: "gpu" },
];
const PLAY = {
  youtube: [".ytp-large-play-button", "button.ytp-play-button"],
  vimeo: ["button[data-play-button]", ".vp-controls button", 'button[aria-label*="Play" i]'],
  spotify: ['button[data-testid="play-pause-button"]', 'button[aria-label*="Play" i]'],
  soundcloud: [".playButton", ".sc-button-play", 'button[title*="Play" i]'],
};
const mode = process.env.PW_DISABLE_GPU === "1" ? "nogpu" : "gpu";
const TRIALS = 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const safe = <T>(fn: () => Promise<T>, fallback: T, ms = 5000) => Promise.race([fn().catch(() => fallback), sleep(ms).then(() => fallback)]);
const bare = (raw: string) => {
  const u = new URL(raw);
  return `${u.protocol}//${u.host}${u.pathname}`;
};
const write = (entry: object) => appendFileSync(OUT!, `${JSON.stringify(entry)}\n`);
const frameState = () => {
  const media = [...document.querySelectorAll("video,audio")].map((e) => ({ t: (e as HTMLMediaElement).currentTime, paused: (e as HTMLMediaElement).paused }));
  return { media, pause: !!document.querySelector('button[aria-label*="Pause" i],button[title*="Pause" i],.playButton.playing,.sc-button-pause'), h: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight };
};

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  test.setTimeout(120_000);
  mkdirSync(path.dirname(OUT!), { recursive: true });
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.117.1" } });
  const page = await context.newPage();
  await page.goto("/setup");
  if (await page.locator("#token").count()) {
    await page.locator("#token").fill(process.env.E2E_SETUP_TOKEN!);
    await page.locator("#name").fill("Setup Owner");
    await page.locator("#email").fill("embed-confirm-owner@example.com");
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
  await page.goto("/dashboard/profiles");
  await page.locator("#handle").fill(HANDLE);
  await page.locator("#label").fill("Confirm");
  await page.locator("#displayName").fill("Confirm");
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page).toHaveURL(/\/dashboard\/profiles\/[0-9a-f-]{36}$/);
  await page.locator("[data-hydrated]").waitFor();

  // Seeded through the real parser's output shape: canonical v2 blocks.
  const fileEnv: Record<string, string> = {};
  config({ path: ".env", quiet: true, processEnv: fileEnv });
  const { url } = assertTestDatabaseUrl(process.env.E2E_DATABASE_URL ?? fileEnv.E2E_DATABASE_URL, { devDatabaseUrl: fileEnv.DATABASE_URL ?? process.env.DATABASE_URL });
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await assertTestDatabaseMarker(sql, new URL(url).pathname.slice(1));
    const blocks = SAMPLES.map((s, i) => ({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, type: s.type, version: 2, visible: true, config: { url: s.url, title: s.name } }));
    await sql`update profiles set draft = jsonb_set(draft, '{blocks}', ${sql.json(blocks as never)}), published = jsonb_set(draft, '{blocks}', ${sql.json(blocks as never)}),
      is_published = true, published_revision = draft_revision, published_at = now() where handle = ${HANDLE}`;
  } finally {
    await sql.end();
  }
  write({ type: "meta", command: "npm run test:browser -- tests/browser/embed-real-providers.spec.ts", mode, playwright: test.info().config.version, browserVersion: browser.version(), channel: process.env.PW_CHANNEL ?? "msedge", startedAt: new Date().toISOString() });
  await context.close();
});

const kids = (page: Page) => page.frames().filter((f) => f !== page.mainFrame());

async function pressPlay(frames: Frame[], selectors: string[]) {
  for (const selector of selectors) {
    for (const f of frames) {
      const l = f.locator(selector).first();
      if (await safe(() => l.isVisible(), false, 2000)) {
        await safe(() => l.click({ timeout: 4000 }), undefined);
        return selector;
      }
    }
  }
  return null;
}

for (const sample of SAMPLES.filter((s) => !s.only || s.only === mode)) {
  for (let trial = 1; trial <= TRIALS; trial++) {
    test(`${sample.name} #${trial}`, async ({ browser, baseURL }) => {
      test.setTimeout(90_000);
      const context = await browser.newContext({ baseURL, viewport: { width: 1000, height: 800 } });
      const page = await context.newPage();
      const requests: string[] = [];
      const navs: { to: string; from: string[]; referer: string | null }[] = [];
      const mediaHosts = new Set<string>();
      context.on("request", (r) => {
        const host = new URL(r.url()).hostname;
        if (host !== "localhost") requests.push(host);
        if (r.isNavigationRequest() && host !== "localhost") {
          const from: string[] = [];
          for (let x = r.redirectedFrom(); x; x = x.redirectedFrom()) from.unshift(bare(x.url()));
          const nav = { to: bare(r.url()), from, referer: null as string | null };
          navs.push(nav);
          void safe(() => r.allHeaders(), {} as Record<string, string>).then((h) => {
            nav.referer = h.referer ? bare(h.referer).replace(/:\d+\//, ":PORT/") : null;
          });
        }
      });
      context.on("response", (r) => {
        const t = r.headers()["content-type"] ?? "";
        if (/^(audio|video)\//.test(t) || /octet-stream/.test(t)) mediaHosts.add(new URL(r.url()).hostname);
      });
      await page.goto(`/${HANDLE}`, { waitUntil: "load" });
      await page.evaluate(() => {
        const w = window as unknown as { __v: string[] };
        w.__v = [];
        document.addEventListener("securitypolicyviolation", (e) => w.__v.push(`${e.effectiveDirective} ${e.blockedURI}`));
      });
      const box = page.getByRole("group", { name: sample.name, exact: true });
      const load = box.getByRole("button");
      await load.waitFor();
      await sleep(1000);
      const requestsBeforeLoad = requests.length;
      const cookiesBeforeLoad = (await context.cookies()).length;

      await load.click();
      const iframe = box.locator("iframe");
      await iframe.waitFor();
      const attributes = await iframe.evaluate((el) => ({ src: el.getAttribute("src"), allow: el.getAttribute("allow"), sandbox: el.getAttribute("sandbox"), referrerpolicy: el.getAttribute("referrerpolicy"), focused: document.activeElement === el }));
      const frameBox = await iframe.boundingBox();
      await sleep(7000);
      const before = await Promise.all(kids(page).map((f) => safe(() => f.evaluate(frameState), null, 4000)));
      const autoplayed = before.flatMap((b) => b?.media ?? []).some((m) => !m.paused || m.t > 0) || before.some((b) => b?.pause);
      const overflow = before[0] ? before[0].h > before[0].ch + 1 : null;
      let clicked = await pressPlay(kids(page), PLAY[sample.provider]);
      if (!clicked && frameBox) {
        // The same fallback as the preflight harness: YouTube's button doesn't always match a selector.
        await page.mouse.click(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2);
        clicked = "center";
      }

      const started = Date.now();
      let playedAfterMs: number | null = null;
      for (;;) {
        await sleep(1000);
        const state = await Promise.all(kids(page).map((f) => safe(() => f.evaluate(frameState), null, 4000)));
        const advanced = state.flatMap((a) => a?.media ?? []).some((m) => m.t > 0 && !m.paused);
        if (playedAfterMs === null && (advanced || (state.some((a) => a?.pause) && mediaHosts.size > 0))) playedAfterMs = Date.now() - started;
        if (Date.now() - started >= (playedAfterMs === null ? 20_000 : 9000)) break;
      }
      const violations = await page.evaluate(() => (window as unknown as { __v: string[] }).__v);
      // Why a player didn't play: its first visible words, and nothing when it did.
      const frameText = playedAfterMs === null ? await safe(() => kids(page)[0].evaluate(() => (document.body?.innerText ?? "").replace(/s+/g, " ").slice(0, 120)), null) : null;
      if (process.env.EMBED_CONFIRM_SHOTS) await page.screenshot({ path: path.join(process.env.EMBED_CONFIRM_SHOTS, `${mode}-${sample.name}-${trial}.png`) });
      write({
        type: "case",
        sample: sample.name,
        trial,
        requestsBeforeLoad,
        cookiesBeforeLoad,
        attributes: { ...attributes, src: attributes.src },
        frameSize: frameBox && { width: frameBox.width, height: frameBox.height },
        autoplayed,
        overflow,
        clicked,
        played: playedAfterMs !== null,
        playedAfterMs,
        frameText,
        violations,
        firstNav: navs[0] ?? null,
        redirects: navs.filter((n) => n.from.length).length,
        mediaHosts: [...mediaHosts],
        cookies: (await context.cookies()).map((c) => `${c.name}@${c.domain}`),
        tabs: context.pages().length - 1,
        finishedAt: new Date().toISOString(),
      });
      await context.close();
      // A provider failing to play is recorded, not a failure of this run; these are the app's own guarantees.
      expect(requestsBeforeLoad, "provider requests before Load").toBe(0);
      expect(cookiesBeforeLoad, "cookies before Load").toBe(0);
      expect(violations, "CSP violations").toEqual([]);
      expect(attributes.focused, "focus moved to the iframe").toBe(true);
    });
  }
}
