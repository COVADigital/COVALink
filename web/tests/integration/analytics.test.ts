import { spawn } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `use cache` helpers only work inside Next.js; here the cached function runs uncached.
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
}));

import { setUserBanned } from "@/features/admin/users";
import { handleViewBeacon } from "@/features/analytics/beacon";
import { handleClick } from "@/features/analytics/click";
import { recordEvent, type EventInput } from "@/features/analytics/ingest";
import { currentSalt } from "@/features/analytics/salts";
import { getProfileAnalytics } from "@/features/analytics/service";
import * as svc from "@/features/profiles/service";
import { setSetting } from "@/features/settings/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { AppError } from "@/lib/errors";
import { cookieFrom, signIn, signUp } from "../support/auth-http";
import { resetDatabase, testSql } from "../support/db";
import { TEST_APP_URL, TEST_SETUP_TOKEN } from "../support/test-env";

/**
 * Analytics against the guarded test database. Requests
 * are built by hand and passed to the real handlers; the trusted-proxy mode is
 * chosen per call (`trustProxy`) instead of through the environment.
 */

const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const SENTINEL_IP = "198.51.100.77";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const header = { header: { displayName: "Alice", bio: "" }, seo: { noindex: false } };

let superId = "";
let alice = "";
let bob = "";
let aliceCookie = "";
let bobCookie = "";
let profileId = "";
let bobProfileId = "";

const idOf = async (email: string) => ((await testSql()`select id from users where email = ${email}`)[0] as { id: string }).id;
const events = async () =>
  (await testSql()`select type, block_id, visitor_hash, referrer_host, device, source from analytics_events order by id`) as unknown as {
    type: string;
    block_id: string | null;
    visitor_hash: string | null;
    referrer_host: string | null;
    device: string;
    source: string | null;
  }[];
const eventCount = async () => Number((await testSql()`select count(*)::int as n from analytics_events`)[0].n);

const headersFor = ({ ip, ua = BROWSER, cookie, extra = {} }: { ip?: string; ua?: string | null; cookie?: string; extra?: Record<string, string> } = {}) => {
  const h = new Headers(extra);
  if (ua !== null) h.set("user-agent", ua);
  if (ip) h.set("x-forwarded-for", ip);
  if (cookie) h.set("cookie", cookie);
  return h;
};

const view = (over: Partial<EventInput> = {}): EventInput => ({ type: "view", profileId, ownerId: alice, headers: headersFor(), ...over });
const click = (over: Partial<EventInput> = {}): EventInput => ({ type: "click", profileId, ownerId: alice, blockId: ID(1), headers: headersFor(), ...over });

async function publish(owner: string, id: string, blocks: unknown[], revision = 0) {
  return svc.publishProfile(owner, id, { expectedRevision: revision, patch: { ...header, blocks } });
}

const LINKS = [
  { id: ID(1), type: "link", visible: true, config: { title: "Shop", url: "shop.example.com" } },
  { id: ID(2), type: "link", visible: false, config: { title: "Hidden", url: "https://hidden.example.com" } },
  { id: ID(3), type: "heading", visible: true, config: { text: "Heading", size: "md", align: "inherit" } },
  { id: ID(4), type: "text", visible: true, config: { markdown: "[md](https://md.example.com)", align: "inherit" } },
];

beforeEach(async () => {
  await resetDatabase();
  ({ userId: superId } = await bootstrapSuperAdmin({ token: TEST_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: "correct-horse-battery" }));
  for (const email of ["alice@example.com", "bob@example.com"]) expect((await signUp(email)).status).toBe(200);
  [alice, bob] = await Promise.all(["alice@example.com", "bob@example.com"].map(idOf));
  aliceCookie = cookieFrom(await signIn("alice@example.com"));
  bobCookie = cookieFrom(await signIn("bob@example.com"));
  ({ id: profileId } = await svc.createProfile(alice, { handle: "alice", label: "Alice", displayName: "Alice" }));
  ({ id: bobProfileId } = await svc.createProfile(bob, { handle: "bob", label: "Bob", displayName: "Bob" }));
  await publish(alice, profileId, LINKS);
  await publish(bob, bobProfileId, [{ id: ID(9), type: "link", visible: true, config: { title: "Bob link", url: "https://bob.example.com" } }]);
});

