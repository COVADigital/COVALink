import http from "node:http";
import { beforeAll, describe, expect, it } from "vitest";
import * as svc from "@/features/profiles/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { resetDatabase, testSql } from "../support/db";
import { parseVCard, unescapeText } from "../support/vcard-parse";

/**
 * Contact, social and spacer blocks over real HTTP against the production
 * server (`next start`, or the hardened image in container mode): public
 * rendering, social `/go` redirects and click recording, the vCard download
 * (status, raw headers, body) and the direct mailto:/tel: destinations.
 */
const BASE = process.env.E2E_BASE_URL!;
const PASSWORD = "correct-horse-battery";
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const header = { header: { displayName: "Contact Owner", bio: "" }, seo: { noindex: false } };
const blockIds = (html: string) => [...html.matchAll(/data-block-id="([^"]+)"/g)].map((m) => m[1]);
let ip = 1;
const nextIp = () => `198.18.10.${ip++ % 250}`;

let profileId = "";

const clicks = async () =>
  ((await testSql()`select block_id from analytics_events where type = 'click' and profile_id = ${profileId} order by id`) as unknown as { block_id: string }[]).map(
    (r) => r.block_id,
  );
const allEvents = async () => Number((await testSql()`select count(*)::int as n from analytics_events where profile_id = ${profileId}`)[0].n);

async function get(path: string, method = "GET") {
  const res = await fetch(`${BASE}${path}`, { method, redirect: "manual", headers: { "user-agent": BROWSER, "x-forwarded-for": nextIp() } });
  return { res, body: await res.text() };
}

