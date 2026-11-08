import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Media against the real database and a throwaway storage root: the
 * upload endpoint (order of checks, bounded intake, rejection of hostile
 * files, rate limit, decode gate, deadlines, quota under concurrency), the
 * library, ownership and kind checks on save and publish, structural
 * reference protection on delete, origin serving, account deletion,
 * readiness and the GC command.
 */
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
}));

import { ProfileView } from "@/components/profile/profile-view";
import { MAX_INPUT_BYTES, type MediaKind } from "@/features/media/constants";
import { ConcurrencyGate } from "@/features/media/gate";
import { mediaUrl } from "@/features/media/layout.mjs";
import { processImage, type ProcessedImage } from "@/features/media/pipeline";
import { serveMedia } from "@/features/media/serve";
import * as media from "@/features/media/service";
import { LocalStorage, mediaStorage } from "@/features/media/storage";
import { handleMediaUpload, type UploadDeps } from "@/features/media/upload";
import { createDefaultDocument } from "@/features/profiles/document";
import { getLiveProfile, getPublishedDocument } from "@/features/profiles/public";
import * as svc from "@/features/profiles/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { getPreset } from "@/features/themes/presets";
import type { ThemeInput } from "@/features/themes/schema";
import { probeStorage } from "@/lib/health/storage-probe";
import { AppError } from "@/lib/errors";
import { cookieFrom, deleteAccount, signIn, signUp } from "../support/auth-http";
import { resetDatabase, testSql } from "../support/db";
import * as img from "../support/images";
import { TEST_APP_URL, TEST_SETUP_TOKEN } from "../support/test-env";

const PASSWORD = "correct-horse-battery";
const header = (avatarUrl?: string) => ({ header: { displayName: "Alice", bio: "", ...(avatarUrl ? { avatarUrl } : {}) }, seo: { noindex: false } });
const idOf = async (email: string) => ((await testSql()`select id from users where email = ${email}`)[0] as { id: string }).id;
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as AppError);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

let alice = "";
let bob = "";
let aliceCookie = "";
let bobCookie = "";
let root = "";

async function storageRoot() {
  return (mediaStorage() as LocalStorage).root();
}
async function list(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}
const tempFiles = async () => list(path.join(root, "tmp"));
async function storedFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const a of (await list(root)).filter((n) => /^[0-9a-f]{2}$/.test(n))) {
    for (const b of await list(path.join(root, a))) out.push(...(await list(path.join(root, a, b))));
  }
  return out.sort();
}
const keyFile = (key: string) => path.join(root, key.slice(0, 2), key.slice(2, 4), key);
const keyOf = (url: string) => url.slice("/media/".length);

function uploadRequest(kind: string, body: BodyInit | Buffer | null, { cookie = aliceCookie, headers = {} as Record<string, string> } = {}) {
  const h: Record<string, string> = { origin: TEST_APP_URL, "content-type": "image/png", ...headers };
  if (cookie) h.cookie = cookie;
  const payload = Buffer.isBuffer(body) ? new Uint8Array(body) : body;
  return new Request(`${TEST_APP_URL}/api/media?kind=${kind}`, { method: "POST", headers: h, body: payload, duplex: "half" } as RequestInit);
}
async function upload(kind: string, body: BodyInit | Buffer | null, opts: Parameters<typeof uploadRequest>[2] & { deps?: Partial<UploadDeps> } = {}) {
  const res = await handleMediaUpload(uploadRequest(kind, body, opts), opts.deps);
  return { res, body: (await res.json()) as { error?: string; code?: string; asset?: media.MediaAssetView; usage?: media.MediaUsage } };
}

let processedCache: Partial<Record<MediaKind, ProcessedImage>> = {};
async function processed(kind: MediaKind): Promise<ProcessedImage> {
  if (!processedCache[kind]) {
    const p = path.join(await mkdtemp(path.join(tmpdir(), "covalink-media-test-src-")), "in.png");
    await writeFile(p, await img.png(kind === "avatar" ? 300 : 1200, kind === "avatar" ? 300 : 800, kind === "avatar" ? "#2255aa" : "#335577"));
    processedCache[kind] = await processImage(p, kind);
    await rm(path.dirname(p), { recursive: true, force: true });
  }
  return processedCache[kind]!;
}
/** Stores a real processed image for `owner` and returns its view. */
async function asset(owner: string, kind: MediaKind, name = `${kind}.png`) {
  return (await media.storeAsset(owner, kind, await processed(kind), name)).asset;
}