describe("daily salts", () => {
  it("concurrent first events on a UTC day create exactly one salt", async () => {
    const salts = await Promise.all(Array.from({ length: 25 }, () => currentSalt()));
    expect(new Set(salts).size).toBe(1);
    const rows = await testSql()`select day::text as day, salt from analytics_salts`;
    expect(rows).toHaveLength(1);
    expect(rows[0].day).toBe(new Date().toISOString().slice(0, 10));
    expect(rows[0].salt).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("visitor identity", () => {
  it("hashes a trusted address; stores nothing raw", async () => {
    expect(await recordEvent(view({ headers: headersFor({ ip: SENTINEL_IP, ua: PHONE }), referrer: "https://news.example.org/a?b=c" }), { trustProxy: true })).toBe("recorded");
    const [e] = await events();
    expect(e).toMatchObject({ type: "view", block_id: null, referrer_host: "news.example.org", device: "mobile", source: null });
    expect(e.visitor_hash).toMatch(/^[0-9a-f]{64}$/);
    const dump = JSON.stringify(await testSql()`select * from analytics_events`) + JSON.stringify(await testSql()`select * from analytics_salts`);
    expect(dump).not.toContain(SENTINEL_IP);
    expect(dump).not.toContain("iPhone");
    expect(dump).not.toContain("b=c");
  });

  it("stores NULL without a trusted address (TRUST_PROXY off, or no header) and never hashes a placeholder", async () => {
    expect(await recordEvent(view({ headers: headersFor({ ip: SENTINEL_IP }) }), { trustProxy: false })).toBe("recorded");
    expect(await recordEvent(view({ headers: headersFor() }), { trustProxy: true })).toBe("recorded");
    expect(await recordEvent(view({ headers: headersFor({ ip: "203.0.113.1, 203.0.113.2" }) }), { trustProxy: true })).toBe("recorded");
    expect((await events()).map((e) => e.visitor_hash)).toEqual([null, null, null]);
    expect(await testSql()`select 1 from analytics_salts`).toHaveLength(0);
  });

  it("hashes are per profile: the same visitor gets different hashes on two profiles", async () => {
    const h = headersFor({ ip: SENTINEL_IP });
    await recordEvent(view({ headers: h }), { trustProxy: true });
    await recordEvent(view({ headers: h, profileId: bobProfileId, ownerId: bob }), { trustProxy: true });
    const [a, b] = await events();
    expect(a.visitor_hash).not.toBe(b.visitor_hash);
  });
});

describe("repeat views", () => {
  it("suppresses a repeat view for 30 minutes only when a hash exists", async () => {
    const h = headersFor({ ip: SENTINEL_IP });
    expect(await recordEvent(view({ headers: h }), { trustProxy: true })).toBe("recorded");
    expect(await recordEvent(view({ headers: h }), { trustProxy: true })).toBe("repeat");
    // A different user-agent class is a different visitor.
    expect(await recordEvent(view({ headers: headersFor({ ip: SENTINEL_IP, ua: PHONE }) }), { trustProxy: true })).toBe("recorded");
    await testSql()`update analytics_events set occurred_at = now() - interval '31 minutes'`;
    expect(await recordEvent(view({ headers: h }), { trustProxy: true })).toBe("recorded");
    // Without a hash there is no suppression.
    expect(await recordEvent(view(), { trustProxy: false })).toBe("recorded");
    expect(await recordEvent(view(), { trustProxy: false })).toBe("recorded");
    expect(await eventCount()).toBe(5);
  });

  it("concurrent identical views record exactly one", async () => {
    const h = headersFor({ ip: SENTINEL_IP });
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => recordEvent(view({ headers: h }), { trustProxy: true })));
    expect(outcomes.filter((o) => o === "recorded")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "repeat")).toHaveLength(11);
  });

  it("clicks are never deduplicated", async () => {
    const h = headersFor({ ip: SENTINEL_IP });
    for (let i = 0; i < 3; i++) expect(await recordEvent(click({ headers: h }), { trustProxy: true })).toBe("recorded");
  });
});

describe("ingestion limits (concurrency-safe)", () => {
  const limits = { perVisitor: 5, perProfile: 8, global: 11 };

  it("per visitor: parallel clicks from one hash stop exactly at the limit", async () => {
    const h = headersFor({ ip: SENTINEL_IP });
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => recordEvent(click({ headers: h }), { trustProxy: true, limits })));
    expect(outcomes.filter((o) => o === "recorded")).toHaveLength(5);
    expect(outcomes.filter((o) => o === "rate_limited")).toHaveLength(15);
  });

  it("per profile: bounds writes even with no trusted address", async () => {
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => recordEvent(view(), { trustProxy: false, limits })));
    expect(outcomes.filter((o) => o === "recorded")).toHaveLength(8);
    expect(await eventCount()).toBe(8);
  });

  it("global: bounds writes across profiles", async () => {
    for (let i = 0; i < 8; i++) await recordEvent(view(), { trustProxy: false, limits });
    const more = await Promise.all(Array.from({ length: 6 }, () => recordEvent(view({ profileId: bobProfileId, ownerId: bob }), { trustProxy: false, limits })));
    expect(more.filter((o) => o === "recorded")).toHaveLength(3);
    expect(await eventCount()).toBe(11);
  });

  it("events older than a minute no longer count", async () => {
    for (let i = 0; i < 8; i++) await recordEvent(view(), { trustProxy: false, limits });
    expect(await recordEvent(view(), { trustProxy: false, limits })).toBe("rate_limited");
    await testSql()`update analytics_events set occurred_at = now() - interval '61 seconds'`;
    expect(await recordEvent(view(), { trustProxy: false, limits })).toBe("recorded");
  });
});