/** Raw response header fields, without the client joining duplicates. */
function raw(path: string, method = "GET"): Promise<{ status: number; fields: [string, string][]; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${path}`, { method, headers: { "user-agent": BROWSER, "x-forwarded-for": nextIp() } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const fields: [string, string][] = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) fields.push([res.rawHeaders[i].toLowerCase(), res.rawHeaders[i + 1]]);
        resolve({ status: res.statusCode!, fields, body: Buffer.concat(chunks) });
      });
    });
    req.on("error", reject);
    req.end();
  });
}
const field = (fields: [string, string][], name: string) => fields.filter(([k]) => k === name).map(([, v]) => v);

beforeAll(async () => {
  await resetDatabase();
  await bootstrapSuperAdmin({ token: process.env.E2E_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: PASSWORD });
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": "198.18.11.1" },
    body: JSON.stringify({ name: "Contact", email: "contact@example.com", password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const [{ id: ownerId }] = (await testSql()`select id from users where email = 'contact@example.com'`) as unknown as { id: string }[];
  ({ id: profileId } = await svc.createProfile(ownerId, { handle: "contacts", label: "Contacts", displayName: "Contact Owner" }));
  const r = await svc.publishProfile(ownerId, profileId, {
    expectedRevision: 0,
    patch: {
      ...header,
      blocks: [
        {
          id: ID(1),
          type: "social",
          visible: true,
          config: { items: [{ platform: "github", url: "github.com/zoe" }, { platform: "mastodon", url: "https://social.example/@zoe" }], style: "pill" },
        },
        { id: ID(2), type: "email", visible: true, config: { label: "Email Zoë", email: "zoe@example.com", subject: "Hi & welcome?" } },
        { id: ID(3), type: "phone", visible: true, config: { label: "Call Zoë", phone: "+1 (555) 010-0100" } },
        {
          id: ID(4),
          type: "contact",
          visible: true,
          config: {
            label: "Save Zoë's card",
            firstName: "Zoë",
            lastName: "Łódź",
            organization: "Acme; Labs, Inc.",
            email: "zoe@example.com",
            phone: "+1 555 0100",
            website: "acme.example",
            note: `END:VCARD\nBEGIN:VCARD ${"東京".repeat(30)}`,
          },
        },
        { id: ID(5), type: "spacer", visible: true, config: { size: "xl" } },
        { id: ID(6), type: "social", visible: false, config: { items: [{ platform: "x", url: "https://x.com/hidden" }] } },
        { id: ID(7), type: "contact", visible: false, config: { organization: "Hidden Org" } },
      ],
    },
  });
  // A draft-only contact card and social block must never be served.
  await svc.saveDraft(ownerId, profileId, {
    expectedRevision: r.revision,
    patch: {
      ...header,
      blocks: [
        { id: ID(8), type: "contact", visible: true, config: { organization: "Draft Org" } },
        { id: ID(9), type: "social", visible: true, config: { items: [{ platform: "x", url: "https://x.com/draft" }] } },
      ],
    },
  });
});

describe("public rendering", () => {
  it("renders the visible published blocks with tracked social links, direct mailto:/tel: and the vCard link", async () => {
    const { res, body: html } = await get("/contacts");
    expect(res.status).toBe(200);
    expect(blockIds(html)).toEqual([ID(1), ID(2), ID(3), ID(4), ID(5)]);
    expect(html).toContain('<ul class="pp-social" data-style="pill" aria-label="Social links">');
    expect(html).toContain(`<a class="pp-social-link" href="/go/${profileId}/${ID(1)}/0" aria-label="GitHub profile" rel="noopener nofollow ugc">`);
    expect(html).toContain(`href="/go/${profileId}/${ID(1)}/1" aria-label="Mastodon profile"`);
    // Social destinations are only behind /go.
    expect(html).not.toContain("github.com/zoe");
    expect(html).toContain('<a class="pp-btn" href="mailto:zoe@example.com?subject=Hi%20%26%20welcome%3F">');
    expect(html).toContain('<a class="pp-btn" href="tel:+15550100100">');
    expect(html).toContain(`<a class="pp-btn" href="/api/vcard/${profileId}/${ID(4)}" download="Zoe-odz.vcf">`);
    expect(html).toContain('<div class="pp-spacer" data-size="xl" aria-hidden="true"></div>');
    for (const absent of ["x.com/hidden", "Hidden Org", "Draft Org", "x.com/draft", ID(6), ID(7), ID(8), ID(9)]) expect(html).not.toContain(absent);
    expect(await allEvents()).toBe(0);
  });
});

describe("social /go", () => {
  it("redirects GET to the stored destination and records one click per GET against the block; HEAD records nothing", async () => {
    const before = (await clicks()).length;
    const a = await get(`/go/${profileId}/${ID(1)}/0`);
    expect([a.res.status, a.res.headers.get("location"), a.res.headers.get("cache-control")]).toEqual([302, "https://github.com/zoe", "no-store"]);
    expect(a.res.headers.getSetCookie()).toEqual([]);
    const b = await get(`/go/${profileId}/${ID(1)}/1`);
    expect(b.res.headers.get("location")).toBe("https://social.example/@zoe");
    const head = await get(`/go/${profileId}/${ID(1)}/1`, "HEAD");
    expect([head.res.status, head.res.headers.get("location")]).toEqual([302, "https://social.example/@zoe"]);
    expect((await clicks()).slice(before)).toEqual([ID(1), ID(1)]);
  });

  it("answers the same 404 for invalid indexes, hidden, draft-only and non-social blocks, recording nothing", async () => {
    const before = await allEvents();
    const reference = await get(`/go/${profileId}/${ID(1)}/2`);
    expect(reference.res.status).toBe(404);
    for (const path of [
      `/go/${profileId}/${ID(1)}/01`,
      `/go/${profileId}/${ID(1)}/-1`,
      `/go/${profileId}/${ID(1)}/99`,
      `/go/${profileId}/${ID(1)}/x`,
      `/go/${profileId}/${ID(6)}/0`,
      `/go/${profileId}/${ID(9)}/0`,
      `/go/${profileId}/${ID(2)}/0`,
      `/go/${profileId}/${ID(1)}`,
      `/go/${ID(77)}/${ID(1)}/0`,
    ]) {
      for (const method of ["GET", "HEAD"]) {
        const r = await get(path, method);
        expect(r.res.status, `${method} ${path}`).toBe(404);
        expect(r.res.headers.get("location"), path).toBeNull();
        if (method === "GET") expect(r.body, path).toBe(reference.body);
      }
    }
    expect(await allEvents()).toBe(before);
  });
});

describe("vCard download", () => {
  const path = () => `/api/vcard/${profileId}/${ID(4)}`;

  it("serves the published card with each required header exactly once and no cookie", async () => {
    const before = await allEvents();
    const r = await raw(path());
    expect(r.status).toBe(200);
    const once = (name: string) => {
      const values = field(r.fields, name);
      expect(values, name).toHaveLength(1);
      return values[0];
    };
    expect(once("content-type")).toBe("text/vcard; charset=utf-8");
    expect(once("content-disposition")).toBe(`attachment; filename="Zoe-odz.vcf"; filename*=UTF-8''Zo%C3%AB%20%C5%81%C3%B3d%C5%BA.vcf`);
    expect(once("x-content-type-options")).toBe("nosniff");
    expect(once("cache-control")).toBe("no-store");
    expect(once("x-robots-tag")).toBe("noindex, nofollow");
    expect(once("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(once("referrer-policy")).toBe("no-referrer");
    expect(once("x-frame-options")).toBe("DENY");
    expect(once("content-length")).toBe(String(r.body.length));
    expect(field(r.fields, "set-cookie")).toEqual([]);
    // The page headers aren't added on top.
    expect(field(r.fields, "permissions-policy")).toEqual([]);
    expect(field(r.fields, "cross-origin-opener-policy")).toEqual([]);

    const text = r.body.toString("utf8");
    const props = parseVCard(text);
    expect(props.map((p) => p.name)).toEqual(["BEGIN", "VERSION", "FN", "N", "ORG", "EMAIL", "TEL", "URL", "NOTE", "END"]);
    expect(unescapeText(props.find((p) => p.name === "FN")!.raw)).toBe("Zoë Łódź");
    expect(unescapeText(props.find((p) => p.name === "ORG")!.raw)).toBe("Acme; Labs, Inc.");
    expect(unescapeText(props.find((p) => p.name === "NOTE")!.raw)).toBe(`END:VCARD\nBEGIN:VCARD ${"東京".repeat(30)}`);
    expect(props.find((p) => p.name === "TEL")!.raw).toBe("tel:+15550100");
    expect(props.find((p) => p.name === "URL")!.raw).toBe("https://acme.example/");
    expect(text.match(/^END:VCARD\r$/gm)).toHaveLength(1);
    expect(await allEvents()).toBe(before);
  });

  it("answers HEAD with the same status and headers and no body", async () => {
    const getRes = await raw(path());
    const headRes = await raw(path(), "HEAD");
    expect(headRes.status).toBe(200);
    expect(headRes.body.length).toBe(0);
    const comparable = (fields: [string, string][]) => fields.filter(([k]) => !["date", "connection", "keep-alive"].includes(k)).sort();
    expect(comparable(headRes.fields)).toEqual(comparable(getRes.fields));
  });

  it("answers other methods with 405 and Allow: GET, HEAD, and a non-HTTP method with Next's 400, each with one copy of the vCard security headers", async () => {
    const vcardOnce = (fields: [string, string][], label: string) => {
      for (const [name, value] of [
        ["content-security-policy", "sandbox; default-src 'none'"],
        ["x-content-type-options", "nosniff"],
        ["cache-control", "no-store"],
        ["x-robots-tag", "noindex, nofollow"],
        ["referrer-policy", "no-referrer"],
        ["x-frame-options", "DENY"],
        ["cross-origin-resource-policy", "same-origin"],
      ]) {
        expect(field(fields, name), `${label} ${name}`).toEqual([value]);
      }
      expect(field(fields, "permissions-policy"), label).toEqual([]);
      expect(field(fields, "set-cookie"), label).toEqual([]);
    };
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      for (const p of [path(), `/api/vcard/${ID(77)}/${ID(78)}`]) {
        const r = await raw(p, method);
        expect(r.status, `${method} ${p}`).toBe(405);
        expect(field(r.fields, "allow"), method).toEqual(["GET, HEAD"]);
        expect(r.body.toString(), method).toBe("Method not allowed");
        vcardOnce(r.fields, method);
      }
    }
    // Next.js answers a method outside its HTTP method list with 400; the config rule still covers it.
    const webdav = await raw(path(), "PROPFIND");
    expect(webdav.status).toBe(400);
    vcardOnce(webdav.fields, "PROPFIND");
  });

  it("gives paths with a missing or extra segment the normal page headers, once each", async () => {
    for (const p of ["/api/vcard", "/api/vcard/x", `/api/vcard/${profileId}/${ID(4)}/extra`, "/api/vcardish/x/y"]) {
      const r = await raw(p);
      expect(r.status, p).toBe(404);
      const csp = field(r.fields, "content-security-policy");
      expect(csp, p).toHaveLength(1);
      expect(csp[0], p).toContain("default-src 'self'");
      expect(csp[0], p).not.toContain("sandbox");
      expect(field(r.fields, "x-content-type-options"), p).toEqual(["nosniff"]);
      expect(field(r.fields, "permissions-policy"), p).toHaveLength(1);
      expect(field(r.fields, "x-frame-options"), p).toEqual(["DENY"]);
    }
  });

  it("answers the same plain 404 for hidden, draft-only, other-type, unknown and malformed ids", async () => {
    const reference = await raw(`/api/vcard/${profileId}/${ID(99)}`);
    expect(reference.status).toBe(404);
    expect(reference.body.toString()).toBe("Not found");
    expect(field(reference.fields, "content-type")).toEqual(["text/plain; charset=utf-8"]);
    expect(field(reference.fields, "content-disposition")).toEqual([]);
    expect(field(reference.fields, "content-security-policy")).toHaveLength(1);
    for (const p of [
      `/api/vcard/${profileId}/${ID(7)}`, // hidden
      `/api/vcard/${profileId}/${ID(8)}`, // draft only
      `/api/vcard/${profileId}/${ID(2)}`, // email block
      `/api/vcard/${profileId}/${ID(1)}`, // social block
      `/api/vcard/${ID(77)}/${ID(4)}`, // unknown profile
      `/api/vcard/not-a-uuid/${ID(4)}`,
      `/api/vcard/${profileId}/x`,
    ]) {
      const r = await raw(p);
      expect(r.status, p).toBe(404);
      expect(r.body.toString(), p).toBe("Not found");
      expect(field(r.fields, "set-cookie"), p).toEqual([]);
      expect((await raw(p, "HEAD")).status, `HEAD ${p}`).toBe(404);
    }
  });
});
