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
    // The display name is user-supplied: kept out of the subject, quoted in the body.
    expect(sent[0].subject).toBe("Confirm your subscription");
    expect(sent[0].text).toContain('"Alice Ames"');
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

  it("a repeated pending sign-up replaces its tokens, so only the newest link confirms", async () => {
    await subscribe({ email: "v@example.com" });
    await subscribe({ email: "v@example.com" });
    expect(sent).toHaveLength(2);
    expect((await confirm(tokenFrom(sent[0], "confirm"))).status).toBe(410);
    expect((await confirm(tokenFrom(sent[1], "confirm"))).status).toBe(200);
  });

  it("expired pending sign-ups can't be confirmed, aren't listed, and are deleted on the next sign-up to any profile", async () => {
    await subscribe({ email: "old@example.com" });
    await testSql()`update audience_contacts set created_at = now() - make_interval(hours => ${PENDING_TTL_HOURS + 1})`;
    expect(await listContacts(alice, profileId)).toEqual([]);
    expect((await confirm(tokenFrom(sent[0], "confirm"))).status).toBe(410);
    // Bob's profile collects too; a sign-up there sweeps Alice's expired row.
    await testSql()`update users set email_verified = true where id = ${bob}`;
    const patch = { header: { displayName: "Bob", bio: "" }, seo: { noindex: false }, blocks: [SUBSCRIBE] };
    await svc.publishProfile(bob, bobProfileId, { expectedRevision: 0, patch });
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
  });

  it("refuses cross-site, non-JSON, oversized and malformed requests", async () => {
    expect((await subscribe({ email: "a@example.com" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await subscribe({ email: "a@example.com" }, { origin: null })).status).toBe(403);
    expect((await subscribe({ email: "a@example.com" }, { type: "text/plain" })).status).toBe(415);
    expect((await subscribe({ email: "a@example.com", hp: "x".repeat(3000) })).status).toBe(413);
    for (const body of [{ email: "not-an-email" }, { email: "a@example.com", extra: 1 }, { email: "a@example.com", p: "nope" }]) {
      expect((await subscribe(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await handleSubscribeToken(post("/api/subscribe/confirm", { token: "short" }), "confirm")).status).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it("limits sign-ups per client address and silently per email address", async () => {
    for (let i = 0; i < 10; i++) expect((await subscribe({ email: `p${i}@example.com` }, { ip: "198.51.100.7" })).status).toBe(202);
    expect((await subscribe({ email: "p10@example.com" }, { ip: "198.51.100.7" })).status).toBe(429);
    sent = [];
    for (let i = 0; i < 4; i++) expect((await subscribe({ email: "same@example.com" }, { ip: `198.51.100.${20 + i}` })).status).toBe(202);
    expect(sent).toHaveLength(3);
  });

  it("repeats of one address don't use up the profile's limit, and the limit keys hold neither the address nor the IP", async () => {
    // More repeats than the profile allows sign-ups per hour (60), each from its own client.
    for (let i = 0; i < 70; i++) expect((await subscribe({ email: "same@example.com" }, { ip: `203.0.113.${i}` })).status).toBe(202);
    sent = [];
    expect((await subscribe({ email: "other@example.com" }, { ip: "198.51.100.99" })).status).toBe(202);
    expect(sent).toHaveLength(1);
    const keys = ((await testSql()`select key from rate_limits where key like 'covalink:subscribe:%'`) as unknown as { key: string }[]).map((r) => r.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.join(" ")).not.toMatch(/same@|other@|203\.0\.113|198\.51\.100/);
  });

  it("refused attempts don't restart the profile's window, so it reopens an hour after the last accepted sign-up", async () => {
    const key = `covalink:subscribe:profile:${profileId}`;
    const startedAt = Date.now() - 30 * 60_000; // Full 30 minutes ago.
    await testSql()`insert into rate_limits (id, key, count, last_request) values (${crypto.randomUUID()}, ${key}, 60, ${startedAt})`;
    for (let i = 0; i < 3; i++) expect((await subscribe({ email: `r${i}@example.com` }, { ip: `203.0.113.${i}` })).status).toBe(429);
    const [row] = (await testSql()`select last_request from rate_limits where key = ${key}`) as unknown as { last_request: string }[];
    expect(Number(row.last_request)).toBe(startedAt);
  });

  it("over the profile limit, new addresses add no rate-limit rows; expired sign-up rows are purged", async () => {
    const count = async (like: string) => ((await testSql()`select count(*)::int as n from rate_limits where key like ${like}`)[0] as { n: number }).n;
    await testSql()`insert into rate_limits (id, key, count, last_request) values
      (${crypto.randomUUID()}, ${`covalink:subscribe:profile:${profileId}`}, 60, ${Date.now()}),
      (${crypto.randomUUID()}, 'covalink:subscribe:email:old', 1, ${Date.now() - 2 * 3600_000})`;
    for (let i = 0; i < 5; i++) expect((await subscribe({ email: `n${i}@example.com` }, { ip: `203.0.113.${i}` })).status).toBe(429);
    expect(await count("covalink:subscribe:email:%")).toBe(1); // Only the old row.
    expect(sent).toEqual([]);

    await testSql()`update rate_limits set last_request = ${Date.now() - 2 * 3600_000} where key = ${`covalink:subscribe:profile:${profileId}`}`;
    expect((await subscribe({ email: "fresh@example.com" }, { ip: "198.51.100.50" })).status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(await count("covalink:subscribe:email:old")).toBe(0);
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
    const res = await cardSignup({ email: "V@Example.com", name: " Vera‮ Visitor ", phone: "+1 (555) 010-0200", note: "Met at​ the fair\nCall me" });
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
    // The email lists what is shared, but never echoes visitor-typed text (name, note) to the inbox.
    expect(sent[0].text).toContain("this email address, a name, the phone number +15550100200 and a note");
    expect(sent[0].text).not.toContain("Vera");
    expect(sent[0].text).not.toContain("Met at");
    // Until confirmed, anyone could have typed these details, so the owner sees only the email.
    expect(await listContacts(alice, profileId)).toEqual([
      expect.objectContaining({ email: "v@example.com", status: "pending", name: null, phone: null, note: null }),
    ]);
    expect((await confirm(tokenFrom(sent[0], "confirm"))).status).toBe(200);
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

  it("share the per-email limit with Subscribe blocks", async () => {
    await setCard(CARD);
    for (let i = 0; i < SUBSCRIBE_LIMITS.perEmail; i++) await subscribe({ email: "v@example.com" });
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