describe("filters", () => {
  it("discards bots and prefetches before anything else", async () => {
    expect(await recordEvent(view({ headers: headersFor({ ua: "Mozilla/5.0 (compatible; Googlebot/2.1)" }) }))).toBe("bot");
    expect(await recordEvent(view({ headers: headersFor({ ua: null }) }))).toBe("bot");
    expect(await recordEvent(view({ headers: headersFor({ extra: { "sec-purpose": "prefetch" } }) }))).toBe("prefetch");
    expect(await eventCount()).toBe(0);
  });

  it("discards the signed-in owner only, using a verified session cookie", async () => {
    expect(await recordEvent(view({ headers: headersFor({ cookie: aliceCookie }) }))).toBe("owner");
    expect(await recordEvent(click({ headers: headersFor({ cookie: aliceCookie }) }))).toBe("owner");
    expect(await recordEvent(view({ headers: headersFor({ cookie: bobCookie }) }))).toBe("recorded");
    // A forged signature on the owner's real token is not the owner.
    const forged = aliceCookie.replace(/(session_token=[^.;]+\.)[^;]+/, `$1${"A".repeat(43)}=`);
    expect(forged).not.toBe(aliceCookie);
    expect(await recordEvent(view({ headers: headersFor({ cookie: forged }) }))).toBe("recorded");
    // An expired session is not the owner either.
    await testSql()`update sessions set expires_at = now() - interval '1 second' where user_id = ${alice}`;
    expect(await recordEvent(view({ headers: headersFor({ cookie: aliceCookie }) }))).toBe("recorded");
    expect(await eventCount()).toBe(3);
  });

  it("a storage failure discards the event without throwing", async () => {
    // A profile id that violates the foreign key.
    expect(await recordEvent(view({ profileId: ID(77) }))).toBe("error");
  });
});

