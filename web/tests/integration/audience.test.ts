import { beforeEach, describe, expect, it, vi } from "vitest";

// `use cache` helpers only work inside Next.js; here the cached function runs uncached.
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
}));

// The test environment has no SMTP; each test decides whether email "works".
const status = vi.hoisted(() => ({ emailReady: true, subscribeEnabled: true }));
vi.mock("@/features/audience/status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/audience/status")>()),
  subscribeStatus: async () => ({ ...status, visitorsKnown: true, live: status.emailReady && status.subscribeEnabled }),
}));

import { deleteContact, exportContacts, listContacts, PENDING_TTL_HOURS } from "@/features/audience/service";
import { handleSubscribe, handleSubscribeToken, SUBSCRIBE_LIMITS } from "@/features/audience/subscribe";
import * as svc from "@/features/profiles/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import type { MailMessage } from "@/lib/mail";
import { signUp } from "../support/auth-http";
import { resetDatabase, testSql } from "../support/db";
import { TEST_APP_URL, TEST_SETUP_TOKEN } from "../support/test-env";

const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SUBSCRIBE = { id: ID(1), type: "subscribe", visible: true, config: { title: "Join my list", buttonLabel: "Subscribe" } };

let alice = "";
let bob = "";
let profileId = "";
let bobProfileId = "";
let sent: MailMessage[] = [];

const idOf = async (email: string) => ((await testSql()`select id from users where email = ${email}`)[0] as { id: string }).id;
const rows = async () =>
  (await testSql()`select email, status, consent_text, confirm_token_hash, confirmed_at from audience_contacts order by email`) as unknown as {
    email: string;
    status: string;
    consent_text: string;
    confirm_token_hash: string | null;
    confirmed_at: Date | null;
  }[];

function post(path: string, body: unknown, init: { origin?: string | null; type?: string; raw?: string; ip?: string } = {}) {
  const h = new Headers({ "user-agent": BROWSER, "content-type": init.type ?? "application/json" });
  if (init.origin !== null) h.set("origin", init.origin ?? TEST_APP_URL);
  if (init.ip) h.set("x-forwarded-for", init.ip);
  return new Request(`${TEST_APP_URL}${path}`, { method: "POST", headers: h, body: init.raw ?? JSON.stringify(body) });
}
// A trusted client address by default: without one, no sign-ups are taken.
const subscribe = (body: Record<string, unknown>, init: Parameters<typeof post>[2] = {}, trustProxy = true) =>
  handleSubscribe(post("/api/subscribe", { p: profileId, b: ID(1), hp: "", ...body }, { ip: "198.51.100.1", ...init }), {
    send: (m) => sent.push(m),
    trustProxy,
  });
const tokenFrom = (msg: MailMessage, page: "confirm" | "remove") => {
  const match = msg.text.match(new RegExp(`/subscribe/${page}#token=([A-Za-z0-9_-]{43})`));
  if (!match) throw new Error(`no ${page} link`);
  return match[1];
};
/** Bob verified, with a published Subscribe block. */
const publishBobSubscribe = async () => {
  await testSql()`update users set email_verified = true where id = ${bob}`;
  const patch = { header: { displayName: "Bob", bio: "" }, seo: { noindex: false }, blocks: [SUBSCRIBE] };
  await svc.publishProfile(bob, bobProfileId, { expectedRevision: 0, patch });
};
const confirm = (token: string) => handleSubscribeToken(post("/api/subscribe/confirm", { token }), "confirm");
const remove = (token: string) => handleSubscribeToken(post("/api/subscribe/remove", { token }), "remove");

beforeEach(async () => {
  await resetDatabase();
  Object.assign(status, { emailReady: true, subscribeEnabled: true });
  sent = [];
  await bootstrapSuperAdmin({ token: TEST_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: "correct-horse-battery" });
  for (const email of ["alice@example.com", "bob@example.com"]) expect((await signUp(email)).status).toBe(200);
  [alice, bob] = await Promise.all(["alice@example.com", "bob@example.com"].map(idOf));
  await testSql()`update users set email_verified = true where id = ${alice}`; // Only verified owners collect sign-ups.
  ({ id: profileId } = await svc.createProfile(alice, { handle: "alice", label: "Alice", displayName: "Alice" }));
  ({ id: bobProfileId } = await svc.createProfile(bob, { handle: "bob", label: "Bob", displayName: "Bob" }));
  const patch = { header: { displayName: "Alice Ames", bio: "" }, seo: { noindex: false }, blocks: [SUBSCRIBE] };
  await svc.publishProfile(alice, profileId, { expectedRevision: 0, patch });
});