async function setSetting(key: string, value: number) {
  await testSql()`insert into system_settings (key, value) values (${key}, ${testSql().json(value)}) on conflict (key) do update set value = excluded.value`;
}
const attempts = async (userId: string) =>
  Number(((await testSql()`select coalesce(sum(attempts), 0)::int as n from media_upload_attempts where user_id = ${userId}`)[0] as { n: number }).n);

async function createFor(owner: string, handle: string) {
  return (await svc.createProfile(owner, { handle, label: handle, displayName: "Alice" })).id;
}

/** Midnight with an uploaded background image and colors that pass the image contrast check. */
function imageTheme(url: string, overlayOpacity = 0.7): ThemeInput {
  const t = clone(getPreset("midnight").theme);
  t.background = { ...t.background, type: "image", imageUrl: url, overlayOpacity };
  t.text = { color: "#ffffff", muted: "#e4e4e7" };
  t.accent = "#ffffff";
  t.button = { ...t.button, variant: "fill", color: "#ffffff", textColor: "#111111" };
  return t;
}

async function publicHtml(handle: string) {
  const live = await getLiveProfile(handle);
  const doc = live ? await getPublishedDocument(live) : null;
  return doc ? renderToStaticMarkup(createElement(ProfileView, { document: doc, verified: false, mode: "public" })) : null;
}

beforeEach(async () => {
  await resetDatabase();
  processedCache = processedCache ?? {};
  root = await storageRoot();
  for (const entry of await list(root)) await rm(path.join(root, entry), { recursive: true, force: true });
  await bootstrapSuperAdmin({ token: TEST_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: PASSWORD });
  for (const email of ["alice@example.com", "bob@example.com"]) expect((await signUp(email)).status).toBe(200);
  [alice, bob] = await Promise.all(["alice@example.com", "bob@example.com"].map(idOf));
  aliceCookie = cookieFrom(await signIn("alice@example.com"));
  bobCookie = cookieFrom(await signIn("bob@example.com"));
});