describe("/go click route", () => {
  const go = (pid: string, bid: string, headers: Headers = headersFor()) => handleClick(new Request(`${TEST_APP_URL}/go/${pid}/${bid}`, { headers }), pid, bid);

  it("redirects a visible published link to its stored, revalidated destination and records the click", async () => {
    const res = await go(profileId, ID(1));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://shop.example.com/");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await events()).toEqual([{ type: "click", block_id: ID(1), visitor_hash: null, referrer_host: null, device: "desktop", source: null }]);
  });

  it("404s for hidden, non-link, Markdown, unknown, cross-profile and malformed ids, recording nothing", async () => {
    for (const [pid, bid] of [
      [profileId, ID(2)], // hidden link
      [profileId, ID(3)], // heading
      [profileId, ID(4)], // text block (Markdown links are never tracked)
      [profileId, ID(99)], // unknown block
      [profileId, ID(9)], // Bob's block via Alice's profile
      [bobProfileId, ID(1)], // Alice's block via Bob's profile
      [ID(55), ID(1)], // unknown profile
      ["not-a-uuid", ID(1)],
      [profileId, "x"],
    ]) {
      const res = await go(pid, bid);
      expect(res.status, `${pid}/${bid}`).toBe(404);
      expect(res.headers.get("location")).toBeNull();
    }
    expect(await eventCount()).toBe(0);
  });

  it("uses the current published document: draft-only links, unpublished profiles and banned owners are 404", async () => {
    const r = await svc.saveDraft(alice, profileId, { expectedRevision: 1, patch: { ...header, blocks: [...LINKS, { id: ID(5), type: "link", visible: true, config: { title: "Draft", url: "https://draft.example.com" } }] } });
    expect(r).toBeTruthy();
    expect((await go(profileId, ID(5))).status).toBe(404);
    // Republish without the link: the old link is gone.
    await svc.publishProfile(alice, profileId, { expectedRevision: 2, patch: { ...header, blocks: [LINKS[0]] } });
    expect((await go(profileId, ID(1))).status).toBe(302);
    await publish(alice, profileId, [], 3);
    expect((await go(profileId, ID(1))).status).toBe(404);
    await publish(alice, profileId, [LINKS[0]], 4);
    await svc.unpublishProfile(alice, profileId);
    expect((await go(profileId, ID(1))).status).toBe(404);
    expect((await go(bobProfileId, ID(9))).status).toBe(302);
    await setUserBanned(superId, bob, true);
    expect((await go(bobProfileId, ID(9))).status).toBe(404);
  });

  it("revalidates the stored destination: a tampered unsafe URL is never redirected to", async () => {
    await testSql()`update profiles set published = jsonb_set(published, '{blocks,0,config,url}', '"javascript:alert(1)"'),
      published_revision = published_revision where id = ${profileId}`;
    expect((await go(profileId, ID(1))).status).toBe(404);
  });

  describe("HEAD", () => {
    const head = (pid: string, bid: string, headers: Headers = headersFor()) =>
      handleClick(new Request(`${TEST_APP_URL}/go/${pid}/${bid}`, { method: "HEAD", headers }), pid, bid);

    it("validates and redirects exactly like GET, with a browser user agent, but stores no event and never calls the recorder", async () => {
      const recorder = vi.fn(async () => "recorded" as const);
      const res = await handleClick(new Request(`${TEST_APP_URL}/go/${profileId}/${ID(1)}`, { method: "HEAD", headers: headersFor({ ip: SENTINEL_IP }) }), profileId, ID(1), {
        record: recorder,
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://shop.example.com/");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(recorder).not.toHaveBeenCalled();
      for (let i = 0; i < 5; i++) expect((await head(profileId, ID(1))).status).toBe(302);
      expect(await eventCount()).toBe(0);
      // The same response as GET, which records exactly one click.
      const get = await go(profileId, ID(1));
      expect([get.status, get.headers.get("location"), get.headers.get("cache-control"), get.headers.get("x-robots-tag")]).toEqual([
        302,
        res.headers.get("location"),
        "no-store",
        "noindex, nofollow",
      ]);
      expect(await eventCount()).toBe(1);
    });

    it("keeps the uniform 404 for every invalid case, storing nothing", async () => {
      await svc.saveDraft(alice, profileId, { expectedRevision: 1, patch: { ...header, blocks: [...LINKS, { id: ID(5), type: "link", visible: true, config: { title: "Draft", url: "https://draft.example.com" } }] } });
      const cases: [string, string][] = [
        ["not-a-uuid", ID(1)], // malformed
        [profileId, "x"],
        [profileId, ID(99)], // unknown block
        [profileId, ID(9)], // cross-profile
        [profileId, ID(2)], // hidden link
        [profileId, ID(3)], // heading
        [profileId, ID(4)], // text (Markdown)
        [profileId, ID(5)], // draft-only link
        [ID(55), ID(1)], // unknown profile
      ];
      for (const [pid, bid] of cases) expect((await head(pid, bid)).status, `${pid}/${bid}`).toBe(404);
      // Unsafe stored destination.
      await testSql()`update profiles set published = jsonb_set(published, '{blocks,0,config,url}', '"javascript:alert(1)"') where id = ${profileId}`;
      expect((await head(profileId, ID(1))).status).toBe(404);
      // Removed (republished without it), unpublished, banned owner.
      await svc.publishProfile(bob, bobProfileId, { expectedRevision: 1, patch: { ...header, blocks: [] } });
      expect((await head(bobProfileId, ID(9))).status).toBe(404);
      await publish(bob, bobProfileId, [{ id: ID(9), type: "link", visible: true, config: { title: "Bob link", url: "https://bob.example.com" } }], 2);
      expect((await head(bobProfileId, ID(9))).status).toBe(302);
      await svc.unpublishProfile(bob, bobProfileId);
      expect((await head(bobProfileId, ID(9))).status).toBe(404);
      await publish(bob, bobProfileId, [{ id: ID(9), type: "link", visible: true, config: { title: "Bob link", url: "https://bob.example.com" } }], 3);
      await setUserBanned(superId, bob, true);
      expect((await head(bobProfileId, ID(9))).status).toBe(404);
      expect(await eventCount()).toBe(0);
    });

    it("repeated HEAD probes don't change dashboard totals or top-link counts", async () => {
      await go(profileId, ID(1));
      await go(profileId, ID(1));
      const before = await getProfileAnalytics(alice, profileId, { range: "7" });
      for (let i = 0; i < 20; i++) await head(profileId, ID(1), headersFor({ ip: `203.0.113.${i + 1}` }));
      const after = await getProfileAnalytics(alice, profileId, { range: "7" });
      expect(after.totals).toEqual(before.totals);
      expect(after.topLinks).toEqual([{ blockId: ID(1), title: "Shop", hidden: false, clicks: 2 }]);
      expect(after.topLinks).toEqual(before.topLinks);
    });
  });

  it("bots, prefetches and the owner are redirected but not recorded", async () => {
    for (const h of [headersFor({ ua: "curl/8.0" }), headersFor({ extra: { purpose: "prefetch" } }), headersFor({ cookie: aliceCookie })]) {
      const res = await go(profileId, ID(1), h);
      expect(res.status).toBe(302);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(await eventCount()).toBe(0);
  });

  it("analytics failures, rate limits and slow storage never block a valid redirect", async () => {
    const req = () => new Request(`${TEST_APP_URL}/go/${profileId}/${ID(1)}`, { headers: headersFor() });
    const failing = await handleClick(req(), profileId, ID(1), { record: () => Promise.reject(new Error("db down")) });
    expect(failing.status).toBe(302);
    const limited = await handleClick(req(), profileId, ID(1), { record: async () => "rate_limited" });
    expect(limited.status).toBe(302);
    const started = Date.now();
    const hung = await handleClick(req(), profileId, ID(1), { record: () => new Promise(() => {}), deadlineMs: 150 });
    expect(hung.status).toBe(302);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("view beacon", () => {
  const beacon = (body: unknown, init: { origin?: string | null; site?: string; type?: string; cookie?: string; raw?: string } = {}) => {
    const h = headersFor({ cookie: init.cookie });
    if (init.origin !== null) h.set("origin", init.origin ?? TEST_APP_URL);
    if (init.site) h.set("sec-fetch-site", init.site);
    h.set("content-type", init.type ?? "application/json");
    return handleViewBeacon(new Request(`${TEST_APP_URL}/api/v`, { method: "POST", headers: h, body: init.raw ?? JSON.stringify(body) }));
  };

  it("records a same-origin view with an allowlisted source, returning an empty 204 with no cookie", async () => {
    const res = await beacon({ p: profileId, s: "qr", r: "https://social.example.net/post/1" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await events()).toEqual([{ type: "view", block_id: null, visitor_hash: null, referrer_host: "social.example.net", device: "desktop", source: "qr" }]);
  });

  it("ignores unknown sources and internal referrers", async () => {
    expect((await beacon({ p: profileId, s: "newsletter", r: `${TEST_APP_URL}/bob` })).status).toBe(204);
    expect(await events()).toEqual([expect.objectContaining({ source: null, referrer_host: null })]);
  });

  it("rejects cross-site, wrong content types, oversized and malformed bodies", async () => {
    expect((await beacon({ p: profileId }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await beacon({ p: profileId }, { origin: null })).status).toBe(403);
    expect((await beacon({ p: profileId }, { site: "cross-site" })).status).toBe(403);
    expect((await beacon({ p: profileId }, { type: "text/plain" })).status).toBe(415);
    expect((await beacon({ p: profileId }, { type: "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await beacon(null, { raw: JSON.stringify({ p: profileId, r: "x".repeat(5000) }) })).status).toBe(413);
    for (const body of [{}, { p: "nope" }, { p: profileId, extra: 1 }, [profileId], { p: profileId, s: 5 }]) {
      expect((await beacon(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await beacon(null, { raw: "{not json" })).status).toBe(400);
    expect(await eventCount()).toBe(0);
  });

  it("accepts only live profiles: unknown, unpublished and banned-owner profiles record nothing", async () => {
    expect((await beacon({ p: ID(55) })).status).toBe(204);
    await svc.unpublishProfile(alice, profileId);
    expect((await beacon({ p: profileId })).status).toBe(204);
    await setUserBanned(superId, bob, true);
    expect((await beacon({ p: bobProfileId })).status).toBe(204);
    expect(await eventCount()).toBe(0);
  });

  it("owner beacons are discarded and set no cookie", async () => {
    const res = await beacon({ p: profileId }, { cookie: aliceCookie });
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await eventCount()).toBe(0);
  });
});

describe("dashboard aggregation and tenant isolation", () => {
  const NOW = new Date("2026-11-02T12:00:00Z");
  async function insert(rows: { type: "view" | "click"; at: string; block?: string; hash?: string | null; ref?: string | null; device?: string; source?: string | null; profile?: string }[]) {
    for (const r of rows) {
      await testSql()`insert into analytics_events (profile_id, type, block_id, visitor_hash, referrer_host, device, source, occurred_at)
        values (${r.profile ?? profileId}, ${r.type}, ${r.block ?? null}, ${r.hash ?? null}, ${r.ref ?? null}, ${r.device ?? "desktop"}, ${r.source ?? null}, ${r.at})`;
    }
  }
  const H = (n: number) => String(n).repeat(64).slice(0, 64);

  it("computes the documented metrics over [start, end) UTC days, with deleted-link labels", async () => {
    await insert([
      { type: "view", at: "2026-10-26T23:59:59.999Z", hash: H(1) }, // just before the 7-day range
      { type: "view", at: "2026-10-27T00:00:00Z", hash: H(1), ref: "news.example.org", source: "qr" },
      { type: "view", at: "2026-10-27T10:00:00Z", hash: H(2), device: "mobile" },
      { type: "view", at: "2026-10-28T10:00:00Z", hash: H(1) }, // same hash, another day: counted again
      { type: "view", at: "2026-11-02T23:59:59.999Z", hash: H(3), ref: "news.example.org" },
      { type: "click", at: "2026-10-27T10:01:00Z", block: ID(1), hash: H(2) },
      { type: "click", at: "2026-10-28T10:01:00Z", block: ID(1) },
      { type: "click", at: "2026-10-28T10:02:00Z", block: ID(77) }, // block no longer exists
      { type: "click", at: "2026-10-29T10:00:00Z", block: ID(2) }, // exists but hidden
      { type: "view", at: "2026-10-30T10:00:00Z", hash: H(5), profile: bobProfileId }, // another profile
    ]);
    const a = await getProfileAnalytics(alice, profileId, { range: "7" }, NOW);
    expect([a.range.from, a.range.to, a.range.days]).toEqual(["2026-10-27", "2026-11-02", 7]);
    expect(a.totals).toEqual({ views: 4, clicks: 4, ctr: 1, visitors: 4, viewsWithoutHash: 0, visitorAvailability: "approximate" });
    expect(a.daily.find((d) => d.day === "2026-10-27")).toEqual({ day: "2026-10-27", views: 2, clicks: 1, visitors: 2, viewsWithoutHash: 0 });
    expect(a.daily).toHaveLength(7);
    expect(a.topLinks).toEqual([
      { blockId: ID(1), title: "Shop", hidden: false, clicks: 2 },
      { blockId: ID(2), title: "Hidden", hidden: true, clicks: 1 },
      { blockId: ID(77), title: null, hidden: false, clicks: 1 },
    ]);
    expect(a.referrers).toEqual([{ key: "news.example.org", views: 2 }, { key: null, views: 2 }]);
    expect(a.devices).toEqual([{ key: "mobile", views: 1 }, { key: "desktop", views: 3 }]);
    expect(a.sources).toEqual([{ key: null, views: 3 }, { key: "qr", views: 1 }]);
  });

  it("labels visitors partial or unavailable when views lack hashes", async () => {
    await insert([{ type: "view", at: "2026-11-01T10:00:00Z", hash: H(1) }, { type: "view", at: "2026-11-01T11:00:00Z" }]);
    expect((await getProfileAnalytics(alice, profileId, { range: "7" }, NOW)).totals).toMatchObject({ visitors: 1, visitorAvailability: "partial" });
    await testSql()`update analytics_events set visitor_hash = null`;
    expect((await getProfileAnalytics(alice, profileId, { range: "7" }, NOW)).totals).toMatchObject({ visitors: 0, visitorAvailability: "unavailable" });
  });

  it("returns empty totals and CTR undefined for a period with no events", async () => {
    const a = await getProfileAnalytics(alice, profileId, {}, NOW);
    expect(a.totals).toEqual({ views: 0, clicks: 0, ctr: null, visitors: 0, viewsWithoutHash: 0, visitorAvailability: "none" });
    expect(a.topLinks).toEqual([]);
  });

  it("caps ranges at the retention setting and reports invalid input", async () => {
    await setSetting("analytics.retentionDays", 30, superId);
    const a = await getProfileAnalytics(alice, profileId, { range: "90" }, NOW);
    expect(a.range).toMatchObject({ days: 30, capped: true });
    const b = await getProfileAnalytics(alice, profileId, { from: "2026-01-01", to: "2026-01-05" }, NOW);
    expect(b.rangeError).toMatch(/kept for 30 days/);
    expect(b.range.days).toBe(30);
  });

  it("another user, a guessed id or a malformed id gets NOT_FOUND and no numbers", async () => {
    await insert([{ type: "view", at: "2026-11-01T10:00:00Z" }]);
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AppError ? e.code : String(e)));
    expect(await code(getProfileAnalytics(bob, profileId, {}, NOW))).toBe("NOT_FOUND");
    expect(await code(getProfileAnalytics(superId, profileId, {}, NOW))).toBe("NOT_FOUND");
    expect(await code(getProfileAnalytics(alice, ID(55), {}, NOW))).toBe("NOT_FOUND");
    expect(await code(getProfileAnalytics(alice, "' or 1=1 --", {}, NOW))).toBe("NOT_FOUND");
    expect(await code(getProfileAnalytics("", profileId, {}, NOW))).toBe("NOT_FOUND");
    expect((await getProfileAnalytics(alice, profileId, {}, NOW)).totals.views).toBe(1);
  });

  it("deleting a profile deletes its analytics events", async () => {
    await insert([{ type: "view", at: "2026-11-01T10:00:00Z" }, { type: "view", at: "2026-11-01T10:00:00Z", profile: bobProfileId }]);
    await svc.deleteProfile(alice, profileId);
    expect(await testSql()`select profile_id from analytics_events`).toEqual([{ profile_id: bobProfileId }]);
  });
});

describe("analytics:purge", () => {
  const purge = (args: string[] = []) =>
    new Promise<{ status: number | null; out: string; err: string }>((resolve) => {
      const p = spawn(process.execPath, ["scripts/analytics-purge.mjs", ...args], { env: { ...process.env, ANALYTICS_RETENTION_DAYS: "" } });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (status) => resolve({ status, out, err }));
    });

  async function seed() {
    await setSetting("analytics.retentionDays", 10, superId);
    // Boundary = start of UTC day (today - 9).
    await testSql()`
      insert into analytics_events (profile_id, type, device, occurred_at)
      select ${profileId}, 'view', 'desktop', t from unnest(array[
        (date_trunc('day', now() at time zone 'utc') - interval '9 days') at time zone 'utc' - interval '1 millisecond',
        (date_trunc('day', now() at time zone 'utc') - interval '30 days') at time zone 'utc',
        (date_trunc('day', now() at time zone 'utc') - interval '9 days') at time zone 'utc',
        now()
      ]::timestamptz[]) as t`;
    await testSql()`
      insert into analytics_salts (day, salt)
      select (now() at time zone 'utc')::date - d, repeat('a', 43 - length(d::text)) || d::text from generate_series(0, 3) d`;
  }

  it("deletes exactly the events before the retention boundary and salts older than yesterday; idempotent", async () => {
    await seed();
    const dry = await purge(["--dry-run"]);
    expect(dry.status).toBe(0);
    expect(dry.out).toMatch(/retention 10 days \(setting\)/);
    expect(dry.out).toMatch(/would delete 2 events and 2 salts/);
    expect(await eventCount()).toBe(4);
    const first = await purge();
    expect(first.status, first.err).toBe(0);
    expect(first.out).toMatch(/deleted 2 events and 2 salts/);
    expect(await eventCount()).toBe(2);
    const salts = (await testSql()`select ((now() at time zone 'utc')::date - day)::int as age from analytics_salts order by 1`).map((r) => r.age);
    expect(salts).toEqual([0, 1]);
    const again = await purge();
    expect(again.out).toMatch(/deleted 0 events and 0 salts/);
    // Output is counts and the boundary only.
    expect(first.out + first.err).not.toMatch(/[0-9a-f]{64}|aaaa|alice|postgres(ql)?:\/\//i);
  });

  it("two concurrent purges together delete each row once", async () => {
    await seed();
    const [a, b] = await Promise.all([purge(), purge()]);
    expect([a.status, b.status]).toEqual([0, 0]);
    const deleted = (r: { out: string }) => Number(/deleted (\d+) events/.exec(r.out)?.[1]);
    expect(deleted(a) + deleted(b)).toBe(2);
    expect(await eventCount()).toBe(2);
  });

  it("refuses unknown arguments and an invalid environment fallback", async () => {
    expect((await purge(["--everything"])).status).toBe(2);
    const bad = await new Promise<number | null>((resolve) =>
      spawn(process.execPath, ["scripts/analytics-purge.mjs"], { env: { ...process.env, ANALYTICS_RETENTION_DAYS: "0" } }).on("close", resolve),
    );
    expect(bad).toBe(1);
  });
});

describe("migration 0004 database checks", () => {
  const violates = async (statement: Promise<unknown>) =>
    statement.then(() => "ok", (e: { code?: string; constraint_name?: string }) => `${e.code}:${e.constraint_name}`);

  it("enforces the event vocabulary, the block rule and bounded formats", async () => {
    const ins = (over: Record<string, unknown>) => {
      const r = { type: "view", block_id: null, visitor_hash: null, referrer_host: null, device: "desktop", source: null, ...over };
      return testSql()`insert into analytics_events (profile_id, type, block_id, visitor_hash, referrer_host, device, source)
        values (${profileId}, ${r.type as string}, ${r.block_id as string | null}, ${r.visitor_hash as string | null}, ${r.referrer_host as string | null}, ${r.device as string}, ${r.source as string | null})`;
    };
    expect(await violates(ins({}))).toBe("ok");
    expect(await violates(ins({ type: "click", block_id: ID(1), visitor_hash: "a".repeat(64), referrer_host: "x.example.com", source: "qr" }))).toBe("ok");
    // An unknown type also breaks the view/click block rule; PostgreSQL may report either check.
    expect(await violates(ins({ type: "hover" }))).toMatch(/^23514:analytics_events_(type_valid|block_by_type)$/);
    const [typeCheck] = await testSql()`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'analytics_events_type_valid'`;
    expect(typeCheck.def).toMatch(/type = ANY \(ARRAY\['view'::text, 'click'::text\]\)/);
    expect(await violates(ins({ device: "fridge" }))).toBe("23514:analytics_events_device_valid");
    expect(await violates(ins({ block_id: ID(1) }))).toBe("23514:analytics_events_block_by_type");
    expect(await violates(ins({ type: "click" }))).toBe("23514:analytics_events_block_by_type");
    expect(await violates(ins({ visitor_hash: "A".repeat(64) }))).toBe("23514:analytics_events_visitor_hash_format");
    expect(await violates(ins({ visitor_hash: "a".repeat(63) }))).toBe("23514:analytics_events_visitor_hash_format");
    expect(await violates(ins({ source: "Q R" }))).toBe("23514:analytics_events_source_format");
    expect(await violates(ins({ source: "x".repeat(33) }))).toBe("23514:analytics_events_source_format");
    expect(await violates(ins({ referrer_host: "https://x.example.com/path" }))).toBe("23514:analytics_events_referrer_host_format");
    expect(await violates(ins({ referrer_host: `${"a".repeat(250)}.com` }))).toBe("23514:analytics_events_referrer_host_format");
    expect(await violates(testSql()`insert into analytics_salts (day, salt) values (current_date, 'short')`)).toBe("23514:analytics_salts_salt_format");
  });

  it("has the reporting, repeat-view and retention indexes", async () => {
    const rows = await testSql()`select indexname, indexdef from pg_indexes where tablename = 'analytics_events' order by 1`;
    const names = rows.map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining(["analytics_events_profile_time_idx", "analytics_events_profile_type_time_idx", "analytics_events_visitor_idx", "analytics_events_time_idx"]),
    );
    expect(rows.find((r) => r.indexname === "analytics_events_visitor_idx")?.indexdef).toMatch(/\(profile_id, type, visitor_hash, occurred_at\) WHERE \(visitor_hash IS NOT NULL\)/);
  });
});