describe("subscribe", () => {
  it("stores a pending sign-up and emails confirm and remove links; confirming makes it a contact", async () => {
    const res = await subscribe({ email: "  Visitor@Example.com " });
    expect(res.status).toBe(202);
    expect(await rows()).toEqual([
      expect.objectContaining({
        email: "visitor@example.com",
        status: "pending",
        consent_text: "By subscribing, you agree to share your email with Alice Ames. You can remove it at any time.",
      }),
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("visitor@example.com");
    // The page is named by its address; no owner-typed text (the display name) reaches the inbox.
    expect(sent[0].subject).toBe("Confirm your subscription");
    expect(sent[0].text).toContain(`the COVALink page ${new URL(TEST_APP_URL).host}/alice.`);
    expect(sent[0].text + sent[0].html).not.toContain("Alice Ames");
    const token = tokenFrom(sent[0], "confirm");
    expect(JSON.stringify(await rows())).not.toContain(token);

    expect((await confirm(token)).status).toBe(200);
    expect(await rows()).toEqual([expect.objectContaining({ status: "confirmed", confirm_token_hash: null, confirmed_at: expect.any(Date) })]);
    expect((await confirm(token)).status).toBe(410); // Used.
    expect(await listContacts(alice, profileId)).toEqual([expect.objectContaining({ email: "visitor@example.com", status: "confirmed" })]);
  });

  it("answers the same for a confirmed address and sends it nothing", async () => {
    await subscribe({ email: "v@example.com" });
    await confirm(tokenFrom(sent[0], "confirm"));
    const again = await subscribe({ email: "v@example.com" });
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(await rows()).toEqual([expect.objectContaining({ status: "confirmed" })]);
  });

  it("an inbox's quota is counted the same whether or not the address is confirmed, so it can't reveal list membership", async () => {
    await publishBobSubscribe();
    const bobRows = async () => ((await testSql()`select count(*)::int as n from audience_contacts where profile_id = ${bobProfileId}`)[0] as { n: number }).n;
    // Confirmed on Alice's page: one sign-up and two repeats.
    await subscribe({ email: "c@example.com" }, { ip: "203.0.113.1" });
    await confirm(tokenFrom(sent[0], "confirm"));
    for (let i = 0; i < SUBSCRIBE_LIMITS.perRecipient - 1; i++) await subscribe({ email: "c@example.com" }, { ip: `203.0.113.${2 + i}` });
    // Never confirmed: the same three sign-ups.
    for (let i = 0; i < SUBSCRIBE_LIMITS.perRecipient; i++) await subscribe({ email: "u@example.com" }, { ip: `203.0.113.${10 + i}` });
    sent = [];
    // On Bob's page both addresses now look the same: no email, a pending row each.
    for (const email of ["c@example.com", "u@example.com"]) {
      expect((await subscribe({ email, p: bobProfileId }, { ip: "203.0.113.50" })).status).toBe(202);
    }
    expect(sent).toEqual([]);
    expect(await bobRows()).toBe(2);
  });

  it("an owner's list looks the same whether or not an address's quota is used up, and earlier links keep working", async () => {
    await publishBobSubscribe();
    // "busy" uses up its quota on Bob's page; "idle" has none used.
    for (let i = 0; i < SUBSCRIBE_LIMITS.perRecipient; i++) await subscribe({ email: "busy@example.com", p: bobProfileId }, { ip: `203.0.113.${i}` });
    const lastLink = tokenFrom(sent.at(-1)!, "confirm");
    sent = [];
    for (const email of ["busy@example.com", "idle@example.com"]) await subscribe({ email }, { ip: "203.0.113.60" });
    expect(sent.map((m) => m.to)).toEqual(["idle@example.com"]);
    const listed = await listContacts(alice, profileId);
    expect(listed.map((c) => [c.email, c.status, c.source]).sort()).toEqual([
      ["b•••@example.com", "pending", "block"],
      ["i•••@example.com", "pending", "block"],
    ]);
    // An existing pending sign-up repeated over quota: the time its owner sees moves as usual, but its emailed link's own
    // time (which its 48 hours run from) stays, and the link still confirms.
    const times = async () =>
      ((await testSql()`select created_at, last_signup_at from audience_contacts where profile_id = ${bobProfileId} and email = 'busy@example.com'`) as unknown as {
        created_at: Date;
        last_signup_at: Date;
      }[])[0];
    const before = await times();
    sent = [];
    await subscribe({ email: "busy@example.com", p: bobProfileId }, { ip: "203.0.113.61" });
    const after = await times();
    expect(after.last_signup_at.getTime()).toBeGreaterThan(before.last_signup_at.getTime());
    expect(after.created_at).toEqual(before.created_at);
    expect(sent).toEqual([]);
    expect((await confirm(lastLink)).status).toBe(200);
  });

  it("a repeated pending sign-up replaces its tokens, so only the newest link confirms", async () => {
    await subscribe({ email: "v@example.com" });
    await subscribe({ email: "v@example.com" });
    expect(sent).toHaveLength(2);
    expect((await confirm(tokenFrom(sent[0], "confirm"))).status).toBe(410);
    expect((await confirm(tokenFrom(sent[1], "confirm"))).status).toBe(200);
  });

  it("a link stops working 48 hours after its email, even while later sign-ups keep the address listed as pending", async () => {
    await subscribe({ email: "old@example.com" });
    await testSql()`update audience_contacts set created_at = now() - make_interval(hours => ${PENDING_TTL_HOURS + 1})`;
    expect((await listContacts(alice, profileId)).map((c) => c.status)).toEqual(["pending"]);
    expect((await confirm(tokenFrom(sent[0], "confirm"))).status).toBe(410);
  });

  it("expired pending sign-ups can't be confirmed, aren't listed, and are deleted on the next sign-up to any profile", async () => {
    await subscribe({ email: "old@example.com" });
    await testSql()`update audience_contacts set created_at = now() - make_interval(hours => ${PENDING_TTL_HOURS + 1}), last_signup_at = now() - make_interval(hours => ${PENDING_TTL_HOURS + 1})`;
    expect(await listContacts(alice, profileId)).toEqual([]);
    expect((await confirm(tokenFrom(sent[0], "confirm"))).status).toBe(410);
    // Bob's profile collects too; a sign-up there sweeps Alice's expired row.
    await publishBobSubscribe();
    await subscribe({ email: "new@example.com", p: bobProfileId });
    expect((await rows()).map((r) => r.email)).toEqual(["new@example.com"]);
  });

  it("accepts but stores and sends nothing without a trusted client address (TRUST_PROXY off, or no address header)", async () => {
    expect((await subscribe({ email: "v@example.com" }, {}, false)).status).toBe(202);
    const noHeader = post("/api/subscribe", { p: profileId, b: ID(1), hp: "", email: "w@example.com" });
    expect((await handleSubscribe(noHeader, { send: (m) => sent.push(m), trustProxy: true })).status).toBe(202);
    expect(await rows()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("accepts but stores and sends nothing while the owner's email isn't verified", async () => {
    await testSql()`update users set email_verified = false where id = ${alice}`;
    expect((await subscribe({ email: "v@example.com" })).status).toBe(202);
    expect(await rows()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("the remove link deletes a pending or confirmed contact once", async () => {
    await subscribe({ email: "v@example.com" });
    await confirm(tokenFrom(sent[0], "confirm"));
    const token = tokenFrom(sent[0], "remove");
    expect((await remove(token)).status).toBe(200);
    expect(await rows()).toEqual([]);
    expect((await remove(token)).status).toBe(410);
  });

  it("accepts but stores nothing for a honeypot, a bot, a hidden or foreign block, or while email or the setting is off", async () => {
    expect((await subscribe({ email: "a@example.com", hp: "https://spam.example" })).status).toBe(202);
    const bot = post("/api/subscribe", { p: profileId, b: ID(1), hp: "", email: "b@example.com" });
    bot.headers.set("user-agent", "Googlebot/2.1");
    expect((await handleSubscribe(bot, { send: (m) => sent.push(m) })).status).toBe(202);
    expect((await subscribe({ email: "c@example.com", b: ID(2) })).status).toBe(202);
    expect((await subscribe({ email: "d@example.com", p: bobProfileId })).status).toBe(202);
    status.emailReady = false;
    expect((await subscribe({ email: "e@example.com" })).status).toBe(202);
    Object.assign(status, { emailReady: true, subscribeEnabled: false });
    expect((await subscribe({ email: "f@example.com" })).status).toBe(202);
    await svc.unpublishProfile(alice, profileId);
    status.subscribeEnabled = true;
    expect((await subscribe({ email: "g@example.com" })).status).toBe(202);
    expect(await rows()).toEqual([]);
    expect(sent).toEqual([]);
    // Requests that can't sign anyone up leave no rate-limit records either.
    const [{ n }] = (await testSql()`select count(*)::int as n from rate_limits where key like 'covalink:subscribe%'`) as unknown as { n: number }[];
    expect(n).toBe(0);
  });

  it("a hidden block or an unverified owner adds no rate-limit records", async () => {
    expect((await subscribe({ email: "a@example.com", b: ID(2) }, { ip: "203.0.113.1" })).status).toBe(202);
    await testSql()`update users set email_verified = false where id = ${alice}`;
    expect((await subscribe({ email: "b@example.com" }, { ip: "2001:db8:5::1" })).status).toBe(202);
    const [{ n }] = (await testSql()`select count(*)::int as n from rate_limits where key like 'covalink:subscribe%'`) as unknown as { n: number }[];
    expect(n).toBe(0);
  });

  it("new visitors share an installation-wide hourly budget; visitors already seen this hour don't use it", async () => {
    expect((await subscribe({ email: "seen@example.com" }, { ip: "203.0.113.10" })).status).toBe(202);
    await testSql()`update rate_limits set count = ${SUBSCRIBE_LIMITS.newVisitors} where key = 'covalink:subscribe:new-visitors'`;
    expect((await subscribe({ email: "new@example.com" }, { ip: "203.0.113.11" })).status).toBe(429);
    expect((await subscribe({ email: "new6@example.com" }, { ip: "2001:db8:7::1" })).status).toBe(429);
    expect((await subscribe({ email: "again@example.com" }, { ip: "203.0.113.10" })).status).toBe(202);
    const keys = ((await testSql()`select key from rate_limits where key like 'covalink:subscribe:client:%' or key like 'covalink:subscribe:site:%'`) as unknown as { key: string }[]);
    expect(keys).toHaveLength(1);
  });

  it("one IPv6 /48 rotating through /64s uses one unit of the new-visitor budget", async () => {
    for (let i = 0; i < SUBSCRIBE_LIMITS.perSite + 30; i++) {
      await subscribe({ email: `r${i}@example.com` }, { ip: `2001:db8:3:${i.toString(16)}::1` });
    }
    const [row] = (await testSql()`select count from rate_limits where key = 'covalink:subscribe:new-visitors'`) as unknown as { count: number }[];
    expect(Number(row.count)).toBe(1);
    expect((await subscribe({ email: "other@example.com" }, { ip: "2001:db8:4::1" })).status).toBe(202);
  });

  it("a burst of simultaneous requests from one new sender uses one unit of the new-visitor budget", async () => {
    const burst = (ip: string) => Promise.all(Array.from({ length: 20 }, (_, i) => subscribe({ email: `b${i}@example.com` }, { ip })));
    await burst("203.0.113.30");
    await burst("2001:db8:6::1");
    const [row] = (await testSql()`select count from rate_limits where key = 'covalink:subscribe:new-visitors'`) as unknown as { count: number }[];
    expect(Number(row.count)).toBe(2);
  });

  it("a burst from a sender whose record has expired also uses one unit of the budget", async () => {
    expect((await subscribe({ email: "early@example.com" }, { ip: "203.0.113.40" })).status).toBe(202);
    // An hour later: the sender's record and the budget's window have both expired, but the rows are still there.
    await testSql()`update rate_limits set last_request = ${Date.now() - 2 * 3600_000} where key like 'covalink:subscribe:%'`;
    await Promise.all(Array.from({ length: 20 }, (_, i) => subscribe({ email: `late${i}@example.com` }, { ip: "203.0.113.40" })));
    const [row] = (await testSql()`select count from rate_limits where key = 'covalink:subscribe:new-visitors'`) as unknown as { count: number }[];
    expect(Number(row.count)).toBe(1);
    const [{ n }] = (await testSql()`select count(*)::int as n from rate_limits where key like 'covalink:subscribe:client:%'`) as unknown as { n: number }[];
    expect(n).toBe(1);
  });

  it("expired records are cleaned up when a new visitor arrives, not on every request", async () => {
    const old = async () => ((await testSql()`select count(*)::int as n from rate_limits where key = 'covalink:subscribe:to:old'`)[0] as { n: number }).n;
    expect((await subscribe({ email: "first@example.com" }, { ip: "203.0.113.20" })).status).toBe(202);
    await testSql()`insert into rate_limits (id, key, count, last_request) values (${crypto.randomUUID()}, 'covalink:subscribe:to:old', 1, ${Date.now() - 2 * 3600_000})`;
    expect((await subscribe({ email: "second@example.com" }, { ip: "203.0.113.20" })).status).toBe(202);
    expect(await old()).toBe(1);
    expect((await subscribe({ email: "third@example.com" }, { ip: "203.0.113.21" })).status).toBe(202);
    expect(await old()).toBe(0);
  });

  it("refuses cross-site, non-JSON, oversized and malformed requests", async () => {
    expect((await subscribe({ email: "a@example.com" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await subscribe({ email: "a@example.com" }, { origin: null })).status).toBe(403);
    expect((await subscribe({ email: "a@example.com" }, { type: "text/plain" })).status).toBe(415);
    expect((await subscribe({ email: "a@example.com", hp: "x".repeat(9000) })).status).toBe(413);
    for (const body of [{ email: "not-an-email" }, { email: "a@example.com", extra: 1 }, { email: "a@example.com", p: "nope" }]) {
      expect((await subscribe(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await handleSubscribeToken(post("/api/subscribe/confirm", { token: "short" }), "confirm")).status).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it("limits sign-ups per client address and silently per recipient", async () => {
    for (let i = 0; i < 10; i++) expect((await subscribe({ email: `p${i}@example.com` }, { ip: "198.51.100.7" })).status).toBe(202);
    expect((await subscribe({ email: "p10@example.com" }, { ip: "198.51.100.7" })).status).toBe(429);
    sent = [];
    for (let i = 0; i < 4; i++) expect((await subscribe({ email: "same@example.com" }, { ip: `198.51.100.${20 + i}` })).status).toBe(202);
    expect(sent).toHaveLength(SUBSCRIBE_LIMITS.perRecipient);
  });

  it("one inbox gets at most three emails an hour, whatever +tag or profile is used; +tags are kept in the stored address", async () => {
    await publishBobSubscribe();
    for (let i = 1; i <= 5; i++) expect((await subscribe({ email: `v+${i}@example.com` }, { ip: `203.0.113.${i}` })).status).toBe(202);
    expect(sent.map((m) => m.to)).toEqual(["v+1@example.com", "v+2@example.com", "v+3@example.com"]);
    sent = [];
    expect((await subscribe({ email: "v@example.com", p: bobProfileId }, { ip: "203.0.113.20" })).status).toBe(202);
    expect(sent).toEqual([]);
    // Over a day: at most ten, even with the hourly window reopened in between.
    await testSql()`update rate_limits set last_request = ${Date.now() - 2 * 3600_000} where key like 'covalink:subscribe:to:%'`;
    await testSql()`update rate_limits set count = ${SUBSCRIBE_LIMITS.perRecipientDay} where key like 'covalink:subscribe-day:to:%'`;
    expect((await subscribe({ email: "v@example.com" }, { ip: "203.0.113.21" })).status).toBe(202);
    expect(sent).toEqual([]);
    expect((await subscribe({ email: "w@example.com" }, { ip: "203.0.113.22" })).status).toBe(202);
    expect(sent).toHaveLength(1);
  });

  it("a full shared limit answers 429 for every address alike, so it can't reveal recent sign-ups; the limit keys hold neither address nor IP", async () => {
    for (let i = 0; i < SUBSCRIBE_LIMITS.perRecipient; i++) await subscribe({ email: "same@example.com" }, { ip: `203.0.113.${i}` });
    await testSql()`update rate_limits set count = ${SUBSCRIBE_LIMITS.perProfile} where key = ${`covalink:subscribe:profile:${profileId}`}`;
    expect((await subscribe({ email: "same@example.com" }, { ip: "203.0.113.50" })).status).toBe(429);
    expect((await subscribe({ email: "other@example.com" }, { ip: "203.0.113.51" })).status).toBe(429);
    const keys = ((await testSql()`select key from rate_limits where key like 'covalink:subscribe%'`) as unknown as { key: string }[]).map((r) => r.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.join(" ")).not.toMatch(/same@|other@|203\.0\.113|198\.51\.100/);
  });

  it("limits sign-ups per owner across their profiles, hourly and daily", async () => {
    const { id: second } = await svc.createProfile(alice, { handle: "alice-two", label: "Two", displayName: "Two" });
    await svc.publishProfile(alice, second, { expectedRevision: 0, patch: { header: { displayName: "Two", bio: "" }, seo: { noindex: false }, blocks: [SUBSCRIBE] } });
    for (let i = 0; i < SUBSCRIBE_LIMITS.perOwner; i++) {
      const res = await subscribe({ email: `o${i}@example.com`, p: i % 2 ? second : profileId }, { ip: `10.0.${i >> 8}.${i & 255}` });
      expect(res.status).toBe(202);
    }
    expect((await subscribe({ email: "over@example.com", p: second }, { ip: "10.1.0.1" })).status).toBe(429);
    expect(sent).toHaveLength(SUBSCRIBE_LIMITS.perOwner);
    // The hour over, the day's cap still holds.
    await testSql()`update rate_limits set last_request = ${Date.now() - 2 * 3600_000} where key like 'covalink:subscribe:%'`;
    await testSql()`update rate_limits set count = ${SUBSCRIBE_LIMITS.perOwnerDay} where key = ${`covalink:subscribe-day:owner:${alice}`}`;
    expect((await subscribe({ email: "day@example.com" }, { ip: "10.1.0.2" })).status).toBe(429);
  });

  it("limits IPv6 clients per /48 site, so rotating through /64s doesn't escape it or add rows", async () => {
    const clientRows = async () => ((await testSql()`select count(*)::int as n from rate_limits where key like 'covalink:subscribe:client:%'`)[0] as { n: number }).n;
    for (let i = 0; i < SUBSCRIBE_LIMITS.perSite; i++) {
      expect((await subscribe({ email: `s${i}@example.com` }, { ip: `2001:db8:1:${i.toString(16)}::1` })).status).toBe(202);
    }
    for (let i = 0; i < 5; i++) expect((await subscribe({ email: `s-over${i}@example.com` }, { ip: `2001:db8:1:f${i}::1` })).status).toBe(429);
    expect(await clientRows()).toBe(SUBSCRIBE_LIMITS.perSite);
    expect((await subscribe({ email: "elsewhere@example.com" }, { ip: "2001:db8:2::1" })).status).toBe(202);
  });

  it("one sender can use only part of an owner's daily quota", async () => {
    const ip = "203.0.113.200";
    for (let i = 0; i < SUBSCRIBE_LIMITS.perSenderOwnerDay; i++) {
      if (i % SUBSCRIBE_LIMITS.perClient === 0) await testSql()`update rate_limits set last_request = ${Date.now() - 2 * 3600_000} where key like 'covalink:subscribe:client:%'`;
      expect((await subscribe({ email: `d${i}@example.com` }, { ip })).status).toBe(202);
    }
    await testSql()`update rate_limits set last_request = ${Date.now() - 2 * 3600_000} where key like 'covalink:subscribe:client:%'`;
    expect((await subscribe({ email: "d-over@example.com" }, { ip })).status).toBe(429);
    expect((await subscribe({ email: "d-other@example.com" }, { ip: "203.0.113.201" })).status).toBe(202);
    // The share is per owner: the same sender can still sign up on another owner's page.
    await publishBobSubscribe();
    expect((await subscribe({ email: "d-bob@example.com", p: bobProfileId }, { ip })).status).toBe(202);
  });

  it("while the installation-wide limit is full, nothing else is counted", async () => {
    await testSql()`insert into rate_limits (id, key, count, last_request) values (${crypto.randomUUID()}, 'covalink:subscribe:global', ${SUBSCRIBE_LIMITS.global}, ${Date.now()})`;
    expect((await subscribe({ email: "full@example.com" })).status).toBe(429);
    expect((await subscribe({ email: "full6@example.com" }, { ip: "2001:db8:9::1" })).status).toBe(429);
    const keys = ((await testSql()`select key from rate_limits where key like 'covalink:subscribe%'`) as unknown as { key: string }[]).map((r) => r.key);
    expect(keys).toEqual(["covalink:subscribe:global"]);
  });

  it("windows are fixed: an accepted attempt doesn't move them, and refused attempts don't either", async () => {
    const key = `covalink:subscribe:profile:${profileId}`;
    const startedAt = Date.now() - 30 * 60_000; // Full 30 minutes ago.
    await testSql()`insert into rate_limits (id, key, count, last_request) values (${crypto.randomUUID()}, ${key}, 59, ${startedAt})`;
    const lastRequest = async () => Number(((await testSql()`select last_request from rate_limits where key = ${key}`)[0] as { last_request: string }).last_request);
    expect((await subscribe({ email: "ok@example.com" }, { ip: "203.0.113.90" })).status).toBe(202);
    expect(await lastRequest()).toBe(startedAt);
    for (let i = 0; i < 3; i++) expect((await subscribe({ email: `r${i}@example.com` }, { ip: `203.0.113.${i}` })).status).toBe(429);
    expect(await lastRequest()).toBe(startedAt);
  });

  it("over the profile limit, new addresses add no recipient rows; expired sign-up rows are purged", async () => {
    const count = async (like: string) => ((await testSql()`select count(*)::int as n from rate_limits where key like ${like}`)[0] as { n: number }).n;
    await testSql()`insert into rate_limits (id, key, count, last_request) values
      (${crypto.randomUUID()}, ${`covalink:subscribe:profile:${profileId}`}, 60, ${Date.now()}),
      (${crypto.randomUUID()}, 'covalink:subscribe:to:old', 1, ${Date.now() - 2 * 3600_000}),
      (${crypto.randomUUID()}, 'covalink:subscribe-day:to:old', 1, ${Date.now() - 25 * 3600_000})`;
    for (let i = 0; i < 5; i++) expect((await subscribe({ email: `n${i}@example.com` }, { ip: `203.0.113.${i}` })).status).toBe(429);
    // No new recipient rows; the expired ones are already gone, because cleanup runs past the per-visitor limit, not only on success.
    expect(await count("covalink:subscribe%:to:%")).toBe(0);
    expect(sent).toEqual([]);

    await testSql()`update rate_limits set last_request = ${Date.now() - 2 * 3600_000} where key = ${`covalink:subscribe:profile:${profileId}`}`;
    expect((await subscribe({ email: "fresh@example.com" }, { ip: "198.51.100.50" })).status).toBe(202);
    expect(sent).toHaveLength(1);
  });

  it("requests for an unknown or unpublished profile store no rate-limit rows", async () => {
    for (let i = 0; i < 3; i++) expect((await subscribe({ email: "v@example.com", p: ID(900 + i) }, { ip: `203.0.113.${i}` })).status).toBe(202);
    expect((await subscribe({ email: "v@example.com", p: bobProfileId })).status).toBe(202); // Bob's profile isn't published.
    const [{ n }] = (await testSql()`select count(*)::int as n from rate_limits where key like 'covalink:subscribe%'`) as unknown as { n: number }[];
    expect(n).toBe(0);
  });

  it("the profile id's letter case can't split the limits: keys and the stored sign-up use the canonical id", async () => {
    const spellings = [profileId.toUpperCase(), profileId, profileId.replace(/[a-f]/, (c) => c.toUpperCase()), profileId.toUpperCase()];
    for (const [i, p] of spellings.entries()) expect((await subscribe({ p, email: "target@example.com" }, { ip: `203.0.113.${40 + i}` })).status).toBe(202);
    // Three confirmation emails per address and profile per hour, however the id is spelled.
    expect(sent).toHaveLength(SUBSCRIBE_LIMITS.perRecipient);
    const keys = ((await testSql()`select key from rate_limits where key like 'covalink:subscribe:profile:%'`) as unknown as { key: string }[]).map((r) => r.key);
    expect(keys).toEqual([`covalink:subscribe:profile:${profileId}`]);
    const [row] = (await testSql()`select profile_id::text as p from audience_contacts`) as unknown as { p: string }[];
    expect(row.p).toBe(profileId);
  });

  it("while sign-ups are off, requests store no rate-limit rows", async () => {
    status.subscribeEnabled = false;
    for (let i = 0; i < 3; i++) expect((await subscribe({ email: `off${i}@example.com` }, { ip: `203.0.113.${60 + i}` })).status).toBe(202);
    const [{ n }] = (await testSql()`select count(*)::int as n from rate_limits where key like 'covalink:subscribe:%'`) as unknown as { n: number }[];
    expect(n).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe("business card sign-ups", () => {
  const CARD = { displayName: "Alice's Card", color: "#c6f135", shareBack: true, saveContact: false };
  const setCard = (card: object) => testSql()`update profiles set card = ${testSql().json(card as never)} where id = ${profileId}`;
  const cardSignup = (body: Record<string, unknown>) =>
    handleSubscribe(post("/api/subscribe", { p: profileId, c: "card", name: "Vera Visitor", hp: "", ...body }, { ip: "198.51.100.9" }), {
      send: (m) => sent.push(m),
      trustProxy: true,
    });
  const cardRows = async () =>
    (await testSql()`select email, name, phone, note, source, block_id, consent_text from audience_contacts order by email`) as unknown as Record<string, unknown>[];

  it("accept but store and send nothing while the card's share-back switch is off", async () => {
    expect((await cardSignup({ email: "v@example.com" })).status).toBe(202);
    await setCard({ ...CARD, shareBack: false });
    expect((await cardSignup({ email: "v@example.com" })).status).toBe(202);
    expect(await cardRows()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("store the name, a canonical phone and the note with source card, and confirm by email like a Subscribe block", async () => {
    await setCard(CARD);
    const res = await cardSignup({ email: "V@Example.com", name: " Vera\u202e Visitor ", phone: "+1 (555) 010-0200", note: "Met at\u200b the fair\nCall me" });
    expect(res.status).toBe(202);
    expect(await cardRows()).toEqual([
      {
        email: "v@example.com",
        name: "Vera Visitor",
        phone: "+15550100200",
        note: "Met at the fair\nCall me",
        source: "card",
        block_id: null,
        consent_text: "By sending, you agree to share these details with Alice's Card. You can remove them at any time.",
      },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("Confirm your subscription");
    expect(sent[0].text).toContain("business card");
    // The email lists what is shared, but never echoes what the visitor typed (name, phone, note) to the inbox.
    expect(sent[0].text).toContain("this email address, a name, a phone number and a note");
    for (const typed of ["Vera", "Met at", "5550100200"]) expect(sent[0].text + sent[0].html).not.toContain(typed);
    // Until confirmed, anyone could have typed these details, and the visitor hasn't agreed to share the address yet,
    // so the owner sees only a masked email.
    expect(await listContacts(alice, profileId)).toEqual([
      expect.objectContaining({ email: "v•••@example.com", status: "pending", name: null, phone: null, note: null }),
    ]);
    // The confirm page previews what confirming shares, without confirming it.
    const token = tokenFrom(sent[0], "confirm");
    const shown = await handleSubscribeToken(post("/api/subscribe/confirm", { token, preview: true }), "confirm");
    expect(shown.status).toBe(200);
    expect(await shown.json()).toEqual({ ok: true, page: `${new URL(TEST_APP_URL).host}/alice`, name: "Vera Visitor", phone: "+15550100200", note: "Met at the fair\nCall me" });
    expect(await listContacts(alice, profileId)).toEqual([expect.objectContaining({ status: "pending" })]);
    expect((await confirm(token)).status).toBe(200);
    expect((await handleSubscribeToken(post("/api/subscribe/confirm", { token, preview: true }), "confirm")).status).toBe(410);
    const [contact] = await listContacts(alice, profileId);
    expect(contact).toMatchObject({ name: "Vera Visitor", phone: "+15550100200", source: "card", status: "confirmed" });
    expect(await exportContacts(alice, profileId)).toEqual([expect.objectContaining({ name: "Vera Visitor", source: "card" })]);
  });

  it("refuse a malformed phone, a note with control characters, a missing name, and mixing block and card fields", async () => {
    await setCard(CARD);
    for (const body of [
      { email: "v@example.com", phone: "call me" },
      { email: "v@example.com", note: "a\u0000b" },
      { email: "v@example.com", name: "" },
      { email: "v@example.com", b: ID(1) },
    ]) {
      expect((await cardSignup(body)).status).toBe(400);
    }
    expect(await cardRows()).toEqual([]);
  });

  it("accept the longest name and note the form allows in a 3-byte script, with a long address", async () => {
    await setCard(CARD);
    const email = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(50)}.com`;
    expect((await cardSignup({ email, name: "名".repeat(100), phone: "+1 555 010 0200", note: "字".repeat(500) })).status).toBe(202);
    expect(await cardRows()).toEqual([expect.objectContaining({ email, name: "名".repeat(100), note: "字".repeat(500) })]);
  });

  it("preview only on confirm, and only for a known pending token", async () => {
    const unknown = "A".repeat(43);
    expect((await handleSubscribeToken(post("/api/subscribe/confirm", { token: unknown, preview: true }), "confirm")).status).toBe(410);
    expect((await handleSubscribeToken(post("/api/subscribe/remove", { token: unknown, preview: true }), "remove")).status).toBe(400);
    expect((await handleSubscribeToken(post("/api/subscribe/confirm", { token: unknown, preview: false }), "confirm")).status).toBe(400);
  });

  it("an over-quota block sign-up after a card sign-up shows as a block sign-up, but the card link confirms the card's details as a card contact", async () => {
    await setCard(CARD);
    for (let i = 0; i < SUBSCRIBE_LIMITS.perRecipient; i++) await cardSignup({ email: "v@example.com", note: "From the card" });
    const cardLink = tokenFrom(sent.at(-1)!, "confirm");
    sent = [];
    expect((await subscribe({ email: "v@example.com" })).status).toBe(202);
    expect(sent).toEqual([]);
    expect((await listContacts(alice, profileId)).map((c) => [c.status, c.source])).toEqual([["pending", "block"]]);
    expect((await confirm(cardLink)).status).toBe(200);
    expect(await exportContacts(alice, profileId)).toEqual([
      expect.objectContaining({ email: "v@example.com", name: "Vera Visitor", note: "From the card", source: "card", consentText: "By sending, you agree to share these details with Alice's Card. You can remove them at any time." }),
    ]);
    expect((await cardRows())[0]).toMatchObject({ source: "card", block_id: null });
    expect((await listContacts(alice, profileId)).map((c) => [c.status, c.source])).toEqual([["confirmed", "card"]]);
  });

  it("share the per-recipient limit with Subscribe blocks", async () => {
    await setCard(CARD);
    for (let i = 0; i < SUBSCRIBE_LIMITS.perRecipient; i++) await subscribe({ email: "v@example.com" });
    sent = [];
    expect((await cardSignup({ email: "v@example.com" })).status).toBe(202);
    expect(sent).toEqual([]);
  });
});

describe("owner access", () => {
  it("lists, exports and deletes only the owner's own contacts; contacts go with the profile", async () => {
    await subscribe({ email: "v@example.com" });
    await confirm(tokenFrom(sent[0], "confirm"));
    await subscribe({ email: "pending@example.com" });
    expect((await listContacts(alice, profileId)).map((c) => c.email)).toEqual(["p•••@example.com", "v@example.com"]);
    const [contact] = await listContacts(alice, profileId);
    expect(await listContacts(bob, profileId)).toEqual([]);
    expect(await exportContacts(bob, profileId)).toEqual([]);
    expect(await exportContacts(alice, profileId)).toEqual([expect.objectContaining({ email: "v@example.com" })]);
    expect(await deleteContact(bob, profileId, contact.id)).toBe(false);
    expect(await deleteContact(alice, bobProfileId, contact.id)).toBe(false);
    expect(await deleteContact(alice, profileId, contact.id)).toBe(true);
    expect((await rows()).map((r) => r.email)).toEqual(["v@example.com"]);
    await svc.deleteProfile(alice, profileId);
    expect(await rows()).toEqual([]);
  });
});