describe("POST /api/media: order of checks", () => {
  it("refuses a missing session, a foreign origin or Fetch Metadata, and an unknown kind, before counting an attempt", async () => {
    const png = await img.png();
    expect((await upload("avatar", png, { cookie: "" })).res.status).toBe(401);
    expect((await upload("avatar", png, { headers: { origin: "https://evil.example" } })).res.status).toBe(403);
    expect((await upload("avatar", png, { headers: { origin: TEST_APP_URL, "sec-fetch-site": "cross-site" } })).res.status).toBe(403);
    const noOrigin = new Request(`${TEST_APP_URL}/api/media?kind=avatar`, { method: "POST", headers: { cookie: aliceCookie }, body: png });
    expect((await handleMediaUpload(noOrigin)).status).toBe(403);
    expect((await upload("logo", png)).res.status).toBe(400);
    expect(await attempts(alice)).toBe(0);
    expect(await tempFiles()).toEqual([]);
  });

  it("accepts a PNG labelled as a GIF named .php: the bytes decide, the output is a re-encoded WebP", async () => {
    const { res, body } = await upload("avatar", await img.png(1000, 600), {
      headers: { "content-type": "image/gif", "x-upload-filename": encodeURIComponent("../../evil.php") },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const a = body.asset!;
    expect(a).toMatchObject({ kind: "avatar", width: 512, height: 307, originalName: "evil.php", usedBy: [] });
    expect(a.url).toMatch(/^\/media\/[0-9a-f-]{36}\.webp$/);
    const [row] = await testSql()`select owner_id, kind, mime_type, size_bytes, width, height, storage_key from media_assets`;
    expect(row).toMatchObject({ owner_id: alice, kind: "avatar", mime_type: "image/webp", width: 512, height: 307, storage_key: keyOf(a.url) });
    const bytes = await readFile(keyFile(keyOf(a.url)));
    expect(bytes.length).toBe(row.size_bytes);
    expect((await sharp(bytes).metadata()).format).toBe("webp");
    expect(body.usage).toEqual({ usedBytes: row.size_bytes, quotaBytes: 50 * 1024 * 1024 });
    expect(await tempFiles()).toEqual([]);
    expect(await attempts(alice)).toBe(1);
  });

  it.each([
    ["an SVG sent as image/png named .png", () => Promise.resolve(img.svg()), 415, "IMAGE_SVG"],
    ["a GIF", img.gif, 415, "IMAGE_GIF"],
    ["HTML", () => Promise.resolve(Buffer.from("<!doctype html><script>alert(1)</script>")), 415, "IMAGE_UNSUPPORTED"],
    ["an animated WebP", img.animatedWebp, 422, "IMAGE_ANIMATED"],
    ["a JPEG with an appended HTML/ZIP payload", async () => img.withTrailing(await img.jpeg()), 422, "IMAGE_TRAILING"],
    ["a truncated JPEG", async () => img.truncated(await img.jpeg()), 422, "IMAGE_MALFORMED"],
    ["an image wider than 8192 px", () => img.png(8200, 4), 422, "IMAGE_DIMENSIONS"],
    ["an empty body", () => Promise.resolve(Buffer.alloc(0)), 400, "EMPTY"],
  ])("rejects %s, counts the attempt and leaves no temp file", async (_, make, status, code) => {
    const { res, body } = await upload("avatar", await make(), { headers: { "x-upload-filename": "x.png" } });
    expect([res.status, body.code]).toEqual([status, code]);
    expect(body.error).toBeTruthy();
    expect(await testSql()`select 1 from media_assets`).toHaveLength(0);
    expect(await tempFiles()).toEqual([]);
    expect(await storedFiles()).toEqual([]);
    expect(await attempts(alice)).toBe(1);
  });

  it("rejects a declared Content-Length over 5 MiB without reading the body", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024));
      },
    });
    const { res } = await upload("avatar", stream, { headers: { "content-length": String(MAX_INPUT_BYTES + 1) } });
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(1);
    expect(await tempFiles()).toEqual([]);
  });

  it("stops a streamed body as soon as it passes 5 MiB, before buffering or decoding it", async () => {
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 64 * 1024;
        c.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const process = vi.fn(processImage);
    const { res, body } = await upload("background", stream, { deps: { process } });
    expect([res.status, body.code]).toEqual([413, "TOO_LARGE"]);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(MAX_INPUT_BYTES + 4 * 64 * 1024);
    expect(process).not.toHaveBeenCalled();
    expect(await tempFiles()).toEqual([]);
  });

  it("times out a stalled body (408) and an over-long decode (503), cleaning up either way", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(100));
      },
    });
    expect((await upload("avatar", stalled, { deps: { intakeTimeoutMs: 100 } })).res.status).toBe(408);
    expect(await tempFiles()).toEqual([]);

    let finish!: (v: ProcessedImage) => void;
    const gate = new ConcurrencyGate({ maxActive: 1, maxQueued: 0, queueTimeoutMs: 100 });
    const slow = () => new Promise<ProcessedImage>((r) => (finish = r));
    const { res, body } = await upload("avatar", await img.png(), { deps: { gate, process: slow, processDeadlineMs: 100 } });
    expect([res.status, body.code]).toEqual([503, "BUSY"]);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await tempFiles()).toEqual([]);
    // The abandoned decode still holds its slot until it really finishes.
    expect(gate.active).toBe(1);
    finish(await processed("avatar"));
    await vi.waitFor(() => expect(gate.active).toBe(0));
    expect(await testSql()`select 1 from media_assets`).toHaveLength(0);
  });

  it("refuses work when the decode gate is saturated instead of queueing unbounded decodes", async () => {
    const gate = new ConcurrencyGate({ maxActive: 1, maxQueued: 0, queueTimeoutMs: 1000 });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const process = vi.fn(async (p: string, k: MediaKind) => {
      await held;
      return processImage(p, k);
    });
    const first = upload("avatar", await img.png(), { deps: { gate, process } });
    await vi.waitFor(() => expect(gate.active).toBe(1));
    const second = await upload("avatar", await img.png(), { cookie: bobCookie, deps: { gate, process } });
    expect([second.res.status, second.body.code]).toEqual([503, "BUSY"]);
    release();
    expect((await first).res.status).toBe(201);
    expect(process).toHaveBeenCalledTimes(1);
    expect(await tempFiles()).toEqual([]);
  });
});

