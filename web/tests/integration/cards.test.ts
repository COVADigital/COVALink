import { beforeEach, describe, expect, it, vi } from "vitest";

/** The business card's save action and download route, with a mocked session over the real database. */
const session = vi.hoisted(() => ({ user: null as null | { id: string; name: string; email: string; emailVerified: boolean; role: "user" } }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => session.user, resolveSessionUser: async () => session.user }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));
// `use cache` helpers only work inside Next.js; here the cached function runs uncached.
vi.mock("next/cache", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/cache")>()), cacheTag: vi.fn(), cacheLife: vi.fn() }));

import { GET as GET_VCARD } from "@/app/api/vcard/[profileId]/card/route";
import { GET } from "@/app/dashboard/profiles/[id]/card/download/route";
import { saveCardAction } from "@/features/cards/actions";
import * as svc from "@/features/profiles/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { signUp } from "../support/auth-http";
import { resetDatabase, testSql } from "../support/db";
import { TEST_APP_URL, TEST_SETUP_TOKEN } from "../support/test-env";

let alice = "";
let bob = "";
let profileId = "";
const as = (id: string | null) => {
  session.user = id ? { id, name: id, email: `${id}@example.com`, emailVerified: true, role: "user" } : null;
};
const idOf = async (email: string) => ((await testSql()`select id from users where email = ${email}`)[0] as { id: string }).id;
const download = (id: string) =>
  GET(new Request(`${TEST_APP_URL}/dashboard/profiles/${id}/card/download`), { params: Promise.resolve({ id }) } as RouteContext<"/dashboard/profiles/[id]/card/download">);
const stored = async () => ((await testSql()`select card, draft_revision, published from profiles where id = ${profileId}`)[0] as { card: unknown; draft_revision: number; published: unknown });

beforeEach(async () => {
  await resetDatabase();
  await bootstrapSuperAdmin({ token: TEST_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: "correct-horse-battery" });
  for (const email of ["alice@example.com", "bob@example.com"]) expect((await signUp(email)).status).toBe(200);
  [alice, bob] = await Promise.all(["alice@example.com", "bob@example.com"].map(idOf));
  ({ id: profileId } = await svc.createProfile(alice, { handle: "alice", label: "Alice", displayName: "Alice Draft" }));
});

describe("business card", () => {
  it("saves only for the owner, and leaves the page's draft and revisions alone", async () => {
    const before = await stored();
    as(bob);
    expect(await saveCardAction({ profileId, patch: { displayName: "Mallory", color: "#b91c1c" } })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    as(null);
    expect((await saveCardAction({ profileId, patch: { displayName: "Mallory", color: "#b91c1c" } })).ok).toBe(false);
    expect((await stored()).card).toBeNull();

    as(alice);
    expect(await saveCardAction({ profileId, patch: { displayName: "A", color: "#123456" } })).toMatchObject({ ok: false, fieldErrors: { color: expect.any(Array) } });
    const saved = { displayName: "Alice Card", color: "#b91c1c", shareBack: false, saveContact: false };
    expect(await saveCardAction({ profileId, patch: { displayName: " Alice Card ", color: "#b91c1c" } })).toEqual({ ok: true, data: saved });
    const after = await stored();
    expect(after.card).toEqual(saved);
    expect(after.draft_revision).toBe(before.draft_revision);
    expect(after.published).toEqual(before.published);
  });

  it("switches change only themselves; Save contact needs valid contact details", async () => {
    as(alice);
    await saveCardAction({ profileId, patch: { displayName: "Alice Card", color: "#1e3a8a" } });
    expect(await saveCardAction({ profileId, patch: { shareBack: true } })).toMatchObject({ ok: true, data: { displayName: "Alice Card", shareBack: true } });
    expect(await saveCardAction({ profileId, patch: { saveContact: true } })).toMatchObject({ ok: false, fieldErrors: { contact: expect.any(Array) } });
    expect(await saveCardAction({ profileId, patch: { saveContact: true, contact: { label: "Save contact", firstName: "", email: "x" } } })).toMatchObject({
      ok: false,
    });
    const contact = { label: "Save contact", firstName: "Alice", lastName: "Ames", email: "alice@example.com", phone: "+1 555 010 0100" };
    expect(await saveCardAction({ profileId, patch: { saveContact: true, contact } })).toMatchObject({ ok: true, data: { saveContact: true, shareBack: true } });
    expect((await stored()).card).toMatchObject({ color: "#1e3a8a", contact: { firstName: "Alice", email: "alice@example.com" } });
  });

  it("a details-only save is refused when Save contact changed since the form loaded, and saves nothing", async () => {
    as(alice);
    const contact = { label: "Save contact", firstName: "Alice", email: "alice@example.com" };
    await saveCardAction({ profileId, patch: { contact } });
    // Another tab turns Save contact on; this tab's form still shows it off.
    await saveCardAction({ profileId, patch: { saveContact: true } });
    const stale = await saveCardAction({ profileId, patch: { contact: { ...contact, firstName: "Changed" } }, expectSaveContact: false });
    expect(stale).toMatchObject({ ok: false, code: "CONFLICT" });
    expect((await stored()).card).toMatchObject({ saveContact: true, contact: { firstName: "Alice" } });
    // With the current state, it saves.
    const fresh = await saveCardAction({ profileId, patch: { contact: { ...contact, firstName: "Changed" } }, expectSaveContact: true });
    expect(fresh).toMatchObject({ ok: true, data: { saveContact: true, contact: { firstName: "Changed" } } });
  });

  it("serves the card's vCard only while Save contact is on and the profile is live", async () => {
    const vcard = () => GET_VCARD(new Request(`${TEST_APP_URL}/api/vcard/${profileId}/card`), { params: Promise.resolve({ profileId }) } as RouteContext<"/api/vcard/[profileId]/card">);
    as(alice);
    const contact = { label: "Save contact", firstName: "Alice", lastName: "Ames", email: "alice@example.com" };
    await saveCardAction({ profileId, patch: { saveContact: true, contact } });
    expect((await vcard()).status).toBe(404); // Not published yet.
    await svc.publishProfile(alice, profileId, { expectedRevision: 0, patch: { header: { displayName: "Alice", bio: "" }, seo: { noindex: false }, blocks: [] } });
    const res = await vcard();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/vcard/);
    const body = await res.text();
    expect(body).toContain("FN:Alice Ames");
    expect(body).toContain("EMAIL:alice@example.com");
    await saveCardAction({ profileId, patch: { saveContact: false } });
    expect((await vcard()).status).toBe(404);
  });

  it("downloads the saved card for the owner and is a 404 for anyone else", async () => {
    as(alice);
    let res = await download(profileId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="covalink-alice-card.svg"');
    expect(res.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
    expect(await res.text()).toContain(">Alice Draft</text>"); // Nothing saved yet: the profile's display name.

    await saveCardAction({ profileId, patch: { displayName: "Alice Card", color: "#1e3a8a" } });
    const svg = await (await download(profileId)).text();
    expect(svg).toContain(">Alice Card</text>");
    expect(svg).toContain('fill="#1e3a8a"');

    as(bob);
    res = await download(profileId);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Alice");
    as(null);
    expect((await download(profileId)).status).toBe(404);
  });
});