describe("abuse limits", () => {
  it("counts rejected uploads, refuses past the hourly limit, and deleting images doesn't reset it", async () => {
    await setSetting("media.uploadsPerHour", 3);
    expect((await upload("avatar", img.svg())).res.status).toBe(415);
    expect((await upload("avatar", Buffer.from("not an image"))).res.status).toBe(415);
    const ok = await upload("avatar", await img.png());
    expect(ok.res.status).toBe(201);
    const limited = await upload("avatar", await img.png());
    expect([limited.res.status, limited.body.code]).toEqual([429, "RATE_LIMITED"]);
    expect(Number(limited.res.headers.get("retry-after"))).toBeGreaterThan(0);
    await media.deleteMedia(alice, ok.body.asset!.id);
    expect((await upload("avatar", await img.png())).res.status).toBe(429);
    expect(await attempts(alice)).toBe(3);
    // Limits are per user.
    expect((await upload("avatar", await img.png(), { cookie: bobCookie })).res.status).toBe(201);
  });

  it("enforces the quota transactionally under concurrent stores, keeping files and rows consistent", async () => {
    await setSetting("media.quotaMb", 1);
    const chunk = { data: Buffer.alloc(300 * 1024, 7), width: 100, height: 100 };
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => media.storeAsset(alice, "background", chunk, null)));
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(3);
    for (const r of refused) expect((r.reason as AppError).code).toBe("LIMIT");
    const [{ used }] = (await testSql()`select sum(size_bytes)::int as used from media_assets where owner_id = ${alice}`) as unknown as { used: number }[];
    expect(used).toBe(3 * 300 * 1024);
    expect(await storedFiles()).toHaveLength(3);
    expect(await tempFiles()).toEqual([]);
    // Once full, an upload is refused before its body is read.
    await setSetting("media.quotaMb", 1);
    await media.storeAsset(alice, "background", { data: Buffer.alloc(1024 * 1024 - used, 1), width: 1, height: 1 }, null);
    const full = await upload("avatar", await img.png());
    expect([full.res.status, full.body.code]).toEqual([413, "QUOTA"]);
  });
});

describe("ownership and kinds on save and publish", () => {
  it("saves and publishes the owner's avatar; renders it on the public page", async () => {
    const a = await asset(alice, "avatar");
    const id = await createFor(alice, "alice");
    await svc.saveDraft(alice, id, { expectedRevision: 0, patch: header(a.url) });
    await svc.publishProfile(alice, id, { expectedRevision: 1 });
    expect(await publicHtml("alice")).toContain(`src="${a.url}"`);
    const lib = await media.listMedia(alice);
    expect(lib.assets[0].usedBy).toEqual([{ profileId: id, handle: "alice", draft: true, published: true }]);
  });

  it("rejects another user's image, a guessed key and the wrong kind, field by field", async () => {
    const aliceAvatar = await asset(alice, "avatar");
    const aliceBackground = await asset(alice, "background");
    const bobProfile = await createFor(bob, "bob");
    const aliceProfile = await createFor(alice, "alice");
    const guessed = mediaUrl("7c9e6679-7425-40de-944b-e07fc1f90ae7.webp");

    for (const url of [aliceAvatar.url, guessed]) {
      const err = await failure(svc.saveDraft(bob, bobProfile, { expectedRevision: 0, patch: header(url) }));
      expect(err?.fieldErrors?.avatarUrl?.[0]).toMatch(/isn't in your library/);
      const pub = await failure(svc.publishProfile(bob, bobProfile, { expectedRevision: 0, patch: header(url) }));
      expect(pub?.fieldErrors?.avatarUrl?.[0]).toMatch(/isn't in your library/);
    }
    const wrongAvatar = await failure(svc.saveDraft(alice, aliceProfile, { expectedRevision: 0, patch: header(aliceBackground.url) }));
    expect(wrongAvatar?.fieldErrors?.avatarUrl?.[0]).toMatch(/uploaded avatars/);
    const wrongBackground = await failure(
      svc.saveDraft(alice, aliceProfile, { expectedRevision: 0, patch: { ...header(), theme: imageTheme(aliceAvatar.url) } }),
    );
    expect(wrongBackground?.fieldErrors?.["theme.background.imageUrl"]?.[0]).toMatch(/uploaded background images/);
    const foreignBackground = await failure(
      svc.saveDraft(bob, bobProfile, { expectedRevision: 0, patch: { ...header(), theme: imageTheme(aliceBackground.url) } }),
    );
    expect(foreignBackground?.fieldErrors?.["theme.background.imageUrl"]?.[0]).toMatch(/isn't in your library/);
    expect((await testSql()`select draft_revision from profiles`).map((r) => r.draft_revision)).toEqual([0, 0]);
  });

  it("publishes an owned background image and checks contrast against both image extremes", async () => {
    const bg = await asset(alice, "background");
    const id = await createFor(alice, "alice");
    const dark = clone(imageTheme(bg.url, 0.3));
    dark.text = { color: "#767676", muted: "#767676" };
    const refused = await failure(svc.publishProfile(alice, id, { expectedRevision: 0, patch: { ...header(), theme: dark } }));
    expect(refused?.fieldErrors?.["theme.text.color"]?.[0]).toMatch(/background image/);
    expect((await testSql()`select published from profiles where id = ${id}`)[0].published).toBeNull();

    const r = await svc.publishProfile(alice, id, { expectedRevision: 0, patch: { ...header(), theme: imageTheme(bg.url) } });
    expect(r.theme.background).toMatchObject({ type: "image", imageUrl: bg.url, overlayOpacity: 0.7 });
    const html = (await publicHtml("alice"))!;
    expect(html).toContain(`url(&quot;${bg.url}&quot;) center / cover no-repeat`);
    expect(html).toContain("rgb(0 0 0 / 0.7)");
  });

  it("publishing checks references anywhere in the document; a header save checks only the touched fields and keeps the rest exactly", async () => {
    const bobs = await asset(bob, "avatar");
    const id = await createFor(alice, "alice");
    const base = createDefaultDocument("Alice");
    await testSql()`update profiles set draft = ${testSql().json({ ...base, futureBlock: { gallery: [{ src: bobs.url }] } })} where id = ${id}`;
    const pub = await failure(svc.publishProfile(alice, id, { expectedRevision: 0 }));
    expect(pub?.message).toMatch(/aren't in your library/);
    await svc.saveDraft(alice, id, { expectedRevision: 0, patch: header() });
    const [{ draft }] = await testSql()`select draft from profiles where id = ${id}`;
    expect(draft.futureBlock).toEqual({ gallery: [{ src: bobs.url }] });
  });

  it("keeps external https avatars, and refuses this instance's own /media address typed as an https URL", async () => {
    const id = await createFor(alice, "alice");
    await svc.saveDraft(alice, id, { expectedRevision: 0, patch: header("https://images.example.com/me.png") });
    await svc.publishProfile(alice, id, { expectedRevision: 1 });
    expect(await publicHtml("alice")).toContain('src="https://images.example.com/me.png"');
    // A dotless test host is already refused as an avatar address; on a real host the media check applies.
    const own = `https://${new URL(TEST_APP_URL).host}/media/7c9e6679-7425-40de-944b-e07fc1f90ae7.webp`;
    expect((await failure(svc.saveDraft(alice, id, { expectedRevision: 1, patch: header(own) })))?.code).toBe("VALIDATION");
    const app = "https://links.example.com";
    const caught = (url: string) => {
      try {
        media.assertExternalAvatar(url, app);
        return null;
      } catch (e) {
        return e as AppError;
      }
    };
    for (const url of [`${app}/media/x.webp`, `${app}/MEDIA/7c9e6679-7425-40de-944b-e07fc1f90ae7.webp`, "https://links.example.com:8443/media/a.webp"]) {
      expect(caught(url)?.fieldErrors?.avatarUrl?.[0], url).toMatch(/from your library/);
    }
    expect(caught("https://images.example.com/media/a.webp")).toBeNull();
    expect(caught(`${app}/avatars/me.png`)).toBeNull();
  });
});

describe("deletion", () => {
  it("refuses while a draft, a published page or an unknown field references the image, then deletes", async () => {
    const a = await asset(alice, "avatar");
    const id = await createFor(alice, "alice");
    await svc.saveDraft(alice, id, { expectedRevision: 0, patch: header(a.url) });
    expect((await failure(media.deleteMedia(alice, a.id)))?.message).toMatch(/still used by \/alice/);

    await svc.publishProfile(alice, id, { expectedRevision: 1 });
    await svc.saveDraft(alice, id, { expectedRevision: 1, patch: header() }); // draft no longer uses it; the published page does
    expect((await failure(media.deleteMedia(alice, a.id)))?.message).toMatch(/still used by \/alice/);

    await svc.publishProfile(alice, id, { expectedRevision: 2 });
    const base = createDefaultDocument("Alice");
    await testSql()`update profiles set draft = ${testSql().json({ ...base, x: { deep: [{ v: a.url }] } })} where id = ${id}`;
    expect((await failure(media.deleteMedia(alice, a.id)))?.message).toMatch(/still used by \/alice/);

    await testSql()`update profiles set draft = ${testSql().json(base)} where id = ${id}`;
    await media.deleteMedia(alice, a.id);
    expect(await testSql()`select 1 from media_assets`).toHaveLength(0);
    await expect(lstat(keyFile(keyOf(a.url)))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await serveMedia(keyOf(a.url))).status).toBe(404);
  });

  it("refuses when another user's stored profile references it, without naming that profile", async () => {
    const a = await asset(alice, "avatar");
    const bobProfile = await createFor(bob, "bobspage");
    const base = createDefaultDocument("Bob");
    await testSql()`update profiles set draft = ${testSql().json({ ...base, header: { ...base.header, avatarUrl: a.url } })} where id = ${bobProfile}`;
    const err = await failure(media.deleteMedia(alice, a.id));
    expect(err?.message).toMatch(/used by a profile/);
    expect(err?.message).not.toContain("bobspage");
  });

  it("returns NOT_FOUND for another user's image and malformed ids", async () => {
    const a = await asset(alice, "avatar");
    expect((await failure(media.deleteMedia(bob, a.id)))?.code).toBe("NOT_FOUND");
    expect((await failure(media.deleteMedia(alice, "../etc/passwd")))?.code).toBe("NOT_FOUND");
    expect((await failure(media.deleteMedia(alice, "00000000-0000-4000-8000-000000000000")))?.code).toBe("NOT_FOUND");
    expect((await media.listMedia(bob)).assets).toEqual([]);
    expect(await testSql()`select 1 from media_assets`).toHaveLength(1);
  });

  it("a concurrent save and delete can't leave a reference to a deleted image", async () => {
    for (let round = 0; round < 6; round++) {
      await testSql()`delete from profiles`;
      const a = await asset(alice, "avatar");
      const id = await createFor(alice, `round${round}`);
      const [saved, deleted] = await Promise.allSettled([
        svc.saveDraft(alice, id, { expectedRevision: 0, patch: header(a.url) }),
        media.deleteMedia(alice, a.id),
      ]);
      const [{ exists }] = await testSql()`select exists(select 1 from media_assets where id = ${a.id}) as exists`;
      const [{ draft }] = await testSql()`select draft from profiles where id = ${id}`;
      if (saved.status === "fulfilled") {
        expect(deleted.status).toBe("rejected");
        expect(exists).toBe(true);
        expect(draft.header.avatarUrl).toBe(a.url);
      } else {
        expect(deleted.status).toBe("fulfilled");
        expect(exists).toBe(false);
        expect(draft.header.avatarUrl).toBeUndefined();
      }
    }
  });

  it("serves 404 as soon as the row is gone, even when the file can't be removed (left for GC)", async () => {
    const a = await asset(alice, "avatar");
    const key = keyOf(a.url);
    // Simulate a failed physical delete: replace the file with a directory, which remove() refuses.
    await rm(keyFile(key));
    await mkdir(keyFile(key));
    await media.deleteMedia(alice, a.id);
    expect((await serveMedia(key)).status).toBe(404);
    expect((await stat(keyFile(key))).isDirectory()).toBe(true);
    // And a plain orphan file (row deleted behind the app's back) is never served.
    const b = await asset(alice, "avatar");
    await testSql()`delete from media_assets where id = ${b.id}`;
    expect((await serveMedia(keyOf(b.url))).status).toBe(404);
    expect((await stat(keyFile(keyOf(b.url)))).isFile()).toBe(true);
  });
});

describe("serving", () => {
  it("serves a live image with the media headers and no cookies", async () => {
    const a = await asset(alice, "avatar");
    const res = await serveMedia(keyOf(a.url));
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      "content-type": "image/webp",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "cross-origin-resource-policy": "same-origin",
      "cache-control": "public, max-age=31536000, immutable",
      "x-robots-tag": "noindex",
    });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(Buffer.from(await res.arrayBuffer()).equals(await readFile(keyFile(keyOf(a.url))))).toBe(true);
  });

  it("answers unknown, malformed and traversal keys with the same 404", async () => {
    const a = await asset(alice, "avatar");
    await rm(keyFile(keyOf(a.url))); // row without a file
    const bodies = new Set<string>();
    for (const key of [keyOf(a.url), "7c9e6679-7425-40de-944b-e07fc1f90ae7.webp", "../../etc/passwd", "..\\..\\x.webp", "%2e%2e%2fx.webp", "x.webp", keyOf(a.url).toUpperCase(), ""]) {
      const res = await serveMedia(key);
      expect(res.status, key).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
      bodies.add(await res.text());
    }
    expect([...bodies]).toEqual(["Not found"]);
  });
});

describe("account deletion", () => {
  it("removes the owner's files after the account and its rows are deleted", async () => {
    const a = await asset(alice, "avatar");
    const b = await asset(alice, "background");
    const kept = await asset(bob, "avatar");
    await deleteAccount(aliceCookie, PASSWORD);
    expect(await testSql()`select 1 from users where id = ${alice}`).toHaveLength(0);
    expect((await testSql()`select storage_key from media_assets`).map((r) => r.storage_key)).toEqual([keyOf(kept.url)]);
    for (const u of [a.url, b.url]) await expect(lstat(keyFile(keyOf(u)))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await storedFiles()).toEqual([keyOf(kept.url)]);
  });
});

describe("storage readiness probe", () => {
  it("succeeds on a writable root and leaves nothing behind", async () => {
    expect(await probeStorage(mediaStorage())).toBe("ok");
    expect((await list(root)).filter((n) => n.startsWith(".readiness-"))).toEqual([]);
  });

  it("reports unavailable for an unusable root and timeout for a hung one, with no details", async () => {
    const file = path.join(root, "not-a-dir");
    await writeFile(file, "x");
    expect(await probeStorage(new LocalStorage(file))).toBe("unavailable");
    const hung = { ...mediaStorage(), probe: () => new Promise<void>(() => {}) } as unknown as LocalStorage;
    const started = performance.now();
    expect(await probeStorage(hung, 200)).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe("media:gc command", () => {
  it("is a dry run by default, refuses --apply without an age, and with both removes only old orphans", async () => {
    const live = await asset(alice, "avatar");
    const orphan = await asset(alice, "avatar");
    await testSql()`delete from media_assets where id = ${orphan.id}`;
    const old = new Date(Date.now() - 48 * 3_600_000);
    await utimes(keyFile(keyOf(orphan.url)), old, old);
    await utimes(keyFile(keyOf(live.url)), old, old);

    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["scripts/media-gc.mjs", ...args], {
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, STORAGE_LOCAL_PATH: root, NODE_ENV: "test" },
        encoding: "utf8",
      });
    const dry = run();
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("dry run");
    expect(dry.stdout).toContain("orphan files (no live row): 1");
    expect(dry.stdout).toContain(keyOf(orphan.url));
    expect(dry.stdout).not.toContain(root);
    expect((await storedFiles()).sort()).toEqual([keyOf(live.url), keyOf(orphan.url)].sort());

    const refused = run("--apply");
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("--min-age-hours");
    expect(await storedFiles()).toHaveLength(2);

    const applied = run("--apply", "--min-age-hours=24");
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("deleted: 1");
    expect(await storedFiles()).toEqual([keyOf(live.url)]);
    expect((await serveMedia(keyOf(live.url))).status).toBe(200);
  });
});
